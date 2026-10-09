// components/fq-sortdone/fq-sortdone.js
// 排序模式的固定底栏
//
// 排序期间替代底栏 / Tab：一是「只能做拖动操作」，
// 二是「完成」永远在屏幕上（拖动时列表滚不动，入口按钮可能已经被滚走）。
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
    // 「完成」：退出排序模式。
    // ⚠️ 方法名与组件 WXML 里的 bindtap="onSortToggle" 必须一致（WXML 是逐字搬来的）。
    //    对外发的是 toggle；页面上同名方法 onSortToggle 在 utils/drag.js 里。
    onSortToggle() {
      this.triggerEvent('toggle');
    },
  },
});
