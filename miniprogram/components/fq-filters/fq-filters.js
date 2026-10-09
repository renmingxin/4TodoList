// components/fq-filters/fq-filters.js
// 详情页筛选（待办 / 已完成 / 全部）
//
// 页面侧：bind:filter="onFilter"（唯一调用点，那边直接从 e.detail 取）。
// 
// 为什么事件叫 filter 而不是 pick：fq-cats / fq-tabbar 已经占用了 pick，
// 而 event-check 的「同名同形」规则要求同名事件形状一致 —— 换个名字比
// 让三处共用同一套语义更清楚。
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
    // 页面上对应 data.filters
    filters: { type: null },
    // 页面上对应 data.sortMode
    sortMode: { type: null },
  },

  methods: {
    onFilter(e) {
      this.triggerEvent('filter', e.currentTarget.dataset);
    },
  },
});
