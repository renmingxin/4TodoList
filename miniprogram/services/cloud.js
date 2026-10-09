// miniprogram/services/cloud.js
// 与云函数 fqTodo 的唯一通道。
//
// 为什么单独成文件：
//   它是「云函数是唯一数据出口」这条铁律在客户端这一侧的唯一落点 ——
//   全项目只有这里会出现 wx.cloud.callFunction，别处一律通过它。
//   集中之后，「哪些 action 算写操作」「错误文案怎么翻译成人话」
//   这两个跨全项目的判断才有唯一事实来源。
//
// 本文件不持有任何页面状态。write 计数是**协议侧**的记账（同步避让要用），
// 所以留在这里而不是页面里 —— 页面只是它的读者。

const { WRITE_ACTIONS } = require('../utils/const.js');

// 正在途中的写操作数量。页面 syncTick 读到 >0 就让自动同步让路。
//
// 为什么计数要跟着 callCloud 走，而不是散在页面的 commit() 里：
//   凡是发出写请求的地方都必须记一笔，漏一个就是「乐观更新被同步冲掉」
//   这类偶发抖动。把记账钉在唯一的出口上，就没有漏的机会。
let pendingWrites = 0;

// 只读暴露：页面需要知道「现在能不能让同步过来」。
// 不直接导出数字或对象 —— 那样导出的是**值**的快照，页面上永远读到 0。
function pendingWriteCount() {
  return pendingWrites;
}

// 云函数调用。第二个参数是 action 之外的载荷，会被摊平进 data。
function callCloud(action, payload) {
  const isWrite = WRITE_ACTIONS.indexOf(action) >= 0;
  if (isWrite) pendingWrites++;
  // 成功失败都要减，否则一次网络异常会让自动同步永远让路（静默停摆，很难查）
  function settle() {
    if (isWrite && pendingWrites > 0) pendingWrites--;
  }
  return wx.cloud
    .callFunction({
      name: 'fqTodo',
      data: Object.assign({ action: action }, payload || {}),
    })
    .then(function (res) {
      const r = res && res.result;
      if (!r || !r.ok) {
        throw new Error((r && r.msg) || '操作失败');
      }
      return r.data;
    })
    .catch(function (err) {
      const msg = (err && err.errMsg) || (err && err.message) || '网络异常';
      if (msg.indexOf('FunctionName parameter could not be found') >= 0) {
        throw new Error('云函数 fqTodo 尚未部署');
      }
      if (msg.indexOf('Environment not found') >= 0) {
        throw new Error('云开发环境不存在，请检查 app.js 的 env');
      }
      // 云端回「未知 action」几乎只有一个成因：本地改了 action 清单、云函数没重新部署。
      // 翻译成能照做的提示，原消息附在后面便于排查。
      if (msg.indexOf('未知 action') >= 0) {
        throw new Error('云函数版本过旧（' + msg + '），请重新上传部署 fqTodo');
      }
      throw new Error(err && err.message ? err.message : msg);
    })
    .then(
      function (v) {
        settle();
        return v;
      },
      function (e) {
        settle();
        throw e;
      }
    );
}

module.exports = {
  callCloud: callCloud,
  pendingWriteCount: pendingWriteCount,
};
