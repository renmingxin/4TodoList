// components/fq-tabbar/fq-tabbar.js
// 底部 Tab（总览 / 日程 / 全部 / 我的）
//
// 四个 tab 共用一个 onTab：组件内部知道「点的是哪一个」，
// 页面只需要知道「要切到哪个视图」。
//
// ⚠️ 方法名 onTab 是**照抄**组件 WXML 里的 bindtap="onTab"（WXML 从页面逐字搬来，
//    不该反过来去改它）。名字对不上就是三个点了没反应的 tab，且不报错。
//    组件对外发的事件叫 pick（页面侧 bind:pick="onTab"）。
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
    // 页面上对应 data.view
    view: { type: null },
  },

  methods: {
    // 把被点那一个的 dataset 原样交给页面。
    // 交给页面的形状是 detail（不是原生事件的 currentTarget.dataset），
    // 所以页面上的 onTab 从 e.detail.k 取值 —— 见 index.js 里那段注释。
    onTab(e) {
      this.triggerEvent('pick', e.currentTarget.dataset);
    },
  },
});
