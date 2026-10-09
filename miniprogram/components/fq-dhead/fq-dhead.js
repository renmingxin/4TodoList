// components/fq-dhead/fq-dhead.js
// 详情页顶部导航（颜色随象限）
//
// 方法名保持页面原来的名字（onBack / onQuadMenu），因为组件 WXML 是从页面
// 逐字搬来的，里面写死了这两个 bindtap。对外换成自己的事件名 back / menu。
// 页面侧：bind:back="onBack" / bind:menu="onQuadMenu"。
// 
// sortMode 是属性而不是让页面挂 class：排序模式下尾部的 ⋮ 要变灰不可点，
// 这个判断由组件自己做，页面只管把它当前的状态传进来。
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
    // 页面上对应 data.quad
    quad: { type: null },
    // 页面上对应 data.quadCap
    quadCap: { type: null },
    // 页面上对应 data.quadHint
    quadHint: { type: null },
    // 页面上对应 data.quadName
    quadName: { type: null },
    // 页面上对应 data.quadUndone
    quadUndone: { type: null },
    // 页面上对应 data.sortMode
    sortMode: { type: null },
  },

  methods: {
    onBack() {
      this.triggerEvent('back');
    },

    onQuadMenu() {
      this.triggerEvent('menu');
    },
  },
});
