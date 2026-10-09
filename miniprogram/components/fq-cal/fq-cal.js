// components/fq-cal/fq-cal.js
// 月历：月份条 + 7×6 = 42 格。
//
// 它是个**纯展示 + 转发**的组件：哪一格是今天、哪一格被选中、哪几天有内容，
// 全部由页面算好、通过 cells 传进来（42 格的日期算术住在 utils/format.js 与页面
// 的 buildCal 里）。组件自己不碰日期、不碰数据、不碰存储 —— 所以它可以被
// 单独看懂，也能被单独截图验证。这也是 calendar 那类组件最容易写歪的地方：
// 一旦让组件自己去算日期，"哪一天算哪一月" 就有了两份说法。
//
// ⚠️ 方法名与 WXML 里的 bindtap 逐一对应（onPrev / onNext / onToday / onPick）。
//    组件化时 WXML 是从页面逐字搬来的，名字对不上就是「点了没反应」且不报错 ——
//    本项目已经因为这一点一次造出过 5 个死按钮，事件接线由 .workbuddy/tools/event-check.js 守。
//
// 组件化三条硬约定（见 README「组件分层」）：
//   1. virtualHost: true —— 组件不产生额外节点。这条是必须的：.screen 是纵向 flex，
//      各固定块靠「不伸不缩」占住高度，组件一旦变成真实 flex item，布局就靠运气了。
//   2. styleIsolation: apply-shared —— 拿得到 app.wxss 的 .ico-chev-l/r 与中性色变量。
//   3. 数据只走 properties、交互只走 triggerEvent。

const { WEEK_MON } = require('../../utils/const.js');

Component({
  options: {
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },

  properties: {
    // '2026 年 10 月'
    label: { type: null },
    // 42 个格子，每格 { k:'YYYY-MM-DD', n:日期数字, other:非本月, today, sel, hi:有事项, hp:有计划 }
    cells: { type: null },
    // 当前选中的就是今天 → 「今天」按钮反色
    attoday: { type: Boolean, value: false },
  },

  data: {
    // 表头。周一起始，取 const.js 里的 WEEK_MON ——
    // 不能拿 WEEK（周日在前、还带「周」字）来当表头，会整体错开一列。
    week: WEEK_MON,
  },

  methods: {
    onPrev() {
      this.triggerEvent('prev');
    },
    onNext() {
      this.triggerEvent('next');
    },
    onToday() {
      this.triggerEvent('today');
    },
    // 把被点那一格的 dataset 原样交给页面（页面侧从 e.detail.k 取值）。
    onPick(e) {
      this.triggerEvent('pick', e.currentTarget.dataset);
    },
  },
});
