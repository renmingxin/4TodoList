// 变异验证：v9「提醒周期」（只提醒一次 / 每天提醒）
//
// 纪律（见 MEMORY.md §三·③）：新增检查的顺序不能反 ——
//   ① 先跑基线确认绿；② 再逐条做变异确认会红。
// **永远绿的测试等于没有测试。**
//
// 每条变异都必须能说出「该由哪条断言拦住」。跑不红的变异只有两种可能：
//   要么断言没守住东西，要么断言自己写错了 —— 后一种实测抓到过（本轮就有一次：
//   test-remind 里用 leadMin: 3 做夹具，而 3 不在白名单里，toLead 静默回落成 30，
//   断言差了 27 分钟却去怀疑实现），别默认是前者。
//
// 最后一条是**对照组**：只改注释，必须保持绿。它证明红是变异带来的，
// 而不是被别的因素搞红的。
//
// v8 那份在 .workbuddy/tmp/mutate-lead.js。v9 单独一份，不合并 ——
// 变异脚本是「一轮改造的验收记录」，按轮次留档比堆成一个巨文件好查。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const TOOLS = path.join(ROOT, '.workbuddy', 'tools');

const TODO = path.join(ROOT, 'cloudfunctions/fqTodo/index.js');
const REMIND = path.join(ROOT, 'cloudfunctions/fqRemind/index.js');
const CONSTJS = path.join(ROOT, 'miniprogram/utils/const.js');
const PAGE = path.join(ROOT, 'miniprogram/pages/index/index.js');
const WXML = path.join(ROOT, 'miniprogram/pages/index/index.wxml');

const MUTATIONS = [
  // ---- fqTodo：周期的净化与夹取 ----
  {
    name: 'toRepeat 恒返回 0（「每天提醒」彻底失效）',
    file: TODO,
    from: '  return Number(v) === REPEAT_DAILY ? REPEAT_DAILY : 0;',
    to: '  return 0;',
    test: 'test-cloudfn.js',
    why: '界面上选了每天，落库仍是 0 —— 用户第二天不响了，而任何一处都不报错',
  },
  {
    name: 'updateItem 忽略客户端给的 repeat（一律沿用旧值）',
    file: TODO,
    from: '    const nextRepeat = src.repeat !== undefined ? toRepeat(src.repeat) : oldRepeat;',
    to: '    const nextRepeat = oldRepeat;',
    test: 'test-cloudfn.js',
    why: '改周期永远改不动：想从「一次」改成「每天」怎么点都没用',
  },
  {
    name: '每天模式下不夹提前量',
    file: TODO,
    from: '  if (repeat === REPEAT_DAILY && n > LEAD_DAILY_MAX) return LEAD_DAILY_MAX;',
    to: '  if (false) return LEAD_DAILY_MAX;',
    test: 'test-cloudfn.js',
    why: '「每天提醒 + 提前 30 天」= 连推 30 条同一件事，还会把攒下的额度一次烧光',
  },
  {
    name: '夹取方向写反（把合法档夹到上限）',
    file: TODO,
    from: '  if (repeat === REPEAT_DAILY && n > LEAD_DAILY_MAX) return LEAD_DAILY_MAX;',
    to: '  if (repeat === REPEAT_DAILY && n < LEAD_DAILY_MAX) return LEAD_DAILY_MAX;',
    test: 'test-cloudfn.js',
    why: '⚠️ 最阴的一条：`-1`（不提醒）也满足 `n < 180`，于是「不提醒」被改写成 180 —— ' +
      '用户明说了不要通知，却开始每天收到通知。哨兵必须在夹取之前被排除',
  },
  {
    name: 'addItem 不落周期（一律落 0）',
    file: TODO,
    from: '      repeat: repeat,',
    to: '      repeat: 0,',
    test: 'test-cloudfn.js',
    why: '新建时选的「每天」被丢掉，只有编辑保存那条路径能生效（两处行为不一致）',
  },
  {
    name: 'addItem 用旧周期（写死 0）夹提前量',
    file: TODO,
    from: '  const leadMin = remindAt === null ? null : toLead(src.leadMin, repeat);',
    to: '  const leadMin = remindAt === null ? null : toLead(src.leadMin, 0);',
    test: 'test-cloudfn.js',
    why: '一次请求里送「每天 + 提前 30 天」时漏夹 —— 客户端藏了那几档，但前端能绕过',
  },
  {
    name: 'updateItem 用 oldRepeat 夹提前量（而不是新周期）',
    file: TODO,
    from: '        : toLead(src.leadMin !== undefined ? src.leadMin : oldLead, nextRepeat);',
    to: '        : toLead(src.leadMin !== undefined ? src.leadMin : oldLead, oldRepeat);',
    test: 'test-cloudfn.js',
    why: '「先选每天、再选提前 7 天」这种同一次请求里送上去的组合会漏夹',
  },
  {
    name: '变化判定漏掉 repeat（改周期不复位 pushed）',
    file: TODO,
    from: '    if (oldAt !== nextAt || oldLead !== nextLead || oldRepeat !== nextRepeat) {',
    to: '    if (oldAt !== nextAt || oldLead !== nextLead) {',
    test: 'test-cloudfn.js',
    why: '从「一次」改成「每天」时那条提醒已经发过了、pushed 还是 true —— ' +
      '它再也不会响，用户看到的是「选了每天提醒，第二天却怎么都不响」',
  },
  {
    name: 'updateItem 不把周期写进 patch',
    file: TODO,
    from: '    patch.repeat = nextRepeat;',
    to: '    patch.repeat = 0;',
    test: 'test-cloudfn.js',
    why: '改每天看起来生效了（pushAt 也重算了），但库里仍是 0 —— 发完一次就结束',
  },
  {
    name: 'fqTodo 的 REPEAT_DAILY 与客户端枚举漂移',
    file: TODO,
    from: 'const REPEAT_DAILY = 1;',
    to: 'const REPEAT_DAILY = 2;',
    test: 'test-remind.js',
    why: '客户端送 1、云端只认 2 → toRepeat 把「每天」净化成「仅一次」，静默降级',
  },
  {
    name: 'fqTodo 与 fqRemind 的 REPEAT_DAILY 不一致',
    file: REMIND,
    from: 'const REPEAT_DAILY = 1;',
    to: 'const REPEAT_DAILY = 0;',
    test: 'test-remind.js',
    why: '两端对「周期」的取值理解不同：fqTodo 落 1，fqRemind 认不出 1 → 永远不滚',
  },

  // ---- fqRemind：滚动、去重、通知里的时刻 ----
  {
    name: '每天提醒不滚动（nextAt 恒 null）',
    file: REMIND,
    from: '    const nextAt = it.repeat === REPEAT_DAILY ? nextDailyPushAt(at, now) : null;',
    to: '    const nextAt = null;',
    test: 'test-remind.js',
    why: '每天提醒退化成「一天响一次然后就没了」（第一轮走普通路径把 pushed 写成 true）',
  },
  {
    name: '滚动时忘了保持未处理态（写回 pushed: true）',
    file: REMIND,
    from: '    data.pushed = false;',
    to: '    data.pushed = true;',
    test: 'test-remind.js',
    why: '滚完就把自己标成已处理 → 明天挑不到 → 只响这一次',
  },
  {
    name: '去重不拿 pushAt 当版本号（并发两条实例会双双成功）',
    file: REMIND,
    from: '    where.pushAt = item.pushAt;',
    to: '    where.pushed = _.neq(true);',
    test: 'test-remind.js',
    why: '⚠️ 本轮最容易漏的一处：每天提醒的 pushed 前后都成立，条件去重失效 → ' +
      '同一件事推两遍，额度也被扣两份。触发器重复触发是官方明说会发生的事',
  },
  {
    name: '滚动只 +1 天（不一次跳到未来）',
    file: REMIND,
    from: '  const k = Math.floor((now - at) / DAY_MS) + 1;',
    to: '  const k = 1;',
    test: 'test-remind.js',
    why: '云函数停过几天、或用户刚把「一次」改成「每天」时，要连跑好几天才追上现在',
  },
  {
    name: '过期的每天提醒被记成「未送达」',
    file: REMIND,
    from: '      const rolled = !!nextAt;',
    to: '      const rolled = false;',
    test: 'test-remind.js',
    why: '用户会在「我的」页看到一条根本没发生过的失败，然后去查手机通知设置',
  },
  {
    name: '通知里的时刻退回 remindAt（起点）',
    file: REMIND,
    from: '  const pushMs = Number(item.pushAt) + (lead > 0 ? lead : 0) * 60000;',
    to: '  const pushMs = Number(item.remindAt);',
    test: 'test-remind.js',
    why: '10 月 20 日那天的通知会写「提醒时间 2026-10-15 09:00」，白白让人以为发错了；' +
      '对「提前 7 天」的仅一次提醒也会显示成提醒时间而不是现在的推送时刻',
  },
  {
    name: '滚动后的 pushAt 相位错开（不是整天）',
    file: REMIND,
    from: '  return at + k * DAY_MS;',
    to: '  return now + DAY_MS;',
    test: 'test-remind.js',
    why: '看似「也是明天」，但起点漂了：每天推的时刻会一天天往前挪，' +
      '最后跑到凌晨去（用户设的是 09:00 吃药）',
  },

  // ---- 客户端 ----
  {
    name: '客户端周期枚举的值与云端不一致',
    file: CONSTJS,
    from: "  { v: 1, label: '每天提醒' },",
    to: "  { v: 2, label: '每天提醒' },",
    test: 'test-remind.js',
    why: '界面送 2、云端只认 1 → 选了每天却按一次处理，第二天不响',
  },
  {
    name: '客户端每天模式上限与云端不一致',
    file: CONSTJS,
    from: 'const LEAD_DAILY_MAX = 180;',
    to: 'const LEAD_DAILY_MAX = 1440;',
    test: 'test-remind.js',
    why: '界面允许选到「提前 1 天」而云端夹到 3 小时 —— 用户选完再看会变，' +
      '而且这种「选了又变回去」的现象与「云端还是旧包」长得一模一样',
  },

  // ---- 客户端：预览行 / 档位列表 / 夹取 / 落库 / 本地镜像 ----
  {
    name: '预览行不再明说「时间还留着」（选不提醒时）',
    file: PAGE,
    from: "    return { text: '提醒时间已保留，不会发送通知', off: true, icon: 'ico-bell-off' };",
    to: "    return { text: '提醒时间已保留，不会发送通知', off: false, icon: 'ico-bell-off' };",
    test: 'test-reorder.js',
    why: '「不提醒」是整套文案里最容易误读的一处：不降级，用户会以为提醒是好的、只是没响',
  },
  {
    name: '「不提醒」那一档的说明丢了',
    file: PAGE,
    from: "      hint: o.v === -1 ? '保留提醒时间，只是不发通知' : '',",
    to: "      hint: '',",
    test: 'test-reorder.js',
    why: '用户在选完之后唯一能读到「时间还在、只是不发」的地方就是这条说明',
  },
  {
    name: '预览行的提前量方向写反（加而不是减）',
    file: PAGE,
    from: '  const push = at - Number(leadMin) * 60000;',
    to: '  const push = at + Number(leadMin) * 60000;',
    test: 'test-reorder.js',
    why: '⚠️ 整个预览行的意义就是让用户看见「提前量把 09:00 挪到几点」。' +
      '方向反了，界面会一本正经地告诉他一个错的时刻 —— 比不显示更糟',
  },
  {
    name: '预览行不提「每天」（措辞退回「仅一次」那一句）',
    file: PAGE,
    from: '  if (repeatIdx === REPEAT_DAILY_IDX) {',
    to: '  if (false) {',
    test: 'test-reorder.js',
    why: '每天提醒和仅一次在视觉上只差一句话，复用措辞会让用户看不出自己选的是哪个',
  },
  {
    name: '每天模式下不藏超 1 天的档位',
    file: PAGE,
    from: '    return !daily || o.v <= LEAD_DAILY_MAX;',
    to: '    return true;',
    test: 'test-reorder.js',
    why: '「每天 + 提前 30 天」= 连推 30 条，还会把攒下的额度一次烧光',
  },
  {
    name: '切到「每天」时不夹提前量',
    file: PAGE,
    from: '    if (idx === REPEAT_DAILY_IDX && cur > LEAD_DAILY_MAX) {',
    to: '    if (false) {',
    test: 'test-reorder.js',
    why: '界面上出现「列表里没有这一档，右侧却写着它」——不报错，只是让人怀疑自己看错了',
  },
  {
    name: '打开抽屉时不夹（脏数据原样带进来）',
    file: PAGE,
    from: '      leadIdx: leadIdxFor(item ? item.leadMin : LEAD_DEFAULT, repeatIdx),',
    to: '      leadIdx: leadIndex(item ? item.leadMin : LEAD_DEFAULT),',
    test: 'test-reorder.js',
    why: '库里的「每天 + 提前 30 天」在抽屉里会显示成一个从列表里选不出来的档位',
  },
  {
    name: '「重复」那一行置灰后仍然响应点击',
    file: PAGE,
    from: '  onToggleLead() {\n    if (!this.data.form.hasRemind) return;',
    to: '  onToggleLead() {\n    if (false) return;',
    test: 'test-reorder.js',
    why: '灰着却能改，比灰着不能改更让人犯嘀咕；而且改的还是「提前多久」，用户看不见自己改了什么',
  },
  {
    name: '清除提醒时间时顺手把周期也复位',
    file: PAGE,
    from: '    this.applyRemind({ hasRemind: false, remOpen: false });',
    to: '    this.applyRemind({ hasRemind: false, remOpen: false, repeatIdx: REPEAT_DEFAULT_IDX });',
    test: 'test-reorder.js',
    why: '清掉的是「什么时候提醒」，不是「要不要每天」—— 用户下次再设时间会发现周期变回一次，而他没动过它',
  },
  {
    name: '没设提醒时间时也把 repeat 送上去（送 0）',
    file: PAGE,
    from: '    if (remindAt) payload.repeat = repeatValueOf(f.repeatIdx);',
    to: '    payload.repeat = repeatValueOf(f.repeatIdx);',
    test: 'test-reorder.js',
    why: '云函数在字段缺席时才沿用旧值；送了 0 就等于把用户选的「每天」一起抹掉',
  },
  {
    name: '编辑保存后无条件改写本地镜像的周期',
    file: PAGE,
    from: '          if (payload.repeat !== undefined) it.repeat = payload.repeat;',
    to: '          it.repeat = payload.repeat === undefined ? 0 : payload.repeat;',
    test: 'test-reorder.js',
    why: '镜像被改成 0、库里还是 1 —— 分岔了，而重开抽屉读的是镜像。' +
      '这个现象与「云端还是旧包」长得一模一样',
  },
  {
    name: '周期净化恒返回默认档（每天永远选不上）',
    file: PAGE,
    from: '  const i = REPEAT_OPTIONS.findIndex(function (o) {\n    return o.v === n;\n  });\n  return i >= 0 ? i : REPEAT_DEFAULT_IDX;',
    to: '  return REPEAT_DEFAULT_IDX;',
    test: 'test-reorder.js',
    why: '一条「每天」的事项重开抽屉会显示成「只提醒一次」，而库里仍是 1',
  },
  {
    name: '「每天」那一档的下标取反（指向默认档）',
    file: PAGE,
    from: '    return o.v !== REPEAT_DEFAULT;',
    to: '    return o.v === REPEAT_DEFAULT;',
    test: 'test-reorder.js',
    why: '下标指错档位：预览行、图标、夹取会整体错位，而下拉文案看着还是对的',
  },
  {
    name: '预览行的图标恒为普通铃铛',
    file: PAGE,
    from: '    remIcon: prev.icon,',
    to: "    remIcon: 'ico-bell',",
    test: 'test-reorder.js',
    why: '未设时间 / 选了不提醒时，图标是用户扫一眼就能判断「不会响」的那条线索',
  },
  {
    name: '补额度入口绕过 askSubscribe（旁路）',
    file: PAGE,
    from: '  onTopUpQuota() {\n    this.askSubscribe();\n  },',
    to: '  onTopUpQuota() {\n    this.grantQuota();\n  },',
    test: 'test-reorder.js',
    why: 'grantQuota 只管记账、不弹授权 —— 用户点了等于白点，额度一条也没多',
  },

  // ---- 客户端：WXML 接线 ----
  // ⚠️ 这两条的锚点里有单引号（WXML 里的三元表达式），所以用**双引号**包 JS 字符串、
  // 把里面的双引号转义。写成单引号包会一路转义到看不出原样 —— 上一版就是这么写错的。
  {
    name: '提醒卡少了「置灰」那一层 class',
    file: WXML,
    from: "class=\"remrow {{form.hasRemind?'':'dis'}}\" bindtap=\"onToggleLead\"",
    to: "class=\"remrow\" bindtap=\"onToggleLead\"",
    test: 'test-reorder.js',
    why: '没设提醒时间时两行还长得像能点 —— 用户会去点，然后以为界面坏了',
  },
  {
    name: '授权说明退回「只要有提醒时间就出现」',
    file: WXML,
    from: "class=\"subhint\" wx:if=\"{{form.hasRemind && !form.remPrevOff}}\"",
    to: "class=\"subhint\" wx:if=\"{{form.hasRemind}}\"",
    test: 'test-reorder.js',
    why: '选了「不提醒」时上下两行自相矛盾：预览说「不会发送通知」，说明说「需授权后才能收到」',
  },

  // ---- 对照组：只改注释，必须保持绿 ----
  {
    name: '[对照组] 只改一句注释',
    file: REMIND,
    from: '// 提醒周期：1 = 每天提醒（0 是「只提醒一次」，也是缺省）。',
    to: '// 提醒周期（注释改动，不该影响任何断言）：1 = 每天提醒（0 是「只提醒一次」，也是缺省）。',
    test: 'test-remind.js',
    control: true,
    why: '它不该红。红了说明测试是被别的东西搞红的，这一整轮结果都不可信',
  },
];

function runTest(name) {
  try {
    execFileSync(NODE, [path.join(TOOLS, name)], { stdio: 'pipe' });
    return true; // 绿
  } catch (e) {
    return false; // 红
  }
}

function applyAndRun(m) {
  const orig = fs.readFileSync(m.file, 'utf8');
  if (orig.indexOf(m.from) < 0) {
    throw new Error('变异锚点找不到（源码改过了？）: ' + m.name);
  }
  const patched = orig.replace(m.from, m.to);
  if (patched === orig) {
    throw new Error('变异没有生效: ' + m.name);
  }
  fs.writeFileSync(m.file, patched);
  try {
    return runTest(m.test);
  } finally {
    fs.writeFileSync(m.file, orig);
  }
}

(function main() {
  console.log('=== 基线 ===');
  const basePass = ['test-cloudfn.js', 'test-remind.js', 'test-reorder.js'].every(function (t) {
    const g = runTest(t);
    console.log((g ? '  ✓ ' : '  ✗ ') + t + (g ? ' 绿' : ' 红（基线就不该红！）'));
    return g;
  });
  if (!basePass) {
    console.error('\n基线不是绿的，先修好再来做变异。');
    process.exit(1);
  }

  console.log('\n=== 逐条变异 ===');
  let good = 0;
  let bad = 0;
  const failures = [];

  MUTATIONS.forEach(function (m) {
    let green;
    try {
      green = applyAndRun(m);
    } catch (e) {
      console.log('  ⚠ ' + m.name + '\n      ' + e.message);
      bad++;
      failures.push(m.name + '（变异没跑起来）');
      return;
    }
    const want = m.control ? green : !green;
    if (want) {
      good++;
      console.log('  ✓ ' + m.name + (m.control ? '  → 保持绿' : '  → 变红'));
    } else {
      bad++;
      console.log('  ✗ ' + m.name + '  → ' + (green ? '仍然绿（没守住）' : '意外变红'));
      console.log('      为什么该被拦住：' + m.why);
      failures.push(m.name);
    }
  });

  console.log('\n----------------------------------------');
  console.log('变异 ' + good + ' / ' + MUTATIONS.length + ' 条符合预期');
  if (failures.length) {
    console.log('不符合预期的：');
    failures.forEach(function (f) {
      console.log('  · ' + f);
    });
    process.exit(1);
  }
  console.log('✓ 全部符合预期（红的红得其所 + 对照组保持绿）');
})();
