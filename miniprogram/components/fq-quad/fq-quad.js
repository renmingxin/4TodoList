// components/fq-quad/fq-quad.js
// 总览 2×2 满色矩阵
//
// 页面侧：bind:open="onOpenQuad"（唯一调用点，所以那边直接从 e.detail 取）。
// 
// 矩阵的四块靠 .q.q1~.q4 取到 --qc；两个象限图标 .qmark 是共享资产、
// 定义在 app.wxss，靠 apply-shared 进来。
// 方块尺寸（宽 50% - 7rpx / 高 476rpx 或自适应）与 .qrow 的等分说明都随样式
// 一起来了，改之前先看头注释里「全局 box-sizing 是 border-box」那一条。
//
// fill：高度算法二选一（见 wxss 的「自适应高度」段）
//   false（默认）→ .q 用设计稿固定高 476rpx，版式与设计稿一致；
//   true         → .grid 撑满宿主给的高度，两块按容器均分。
//   总览页用 true：它要「矩阵 + 饮水卡」在一屏里恰好装下，两块的高度都不能写死。
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
    // 页面上对应 data.grid
    grid: { type: null },

    // 高度自适应开关，见文件头。默认 false，保持设计稿的固定版式。
    fill: { type: Boolean, value: false },
  },

  methods: {
    onOpenQuad(e) {
      this.triggerEvent('open', e.currentTarget.dataset);
    },
  },
});
