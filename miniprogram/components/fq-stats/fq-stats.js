// components/fq-stats/fq-stats.js
// 统计条（总览 / 我的共用）
//
// 同一个组件被两个视图用：总览看四项待办数，我的看家庭概览。
// 区别只有 flat 一个变体（去掉外层留白），所以做成属性而不是两个组件。
//
// 组件化三条硬约定（见 README「组件分层」）：
//   1. virtualHost: true —— 组件不产生额外节点。
//      这条是必须的：.screen 是纵向 flex，各固定块靠「不伸不缩」占住自己的高度，
//      组件一旦变成真实的 flex item，原先的布局就全靠运气了。
//   2. styleIsolation: apply-shared —— app.wxss 的共享资产能进组件，
//      同时组件自己的 wxss 不会反向污染页面。
//   3. 数据只走 properties、交互只走 triggerEvent。
//      组件不碰 wx.cloud、不读写页面实例 —— 那样它才能被单独看懂。

Component({
  options: {
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },

  properties: {
    // 页面上对应 data.flat
    flat: { type: null },
    // 页面上对应 data.stats
    stats: { type: null },
  },

  methods: {
    // 本组件没有交互。
  },
});
