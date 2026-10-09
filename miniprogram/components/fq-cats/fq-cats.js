// components/fq-cats/fq-cats.js
// 分类胶囊条（仅总览）
//
// 页面侧：bind:pick="onPickCat" / bind:add="onAddCategory"。
// 
// ⚠️ onPickCat 在页面上有**两个来源**：这个组件（值走 e.detail），
// 以及「我的」页里的分类行（还是原来的 currentTarget.dataset）。
// 所以那个 handler 两边都要认 —— 见 index.js 里的写法。
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
    // 页面上对应 data.catTabs
    catTabs: { type: null },
  },

  methods: {
    onPickCat(e) {
      this.triggerEvent('pick', e.currentTarget.dataset);
    },

    onAddCategory() {
      this.triggerEvent('add');
    },
  },
});
