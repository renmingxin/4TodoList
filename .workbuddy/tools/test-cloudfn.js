// 云函数 fqTodo 的逻辑仿真测试
//
// 为什么要单独测它：云函数是**本地改完必须手动上传部署**的一份代码，
// 「本地对了、线上是旧包」和「本地本身就写错了」在模拟器里长得一模一样
// （都是那一条 toast）。这份测试直接把 fqTodo/index.js 加载进假数据库跑，
// 就能把这两种情况区分开 —— 它绿了，说明代码是对的，问题只在部署。
//
// 做法：拦截 require('wx-server-sdk')，换成一个内存实现的假 SDK。
// 假 SDK 只实现 fqTodo 真正用到的那几个方法，不做通用模拟。

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const FN_PATH = path.join(ROOT, 'cloudfunctions/fqTodo/index.js');

/* ---------------- 假云数据库 ---------------- */
// 假 SDK 已抽到 fake-cloud.js —— fqTodo 与 fqRemind 两份测试共用同一份实现，
// 免得查询语义（尤其是 _.neq 对「字段不存在」的处理）在两边漂移。
// 注意：必须在 require 云函数**之前** install，否则云函数拿到的是真 SDK。

const FC = require('./fake-cloud.js');
const COLLECTIONS = FC.COLLECTIONS;
const fn = FC.loadFunction(FN_PATH);

const call = function (event) {
  return fn.main(event);
};

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

function reset() {
  FC.reset();
}

function put(rows) {
  COLLECTIONS.fq_items = rows.map(function (r, i) {
    return Object.assign({ _id: 'i' + i, order: i * 10 }, r);
  });
  return COLLECTIONS.fq_items;
}

function items() {
  return COLLECTIONS.fq_items
    .slice()
    .sort(function (a, b) {
      return a.order - b.order;
    })
    .map(function (i) {
      return i._id + ':' + i.order + (i.quad ? ':' + i.quad : '');
    });
}

function byId(id) {
  return COLLECTIONS.fq_items.filter(function (i) {
    return i._id === id;
  })[0];
}

/* ---------------- 用例 ---------------- */

async function run() {
  const FN_VER = Number(/const FN_VER = (\d+)/.exec(fs.readFileSync(FN_PATH, 'utf8'))[1]);

  console.log('\n[1] reorder：只写提交的那几条，没提交的保持原样');
  {
    reset();
    put([
      { _openid: 'openid-me', title: 'a', quad: 'q1', catId: 'c1', done: false },
      { _openid: 'openid-me', title: 'b', quad: 'q1', catId: 'c1', done: false },
      { _openid: 'openid-me', title: 'c', quad: 'q1', catId: 'c1', done: false },
    ]);
    // 提交 2 条：客户端并不总是整段发，只发 order 真的变了的行
    const r = await call({
      action: 'reorder',
      items: [
        { id: 'i2', order: 0 },
        { id: 'i0', order: 10 },
      ],
    });
    eq('reorder 成功', r.ok, true);
    eq('回传更新条数（只改提交的 2 条）', r.data.updated, 2);
    eq('c 提到最前、a 退到第二', items(), ['i2:0:q1', 'i0:10:q1', 'i1:10:q1']);
    eq('没提交的 b 保持原 order（提交部分集也不会冲突）', byId('i1').order, 10);

    // 整段重排：这才是客户端拖动时的常规形态（该象限可见列表全部提交）
    const full = await call({
      action: 'reorder',
      items: [
        { id: 'i2', order: 0 },
        { id: 'i0', order: 10 },
        { id: 'i1', order: 20 },
      ],
    });
    eq('整段重排 → 0 / 10 / 20 干净排开', items(), ['i2:0:q1', 'i0:10:q1', 'i1:20:q1']);
    eq('整段重排更新 3 条', full.data.updated, 3);
  }

  console.log('\n[2] reorder：跨象限带 quad，顺带改象限');
  {
    reset();
    put([
      { _openid: 'openid-me', title: 'a', quad: 'q1', catId: 'c1', done: false },
      { _openid: 'openid-me', title: 'b', quad: 'q3', catId: 'c1', done: false },
    ]);
    await call({ action: 'reorder', items: [{ id: 'i0', order: 0, quad: 'q3' }] });
    eq('象限已搬到 q3', byId('i0').quad, 'q3');
    eq('order 已写入', byId('i0').order, 0);
  }

  console.log('\n[3] reorder：不带 quad 时不许动象限（避免误把事项挪走）');
  {
    reset();
    put([{ _openid: 'openid-me', title: 'a', quad: 'q1', catId: 'c1', done: false }]);
    await call({ action: 'reorder', items: [{ id: 'i0', order: 50 }] });
    eq('象限保持 q1', byId('i0').quad, 'q1');
    eq('order 已写入', byId('i0').order, 50);
  }

  console.log('\n[4] reorder：只认得本人的数据，别人的条目纹丝不动');
  {
    reset();
    put([
      { _openid: 'openid-me', title: 'mine', quad: 'q1', catId: 'c1', done: false },
      { _openid: 'openid-other', title: 'other', quad: 'q1', catId: 'c1', done: false },
    ]);
    const r = await call({
      action: 'reorder',
      items: [
        { id: 'i0', order: 90 },
        { id: 'i1', order: 90 },
      ],
    });
    eq('只有本人那条被更新', r.data.updated, 1);
    eq('本人的 order 变了', byId('i0').order, 90);
    eq('别人的 order 没动', byId('i1').order, 10);
  }

  console.log('\n[5] reorder：空数组 / 超上限 / 非法 id');
  {
    reset();
    put([{ _openid: 'openid-me', title: 'a', quad: 'q1', catId: 'c1', done: false }]);
    eq('空 items → updated 0', (await call({ action: 'reorder', items: [] })).data, { updated: 0 });
    eq('items 缺失 → updated 0', (await call({ action: 'reorder' })).data, { updated: 0 });
    eq('全是空 id → updated 0', (await call({ action: 'reorder', items: [{ id: '' }] })).data, { updated: 0 });

    const many = [];
    for (let i = 0; i < 201; i++) many.push({ id: 'x' + i, order: i });
    const over = await call({ action: 'reorder', items: many });
    eq('超过 200 条被拒', over.ok, false);
    eq('拒绝原因可读', over.msg, '一次最多重排 200 条');
  }

  console.log('\n[6] 未知 action：回包里带上云端版本号（本次事故的原文）');
  {
    reset();
    const r = await call({ action: 'reorder_typo' });
    eq('未识别的 action 返回 ok:false', r.ok, false);
    ok('msg 以「未知 action」开头', /^未知 action: reorder_typo/.test(r.msg));
    ok('msg 带上云端 FN_VER（v' + FN_VER + '）', r.msg.indexOf('v' + FN_VER) >= 0);
    ok('msg 给出「重新上传部署」的指引', r.msg.indexOf('重新上传部署') >= 0);
  }

  console.log('\n[7] bootstrap：握手信息 + 首屏种子');
  {
    reset();
    const r = await call({ action: 'bootstrap' });
    eq('bootstrap 成功', r.ok, true);
    eq('带 fnVer（客户端就是拿它握手的）', r.data.fnVer, FN_VER);
    ok('带 actions 清单', Array.isArray(r.data.actions) && r.data.actions.length >= 9);
    ok('actions 含 reorder —— 客户端拖动的出口', r.data.actions.indexOf('reorder') >= 0);

    eq('首次进入写入 2 个分类', r.data.categories.length, 2);
    eq('首次进入写入 5 条示例事项', r.data.items.length, 5);
    eq('分类顺序：工作 / 生活', r.data.categories.map((c) => c.name), ['工作', '生活']);
    ok('有一条带提醒时间', r.data.items.filter((i) => i.remindAt).length === 1);

    // 再进一次不该重复播种
    const again = await call({ action: 'bootstrap' });
    eq('二次进入不重复播种', again.data.items.length, 5);
    eq('二次进入分类数不变', again.data.categories.length, 2);
  }

  console.log('\n[8] addItem：分类归属二次校验');
  {
    reset();
    await call({ action: 'bootstrap' });
    const catId = COLLECTIONS.fq_categories[0]._id;

    const good = await call({
      action: 'addItem',
      item: { title: '写测试', catId: catId, quad: 'q2', priority: 1 },
    });
    eq('本人分类 → 成功', good.ok, true);
    ok('返回新 id', !!good.data._id);
    const created = COLLECTIONS.fq_items.filter((i) => i._id === good.data._id)[0];
    eq('落到 q2', created.quad, 'q2');
    eq('order 用 Date.now() 排到末尾', created.order > 1000, true);

    const bad = await call({
      action: 'addItem',
      item: { title: '偷写', catId: '别人的分类', quad: 'q1' },
    });
    eq('不存在的分类 → 拒绝', bad.ok, false);
    eq('拒绝原因可读', bad.msg, '分类不存在');

    const noCat = await call({ action: 'addItem', item: { title: 'x' } });
    eq('缺分类 → 拒绝', noCat.msg, '缺少分类');
  }

  console.log('\n[9] updateItem / bulk / clearDone：按 _openid 隔离');
  {
    reset();
    FC.OPENID = 'openid-me';
    put([
      { _openid: 'openid-me', title: 'mine', quad: 'q1', catId: 'c1', done: false },
      { _openid: 'openid-other', title: 'other', quad: 'q1', catId: 'c1', done: false },
    ]);

    const u = await call({ action: 'updateItem', id: 'i1', patch: { done: true } });
    eq('改别人的条目 → 一条都没改', u.data.updated, 0);

    const u2 = await call({ action: 'updateItem', id: 'i0', patch: { done: true } });
    eq('改自己的条目 → 成功', u2.data.updated, 1);
    ok('doneAt 已写入', byId('i0').doneAt && byId('i0').doneAt.__serverDate);

    const b = await call({ action: 'bulk', op: 'clearDone', quad: 'q1', catId: 'c1' });
    eq('清已完成只删自己的', b.data.removed, 1);
    eq('别人的仍在', COLLECTIONS.fq_items.length, 1);
    eq('剩下的是别人的', COLLECTIONS.fq_items[0]._openid, 'openid-other');

    const badOp = await call({ action: 'bulk', op: 'nope', quad: 'q1', catId: 'c1' });
    eq('未知批量操作被拒', badOp.msg, '未知批量操作: nope');
  }

  console.log('\n[10] 没有 OPENID 时一律拒绝（模拟调用链异常）');
  {
    reset();
    FC.OPENID = '';
    const r = await call({ action: 'bootstrap' });
    eq('无身份 → ok:false', r.ok, false);
    eq('无身份 → 提示可读', r.msg, '无法识别用户身份');
  }

  console.log('\n[11] 家庭：首次进入自动建默认家庭，并把老数据认领进来');
  {
    reset();
    // 老数据：有 _openid、没有 fid —— 这正是升级前线上库里的样子。
    // 这一步如果漏了，老用户升级后会看到空列表，以为数据丢了。
    put([
      { _openid: 'openid-me', title: '老事项 A', quad: 'q1', catId: 'c1', done: false },
      { _openid: 'openid-me', title: '老事项 B', quad: 'q2', catId: 'c1', done: false },
    ]);
    const r = await call({ action: 'bootstrap' });

    eq('bootstrap 成功', r.ok, true);
    eq('回包里带 family', !!r.data.family, true);
    eq('我是创建者', r.data.family.isOwner, true);
    eq('成员只有一个', r.data.family.memberCount, 1);
    eq('认领了 2 条老数据，没有另外播种', r.data.items.length, 2);
    eq('老数据都补上了 fid', COLLECTIONS.fq_items.every(function (i) { return !!i.fid; }), true);
    eq(
      '两条落在同一个家庭',
      COLLECTIONS.fq_items[0].fid === COLLECTIONS.fq_items[1].fid,
      true
    );
    eq('家庭表里正好一条', COLLECTIONS.fq_family.length, 1);
    eq('成员表里正好一条', COLLECTIONS.fq_members.length, 1);
    eq('成员记录是 active 的', COLLECTIONS.fq_members[0].active, true);
    eq('成员身份是 owner', COLLECTIONS.fq_members[0].role, 'owner');

    // 再进一次不该重复播种 / 不该又建一个家庭
    const again = await call({ action: 'bootstrap' });
    eq('二次进入不重复建家庭', COLLECTIONS.fq_family.length, 1);
    eq('二次进入事项数不变', again.data.items.length, 2);
  }

  console.log('\n[12] 越权：归属只认服务端解析出的 fid，客户端传 fid 必须被忽略');
  {
    reset();
    FC.OPENID = 'openid-a';
    await call({ action: 'bootstrap' });
    const fidA = COLLECTIONS.fq_family[0]._id;
    const catA = COLLECTIONS.fq_categories[0]._id;
    const itemA = COLLECTIONS.fq_items[0]._id;

    FC.OPENID = 'openid-b';
    await call({ action: 'bootstrap' });
    const fidB = COLLECTIONS.fq_family[1]._id;
    ok('两个家庭互不相同', fidA !== fidB);

    // 乙在请求里硬塞甲的 fid —— 云函数用的是管理员权限，
    // 一旦这里被入参左右，就等于任何人构造一个请求就能读写全部家庭。
    const bad = await call({ action: 'updateItem', id: itemA, patch: { title: '改掉甲' }, fid: fidA });
    eq('伪造型改别人的事项 → 一条都没改', bad.data.updated, 0);
    eq('甲的事项标题没被动', byId(itemA).title === '改掉甲', false);

    const badDel = await call({ action: 'removeItem', id: itemA, fid: fidA });
    eq('伪造 fid 删别人的事项 → 删不掉', badDel.data.removed, 0);

    const badAdd = await call({
      action: 'addItem',
      fid: fidA,
      item: { title: '塞进甲家', catId: catA, quad: 'q1' },
    });
    eq('用别人家的分类新建 → 被拒', badAdd.ok, false);
    eq('拒绝原因可读', badAdd.msg, '分类不存在');

    const badBulk = await call({ action: 'bulk', op: 'clearQuad', quad: 'q1', catId: catA, fid: fidA });
    eq('批量删别人家的象限 → 删不掉', badBulk.data.removed, 0);

    const mine = await call({ action: 'bootstrap' });
    eq('乙看到的仍是自己的家庭', mine.data.family.id, fidB);
    eq(
      '乙看不到甲的任何事项',
      mine.data.items.every(function (i) { return i.fid === fidB; }),
      true
    );
  }

  console.log('\n[13] 邀请码：生成 / 归一化 / 加入 / 复用 / 过期 / 权限');
  {
    reset();
    FC.OPENID = 'openid-a';
    const bootA = await call({ action: 'bootstrap' });
    const fidA = bootA.data.family.id;
    const catA = bootA.data.categories[0]._id;

    const inv = await call({ action: 'genInvite' });
    eq('创建者能生成邀请码', inv.ok, true);
    eq('码长 6 位', String(inv.data.inviteCode).length, 6);
    eq('只用易读字符（没有 0/O/1/I/L）', /^[2-9A-HJKMNP-Z]{6}$/.test(inv.data.inviteCode), true);
    ok('带 24 小时有效期', inv.data.inviteExpire > Date.now());
    ok('家庭文档里落了码', COLLECTIONS.fq_family[0].inviteCode === inv.data.inviteCode);

    FC.OPENID = 'openid-b';
    const bootB = await call({ action: 'bootstrap' });
    const fidB = bootB.data.family.id;

    const join = await call({
      action: 'joinFamily',
      code: ' ' + inv.data.inviteCode.toLowerCase() + ' ',
    });
    eq('小写带空格的码也能加入（两边都做归一化）', join.ok, true);
    eq('切到甲的家庭', join.data.fid, fidA);

    const after = await call({ action: 'bootstrap' });
    eq('乙现在看到的是甲的家庭', after.data.family.id, fidA);
    eq('乙看到的正是甲的数据', after.data.items.length, bootA.data.items.length);
    eq('乙不是创建者', after.data.family.isOwner, false);
    eq('乙拿不到邀请码（码只回给创建者）', after.data.family.inviteCode, '');
    eq('成员数是 2', after.data.family.memberCount, 2);

    // 加入之后真的能写对方的数据 —— 这才是整个需求的目的
    const add = await call({
      action: 'addItem',
      item: { title: '妻子加的一条', catId: catA, quad: 'q2' },
    });
    eq('成员能在家庭里新建事项', add.ok, true);
    FC.OPENID = 'openid-a';
    const aSees = await call({ action: 'sync', rev: -1 });
    ok(
      '甲能看到成员新增的这条',
      aSees.data.items.some(function (i) { return i.title === '妻子加的一条'; })
    );

    // 甲视角的成员列表
    const aView = await call({ action: 'bootstrap' });
    eq('甲看到 2 个成员', aView.data.family.memberCount, 2);
    eq('成员列表里恰好一个「我」', aView.data.family.members.filter(function (m) { return m.me; }).length, 1);
    eq('乙在甲的列表里显示为家人', aView.data.family.members.filter(function (m) { return !m.me; })[0].name, '家人');
    eq('家庭成员信息里不含 openid', JSON.stringify(aView.data.family).indexOf('openid-'), -1);

    // 刷新自己的显示名
    FC.OPENID = 'openid-b';
    const named = await call({ action: 'renameMember', name: '小明' });
    eq('改显示名成功', named.ok, true);

    FC.OPENID = 'openid-a';
    const aView2 = await call({ action: 'bootstrap' });
    eq(
      '甲看到的成员名跟着变了',
      aView2.data.family.members.filter(function (m) { return !m.me; })[0].name,
      '小明'
    );

    const dup = await call({ action: 'joinFamily', code: inv.data.inviteCode });
    eq('重复加入同一个家庭 → 友好拒绝', dup.ok, false);
    eq('拒绝原因可读', dup.msg, '你已经在这个家庭里了');

    const noSuch = await call({ action: 'joinFamily', code: 'ZZZZZZ' });
    eq('不存在的码被拒', noSuch.msg, '邀请码无效');

    const empty = await call({ action: 'joinFamily', code: '   ' });
    eq('空码被拒', empty.msg, '请输入邀请码');

    // 过期
    COLLECTIONS.fq_family.forEach(function (f) {
      if (f._id === fidA) f.inviteExpire = Date.now() - 1000;
    });
    FC.OPENID = 'openid-c';
    await call({ action: 'bootstrap' });
    const exp = await call({ action: 'joinFamily', code: inv.data.inviteCode });
    eq('过期码被拒', exp.ok, false);
    eq('拒绝原因可读', exp.msg, '邀请码已过期，请让对方重新生成');

    // 非创建者不能生成码
    FC.OPENID = 'openid-b';
    const cant = await call({ action: 'genInvite' });
    eq('成员不能生成邀请码', cant.ok, false);
    eq('拒绝原因可读', cant.msg, '只有家庭创建者可以生成邀请码');

    ok('乙自己那份家庭还留着（没被吞掉）', COLLECTIONS.fq_family.some(function (f) { return f._id === fidB; }));
  }

  console.log('\n[14] 退出家庭：回到自己的清单，谁的数据都没被删');
  {
    reset();
    FC.OPENID = 'openid-a';
    await call({ action: 'bootstrap' });
    const fidA = COLLECTIONS.fq_family[0]._id;
    const inv = await call({ action: 'genInvite' });
    const aItems = COLLECTIONS.fq_items.filter(function (i) { return i.fid === fidA; }).length;

    FC.OPENID = 'openid-b';
    await call({ action: 'bootstrap' });
    const fidB = COLLECTIONS.fq_family[1]._id;
    const bItems = COLLECTIONS.fq_items.filter(function (i) { return i.fid === fidB; }).length;

    await call({ action: 'joinFamily', code: inv.data.inviteCode });
    eq('加入后看甲的家', (await call({ action: 'bootstrap' })).data.family.id, fidA);

    const back = await call({ action: 'leaveFamily' });
    eq('退出成功', back.ok, true);
    eq('回到自己的家庭', back.data.fid, fidB);
    eq('回自己的家时标记为「回到自己的」', back.data.backToOwn, true);
    eq('首页确实切回来了', (await call({ action: 'bootstrap' })).data.family.id, fidB);
    eq('自己的事项一条没少', COLLECTIONS.fq_items.filter(function (i) { return i.fid === fidB; }).length, bItems);
    eq('甲的事项也一条没少', COLLECTIONS.fq_items.filter(function (i) { return i.fid === fidA; }).length, aItems);
    eq('两个家庭都还在', COLLECTIONS.fq_family.length, 2);

    // 退出后不能在甲家里写了
    FC.OPENID = 'openid-b';
    const catA = COLLECTIONS.fq_categories.filter(function (c) { return c.fid === fidA; })[0]._id;
    const noWrite = await call({ action: 'addItem', item: { title: '偷写', catId: catA, quad: 'q1' } });
    eq('退出后再往甲家写 → 被拒', noWrite.ok, false);
    eq('拒绝原因可读', noWrite.msg, '分类不存在');

    FC.OPENID = 'openid-a';
    const own = await call({ action: 'leaveFamily' });
    eq('创建者不能退出自己的家庭', own.ok, false);
    eq('拒绝原因可读', own.msg, '这是你自己的家庭，不能退出');
  }

  console.log('\n[15] 清空全部数据：共享之后只留给家庭创建者');
  {
    reset();
    FC.OPENID = 'openid-a';
    await call({ action: 'bootstrap' });
    const inv = await call({ action: 'genInvite' });

    FC.OPENID = 'openid-b';
    await call({ action: 'bootstrap' });
    await call({ action: 'joinFamily', code: inv.data.inviteCode });

    const before = COLLECTIONS.fq_items.length;
    const denied = await call({ action: 'clearAll' });
    eq('成员清空全家 → 被拒', denied.ok, false);
    eq('拒绝原因可读', denied.msg, '只有家庭创建者可以清空整个家庭的数据');
    eq('一条都没删', COLLECTIONS.fq_items.length, before);

    FC.OPENID = 'openid-a';
    const okAll = await call({ action: 'clearAll' });
    eq('创建者可以清空', okAll.ok, true);
    ok('事项被清空', okAll.data.removed > 0);
    ok('分类保留', COLLECTIONS.fq_categories.length > 0);
  }

  console.log('\n[16] 自动同步：rev 没变只回一个数字，变了才把数据带回来');
  {
    reset();
    FC.OPENID = 'openid-a';
    const boot = await call({ action: 'bootstrap' });
    const fidA = boot.data.family.id;
    const rev0 = boot.data.family.rev;
    eq('bootstrap 带回 rev', typeof rev0, 'number');

    const same = await call({ action: 'sync', rev: rev0 });
    eq('rev 一致 → changed:false', same.data.changed, false);
    eq('不带数据回来（省流量）', same.data.items, undefined);
    eq('rev 原样回传', same.data.rev, rev0);

    // 甲新建一条 → rev 必须前进
    const cat = boot.data.categories[0]._id;
    await call({ action: 'addItem', item: { title: '新事项', catId: cat, quad: 'q1' } });
    const famRow = COLLECTIONS.fq_family.filter(function (f) { return f._id === fidA; })[0];
    eq('写操作把 rev 推了一格', famRow.rev, rev0 + 1);

    const diff = await call({ action: 'sync', rev: rev0 });
    eq('rev 变了 → changed:true', diff.data.changed, true);
    ok('带回了数据', Array.isArray(diff.data.items) && diff.data.items.length > 0);
    eq('带回新的 rev', diff.data.rev, rev0 + 1);

    // 别人加入，也得能被察觉（成员数变了）
    const inv = await call({ action: 'genInvite' });
    const rev1 = COLLECTIONS.fq_family.filter(function (f) { return f._id === fidA; })[0].rev;
    FC.OPENID = 'openid-b';
    await call({ action: 'bootstrap' });
    await call({ action: 'joinFamily', code: inv.data.inviteCode });

    FC.OPENID = 'openid-a';
    const r2 = await call({ action: 'sync', rev: rev1 });
    eq('别人加入也推了 rev', r2.data.changed, true);
    eq('甲看到成员数变成 2', r2.data.family.memberCount, 2);

    // 成员改名同样要能被察觉
    const rev2 = r2.data.rev;
    FC.OPENID = 'openid-b';
    await call({ action: 'renameMember', name: '小明' });
    FC.OPENID = 'openid-a';
    const r3 = await call({ action: 'sync', rev: rev2 });
    eq('成员改名也推了 rev', r3.data.changed, true);
    eq('名字已更新', r3.data.family.members.filter(function (m) { return !m.me; })[0].name, '小明');
  }

  console.log('\n[17] 分类删除与改名：空删 / 转移 / 级联 / 兜底');
  {
    reset();
    FC.OPENID = 'openid-a';
    const boot = await call({ action: 'bootstrap' });
    const fidA = boot.data.family.id;
    const cWork = boot.data.categories[0]._id;
    const cLife = boot.data.categories[1]._id;
    const catRow = function (id) {
      return COLLECTIONS.fq_categories.filter(function (c) { return c._id === id; })[0];
    };
    const myCats = function () {
      return COLLECTIONS.fq_categories.filter(function (c) { return c.fid === fidA; });
    };

    // ---- 改名 ----
    const ren = await call({ action: 'renameCategory', id: cLife, name: '生活家' });
    eq('改名成功', ren.ok, true);
    eq('名字已写入', catRow(cLife).name, '生活家');

    const dup = await call({ action: 'renameCategory', id: cLife, name: '工作' });
    eq('改成同家庭已有的名字 → 被拒', dup.ok, false);
    eq('拒绝原因可读', dup.msg, '分类已存在');

    // 这条是在钉「查重不能误伤自己」：点开重命名、原样确定，不该报「已存在」
    const same = await call({ action: 'renameCategory', id: cLife, name: '生活家' });
    eq('改成自己原来的名字 → 放行', same.ok, true);

    const blank = await call({ action: 'renameCategory', id: cLife, name: '   ' });
    eq('空名字 → 被拒', blank.ok, false);

    // ---- 空分类：谁都能删，一次就完 ----
    const cEmpty = (await call({ action: 'addCategory', name: '空的' })).data._id;
    const delEmpty = await call({ action: 'removeCategory', id: cEmpty });
    eq('删空分类成功', delEmpty.ok, true);
    eq('回传删了 1 个分类', delEmpty.data.removed, 1);
    eq('没有连带删事项', delEmpty.data.deletedItems, 0);
    eq('分类确实没了', catRow(cEmpty), undefined);
    eq('其他分类没被波及', myCats().length, 2);

    // ---- 非空 + moveTo：事项换家，一条不丢 ----
    const cTmp = (await call({ action: 'addCategory', name: '临时' })).data._id;
    await call({ action: 'addItem', item: { title: '甲1', catId: cTmp, quad: 'q1' } });
    await call({ action: 'addItem', item: { title: '甲2', catId: cTmp, quad: 'q2' } });
    const beforeMove = COLLECTIONS.fq_items.length;

    const mv = await call({ action: 'removeCategory', id: cTmp, moveTo: cWork });
    eq('带 moveTo 删除成功', mv.ok, true);
    eq('回传搬走了 2 条', mv.data.moved, 2);
    eq('回传没删事项', mv.data.deletedItems, 0);
    eq('事项总数一条没变', COLLECTIONS.fq_items.length, beforeMove);
    eq('那 2 条已落到「工作」', COLLECTIONS.fq_items.filter(function (i) {
      return i.catId === cWork && (i.title === '甲1' || i.title === '甲2');
    }).length, 2);
    eq('分类本身没了', catRow(cTmp), undefined);

    // moveTo 指向不存在的分类 → 整件事都不做（不能删了分类却把事项留下）
    const cTmp2 = (await call({ action: 'addCategory', name: '临时2' })).data._id;
    await call({ action: 'addItem', item: { title: '乙1', catId: cTmp2, quad: 'q1' } });
    const badDest = await call({ action: 'removeCategory', id: cTmp2, moveTo: 'c-not-exist' });
    eq('moveTo 指向不存在的分类 → 被拒', badDest.ok, false);
    eq('拒绝原因可读', badDest.msg, '目标分类不存在');
    eq('分类还在（失败不留半截状态）', catRow(cTmp2) ? 1 : 0, 1);
    eq('那 1 条也还在原处', COLLECTIONS.fq_items.filter(function (i) { return i.catId === cTmp2; }).length, 1);

    // ---- 非空 + 不给 moveTo：连事项一起删（服务端自己数出来的，不靠客户端说） ----
    const cascade = await call({ action: 'removeCategory', id: cTmp2 });
    eq('级联删除成功', cascade.ok, true);
    eq('回传删了 1 条事项', cascade.data.deletedItems, 1);
    eq('那 1 条真的没了', COLLECTIONS.fq_items.filter(function (i) { return i.catId === cTmp2; }).length, 0);
    eq('分类也没了', catRow(cTmp2), undefined);

    // ---- 兜底：家里至少要留一个分类 ----
    eq('此时墙上还剩 2 个分类', myCats().length, 2);
    await call({ action: 'removeCategory', id: myCats()[0]._id });
    const lastOne = await call({ action: 'removeCategory', id: myCats()[0]._id });
    eq('删最后一个分类 → 被拒', lastOne.ok, false);
    eq('拒绝原因可读', lastOne.msg, '至少要保留一个分类');
    eq('确实还剩一个', myCats().length, 1);

    // ---- 伪造 id ----
    const noId = await call({ action: 'removeCategory' });
    eq('不给 id → 被拒', noId.ok, false);
    const ghost = await call({ action: 'removeCategory', id: 'c-ghost' });
    eq('不存在的分类 → 被拒', ghost.ok, false);
    eq('拒绝原因可读', ghost.msg, '分类不存在');
  }

  console.log('\n[18] 分类分权：成员能删到什么程度 / 跨家庭一律落空');
  {
    // ---- 同一家庭里：成员只能删空分类 ----
    reset();
    FC.OPENID = 'openid-a';
    await call({ action: 'bootstrap' });
    const inv = await call({ action: 'genInvite' });

    FC.OPENID = 'openid-b';
    await call({ action: 'bootstrap' });
    await call({ action: 'joinFamily', code: inv.data.inviteCode });

    // 乙现在在甲家。挑一个分类往里塞事项，让它变成「非空」
    const curFid = COLLECTIONS.fq_members.filter(function (m) {
      return m._openid === 'openid-b' && m.active;
    })[0].fid;
    const shared = COLLECTIONS.fq_categories.filter(function (c) {
      return c.fid === curFid;
    })[0]._id;
    await call({ action: 'addItem', item: { title: '家人录的', catId: shared, quad: 'q1' } });

    const memberDel = await call({ action: 'removeCategory', id: shared });
    eq('成员删非空分类 → 被拒', memberDel.ok, false);
    eq('拒绝原因可读', memberDel.msg, '只有家庭创建者可以删除还有事项的分类');
    eq('分类还在', COLLECTIONS.fq_categories.filter(function (c) { return c._id === shared; }).length, 1);

    const bEmpty = (await call({ action: 'addCategory', name: '乙建的空类' })).data._id;
    const bDel = await call({ action: 'removeCategory', id: bEmpty });
    eq('成员删自己建的空分类 → 放行', bDel.ok, true);

    // 成员能改名（和「新增分类」对称）
    const bRen = await call({ action: 'renameCategory', id: shared, name: '家人改的' });
    eq('成员改名 → 放行', bRen.ok, true);

    // ---- 跨家庭：乙用甲家的分类 id，一切落空 ----
    reset();
    FC.OPENID = 'openid-a';
    const bootA = await call({ action: 'bootstrap' });
    const fidA = bootA.data.family.id;
    const catA0 = bootA.data.categories[0]._id;
    const catA1 = bootA.data.categories[1]._id;

    FC.OPENID = 'openid-b';
    await call({ action: 'bootstrap' }); // 乙有自己的家，没有加入甲家

    const steal = await call({ action: 'removeCategory', id: catA0 });
    eq('乙删甲家的分类 → 被拒', steal.ok, false);
    eq('拒绝原因可读', steal.msg, '分类不存在');
    eq('甲家的分类一个没少', COLLECTIONS.fq_categories.filter(function (c) { return c.fid === fidA; }).length, 2);

    const stealRen = await call({ action: 'renameCategory', id: catA0, name: '被改了' });
    eq('乙改甲家的分类名 → 被拒', stealRen.ok, false);
    eq('甲家的名字没被动', COLLECTIONS.fq_categories.filter(function (c) { return c._id === catA0; })[0].name, '工作');

    // 乙往 moveTo 里塞甲家的分类 → 目标也不认（否则等于把事项送进别人家）
    const bCat = (await call({ action: 'addCategory', name: '乙的类' })).data._id;
    await call({ action: 'addItem', item: { title: '乙的事项', catId: bCat, quad: 'q1' } });
    const crossDest = await call({ action: 'removeCategory', id: bCat, moveTo: catA1 });
    eq('moveTo 指向别人家的分类 → 被拒', crossDest.ok, false);
    eq('拒绝原因可读', crossDest.msg, '目标分类不存在');
    eq('乙的分类还在', COLLECTIONS.fq_categories.filter(function (c) { return c._id === bCat; }).length, 1);
    eq('乙的事项也还在原处', COLLECTIONS.fq_items.filter(function (i) { return i.catId === bCat; }).length, 1);
  }

  console.log('\n[19] 订阅额度：记账 / 防连点 / 封顶 / 跨用户隔离');
  {
    const TPL = '1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM';
    reset();
    FC.OPENID = 'openid-a';
    const boot = await call({ action: 'bootstrap' });

    eq('bootstrap 带回 sub 信息', typeof boot.data.sub, 'object');
    eq('初始额度为 0', boot.data.sub.quota, 0);
    eq('初始未送达为 0', boot.data.sub.missed, 0);
    // 模板 id 只由服务端下发 —— 客户端硬编码一份的话，换模板时必然漏改
    eq('模板 id 由服务端下发', boot.data.sub.templateId, TPL);
    eq('action 清单里多了 grantSub', boot.data.actions.indexOf('grantSub') >= 0, true);
    eq('action 清单里多了 savePlan', boot.data.actions.indexOf('savePlan') >= 0, true);
    // 长度是**故意写死的绊线**：加了 action 就得来这里走一趟，顺手把新 action 的用例补上。
    eq('action 清单长度 19', boot.data.actions.length, 19);
    // 版本号的**绝对值**不写死 —— FN_VER 从云函数源码读（run() 顶部），
    // 这里只断言「bootstrap 上报的 === 源码声明的」：两边一起升才不会白握手。
    eq('握手版本与源码声明一致（v' + FN_VER + '）', boot.data.fnVer, FN_VER);

    // ---- 模板必须对得上 ----
    const wrong = await call({ action: 'grantSub', templateId: 'someone-elses-template' });
    eq('拿别的模板来记账 → 被拒', wrong.ok, false);
    eq('拒绝原因可读', wrong.msg, '模板不匹配');
    const none = await call({ action: 'grantSub' });
    eq('不带模板 id → 被拒', none.ok, false);
    eq('两次都没建账本', COLLECTIONS.fq_subs.length, 0);

    // ---- 正常记账 ----
    const g1 = await call({ action: 'grantSub', templateId: TPL });
    eq('第一次授权 → 额度 1', g1.data.quota, 1);
    eq('账本落了库', COLLECTIONS.fq_subs.length, 1);
    eq('账本上的 openid 由服务端填', COLLECTIONS.fq_subs[0]._openid, 'openid-a');

    // ---- 防连点：间隔太短，当没发生过 ----
    const fast = await call({ action: 'grantSub', templateId: TPL });
    eq('连点 → 不记账', fast.data.quota, 1);
    eq('连点被标记出来', fast.data.tooFast, true);
    eq('连点不报错（正当的快速保存不该弹错）', fast.ok, true);

    COLLECTIONS.fq_subs[0].lastGrantAt = Date.now() - 60000;
    const g2 = await call({ action: 'grantSub', templateId: TPL });
    eq('间隔够了 → 累加到 2', g2.data.quota, 2);

    // ---- 一次授权就是一条，客户端塞多少都不认 ----
    COLLECTIONS.fq_subs[0].lastGrantAt = Date.now() - 60000;
    const flood = await call({ action: 'grantSub', templateId: TPL, n: 999, count: 999, quota: 999 });
    eq('客户端塞 n=999 → 仍然只 +1', flood.data.quota, 3);

    // ---- 封顶 ----
    COLLECTIONS.fq_subs[0].quota = 50;
    COLLECTIONS.fq_subs[0].lastGrantAt = Date.now() - 60000;
    const cap = await call({ action: 'grantSub', templateId: TPL });
    eq('到顶后不再累加', cap.data.quota, 50);
    eq('回传标记已封顶', cap.data.capped, true);

    // ---- 跨用户隔离：额度是按人攒的，不是家庭资产 ----
    FC.OPENID = 'openid-b';
    const bootB = await call({ action: 'bootstrap' });
    eq('乙是另一个人 → 自己的额度从 0 起', bootB.data.sub.quota, 0);
    await call({ action: 'grantSub', templateId: TPL });
    eq('乙攒的额度不进甲的账', COLLECTIONS.fq_subs.filter(function (d) {
      return d._openid === 'openid-a';
    })[0].quota, 50);
    eq('两个账号各一条账本', COLLECTIONS.fq_subs.length, 2);
  }

  console.log('\n[20] 推送状态：新建落 false / 改提醒才复位 / 未送达不算错人');
  {
    reset();
    FC.OPENID = 'openid-a';
    const boot = await call({ action: 'bootstrap' });
    const catId = boot.data.categories[0]._id;

    const add = await call({
      action: 'addItem',
      item: { title: '带提醒的事', catId: catId, quad: 'q1', remindAt: Date.now() + 3600000 },
    });
    const it = byId(add.data._id);
    eq('新建事项带 pushed=false', it.pushed, false);
    eq('新建事项带 pushOk=false', it.pushOk, false);
    eq('新建事项带 pushedAt=null', it.pushedAt, null);

    // 模拟 fqRemind 已经处理过这一条（推送成功）
    it.pushed = true;
    it.pushOk = true;
    it.pushErr = '';
    const sameRemind = it.remindAt;

    await call({ action: 'updateItem', id: it._id, patch: { title: '改个标题', remindAt: sameRemind } });
    eq('只改标题、提醒没动 → 已推过的不重新排队', byId(it._id).pushed, true);

    await call({ action: 'updateItem', id: it._id, patch: { remindAt: sameRemind + 60000 } });
    eq('提醒时间变了 → pushed 复位', byId(it._id).pushed, false);
    eq('pushOk 也复位', byId(it._id).pushOk, false);
    eq('pushedAt 清空', byId(it._id).pushedAt, null);

    // 白名单之外：客户端直接塞这几个字段，一个字也不许写进去
    await call({
      action: 'updateItem',
      id: it._id,
      patch: { pushed: true, pushOk: true, pushErr: '伪造', pushedAt: 1 },
    });
    eq('客户端改不了 pushed', byId(it._id).pushed, false);
    eq('客户端改不了 pushOk', byId(it._id).pushOk, false);
    eq('客户端改不了 pushErr', byId(it._id).pushErr, '');

    // ---- 未送达计数 ----
    // 夹具照真库的形态给：被 fqRemind 处理过、但没送出去的那条，
    // pushErr 里一定留着原因（no-quota / expired / 错误码）。
    it.pushed = true;
    it.pushOk = false;
    it.pushErr = 'no-quota';
    const boot2 = await call({ action: 'bootstrap' });
    eq('没送出去的那条被计进 missed', boot2.data.sub.missed, 1);

    // ⚠️ v9：「每天提醒」的条目 pushed 必须**一直是未处理态**（下一轮 tick 还要
    // 再发它），所以未送达的判据不能挂在 pushed 上 —— 挂上去的话，额度耗尽时
    // 用户永远看不到提示，只会在某天自己发现「提醒怎么不响了」。
    it.pushed = false;
    const boot2b = await call({ action: 'bootstrap' });
    eq('每天提醒（pushed 仍为 false）没送出去也照样计数', boot2b.data.sub.missed, 1);

    it.pushed = true;
    it.pushOk = true;
    it.pushErr = '';
    const boot3 = await call({ action: 'bootstrap' });
    eq('送成功的从 missed 里消失', boot3.data.sub.missed, 0);

    it.pushOk = false;
    it.pushErr = 'no-quota';
    it.done = true;
    const boot4 = await call({ action: 'bootstrap' });
    eq('已完成的不算未送达', boot4.data.sub.missed, 0);

    // 种子事项一条都没被算进来（它们压根没有 pushed / pushErr 字段，
    // 而判据里的 pushed: _.exists(true) 挑不到「字段不存在」的文档）
    it.done = false;
    delete it.pushed;
    delete it.pushErr;
    const boot5 = await call({ action: 'bootstrap' });
    eq('没有 pushed 字段的老数据不误报未送达', boot5.data.sub.missed, 0);

    // ---- 别人家的失败不该算在我头上 ----
    it.pushed = true;
    it.pushOk = false;
    it.pushErr = 'no-quota';
    FC.OPENID = 'openid-b';
    const boot6 = await call({ action: 'bootstrap' });
    eq('别人没送达的不计进我的 missed', boot6.data.sub.missed, 0);
  }

  console.log('\n[21] 事项进度：progress 与 done 是同一条状态线');
  {
    reset();
    const boot0 = await call({ action: 'bootstrap' });
    const catId = boot0.data.categories[0]._id;

    // 种子事项也必须从 0% 起步 —— 少写这一处，「新库里的第一条事项」
    // 就成了整库里唯一没有 progress 的行。
    eq(
      '种子事项也带 progress（没有漏掉的行）',
      COLLECTIONS.fq_items.filter(function (r) { return typeof r.progress !== 'number'; }).length,
      0
    );

    const added = await call({
      action: 'addItem',
      item: { title: '给事项加进度', quad: 'q1', catId: catId, priority: 3 },
    });
    const id = added.data._id;
    eq('新建事项落库 progress = 0', byId(id).progress, 0);
    eq('新建事项未完成', byId(id).done, false);

    // ---- 客户端送 progress（拖进度条走这条）----
    await call({ action: 'updateItem', id: id, patch: { progress: 60 } });
    eq('送 60% → 落库 60', byId(id).progress, 60);
    eq('送 60% → 不算完成', byId(id).done, false);

    await call({ action: 'updateItem', id: id, patch: { progress: 100 } });
    eq('送 100% → 进度 100', byId(id).progress, 100);
    eq('送 100% → 自动成为已完成', byId(id).done, true);
    ok('完成时间被记下', byId(id).doneAt && byId(id).doneAt.__serverDate);
    eq('完成人由服务端填', byId(id).doneBy, 'openid-me');

    await call({ action: 'updateItem', id: id, patch: { progress: 99 } });
    eq('从 100% 拖回 99% → 自动撤销完成', byId(id).done, false);
    eq('撤销后进度停在 99（不是归零，也不是留 100）', byId(id).progress, 99);
    eq('撤销后完成时间清空', byId(id).doneAt, null);
    eq('撤销后完成人清空', byId(id).doneBy, '');

    // ---- 客户端只送 done（左滑的「完成 / 撤销」走这条，老版本客户端也只有这条）----
    await call({ action: 'updateItem', id: id, patch: { done: true } });
    eq('只送 done:true → 进度补齐到 100（不留「完成但 60%」的矛盾行）', byId(id).progress, 100);
    await call({ action: 'updateItem', id: id, patch: { done: false } });
    eq('撤销 → 进度归零（保留 100% 等于没撤销）', byId(id).progress, 0);

    // ---- 边界与脏数据 ----
    await call({ action: 'updateItem', id: id, patch: { progress: 150 } });
    eq('150% 夹到 100', byId(id).progress, 100);
    eq('夹到 100 之后自然算完成', byId(id).done, true);
    await call({ action: 'updateItem', id: id, patch: { progress: -5 } });
    eq('-5% 夹到 0', byId(id).progress, 0);
    await call({ action: 'updateItem', id: id, patch: { progress: 72.6 } });
    eq('小数落到整数（拖动的每一帧都是小数）', byId(id).progress, 73);
    await call({ action: 'updateItem', id: id, patch: { progress: 'abc' } });
    eq('非数字落 0，不是 NaN', byId(id).progress, 0);

    // ---- 自相矛盾的一对 ----
    await call({ action: 'updateItem', id: id, patch: { progress: 60, done: true } });
    eq('矛盾输入以 done 为准：进度补到 100', byId(id).progress, 100);
    eq('矛盾输入以 done 为准：确实完成', byId(id).done, true);

    // ---- 不变量本身 ----
    // 逐条断言容易漏掉某条路径；这里直接把整库拉出来验「done ⟺ progress===100」。
    await call({ action: 'updateItem', id: id, patch: { progress: 30 } });
    const bad = COLLECTIONS.fq_items.filter(function (r) {
      return !!r.done !== (r.progress === 100);
    });
    eq('全库没有「已完成但进度不满 / 进度满却未完成」的行', bad.length, 0);

    // ---- 批量路径不能成为破口（markAllDone 绕过 updateItem）----
    await call({ action: 'bulk', op: 'markAllDone', quad: 'q1', catId: catId });
    const still = COLLECTIONS.fq_items.filter(function (r) {
      return r.quad === 'q1' && (!r.done || r.progress !== 100);
    });
    eq('批量标记完成 → 进度一并补到 100', still.length, 0);
  }

  console.log('\n[22] 提前提醒时长：白名单 / pushAt 预算 / 改它也要复位');
  {
    reset();
    FC.OPENID = 'openid-a';
    const boot = await call({ action: 'bootstrap' });
    const catId = boot.data.categories[0]._id;
    const DAY_MS = 24 * 3600 * 1000;

    // ---- 默认值：不传就是 30 分钟，pushAt 由它算出来 ----
    {
      const add = await call({
        action: 'addItem',
        item: { title: '默认提前量', catId: catId, quad: 'q1', remindAt: Date.now() + 10 * DAY_MS },
      });
      const it = byId(add.data._id);
      eq('不传 leadMin → 落默认 30 分钟', it.leadMin, 30);
      eq('pushAt = 提醒时间 - 30 分钟', it.pushAt, it.remindAt - 30 * 60000);
    }

    // ---- 十个档位一个一个走一遍，确保白名单没有把哪一档排除了 ----
    {
      const vals = [-1, 5, 10, 30, 60, 180, 1440, 4320, 10080, 43200];
      for (let i = 0; i < vals.length; i++) {
        const add = await call({
          action: 'addItem',
          item: {
            title: '档位' + vals[i],
            catId: catId,
            quad: 'q1',
            remindAt: Date.now() + 400 * DAY_MS,
            leadMin: vals[i],
          },
        });
        eq('白名单档位 ' + vals[i] + ' 原样落库', byId(add.data._id).leadMin, vals[i]);
      }
    }

    // ---- 「不提醒」：pushAt 落 null，fqRemind 的 _.gt(0) 自然挑不到 ----
    {
      const add = await call({
        action: 'addItem',
        item: { title: '不提醒', catId: catId, quad: 'q1', remindAt: Date.now() + 5 * DAY_MS, leadMin: -1 },
      });
      const it = byId(add.data._id);
      eq('选了不提醒 → leadMin = -1', it.leadMin, -1);
      eq('选了不提醒 → pushAt 落 null（不会误发）', it.pushAt, null);
      ok('提醒时间仍然存着（只是不发通知，不是删掉它）', it.remindAt > 0);
    }

    // ---- ⚠️ 白名单之外一律回落默认，**绝不回落成 -1** ----
    // 这是整条改造最容易写错的地方：0 若被当成合法档位，一个脏值
    // （老数据的 null、前端手滑传的字符串）就会把这条提醒**静默关掉**。
    // 回落成 30 只是「发得比预期早」，用户看得见也改得回来。
    {
      const bad = [0, 7, 999, -2, 31, 5.6, 'abc', null, undefined, NaN];
      for (let i = 0; i < bad.length; i++) {
        const add = await call({
          action: 'addItem',
          item: {
            title: '脏值',
            catId: catId,
            quad: 'q1',
            remindAt: Date.now() + 400 * DAY_MS,
            leadMin: bad[i],
          },
        });
        eq('脏值 ' + String(bad[i]) + ' → 回落 30（不是 -1）', byId(add.data._id).leadMin, 30);
      }
    }

    // ---- 没设提醒时间 → 两个字段都是 null ----
    {
      const add = await call({
        action: 'addItem',
        item: { title: '没提醒', catId: catId, quad: 'q1', leadMin: 30 },
      });
      const it = byId(add.data._id);
      eq('没设提醒时间 → leadMin 落 null', it.leadMin, null);
      eq('没设提醒时间 → pushAt 落 null', it.pushAt, null);
    }

    // ---- 只改提前量，也要像改提醒时间那样复位推送状态 ----
    {
      const add = await call({
        action: 'addItem',
        item: { title: '改提前量', catId: catId, quad: 'q1', remindAt: Date.now() + 10 * DAY_MS, leadMin: 30 },
      });
      const id = add.data._id;
      const base = byId(id).remindAt;

      byId(id).pushed = true;
      byId(id).pushOk = true;

      await call({
        action: 'updateItem',
        id: id,
        patch: { title: '只改标题', remindAt: base, leadMin: 30 },
      });
      eq('两个提醒字段原样回传 → 已推过的不重新排队', byId(id).pushed, true);

      await call({ action: 'updateItem', id: id, patch: { leadMin: 60 } });
      eq('只改提前量 → pushed 复位', byId(id).pushed, false);
      eq('pushAt 跟着提前量重算', byId(id).pushAt, base - 60 * 60000);
      eq('提醒时间没被动过', byId(id).remindAt, base);
      ok('pushOk 也复位', byId(id).pushOk === false);

      byId(id).pushed = true;
      await call({ action: 'updateItem', id: id, patch: { leadMin: -1 } });
      eq('改成「不提醒」→ pushed 复位', byId(id).pushed, false);
      eq('改成「不提醒」→ pushAt 清成 null', byId(id).pushAt, null);
    }

    // ---- 清除提醒时间：三个字段一起清，不留半截 ----
    {
      const add = await call({
        action: 'addItem',
        item: { title: '清除提醒', catId: catId, quad: 'q1', remindAt: Date.now() + 10 * DAY_MS, leadMin: 60 },
      });
      const id = add.data._id;
      await call({ action: 'updateItem', id: id, patch: { remindAt: null } });
      eq('清提醒时间 → remindAt 落 null', byId(id).remindAt, null);
      eq('清提醒时间 → leadMin 一并落 null', byId(id).leadMin, null);
      eq('清提醒时间 → pushAt 一并落 null', byId(id).pushAt, null);
    }

    // ---- 全库不变量：只要带着 pushAt，就必须有提醒时间、且不是「不提醒」----
    // 逐条断言容易漏掉某条写入路径（addItem / updateItem / seed），这里整库验一遍。
    {
      const bad = COLLECTIONS.fq_items.filter(function (r) {
        if (r.pushAt === null || r.pushAt === undefined) return false;
        return !(r.remindAt > 0) || r.leadMin === -1;
      });
      eq('全库没有「不提醒却带着 pushAt」的行', bad.length, 0);
    }
  }

  console.log('\n[23] 提醒周期：只认「每天」/ 每天模式下夹提前量 / 改周期也要复位');
  {
    reset();
    FC.OPENID = 'openid-a';
    const boot = await call({ action: 'bootstrap' });
    const catId = boot.data.categories[0]._id;
    const DAY_MS = 24 * 3600 * 1000;
    const far = Date.now() + 400 * DAY_MS;

    const mk = async function (item) {
      const r = await call({
        action: 'addItem',
        item: Object.assign({ catId: catId, quad: 'q1', remindAt: far }, item),
      });
      return byId(r.data._id);
    };

    // ---- 默认「只提醒一次」，而且是**显式落 0**（不是留空）----
    // 显式落库的好处：往后「字段存不存在」不再是一种额外含义，
    // 云函数里那些 _.neq(true) 式的查询也就少一层含糊（与 progress 同一个理由）。
    eq('不传 repeat → 落 0（只提醒一次）', (await mk({ title: '默认周期' })).repeat, 0);
    eq('repeat = 1 原样落库', (await mk({ title: '每天', repeat: 1 })).repeat, 1);

    // ---- ⚠️ 只认 1 这一个值。其余一律 0（「只提醒一次」）----
    // 失败方向是「少提醒」吗？不，是「少**重复**提醒」—— 用户仍然会收到那一条，
    // 只是不会每天响。与 leadMin 的取舍刚好相反，因为「每条额度都要烧一条」这件事
    // 让「多发」比「少发」更贵。所以这里不设默认档，脏值直接退到最省的那一档。
    const badRepeat = [0, 2, -1, 5, 0.5, '1x', '', '2', null, undefined, NaN];
    for (let i = 0; i < badRepeat.length; i++) {
      eq('脏值 ' + String(badRepeat[i]) + ' → 落 0', (await mk({ title: '脏', repeat: badRepeat[i] })).repeat, 0);
    }

    // ---- ⚠️ 每天模式下超过 1 天的提前量**夹到 180**，不是回落默认 ----
    // 「每天提醒 + 提前 30 天」字面读出来就是「提前 30 天起每天推一条」= 连推 30 条，
    // 还会把攒了很久的额度一次性烧光。夹到最接近的合法档而不是跳到 30 分钟，
    // 是因为用户表达的是「想提前得多一点」，而失败方向仍是「发得晚」而不是「不发」。
    {
      const a = await mk({ title: '每天+7天', repeat: 1, leadMin: 10080 });
      eq('每天 + 提前 7 天 → 夹到 180', a.leadMin, 180);
      eq('pushAt 按夹取后的值算', a.pushAt, a.remindAt - 180 * 60000);

      const b = await mk({ title: '每天+1天', repeat: 1, leadMin: 1440 });
      eq('每天 + 提前 1 天 → 夹到 180', b.leadMin, 180);

      // 边界：180 **不是**超限档，不能被误夹
      const c = await mk({ title: '每天+3小时', repeat: 1, leadMin: 180 });
      eq('每天 + 提前 3 小时 → 原样保留（边界不该被夹）', c.leadMin, 180);
      eq('每天 + 提前 1 小时 → 原样保留', (await mk({ title: '每天+1小时', repeat: 1, leadMin: 60 })).leadMin, 60);

      // ⚠️ 哨兵 -1 必须排在夹取之前：0 > 180 不成立所以看着没事，
      // 但一旦有人把夹取写成 `n > LEAD_DAILY_MAX ? LEAD_DAILY_MAX : n` 之外的
      // 形式（例如先 clamp 再判白名单），-1 就可能被当成「很小的数」留下来。
      // 「不提醒」是这三种里唯一**不允许被改写**的值 —— 用户明确说了不要通知。
      const d = await mk({ title: '每天+不提醒', repeat: 1, leadMin: -1 });
      eq('每天 + 不提醒 → 仍是 -1（哨兵不被夹取改写）', d.leadMin, -1);
      eq('pushAt 落 null', d.pushAt, null);
    }

    // ---- 反向对照：夹取只发生在每天模式，仅一次不受影响 ----
    {
      const a = await mk({ title: '一次+7天', leadMin: 10080 });
      eq('仅一次 + 提前 7 天 → 原样保留（夹取没溢出到这条路径）', a.leadMin, 10080);
      const b = await mk({ title: '一次+30天', leadMin: 43200 });
      eq('仅一次 + 提前 30 天 → 原样保留', b.leadMin, 43200);
    }

    // ---- ⚠️ 改周期也必须复位推送状态，且要用**新**周期夹提前量 ----
    // 不复位的表现是「选了每天提醒，第二天却怎么都不响」（它已经发过一次、
    // pushed 还是 true）；用旧周期夹的表现是「先选每天、再选提前 7 天、
    // 一次请求里送上去，结果 7 天没被夹掉」。
    {
      const add = await call({
        action: 'addItem',
        item: { title: '改周期', catId: catId, quad: 'q1', remindAt: far, leadMin: 43200, repeat: 0 },
      });
      const id = add.data._id;
      eq('前提：仅一次 + 提前 30 天，档位原样', byId(id).leadMin, 43200);

      byId(id).pushed = true;
      byId(id).pushOk = true;
      byId(id).pushErr = '';

      // 只改周期、另外两个字段原样回传 —— 这是客户端每次保存的真实形状
      await call({
        action: 'updateItem',
        id: id,
        patch: { remindAt: far, leadMin: 43200, repeat: 1 },
      });
      eq('改成每天 → pushed 复位（否则它再也不会响）', byId(id).pushed, false);
      eq('顺手把 pushOk 也复位', byId(id).pushOk, false);
      eq('提前量被**新**周期夹到 180', byId(id).leadMin, 180);
      eq('pushAt 跟着重算', byId(id).pushAt, far - 180 * 60000);
      eq('提醒时间没被动过', byId(id).remindAt, far);
      eq('周期本身落了 1', byId(id).repeat, 1);

      // 同样三个字段原样再回传一次 → 这时什么都没变，不该复位
      byId(id).pushed = true;
      await call({
        action: 'updateItem',
        id: id,
        patch: { remindAt: far, leadMin: 180, repeat: 1 },
      });
      // ⚠️ 这里如果写成 `leadMin: 43200`（客户端手里那份「用户当初选的」），
      // 夹取结果仍是 180，所以照样不该复位 —— 这条断言同时守住「拿 nextLead
      // 比而不是拿入参比」这个细节。
      eq('三个字段原样回传 → 已推过的不重新排队', byId(id).pushed, true);
      byId(id).pushed = false;

      // 改回「仅一次」：180 是**保留**的，不会还原成 43200 ——
      // 夹取是不可逆的信息损失（用户当初选的档位没存第二份）。
      // 这是有意的：为它多存一个字段，只为了让一次「改回去」看起来更聪明，
      // 不值。而且 180 仍然是用户想要的「提前不少」那一档。
      await call({ action: 'updateItem', id: id, patch: { repeat: 0 } });
      eq('改回仅一次 → 周期落 0', byId(id).repeat, 0);
      eq('夹过的提前量保留 180（夹取不可逆）', byId(id).leadMin, 180);
      eq('仅一次模式下 180 本就合法，pushAt 重算成同一个值', byId(id).pushAt, far - 180 * 60000);

      // 只改标题、周期原样回传 → 什么都不该动
      byId(id).pushed = true;
      await call({ action: 'updateItem', id: id, patch: { title: '只改标题', repeat: 0 } });
      eq('只改标题 → 已推过的不重新排队', byId(id).pushed, true);
    }

    // ---- ⚠️ 只改周期、且提前量**不需要夹取**时，也必须复位 ----
    // 上面那条用的是「每天 + 提前 30 天」，夹取让 nextLead 从 43200 变成 180 ——
    // 于是即便实现里漏掉 `oldRepeat !== nextRepeat` 这一项，pushed 照样会被复位
    // （因为 nextLead 也变了），那条断言**检验的东西和我以为的不是同一个**。
    // 变异验证实测抓到了这一点（mutate-repeat.js「变化判定漏掉 repeat」跑出来是绿的）。
    // 这条用 60（≤LEAD_DAILY_MAX，不触发夹取），保证「只有 repeat 变了」。
    {
      const it = await mk({ title: '只改周期', leadMin: 60, repeat: 0 });
      const before = it.pushAt;
      byId(it._id).pushed = true;
      byId(it._id).pushOk = true;

      await call({ action: 'updateItem', id: it._id, patch: { repeat: 1 } });
      eq('只改周期（提前量无需夹取）→ pushed 也复位', byId(it._id).pushed, false);
      eq('提前量原样没动', byId(it._id).leadMin, 60);
      eq('提醒时间没被碰过', byId(it._id).remindAt, far);
      eq('pushAt 落在同一个值上', byId(it._id).pushAt, before);
      eq('周期落了 1', byId(it._id).repeat, 1);
    }

    // ---- 清提醒时间：周期**保留**（周期是偏好，提醒时间是开关）----
    {
      const it = await mk({ title: '清了时间', repeat: 1, leadMin: 60 });
      await call({ action: 'updateItem', id: it._id, patch: { remindAt: null } });
      const r = byId(it._id);
      eq('清提醒时间 → remindAt 落 null', r.remindAt, null);
      eq('清提醒时间 → leadMin 一并落 null', r.leadMin, null);
      eq('清提醒时间 → pushAt 一并落 null', r.pushAt, null);
      // 清的是「什么时候提醒」，不是「要不要每天」。用户下次再设时间时
      // 周期还在，不必重选一遍 —— 界面上的表现是「周期那行没被重置」。
      eq('清提醒时间 → 周期保留（不是提醒时间的附庸）', r.repeat, 1);
    }

    // ---- 全库不变量：repeat 只可能是 0 / 1 ----
    {
      const odd = COLLECTIONS.fq_items.filter(function (r) {
        return r.repeat !== 0 && r.repeat !== 1;
      });
      eq('全库没有非 0 / 1 的周期值', odd.length, 0);

      const mismatch = COLLECTIONS.fq_items.filter(function (r) {
        return r.repeat === 1 && r.leadMin !== null && r.leadMin > 180;
      });
      eq('全库没有「每天却还留着超 1 天的提前量」的行', mismatch.length, 0);
    }
  }

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

run().catch(function (err) {
  console.log('\n✗ 测试自身抛异常: ' + ((err && err.stack) || err));
  process.exit(1);
});
