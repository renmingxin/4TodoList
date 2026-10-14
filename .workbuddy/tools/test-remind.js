// 云函数 fqRemind 的逻辑仿真测试
//
// 为什么值得单独一份：这个函数跑在**定时触发器**里，本地根本没法手动触发，
// 而它踩坑的方式全是「静默的」——
//   · 去重失效 → 用户收到重复通知（而且每条都烧掉一条攒来的额度）；
//   · 额度判断写反 → 发出去了却扣不掉，或者扣掉了却没发；
//   · 窗口条件写松 → 把几个月前的老提醒全补发一遍。
// 这些在开发者工具里一条都看不见。所以把 fqRemind 加载进假云 SDK 真跑一遍。
//
// 假 SDK 与 test-cloudfn.js 共用一份（.workbuddy/tools/fake-cloud.js）：
// 两个函数的查询语义必须一致，否则「升级上来的老文档没有 pushed 字段」
// 这类判断在两份测试里会得出相反的结论。

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const FN_PATH = path.join(ROOT, 'cloudfunctions/fqRemind/index.js');
const CONFIG_PATH = path.join(ROOT, 'cloudfunctions/fqRemind/config.json');
const FQ_TODO_PATH = path.join(ROOT, 'cloudfunctions/fqTodo/index.js');

const FC = require('./fake-cloud.js');
const fn = FC.loadFunction(FN_PATH);

const TPL = '1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* ---------------- 断言脚手架 ---------------- */

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + '\n      实际 ' + a + '\n      期望 ' + e);
  }
}
function ok(label, cond) {
  eq(label, !!cond, true);
}

/* ---------------- 夹具 ---------------- */

let seq = 0;

// 每个用例从这开始：一个家庭、一个分类、一份账本
function seed(opts) {
  FC.reset();
  seq = 0;
  const o = opts || {};
  FC.COLLECTIONS.fq_family.push({ _id: 'fam1', name: '我的家庭', ownerOpenid: 'openid-me', rev: 0 });
  FC.COLLECTIONS.fq_categories.push({ _id: 'cat1', fid: 'fam1', _openid: 'openid-me', name: '工作', order: 0 });
  if (o.noLedger !== true) {
    FC.COLLECTIONS.fq_subs.push({
      _id: 'sub1',
      _openid: 'openid-me',
      quota: o.quota === undefined ? 3 : o.quota,
      lastGrantAt: 0,
    });
  }
}

// v8：fqRemind 改按 pushAt 扫 —— 提前量逐条不同，一个全局窗口表达不了。
//
// ⚠️ 夹具里 **remindAt 与 pushAt 已经解耦**，别再让 pushAt 由 remindAt 折算出来。
// 曾经想写成 `pushAt = remindAt - 10min` 来复刻旧语义，但那样默认夹具的 pushAt
// 恰好落在 `now - LATE_MS`（迟到容忍 5 分钟）的**边界**上：`at < now - 5min`
// 成不成立取决于两次 Date.now() 之间那几毫秒，用例会偶发飘红。
//
// 所以默认给「**现在就该发**」：remindAt 只是个好看的文案值（消息的 time23 槽），
// 什么时候发完全由 pushAt 说了算。要测「还没到期 / 已经过期 / 谁先谁后」，
// 显式传 pushAt —— 这也比「换个提前量再看效果」直白得多。
const FIX_LEAD_MS = 10 * MIN;

function mkItem(over) {
  seq++;
  const o = over || {};
  const noRemind = o.remindAt === null;
  const d = Object.assign(
    {
      _id: 'it' + seq,
      _openid: 'openid-me',
      fid: 'fam1',
      title: '事项' + seq,
      note: '备注' + seq,
      quad: 'q1',
      catId: 'cat1',
      done: false,
      remindAt: Date.now() + 5 * MIN,
      leadMin: 10,
      pushAt: Date.now(),
      pushed: false,
      pushedAt: null,
      pushOk: false,
      pushErr: '',
    },
    o
  );
  // 没设提醒时间 → pushAt 也得是 null（真库里 addItem 就是这么落的）。
  // 少了这一步，「remindAt: null 不该被捞到」那条断言会因为 pushAt 仍是
  // 「现在」而失败 —— 而且失败的原因和它想测的东西完全无关。
  if (noRemind) {
    d.remindAt = null;
    d.pushAt = null;
  }
  // 造「v8 之前的老数据」：leadMin 与 pushAt 两个字段**都不存在**（不是值为空）。
  // ⚠️ 必须真 delete：赋成 undefined 的话 hasOwnProperty 仍是 true，
  // _.exists(false) 就挑不到它了，回填用例会「因为挑不到而假装通过」。
  if (d.legacy) {
    delete d.legacy;
    delete d.leadMin;
    delete d.pushAt;
  }
  FC.COLLECTIONS.fq_items.push(d);
  return d;
}

function row(id) {
  return FC.COLLECTIONS.fq_items.filter(function (i) {
    return i._id === id;
  })[0];
}

function quotaOf(openid) {
  const d = FC.COLLECTIONS.fq_subs.filter(function (x) {
    return x._openid === openid;
  })[0];
  return d ? d.quota : null;
}

function revOf(fid) {
  const d = FC.COLLECTIONS.fq_family.filter(function (f) {
    return f._id === fid;
  })[0];
  return d ? d.rev : null;
}

// 每次下发的参数（假 SDK 记的就是 send 的入参本身）。
// 注意每次都重新读 —— reset() 会把 openapi.calls 整个换成新数组，
// 缓存一份的话后面所有用例都会看到空数组。
function calls() {
  return FC.openapi.calls.slice();
}

// 北京时间字符串，用 ICU 的时区库算 —— 与云函数里「手写 +8 再取 UTC」是
// 两条独立的路子。两边对上，才说明时区处理是对的；拿同一套算法自证没有意义。
function bjString(ts) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const g = {};
  parts.forEach(function (p) {
    g[p.type] = p.value;
  });
  return g.year + '-' + g.month + '-' + g.day + ' ' + (g.hour === '24' ? '00' : g.hour) + ':' + g.minute;
}

// 容器时区若是 UTC，直接取本地字段会得到这个 —— 用来做反向对照
function utcNaive(ts) {
  const d = new Date(ts);
  function p2(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  return (
    d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) +
    ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
  );
}

/* ---------------- 用例 ---------------- */

async function run() {
  console.log('\n[1] 到点的一条：扣 1 条额度、发 1 条、结果落库');
  {
    seed({ quota: 3 });
    const it = mkItem({ remindAt: Date.now() + 5 * MIN });

    const r = await fn.main();
    eq('返回信封是 ok', r.ok, true);
    eq('扫到 1 条', r.data.scanned, 1);
    eq('发出去 1 条', r.data.sent, 1);
    eq('真调了下发接口 1 次', calls().length, 1);
    eq('额度扣掉 1 条', quotaOf('openid-me'), 2);
    eq('事项标记为已处理', row(it._id).pushed, true);
    eq('事项标记为发送成功', row(it._id).pushOk, true);
    eq('错误信息为空', row(it._id).pushErr, '');
    ok('落了一次处理时间', !!row(it._id).pushedAt);
    eq('家庭版本被推了一格（界面上的未送达计数要跟着刷）', revOf('fam1'), 1);

    // 收件人就是条目创建者，不做全家广播
    eq('收件人是条目的创建者', calls()[0].touser, 'openid-me');
    eq('用的是模板「待办事项提醒」', calls()[0].templateId, TPL);
    eq('点通知跳体验版（没发布正式版时必须这么设）', calls()[0].miniprogramState, 'trial');
    eq('点通知落在首页', calls()[0].page, 'pages/index/index');
  }

  console.log('\n[2] 去重：定时触发器会重复触发，同一条只能发一次');
  {
    seed({ quota: 3 });
    const it = mkItem({ remindAt: Date.now() + 5 * MIN });

    const first = await fn.main();
    const second = await fn.main();
    eq('第一轮发了 1 条', first.data.sent, 1);
    // 这一条才是真正有判别力的断言：去重要是失效，第二轮会扫到 1 条并再发一次
    eq('第二轮一条候选都扫不到', second.data.scanned, 0);
    eq('第二轮一条都没发', second.data.sent, 0);
    eq('全程只发了 1 次', calls().length, 1);
    eq('额度只扣了 1 次', quotaOf('openid-me'), 2);

    // 并发：两个实例同时被触发（这是官方明确说会发生的事）
    seed({ quota: 3 });
    const it2 = mkItem({ remindAt: Date.now() + 5 * MIN });
    const both = await Promise.all([fn.main(), fn.main()]);
    const totalSent = both[0].data.sent + both[1].data.sent;
    eq('两个实例并发 → 合计也只发 1 条', totalSent, 1);
    eq('并发下也只发 1 次接口', calls().length, 1);
    eq('额度只扣 1 条', quotaOf('openid-me'), 2);
    eq('事项只被处理一次', row(it2._id).pushed, true);
  }

  console.log('\n[3] 额度不足：不发、记 no-quota、不留重试漩涡');
  {
    seed({ quota: 0 });
    const it = mkItem({ remindAt: Date.now() + 5 * MIN });

    const r = await fn.main();
    eq('一条都没发出去（接口压根没调）', calls().length, 0);
    eq('计入 no-quota', r.data.noQuota, 1);
    eq('sent 为 0', r.data.sent, 0);
    eq('额度不会变成负数', quotaOf('openid-me'), 0);
    eq('仍然标记为已处理（否则每分钟重试到天荒地老）', row(it._id).pushed, true);
    eq('记为未送达', row(it._id).pushOk, false);
    eq('原因可读', row(it._id).pushErr, 'no-quota');

    const again = await fn.main();
    eq('下一轮不会再捞它', again.data.scanned, 0);

    // 对照：把额度补上、但这条已经标成已处理了 —— 也不会重复发
    FC.COLLECTIONS.fq_subs[0].quota = 5;
    const after = await fn.main();
    eq('补了额度也不补发（这条已经过去了）', after.data.scanned, 0);
  }

  console.log('\n[4] 三类不该发的：已完成 / 未到窗口 / 没设提醒');
  {
    seed({ quota: 5 });
    mkItem({ remindAt: Date.now() + 5 * MIN, done: true });        // 做完了
    // 「还没到窗口」现在说的是 pushAt 还没到 —— remindAt 已经不参与发不发的判断
    mkItem({ remindAt: Date.now() + 30 * MIN, pushAt: Date.now() + 20 * MIN });
    mkItem({ remindAt: null });                                   // 没设提醒
    mkItem({ remindAt: null, pushed: true });                     // 没设提醒且已处理

    const r = await fn.main();
    eq('一条都没发', r.data.sent, 0);
    eq('一条候选都没扫到', r.data.scanned, 0);
    eq('额度没动', quotaOf('openid-me'), 5);
    eq('接口一次没调', calls().length, 0);

    // 对照：把「已完成」改成未完成，立刻就会进窗口 —— 证明上面挡住的确实是 done
    FC.COLLECTIONS.fq_items[0].done = false;
    const r2 = await fn.main();
    eq('改回未完成 → 立刻被扫到', r2.data.scanned, 1);
    eq('并且发了出去', r2.data.sent, 1);

    // 升级上来的老数据：压根没有 pushed 字段。
    // 查询条件必须写 _.neq(true) 而不是等值 false —— 后者挑不到「字段不存在」的
    // 文档，这批提醒会永远躺在库里发不出去，而且一点报错都没有。
    seed({ quota: 3 });
    const legacy = mkItem({ remindAt: Date.now() + 5 * MIN });
    delete legacy.pushed;
    delete legacy.pushOk;
    const r3 = await fn.main();
    eq('没有 pushed 字段的老事项照样被扫到', r3.data.scanned, 1);
    eq('照样能发出去', r3.data.sent, 1);
    eq('发完之后补上了 pushed', row(legacy._id).pushed, true);
  }

  console.log('\n[5] 窗口边界：差 1 分钟算迟到补发，差 10 分钟算过期不补');
  {
    seed({ quota: 5 });
    // 迟到容忍看的是 pushAt（该发的时刻过去多久），不是 remindAt
    const late = mkItem({ remindAt: Date.now() - MIN, pushAt: Date.now() - MIN });           // 刚过点 1 分钟 → 补发
    const old = mkItem({ remindAt: Date.now() - 10 * MIN, pushAt: Date.now() - 10 * MIN });  // 过点 10 分钟 → 过期

    const r = await fn.main();
    eq('刚过点的补发了', r.data.sent, 1);
    eq('早就过点的不补发', r.data.expired, 1);
    eq('只调了一次接口', calls().length, 1);
    eq('补发的那条是刚过点的', row(late._id).pushOk, true);
    eq('过期那条记为未送达', row(old._id).pushOk, false);
    eq('原因可读', row(old._id).pushErr, 'expired');
    eq('过期那条不会再被捞到', (await fn.main()).data.scanned, 0);
    eq('额度只扣了补发的那一条', quotaOf('openid-me'), 4);

    // ⚠️ 到期判据必须是 pushAt，不能退回 remindAt。
    // 一条「提前 30 天提醒」的事项：提醒时间还在一个月后，但它该发的时刻
    // 早就过去了。按 remindAt 判会说「还没到期」，然后**永远静默不发** ——
    // 这是把全局提前量改成逐条之后最容易被忽略的一处，光看 diff 看不出来。
    const far = mkItem({
      remindAt: Date.now() + 30 * 24 * HOUR,
      pushAt: Date.now() - 10 * MIN,
    });
    const r2 = await fn.main();
    eq('提醒时间在未来、但该发时刻已过 → 照样判过期', r2.data.expired, 1);
    eq('过期原因可读', row(far._id).pushErr, 'expired');
    eq('没有「因为提醒时间还没到」而静默不发', row(far._id).pushOk, false);
  }

  console.log('\n[6] 消息内容：五个槽一个都不能空');
  {
    seed({ quota: 3 });
    mkItem({
      title: '整理面试信息-鹏程九点',
      note: '面试宝典 BPM2 系列',
      quad: 'q3',
      remindAt: Date.now() + 5 * MIN,
    });

    await fn.main();
    const d = calls()[0].data;
    const keys = Object.keys(d).sort();
    eq('正好五个槽', keys, ['thing1', 'thing12', 'thing15', 'thing26', 'time23']);
    eq('事项名称 = 标题', d.thing26.value, '整理面试信息-鹏程九点');
    eq('事项类型 = 象限名', d.thing15.value, '重要不紧急');
    eq('备注消息 = 事项备注', d.thing12.value, '面试宝典 BPM2 系列');
    eq('事项主题 = 分类名', d.thing1.value, '工作');
    ok('提醒时间有值', !!d.time23.value);

    // 五个槽全非空是硬要求：勾了几个字段就得赋几个值，少一个整条消息 47003
    ok('没有任何空槽', keys.every(function (k) {
      return String(d[k].value || '').length > 0;
    }));
  }

  console.log('\n[7] 内容兜底：超长截断 / 备注为空 / 分类没了 / 象限异常');
  {
    seed({ quota: 6 });
    // pushAt 递增，为的是让 calls() 的顺序稳定：三条默认都取 Date.now()，
    // 同值排序结果不确定，而下面按 cs[0]/cs[1]/cs[2] 取，顺序一飘断言就整体错位。
    mkItem({ title: '这是一个特别特别特别长的待办事项标题超过二十个字了哦', note: '', remindAt: Date.now() + 5 * MIN, pushAt: Date.now() - 3 * MIN });
    mkItem({ title: 'B', note: '有备注', catId: 'cat-不见了', remindAt: Date.now() + 6 * MIN, pushAt: Date.now() - 2 * MIN });
    mkItem({ title: 'C', note: '有备注', quad: 'q9', remindAt: Date.now() + 7 * MIN, pushAt: Date.now() - 1 * MIN });

    await fn.main();
    const cs = calls().map(function (c) {
      return c.data;
    });
    const long = cs[0].thing26.value;
    eq('超 20 字按字符截断（含省略号正好 20）', Array.from(long).length, 20);
    eq('截断后带省略号', long.slice(-1), '…');
    eq('备注为空 → 填占位符，不留空槽', cs[0].thing12.value, '-');
    eq('分类查不到 → 填占位符', cs[1].thing1.value, '-');
    eq('象限值异常 → 回落到默认文案', cs[2].thing15.value, '重要且紧急');
  }

  console.log('\n[8] 时间格式：必须是北京时间的 YYYY-MM-DD HH:MM');
  {
    seed({ quota: 3 });
    // 夹具统一从一个**早于 main()** 的锚点出发，反推两个值：
    //   pushAt 必须是过去，否则 fetchDue 的 `pushAt <= now` 挑不到它；
    //   而「提醒时刻」= pushAt + 提前量又要是我们想验证的那个值。
    // ⚠️ 别写成 `pushAt: Date.now()` —— 它和 main() 之间隔着几毫秒，
    // 同值比较的结果就不确定了（v8 在 LATE_MS 边界上踩过同样的坑）。
    const t0 = Date.now() - 1000;
    const at = t0 + 5 * MIN;
    mkItem({ remindAt: at, leadMin: 5, pushAt: t0 });

    await fn.main();
    const got = calls()[0].data.time23.value;
    eq('与 ICU 时区库算出的北京时间一致', got, bjString(at));
    ok('格式符合模板要求', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(got));
    // 反向对照：容器时区若是 UTC，不补 8 小时就会得到这个 —— 断言两者不同，
    // 这条才真正钉住「时区被处理过」。用固定时间戳做一次确定性对照：
    eq('固定时间戳 2026-10-01T00:50Z → 北京 08:50', bjString(Date.UTC(2026, 9, 1, 0, 50)), '2026-10-01 08:50');
    ok('北京时间不是 UTC 裸值', got !== utcNaive(at));

    // ⚠️ v9：每天提醒的 remindAt 是**起点**（一直不动），pushAt 才是滚到今天的
    // 那个时刻。通知里必须用后者 —— 用 remindAt 会在 10 月 20 日那天告诉用户
    // 「提醒时间 10 月 15 日」，白白让人以为发错了。
    // 夹具故意把起点放在 40 天前，两者差得足够远，这条断言才有区分度。
    //
    // ⚠️ leadMin 必须取白名单里的档位。第一版这里写的是 3（"3 分钟"看着更顺眼），
    // 而 LEAD_ALLOWED 是 [-1,5,10,30,60,180,...] —— toLead(3) 会静默回落成
    // LEAD_DEFAULT=30，于是断言差了 27 分钟。测试红了半小时才定位到是**夹具**
    // 用了非法档位，而实现完全是对的。教训：夹具里的每一个枚举值都得是白的。
    const t1 = Date.now() - 1000;
    const at2 = t1 + 10 * MIN;
    const it2 = mkItem({ remindAt: at2 - 40 * 86400000, leadMin: 10, pushAt: t1, repeat: 1 });
    await fn.main();
    const lastCall = calls()[calls().length - 1];
    eq('每天提醒的通知里显示的是本次时刻，不是起点',
       lastCall.data.time23.value, bjString(at2));
    ok('确实不是那个 40 天前的起点', lastCall.data.time23.value !== bjString(row(it2._id).remindAt));
  }

  console.log('\n[9] 一条提醒 = 一条额度：额度先到先用，用完就停');
  {
    seed({ quota: 2 });
    // 「先到先发」看的是 pushAt（不再是 remindAt）。三条显式错开 ——
    // 默认值都是 Date.now()，谁先谁后取决于排序对同值的处理，那是随机的。
    //
    // ⚠️ 刻意让两个字段的**顺序相反**：A 的 pushAt 最早、remindAt 却最晚。
    // 早先三条是同向递增的，结果把 orderBy 从 pushAt 改回 remindAt 也得到
    // 同样的发出顺序 —— 这条断言成了摆设。变异验证实测抓到了这一点。
    const a = mkItem({ title: 'A', remindAt: Date.now() + 3 * MIN, pushAt: Date.now() - 3 * MIN });
    const b = mkItem({ title: 'B', remindAt: Date.now() + 2 * MIN, pushAt: Date.now() - 2 * MIN });
    const c = mkItem({ title: 'C', remindAt: Date.now() + 1 * MIN, pushAt: Date.now() - 1 * MIN });

    const r = await fn.main();
    eq('3 条候选', r.data.scanned, 3);
    eq('额度 2 → 只发 2 条', r.data.sent, 2);
    eq('剩 1 条记未送达', r.data.noQuota, 1);
    eq('额度归零', quotaOf('openid-me'), 0);
    eq('按 pushAt 先到先发：A 发了', row(a._id).pushOk, true);
    eq('B 也发了', row(b._id).pushOk, true);
    eq('C 没发', row(c._id).pushOk, false);
    eq('C 的原因是可读的', row(c._id).pushErr, 'no-quota');
    eq('发了 2 次接口', calls().length, 2);
    eq('三条都被标成已处理（不会下轮重来）', FC.COLLECTIONS.fq_items.filter(function (i) {
      return i.pushed === true;
    }).length, 3);
  }

  console.log('\n[10] 下发被微信拒绝：记原因、不重试、不退还额度（已知取舍）');
  {
    seed({ quota: 3 });
    const it = mkItem({ remindAt: Date.now() + 5 * MIN });
    // 43101 = 用户拒绝接受消息（额度其实已经真被消耗掉了）
    FC.openapi.queue = [{ errCode: 43101, errMsg: 'user refuse to accept the msg' }];

    const r = await fn.main();
    eq('算作失败', r.data.failed, 1);
    eq('没算成功', r.data.sent, 0);
    eq('错误码落到文档上，便于排查', /43101/.test(row(it._id).pushErr), true);
    eq('没标成发送成功', row(it._id).pushOk, false);
    eq('额度照扣（微信那边其实已经消耗掉了，退了记账反而不准）', quotaOf('openid-me'), 2);
    eq('仍然标记为已处理', row(it._id).pushed, true);
    eq('下一轮不会重试', (await fn.main()).data.scanned, 0);
    eq('因此总共只调了 1 次接口', calls().length, 1);
  }

  console.log('\n[11] 跨用户 / 跨家庭：各扣各的额度、各推各的版本号');
  {
    seed({ quota: 2 });
    // 甲家的第二个人（同一个家庭，但额度是自己的）
    FC.COLLECTIONS.fq_members.push({ _id: 'm2', _openid: 'openid-wife', fid: 'fam1', role: 'member', active: true });
    FC.COLLECTIONS.fq_subs.push({ _id: 'sub2', _openid: 'openid-wife', quota: 1, lastGrantAt: 0 });
    mkItem({ title: '甲的事', _openid: 'openid-me', remindAt: Date.now() + 1 * MIN });
    mkItem({ title: '妻的事', _openid: 'openid-wife', remindAt: Date.now() + 2 * MIN });
    // 另起一个家庭，没有账本
    FC.COLLECTIONS.fq_family.push({ _id: 'fam2', name: '别人家', ownerOpenid: 'openid-other', rev: 5 });
    FC.COLLECTIONS.fq_categories.push({ _id: 'cat2', fid: 'fam2', _openid: 'openid-other', name: '生活', order: 0 });
    mkItem({ title: '没额度的人', _openid: 'openid-other', fid: 'fam2', catId: 'cat2', remindAt: Date.now() + 3 * MIN });

    const r = await fn.main();
    eq('三条候选', r.data.scanned, 3);
    eq('发了 2 条', r.data.sent, 2);
    eq('1 条没额度', r.data.noQuota, 1);
    eq('甲的额度扣成 1', quotaOf('openid-me'), 1);
    eq('妻的额度扣成 0', quotaOf('openid-wife'), 0);
    eq('没账本的人不会凭空多出账本', FC.COLLECTIONS.fq_subs.length, 2);
    eq('收件人跟着条目的创建者走', calls().map(function (c) {
      return c.touser;
    }).sort(), ['openid-me', 'openid-wife']);
    eq('甲家的 rev 推一格', revOf('fam1'), 1);
    eq('别人家的 rev 也推了一格（那边有未送达要显示）', revOf('fam2'), 6);
  }

  console.log('\n[12] 契约：触发器配置与模板常量');
  {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    ok('config.json 声明了 subscribeMessage.send 的云调用权限', (cfg.permissions.openapi || []).indexOf('subscribeMessage.send') >= 0);
    eq('只申请了一个权限（权限最小化）', cfg.permissions.openapi.length, 1);
    eq('配了一个定时触发器', cfg.triggers.length, 1);
    eq('触发器类型是 timer', cfg.triggers[0].type, 'timer');
    // 七段式：秒 分 时 日 月 星期 年。每分钟第 0 秒跑一次
    eq('cron 是每分钟第 0 秒', cfg.triggers[0].config, '0 * * * * * *');
    eq('cron 是七段', cfg.triggers[0].config.split(' ').length, 7);

    const remindSrc = fs.readFileSync(FN_PATH, 'utf8');
    const todoSrc = fs.readFileSync(FQ_TODO_PATH, 'utf8');
    const remindTpl = /const TEMPLATE_ID = '([^']+)'/.exec(remindSrc)[1];
    const todoTpl = /const SUB_TEMPLATE_ID = '([^']+)'/.exec(todoSrc)[1];
    eq('两个云函数用的是同一个模板 id', remindTpl, todoTpl);
    eq('模板 id 就是后台申请到的那个', remindTpl, TPL);

    // 5 个槽的 key 必须逐字出现在代码里。编号毫无规律（26/15/12/1/23），
    // 照常规推测写成 thing1~thing5 的话，5 个字段会全部对不上、每条消息 47003
    ['thing26', 'thing15', 'thing12', 'thing1', 'time23'].forEach(function (k) {
      ok('消息里用到槽位 ' + k, remindSrc.indexOf(k + ':') >= 0);
    });

    ok('体验期指向 trial', /const MINI_STATE = 'trial'/.test(remindSrc));

    // ---- v8：提前量从「一个全局常量」变成「每条各存一个」 ----
    // 先钉全局常量的消失：剥掉注释再找（注释里提到历史不算，留着那句解释是对的）。
    ok('不再有全局提前量常量', !/LEAD_MS/.test(remindSrc.replace(/\/\/[^\n]*/g, '')));

    // ⚠️ 同一份枚举抄了三遍（fqTodo / fqRemind / utils/const.js）—— 云函数不能
    // require 客户端代码，两个云函数之间也不共享。抄三遍的地方必须有守卫：
    // 漏改一处的表现是「界面能选、云端不认」，而白名单写法会把它**静默**丢掉。
    const clientConst = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/const.js'), 'utf8');
    const allowedOf = function (src) {
      const m = /const LEAD_ALLOWED = \[([^\]]+)\]/.exec(src);
      return m ? m[1].replace(/\s+/g, '') : null;
    };
    const remindLead = allowedOf(remindSrc);
    const todoLead = allowedOf(todoSrc);
    // ⚠️ 只在 LEAD_OPTIONS 块里抽，不能全文匹配 —— v9 新增的 REPEAT_OPTIONS
    // 是同样的 `{ v: ..., label: ... }` 形状，全文匹配会把 0 / 1 混进来，
    // 于是「客户端枚举与云端白名单一致」会把正确的代码判红。
    const leadBlock = /const LEAD_OPTIONS = \[([\s\S]*?)\n\];/.exec(clientConst);
    ok('能从 utils/const.js 里抽出 LEAD_OPTIONS 块', !!leadBlock);
    const clientLead = (leadBlock[1].match(/\{ v: (-?\d+), label:/g) || [])
      .map(function (s) {
        return /(-?\d+)/.exec(s)[1];
      })
      .join(',');

    ok('fqRemind 里有提前量白名单', !!remindLead);
    eq('fqTodo 与 fqRemind 的白名单逐字相同', todoLead, remindLead);
    eq('客户端枚举与云端白名单一致', clientLead, remindLead);
    ok('白名单第一项是「不提醒」哨兵 -1', remindLead.indexOf('-1') === 0);
    ok(
      '默认提前量三处都是 30',
      /const LEAD_DEFAULT = 30/.test(remindSrc) &&
        /const LEAD_DEFAULT = 30/.test(todoSrc) &&
        /const LEAD_DEFAULT = 30/.test(clientConst)
    );

    // 推送时刻必须是「预算好落库」的：fqRemind 只按 pushAt 扫，且到期判据也用它。
    // 这两条一起被改掉，才会出现「提前 7 天的事按提醒时间判、说自己还没到期」。
    ok('fqRemind 按 pushAt 扫', /pushAt: _\.and\(_\.gt\(0\), _\.lte\(now\)\)/.test(remindSrc));
    ok('fqRemind 的到期判据用 pushAt', /const at = Number\(it\.pushAt\)/.test(remindSrc));
    ok('fqTodo 预算 pushAt', /pushAt: toPushAt\(/.test(todoSrc));

    // ---- v9：提醒周期，同样抄了三份 ----
    // ⚠️ 这三份与上面 LEAD_OPTIONS 是同一类风险，但**方向相反**：提前量漏改一处
    // 是「界面能选、云端不认」（静默丢掉）；周期漏改一处是「界面选每天、
    // 云端按一次处理」（用户第二天发现不响）或者反过来的「云端每天发、
    // 界面显示仅一次」（额度被悄悄烧掉）。两种都不可见，所以必须有个守卫。
    const repeatBlock = /const REPEAT_OPTIONS = \[([\s\S]*?)\n\];/.exec(clientConst);
    ok('能从 utils/const.js 里抽出 REPEAT_OPTIONS 块', !!repeatBlock);
    const clientRepeat = (repeatBlock[1].match(/\{ v: (-?\d+), label:/g) || [])
      .map(function (s) {
        return /(-?\d+)/.exec(s)[1];
      })
      .join(',');
    eq('客户端周期枚举就是 0 / 1', clientRepeat, '0,1');
    eq('客户端默认周期是 0（只提醒一次）', /const REPEAT_DEFAULT = 0/.test(clientConst), true);

    const todoRepeat = /const REPEAT_DAILY = (\d+);/.exec(todoSrc);
    const remindRepeat = /const REPEAT_DAILY = (\d+);/.exec(remindSrc);
    ok('fqTodo 有 REPEAT_DAILY', !!todoRepeat);
    ok('fqRemind 有 REPEAT_DAILY', !!remindRepeat);
    eq('两个云函数的 REPEAT_DAILY 一致', todoRepeat[1], remindRepeat[1]);
    eq('云端的 REPEAT_DAILY 就是客户端枚举里的「每天」那一项', todoRepeat[1], clientRepeat.split(',')[1]);

    // 每天模式的提前量上限：只有**写入方**（fqTodo）需要它，fqRemind 有意不设。
    // 这条把「有意不设」钉成断言，免得以后有人为了「对称」在 fqRemind 里也加一份，
    // 那就是第四个要同步的常量了 —— 而它永远用不上。
    eq(
      '每天模式提前量上限两处都是 180',
      /const LEAD_DAILY_MAX = 180/.test(clientConst) && /const LEAD_DAILY_MAX = 180/.test(todoSrc),
      true
    );
    ok('fqRemind 里没有这个常量（有意：夹取只发生在写入方）', !/LEAD_DAILY_MAX/.test(remindSrc.replace(/\/\/[^\n]*/g, '')));
  }

  console.log('\n[13] 老数据回填：v8 之前的事项没有 pushAt，第一轮就得补上');
  {
    seed({ quota: 5 });
    // 老数据的样子：leadMin 与 pushAt **两个字段都不存在**。
    // 不补的话这批提醒一条都发不出去 —— 而用户根本不会知道自己有提醒失效了。
    const legacy = mkItem({ remindAt: Date.now() + 28 * MIN, legacy: true });
    eq('前提：夹具确实没有 pushAt', 'pushAt' in legacy, false);
    eq('前提：夹具确实没有 leadMin', 'leadMin' in legacy, false);

    const r = await fn.main();
    eq('上报回填了 1 条', r.data.backfilled, 1);
    eq('补上默认提前量 30 分钟', row(legacy._id).leadMin, 30);
    eq(
      '补出的 pushAt = 提醒时间 - 30 分钟',
      row(legacy._id).pushAt,
      row(legacy._id).remindAt - 30 * 60000
    );
    // 28 分钟后的提醒 + 提前 30 分钟 → 该发的时刻是 2 分钟前，正落在迟到容忍内
    eq('同一条顺手就发出去了', row(legacy._id).pushOk, true);

    const r2 = await fn.main();
    eq('第二轮不再重复回填', r2.data.backfilled, 0);
  }

  console.log('\n[14] 「不提醒」的条目：不回填、也不进推送候选');
  {
    seed({ quota: 5 });
    // 新数据：leadMin = -1、pushAt = null（字段存在、值为空）。
    // 这段守的是「它既不会被回填、也不会被当成候选发出去」。
    //
    // ⚠️ 别把这条当成「回填判据必须是 leadMin」的守卫 —— 实测区分不了：
    // 新数据的 pushAt 字段总在（要么数字、要么 null），老数据两个字段都缺，
    // 换判据挑出的是同一批文档。判据选 leadMin 更严谨，但那是设计选择，
    // 不是这条断言守得住的东西。详见 .workbuddy/tmp/mutate-lead.js 里的说明。
    mkItem({ remindAt: Date.now() + 5 * MIN, leadMin: -1, pushAt: null });

    const r = await fn.main();
    eq('没有被回填', r.data.backfilled, 0);
    eq('也不会被当成推送候选', r.data.scanned, 0);
    eq('额度没动', quotaOf('openid-me'), 5);
    eq('接口没调', calls().length, 0);
  }

  console.log('\n[15] v9「每天提醒」：发完滚到明天、去重换 pushAt、失败也照滚');
  {
    const DAY = 24 * 60 * MIN;
    const t = Date.now() - 1000;

    /* (a) 到点：发一条，pushAt 往后滚一天，pushed 保持未处理态 */
    seed({ quota: 5 });
    const d1 = mkItem({ remindAt: t + 10 * MIN, leadMin: 10, pushAt: t, repeat: 1 });
    let r = await fn.main();
    eq('每天提醒到点 → 照常发出去', r.data.sent, 1);
    eq('不算过期', r.data.expired, 0);
    eq('也不算「已滚」（这次是真发了）', r.data.rolled, 0);
    eq('pushAt 滚到明天同一时刻', row(d1._id).pushAt, t + DAY);
    // ⚠️ 这是「每天提醒」与普通提醒**行为上唯一的区别**：pushed 必须留在未处理态，
    // 下一轮 tick 还要再发它。写成 true 的话它只响一次就永远安静了 ——
    // 而且用户看不出哪里出了错（他会以为是自己没设对）。
    eq('pushed 保持未处理态（明天还要再发）', row(d1._id).pushed, false);
    ok('留下了处理时间', !!row(d1._id).pushedAt);

    /* (b) 紧接着再来一轮：pushAt 已经在未来，挑不到 */
    r = await fn.main();
    eq('同一分钟内不会再发一次', r.data.scanned, 0);
    eq('全程只调了 1 次接口', calls().length, 1);
    eq('额度只扣了 1 条', quotaOf('openid-me'), 4);

    /* (c) 滚动要一次跳到「严格大于 now」，不是每轮 +1 天慢慢追 */
    seed({ quota: 3 });
    const start = t - 40 * DAY;
    const stale = mkItem({ remindAt: t + 10 * MIN, leadMin: 10, pushAt: start, repeat: 1 });
    r = await fn.main();
    eq('停了 40 天的每天提醒：算「已滚」，不算「未送达」', r.data.rolled, 1);
    eq('不算过期', r.data.expired, 0);
    // 记成 expired 会让「我的」页显示一条**根本没发生过**的失败，用户会去查手机通知设置。
    eq('不记未送达', row(stale._id).pushErr, '');
    eq('本轮不发（滚不是补发）', r.data.sent, 0);
    const rolled = row(stale._id).pushAt;
    ok('一次就跳到未来', rolled > Date.now());
    ok('落点与起点同相位（相差整天，不是「现在 + 1 天」）', (rolled - start) % DAY === 0);
    eq('恰好跳到下一个整天（不是跳两个）', rolled, start + 41 * DAY);
    eq('滚完也不该被同一轮再捞一次', (await fn.main()).data.scanned, 0);

    /* (d) 额度不足也要滚：否则补上额度之后它还停在原地 */
    seed({ quota: 0 });
    const nq = mkItem({ remindAt: t + 10 * MIN, leadMin: 10, pushAt: t, repeat: 1 });
    r = await fn.main();
    eq('没额度 → 记 no-quota', r.data.noQuota, 1);
    eq('原因落到文档上', row(nq._id).pushErr, 'no-quota');
    eq('pushAt 照样往后滚（明天还有机会）', row(nq._id).pushAt, t + DAY);

    /* (e) 发送失败也要滚 —— 三条路（过期 / 正常 / 失败）一条都不能漏 */
    seed({ quota: 3 });
    FC.openapi.queue = [{ errCode: 43101, errMsg: 'user refuse to accept the msg' }];
    const bad = mkItem({ remindAt: t + 10 * MIN, leadMin: 10, pushAt: t, repeat: 1 });
    r = await fn.main();
    eq('发送失败计入 failed', r.data.failed, 1);
    eq('失败也照滚，不会每分钟重试到天荒地老', row(bad._id).pushAt, t + DAY);

    /* (f) 反向对照：「仅一次」不能被同一轮改动带歪 */
    seed({ quota: 3 });
    const once = mkItem({ remindAt: t + 10 * MIN, leadMin: 10, pushAt: t });
    r = await fn.main();
    eq('「仅一次」照旧只发一次', row(once._id).pushed, true);
    eq('pushAt 原地不动（没被误当成每天）', row(once._id).pushAt, t);

    /* (g) ⚠️ 并发去重：这是本轮最会咬人的一条
     * 普通提醒靠「写入 pushed: true」去重 —— 那个条件在写入之后就不成立了。
     * 每天提醒**不能**写 pushed: true（下一轮还要发），于是条件在写入前后**都成立**，
     * 两条并发实例会双双拿到 updated: 1：同一件事推两遍，额度也扣两份。
     * 所以去重改由 pushAt 当版本号承担 —— 把刚读到的旧 pushAt 写进 where。
     * 少了那个条件，这条断言就红。 */
    seed({ quota: 5 });
    const cd = mkItem({ remindAt: t + 10 * MIN, leadMin: 10, pushAt: t, repeat: 1 });
    const both = await Promise.all([fn.main(), fn.main()]);
    eq('并发两实例合计只发 1 条', both[0].data.sent + both[1].data.sent, 1);
    eq('只调了 1 次接口', calls().length, 1);
    eq('额度只扣 1 条', quotaOf('openid-me'), 4);
    eq('pushAt 只滚了一次（滚两次就跳到后天了）', row(cd._id).pushAt, t + DAY);
    eq('仍然是未处理态', row(cd._id).pushed, false);
  }

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

run().catch(function (err) {
  console.log('\n✗ 测试自身抛异常: ' + ((err && err.stack) || err));
  process.exit(1);
});
