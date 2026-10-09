// components/fq-appbar/fq-appbar.js
// 顶部应用栏（总览 / 全部 / 我的）
//
// 原来这三块（标题 / 副标题 / 右上角按钮）写在页面里，但页面自己
// 只提供数据，不该管它长什么样。
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
    // 页面上对应 data.capsuleReserve
    capsuleReserve: { type: null },
    // 页面上对应 data.pageMeta
    pageMeta: { type: null },
    // 页面上对应 data.pageTitle
    pageTitle: { type: null },
  },

  methods: {
    // 右上角齿轮：切到「我的」。
    //
    // ⚠️ 方法名必须是 onGotoMine，而不是「更顺眼」的 onMine。
    //    组件 WXML 是从页面**逐字搬来**的，里面写死了 bindtap="onGotoMine"；
    //    两边名字对不上，就是一个点了完全没反应、又不报任何错的按钮。
    //    （这条契约由 .workbuddy/tools/event-check.js 的「A 组件自带」守着。）
    //    由此得出通用规则：**组件内部 handler 保持页面原来的名字**，
    //    对外则用 triggerEvent 换成自己的事件名（这里是 mine）。
    onGotoMine() {
      this.triggerEvent('mine');
    },
  },
});
