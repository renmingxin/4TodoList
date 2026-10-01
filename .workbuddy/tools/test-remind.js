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

function mkItem(over) {
  seq++;
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
      pushed: false,
      pushedAt: null,
      pushOk: false,
      pushErr: '',
    },
    over || {}
  );
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
    mkItem({ remindAt: Date.now() + 30 * MIN });                  // 还没到 10 分钟窗口
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
    const late = mkItem({ remindAt: Date.now() - MIN });      // 刚过点 1 分钟 → 补发
    const old = mkItem({ remindAt: Date.now() - 10 * MIN });  // 过点 10 分钟 → 过期

    const r = await fn.main();
    eq('刚过点的补发了', r.data.sent, 1);
    eq('早就过点的不补发', r.data.expired, 1);
    eq('只调了一次接口', calls().length, 1);
    eq('补发的那条是刚过点的', row(late._id).pushOk, true);
    eq('过期那条记为未送达', row(old._id).pushOk, false);
    eq('原因可读', row(old._id).pushErr, 'expired');
    eq('过期那条不会再被捞到', (await fn.main()).data.scanned, 0);
    eq('额度只扣了补发的那一条', quotaOf('openid-me'), 4);
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
    mkItem({ title: '这是一个特别特别特别长的待办事项标题超过二十个字了哦', note: '', remindAt: Date.now() + 5 * MIN });
    mkItem({ title: 'B', note: '有备注', catId: 'cat-不见了', remindAt: Date.now() + 6 * MIN });
    mkItem({ title: 'C', note: '有备注', quad: 'q9', remindAt: Date.now() + 7 * MIN });

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
    const at = Date.now() + 5 * MIN;
    mkItem({ remindAt: at });

    await fn.main();
    const got = calls()[0].data.time23.value;
    eq('与 ICU 时区库算出的北京时间一致', got, bjString(at));
    ok('格式符合模板要求', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(got));
    // 反向对照：容器时区若是 UTC，不补 8 小时就会得到这个 —— 断言两者不同，
    // 这条才真正钉住「时区被处理过」。用固定时间戳做一次确定性对照：
    eq('固定时间戳 2026-10-01T00:50Z → 北京 08:50', bjString(Date.UTC(2026, 9, 1, 0, 50)), '2026-10-01 08:50');
    ok('北京时间不是 UTC 裸值', got !== utcNaive(at));
  }

  console.log('\n[9] 一条提醒 = 一条额度：额度先到先用，用完就停');
  {
    seed({ quota: 2 });
    const a = mkItem({ title: 'A', remindAt: Date.now() + 1 * MIN });
    const b = mkItem({ title: 'B', remindAt: Date.now() + 2 * MIN });
    const c = mkItem({ title: 'C', remindAt: Date.now() + 3 * MIN });

    const r = await fn.main();
    eq('3 条候选', r.data.scanned, 3);
    eq('额度 2 → 只发 2 条', r.data.sent, 2);
    eq('剩 1 条记未送达', r.data.noQuota, 1);
    eq('额度归零', quotaOf('openid-me'), 0);
    eq('按提醒时间先到先发：A 发了', row(a._id).pushOk, true);
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
    ok('提前量是 10 分钟', /const LEAD_MS = 10 \* 60 \* 1000/.test(remindSrc));
  }

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

run().catch(function (err) {
  console.log('\n✗ 测试自身抛异常: ' + ((err && err.stack) || err));
  process.exit(1);
});
