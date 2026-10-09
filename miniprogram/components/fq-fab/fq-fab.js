// components/fq-fab/fq-fab.js
// 悬浮新建（仅总览）
//
// 组件化三条硬约定（见 README「组件分层」）：
//   1. virtualHost: true —— 组件不产生额外节点。
//      这条是必须的：.screen 是纵向 flex，各固定块靠「不伸不缩」占住自己的高度，
//      组件一旦变成真实的 flex item，原先的布局就全靠运气了。
//   2. styleIsolation: apply-shared —— app.wxss 的共享资产能进组件，
//      同时组件自己的 wxss 不会反向污染页面。
//   3. 交互只走 triggerEvent。本组件**连入参都没有**（见下）——
//      组件不碰 wx.cloud、不读写页面实例，那样它才能被单独看懂。

Component({
  options: {
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },

  // 本组件现在**不收任何入参**。原先有个 bottom property（页面按「tab 高 + 安全区」
  // 算成 px 传进来），因为按钮当时是贴在屏幕右下角的；挪进 .ovgrid 之后，
  // 偏移量变成「距矩阵右下角」的常数，写进 wxss 即可 —— 位置不再依赖屏幕尺寸，
  // 也就没有需要从页面流下来的数据了。

  methods: {
    // 右下角那颗「+」。
    // ⚠️ 方法名与组件 WXML 里的 bindtap="onNew" 必须一致（WXML 是逐字搬来的）。
    //    对外发的是 create，页面侧绑 bind:create="onNew"。
    onNew() {
      this.triggerEvent('create');
    },
  },
});
