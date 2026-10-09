// components/fq-water/fq-water.js
// 今日饮水条：拖动过程由组件自己管，只在松手时把结果交给页面。
//
// 为什么高频那一段不 triggerEvent：拖动时每帧都要改数值，若走
// 「组件 → 页面 setData → 再传回组件」，路径长，而且会牵动整个页面重渲染
// （页面 data 里有几十个事项字段）。饮水不参与任何象限统计，松手后没有汇总值
// 要同步，所以按住期间只在本组件内 setData 一个数字（wcur），
// 松手再 triggerEvent('change', { ml })，由页面写本地存储。
//
// 组件化三条硬约定（见 README「组件分层」）：
//   1. virtualHost: true —— 组件不产生额外节点；
//   2. styleIsolation: apply-shared —— 拿得到 app.wxss 的中性色变量；
//   3. 数据只走 properties、交互只走 triggerEvent —— 组件不碰 wx 存储，
//      所以它可被单独看懂，也方便将来换存储方式。

const { WATER_GOAL } = require('../../utils/const.js');

Component({
  options: {
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },

  properties: {
    // 页面 data.waterMl —— 已落库的饮水量。拖动中组件用自己的 wcur，不受它牵动。
    ml: {
      type: null,
      value: 0,
      observer: function (v) {
        // 外部改了值（首屏读取 / 跨天清零）就同步到内部显示值。
        // 松手后页面回写同一个数字时这里会再跑一次，值相同、无副作用。
        const goal = Number(this.data.goal) || WATER_GOAL;
        const n = Math.max(0, Math.min(goal, Number(v) || 0));
        if (n !== this.data.wcur) this.setData({ wcur: n });
      },
    },
    // 每日目标（ml）。默认取 utils/const.js 的唯一来源，页面也可以显式传。
    goal: { type: null, value: WATER_GOAL },
  },

  data: {
    // 组件当前显示值。拖动中只改这一个字段。
    wcur: 0,
    // 按住中：只用于放大圆点、加深轨道底色（视觉反馈），不参与任何计算。
    wdrag: false,
  },

  lifetimes: {
    // ready：视图层布局完成后触发，这时候量的轨道宽度才是真的。
    // （attached 时节点已建但可能还没排完版，量出来是 0。）
    ready() {
      this.measureTrack();
    },
  },

  methods: {
    // 量轨道在屏幕上的位置与宽度。每次按下会再量一次，
    // 横竖屏切换 / 键盘弹起后也不会一直用旧值。
    measureTrack() {
      const that = this;
      try {
        wx.createSelectorQuery()
          .in(this)
          .select('.wtrack')
          .boundingClientRect(function (r) {
            if (r && r.width) {
              that._twLeft = r.left;
              that._twWidth = r.width;
            }
          })
          .exec();
      } catch (e) {
        /* 量不到就等下一次按下再量 */
      }
    },

    // 手指位置 → 饮水量：按 goal/40 一档吸附（默认 50ml，共 40 档）。
    applyTouch(e) {
      const t = e.touches && e.touches[0];
      if (!t || !this._twWidth) return;
      const goal = Number(this.data.goal) || WATER_GOAL;
      const step = goal / 40;
      const ratio = (t.clientX - this._twLeft) / this._twWidth;
      const snapped = Math.round((ratio * goal) / step) * step;
      const v = Math.max(0, Math.min(goal, snapped));
      if (v === this.data.wcur) return;   // 去重：同一档不重复 setData
      this.setData({ wcur: v });
    },

    onWaterStart(e) {
      this._wOn = true;
      this.measureTrack();          // 异步重量（这次先用 ready 量到的值兜底）
      this.setData({ wdrag: true });
      this.applyTouch(e);
    },

    onWaterMove(e) {
      if (!this._wOn) return;
      this.applyTouch(e);
    },

    onWaterEnd() {
      if (!this._wOn) return;
      this._wOn = false;
      this.setData({ wdrag: false });
      // 落库交给页面：组件不碰存储，也不关心存在哪里。
      this.triggerEvent('change', { ml: this.data.wcur });
    },
  },
});
