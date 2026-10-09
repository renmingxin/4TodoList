// components/fq-plan/fq-plan.js
// 一张计划卡。纯展示：点一下就把「我要编辑这一张」告诉页面，自己不改任何东西。
//
// 内容（label / dateShort / text）全部由页面按选中日期算好传进来 ——
// 「今天 / 明天 / 这天 / 次日」这套文案随日期变，属于页面知道的上下文（今天是几号），
// 组件不该自己拿系统时间去推一遍（那样就有了两份「今天」）。
//
// ⚠️ 方法名 onEdit 与 WXML 里的 bindtap="onEdit" 对应；对外事件叫 edit。
//    这对名字由 .workbuddy/tools/event-check.js 守（它一次性抓到过 5 个死按钮）。
//
// 组件化三条硬约定（见 README「组件分层」）：
//   virtualHost / apply-shared / 数据走 properties、交互走 triggerEvent。

Component({
  options: {
    virtualHost: true,
    styleIsolation: 'apply-shared',
  },

  properties: {
    // 'day'（选中那天） | 'next'（次日）—— 决定色条颜色与图标
    kind: { type: null },
    // '今天要做什么' / '明天准备做什么' / '这天要做什么' …
    label: { type: null },
    // '10/9'
    dateShort: { type: null },
    // 计划正文。空串表示还没写。
    text: { type: null },
    // 空态占位文案
    placeholder: { type: null },
  },

  methods: {
    // 两张卡共用一个出口，页面靠 e.detail.kind 分辨是哪一张
    // （与 fq-tabbar / fq-cal 同一套形状：把被点元素的 dataset 原样交出去）。
    onEdit(e) {
      this.triggerEvent('edit', e.currentTarget.dataset);
    },
  },
});
