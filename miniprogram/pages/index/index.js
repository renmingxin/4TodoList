// pages/index/index.js
// 四象限事项中心 · 单页状态机
//
// 视图状态完全在内存里切换（overview / detail / all / mine），不走路由，
// 这样象限详情可以继承象限色铺满整屏，也不会出现 tabBar 闪烁。
//
// 数据源：云函数 fqTodo（唯一出口）。本地只做一次内存镜像 + 乐观更新，
// 每次改动先改本地立即重绘，再异步落库；落库失败回滚到服务端状态。

// 象限文案唯一来源：QUADS 是列表，QUAD_MAP 是按 key 查
const QUADS = [
  { key: 'q1', name: '重要且紧急', hint: '立刻做' },
  { key: 'q2', name: '不重要但紧急', hint: '授权出去' },
  { key: 'q3', name: '重要不紧急', hint: '排进日程' },
  { key: 'q4', name: '不重要也不紧急', hint: '划掉它' },
];

const QUAD_MAP = QUADS.reduce(function (m, q) {
  m[q.key] = q;
  return m;
}, {});

// 布局常量（单位 rpx），与 index.wxss 顶部注释里的同名常量一一对应。
// 改用 flex 布局后，只有 TAB_H 还参与计算（算 FAB 的 bottom 偏移），
// 其余保留是为了让 WXSS 里的固定高度有个单一说明来源。
const LAYOUT = {
  NAV_H: 88,
  CATS_H: 88,
  STATS_H: 112,
  TAB_H: 120,
  BOTTOM_H: 134,
  // 拖动排序用：.row 的 margin-bottom，以及左滑面板的宽度
  ROW_GAP: 16,
  SWIPE_W: 240,     // 左滑面板：完成 / 删除 各 120rpx，两种视图一致
  // 「拖到屏幕边缘、列表自己滚」用（单位 px，不是 rpx —— 这里比的是 clientY）：
  // DRAG_EDGE = 距滚动区上下边多少像素算进入边缘区；AS_STEP / AS_TICK = 每拍滚多远、隔多久。
  DRAG_EDGE: 96,
  AS_STEP: 14,
  AS_TICK: 40,
};

// 排序用的稀疏步长：每次重排都写成 0 / 10 / 20…，留出插入空间也便于人工核对
const ORDER_STEP = 10;
// 一次重排最多提交多少条（云函数侧同样有上限）
const REORDER_CAP = 200;

// 云函数协议版本，必须与 cloudfunctions/fqTodo/index.js 的 FN_VER 相等。
// 云函数新增/删除 action 时两边一起 +1，首屏握手就能发现「云端还是旧包」。
// v3：引入共享家庭（归属键从 _openid 变成 fid），新增 sync / 家庭管理系列 action。
// v4：分类支持删除与改名，新增 removeCategory / renameCategory。
// v5：提醒推送，新增 grantSub（攒订阅额度）；保存带提醒的事项时顺手请求一次授权。
const FN_VER = 5;
// 握手弹窗只弹一次，别每次 load 都糊用户一脸
let fnVerWarned = false;

// 自动同步的轮询间隔。页面可见时每 8 秒问一次「家庭数据变了没」，
// 云函数只回一个 rev 数字，没变就是几十字节。
// 为什么不用客户端 watch()：那要求把集合读权限放开给客户端，等于破掉
// 「云函数是唯一数据出口」这条底线（见云函数头部铁律二）。两人用，轮询完全够。
const SYNC_MS = 8000;

// 这些 action 会改数据。计数是为了让自动同步给它们让路 ——
// 本地已经改完、页面也重绘了，但云端还没落库，这时如果同步把服务端快照拉回来覆盖，
// 用户会看到自己刚点的那一下被弹回去（几秒后才自愈，属于最招人烦的那类抖动）。
const WRITE_ACTIONS = [
  'addItem', 'updateItem', 'removeItem', 'reorder', 'bulk', 'clearDone', 'clearAll',
  'addCategory', 'removeCategory', 'renameCategory',
  'genInvite', 'joinFamily', 'leaveFamily', 'renameMember', 'renameFamily',
  // grantSub 也改云端状态（额度）。它不在数据快照里，但同样要占住
  // pendingWrites —— 否则同步回来的 sub 会把这刚攒的那条盖回旧值。
  'grantSub',
];
let pendingWrites = 0;

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ---------------- 纯函数工具 ---------------- */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function todayMeta() {
  const d = new Date();
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
}

// 明天 09:00 / 今天 18:30 / 9月30日 09:00
function remindText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayX = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((dayX - day0) / 86400000);
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (diff === 0) return '今天 ' + hm;
  if (diff === 1) return '明天 ' + hm;
  if (diff === 2) return '后天 ' + hm;
  if (diff === -1) return '昨天 ' + hm;
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hm;
}

function remindDayShort(dateStr, timeStr) {
  // dateStr: 'YYYY-MM-DD'
  const p = String(dateStr).split('-');
  const target = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((target.getTime() - day0) / 86400000);
  if (diff === 0) return '今天 ' + timeStr;
  if (diff === 1) return '明天 ' + timeStr;
  if (diff === 2) return '后天 ' + timeStr;
  return Number(p[1]) + '月' + Number(p[2]) + '日 ' + timeStr;
}

// 手动拼 Date，避免 iOS 对 'YYYY-MM-DDTHH:mm' 解析不一致
function toTimestamp(dateStr, timeStr) {
  const dp = String(dateStr).split('-');
  const tp = String(timeStr).split(':');
  const y = Number(dp[0]);
  const mo = Number(dp[1]) - 1;
  const d = Number(dp[2]);
  const h = Number(tp[0]);
  const mi = Number(tp[1]);
  if (!y || mo < 0 || !d) return null;
  const out = new Date(y, mo, d, isNaN(h) ? 9 : h, isNaN(mi) ? 0 : mi, 0, 0);
  return out.getTime();
}

/* ---------------- 云函数调用 ---------------- */

// 邀请码归一化：大写、去空格与连字符。手抄来的码经常带空格或写成小写，
// 与其让用户自己对齐格式，不如两边都归一（云函数侧有一份同样的 toCode）。
function normCode(v) {
  return String(v == null ? '' : v)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .slice(0, 16);
}

// 邀请码入口那一行字：没生成 / 可复制 / 已过期。
// 非创建者拿到的 inviteCode 是空串（云函数只把码回给创建者），
// 所以这里天然只会给创建者出文案，不用再判一次身份。
function inviteLabel(f) {
  if (!f || !f.isOwner) return '';
  if (f.inviteCode && Number(f.inviteExpire) > Date.now()) {
    return '邀请码 ' + f.inviteCode + '（点击复制）';
  }
  if (f.inviteCode) return '邀请码已过期，点击重新生成';
  return '生成邀请码';
}

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

/* ---------------- Page ---------------- */

Page({
  data: {
    // 布局
    ready: false,
    statusBarHeight: 20,
    capsuleReserve: 100,
    safeBottom: 0,
    fabBottom: 80,
    // 视图
    view: 'overview',
    pageTitle: '四象限',
    pageMeta: '',
    // 总览
    catTabs: [],
    stats: [],
    grid: [],
    // 详情
    quad: 'q1',
    quadName: '',
    quadHint: '',
    quadUndone: 0,
    quadCap: '',
    filters: [],
    filt: 'all',
    rows: [],
    // 全部
    sections: [],
    // 我的
    mineStats: [],
    catRows: [],
    // 分类管理（长按分类行呼出）。catMenuId 记的是**被长按的那个分类**，
    // 不是 state.catId —— 两者经常不是同一个，拿错了就会删错行。
    catMenuId: '',
    catDelCount: 0,   // 该分类下有多少条事项，决定删除走哪条分支
    catCanDel: false, // 空分类谁都可删；非空分类只有家庭创建者可删（云函数侧同一把尺子）
    moveRows: [],     // 删除非空分类时可选的「事项新家」
    // 家庭（共享清单）。服务端给什么就显示什么，客户端只读不改。
    fam: {
      id: '',
      name: '我的家庭',
      role: 'owner',
      isOwner: true,
      memberCount: 1,
      members: [],
      inviteCode: '',
      inviteExpire: 0,
      rev: 0,
    },
    famRev: 0,
    // 提醒推送（v5）。quota = 还能发几条，missed = 有几条到点了没发出去。
    // 两个数都由服务端算好下发，客户端只负责显示 —— 它数不准：
    // 额度会被定时任务消耗掉，而「未送达」的判定本身就在云端。
    subQuota: 0,
    subMissed: 0,
    // 邀请码入口的那行字：生成 / 已生成可复制 / 已过期
    famInviteLabel: '生成邀请码',
    // 滑动
    swipeKey: '',
    swipeX: 0,
    dragging: false,
    // 排序模式：由列表上方的「调整顺序」按钮开启。
    // 开启后只允许拖动卡片 —— 点卡片不编辑、左滑不展开、筛选与详情菜单被锁住。
    sortMode: false,
    // 只在「点调整顺序」那一刻为真，380ms 后摘掉：卡片抖一下作模式信号的
    // 一次性开关。单独放一个字段而不是直接挂在 sortMode 上，是因为动画由 class
    // 驱动，只要 class 不变就不会重放 —— 而 sortMode 在整段拖动期间一直是 true。
    sortPulse: false,
    // 拖动排序：dragY 每帧只推这一个数字，位移由 shift 承担（仅在跨行时更新）
    dragId: '',
    dragY: 0,
    dragOn: false,
    dropQuad: '',
    // 主滚动区的目标位置。平时完全不碰它 —— 用户怎么滚都行，bindscroll 只更新
    // 内部镜像值（this._scrollTop），不 setData；只有「拖到屏幕边缘自动滚动」
    // 才会推它，把列表带着走（见 runAutoScroll）。
    scrollTop: 0,
    // 抽屉
    sheetOpen: false,
    sheetKind: 'form',
    sheetTitle: '',
    sheetSub: '',
    sheetDone: false,   // 编辑一条已完成事项时，抽屉里多给一个「标记为未完成」
    qpicks: [],
    catPills: [],
    priPills: [],
    form: {
      id: '',
      title: '',
      note: '',
      quad: 'q1',
      priority: 3,
      catId: '',
      date: '',
      time: '09:00',
      hasRemind: false,
      dateLabel: '不提醒',
    },
    saveLabel: '保存',
  },

  /* ================= 生命周期 ================= */

  onLoad(options) {
    this.cats = [];   // 服务端分类镜像
    this.items = [];  // 服务端事项镜像
    // 家庭信息与数据版本号。同样放内存镜像：syncTick 每 8 秒要用 rev 做一次比对，
    // 放 data 里会白白走一层 setData。
    this.fam = null;
    this.rev = 0;
    this.state = { view: 'overview', catId: '', quad: 'q1', filt: 'all' };
    this._drag = null;        // 左滑手势状态
    this._dg = null;          // 拖动排序状态（量的行位置、起止下标）
    this._dgY0 = 0;
    // 「量行位置还在路上」的闸。measureRows 是异步的，回调落地前 _dg 一直是空的，
    // 而 onRowMove 在每个 touchmove 上都会再喊一次 startDrag —— 见那里的说明。
    this._dgP = null;
    // 拖动代号：量行位置是异步的，回调回来时要能判断「这次拖动还算不算数」。
    // 见 startDrag 里的僵尸拖动说明 —— 这是「滚动时卡片乱跳/消失」的根因。
    this._dragSeq = 0;
    // 滚动同步。_scrollTop 是滚动区真实位置的内存镜像（bindscroll 更新，不进 data）；
    // _scBand 是滚动区在屏幕上的上下边界（量一次就固定，之后列表怎么滚它都不变）。
    this._scrollTop = 0;
    this._scBand = null;
    this._asTimer = null;     // 「拖到边缘自动滚」的定时器
    this._syncTimer = null;   // 自动同步轮询的定时器
    // 分享卡片带进来的邀请码（path 里挂 ?code=XXXXXX）。
    // 存下来等首屏加载完再处理 —— onLoad 时还没拿到家庭信息，直接加入会打断首屏。
    this._invite = normCode((options && (options.code || options.inviteCode)) || '');
    // 订阅消息模板 id。由 bootstrap 下发，客户端**不硬编码一份** ——
    // 换模板时只要改云函数那一处，客户端跟着走。
    this.subTpl = '';

    this.measure();
    this.load();
  },

  onShow() {
    // 页面回到前台：先拉一次最新（可能家人刚改过），再把轮询开起来。
    // 首次进入时 onLoad 的 load() 还在路上，跳过这次重复请求。
    if (this.data.ready) this.load();
    this.startSync();
  },

  onHide() {
    // 离开页面就停轮询。后台轮询既费额度也没有意义。
    this.stopSync();
  },

  onUnload() {
    this.stopSync();
  },

  onPullDownRefresh() {
    this.load().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  /* ================= 布局测量 ================= */

  measure() {
    let win;
    try {
      win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (e) {
      win = wx.getSystemInfoSync();
    }

    const width = win.windowWidth || win.screenWidth || 375;
    const screenH = win.screenHeight || win.windowHeight || 667;
    const statusBarHeight = win.statusBarHeight || 20;
    const safeArea = win.safeArea || { bottom: screenH };
    const safeBottom = Math.max(0, screenH - safeArea.bottom);

    // rpx → px
    const rf = width / 750;
    this.rf = rf;

    // 右下角胶囊避让：自绘导航的右侧内容必须让出胶囊区域
    let reserve = width - 96;
    try {
      const rect = wx.getMenuButtonBoundingClientRect();
      if (rect && rect.left) {
        reserve = width - rect.left + 8;
      }
    } catch (e) {
      /* 取不到就用兜底值 */
    }

    this.screenH = screenH;
    this.statusBarHeight = statusBarHeight;
    this.safeBottom = safeBottom;

    this.setData(
      {
        statusBarHeight: statusBarHeight,
        capsuleReserve: Math.round(reserve),
        safeBottom: safeBottom,
      },
      function () {
        this.recalcFab();
      }.bind(this)
    );
  },

  /* 底部 tab / 主按钮靠 .screen 的纵向 flex 天然贴底，这里只算 FAB 的悬浮偏移。
     早期版本还在这里算 scrollerH 并内联给 scroll-view，但 Android 的 screenHeight
     含底部虚拟导航条，算出来偏大就会把 tabbar 顶出屏幕 ——
     表现为「tab 不贴底 + 图标被压扁」，已改为 flex 布局。 */
  recalcFab() {
    this.setData({
      fabBottom: Math.round((LAYOUT.TAB_H + 36) * this.rf + this.safeBottom),
    });
  },

  /* ================= 数据加载 ================= */

  load() {
    const that = this;
    return callCloud('bootstrap')
      .then(function (data) {
        that.cats = data.categories || [];
        that.items = data.items || [];
        that.adoptFamily(data.family);
        that.adoptSub(data.sub);
        // 换了家庭（刚加入 / 刚退出）之后，原来选中的分类在新家里根本不存在，
        // 必须重新落到第一个分类上 —— 否则首屏是一片空白，看着像「数据没了」。
        that.fixCatId();
        that.setData({ ready: true });
        that.render();
        that.checkFnVer(data);
        that.handlePendingInvite();
      })
      .catch(function (err) {
        that.setData({ ready: true });
        that.fatal(err.message);
      });
  },

  // 当前选中的分类必须真实存在于镜像里，否则回落到第一个
  fixCatId() {
    const cur = this.state.catId;
    const ok = this.cats.some(function (c) {
      return c._id === cur;
    });
    if (!ok && this.cats.length) this.state.catId = this.cats[0]._id;
  },

  // 服务端给的家庭信息落进内存镜像 + data。
  // 所有要用家庭信息的地方都走这里，免得两处状态各说各话。
  adoptFamily(f) {
    if (!f) return;
    this.fam = f;
    this.rev = Number(f.rev) || 0;
    this.setData({ fam: f, famRev: this.rev, famInviteLabel: inviteLabel(f) });
  },

  // 服务端给的提醒额度与未送达数。
  adoptSub(s) {
    if (!s) return;
    if (s.templateId) this.subTpl = s.templateId;
    this.setData({
      subQuota: Math.max(0, Number(s.quota) || 0),
      subMissed: Math.max(0, Number(s.missed) || 0),
    });
  },

  /* 请求一次订阅授权，用户点了「允许」才回来记账。
     个人主体只有一次性订阅：一次允许 = 一条发送权，攒够几条就能发几条。
     用户勾过「总是保持以上选择」之后，这里**不再弹窗**、但授权次数照常 +1，
     所以体感就是「点一下保存就完事」。 */
  askSubscribe() {
    const tpl = this.subTpl;
    if (!tpl || !wx.requestSubscribeMessage) return;  // 首屏还没回来就静默跳过
    const that = this;
    wx.requestSubscribeMessage({
      tmplIds: [tpl],
      success(res) {
        // 只有 accept 才算攒到一条。reject（用户点了拒绝）/ ban（被后台限制）
        // / filter 都不给额度 —— 给了的话，第 N 次发送会被微信直接拒掉。
        if (res && res[tpl] === 'accept') that.grantQuota();
      },
      fail() {
        // 环境不支持或调用被限，当没发生过。提醒本身已经存下了，
        // 只是这次没攒到额度 —— 界面上那行「未送达」会如实反映。
      },
    });
  },

  grantQuota() {
    const that = this;
    const tpl = this.subTpl;
    if (!tpl) return;
    callCloud('grantSub', { templateId: tpl })
      .then(function (data) {
        if (data) that.setData({ subQuota: Math.max(0, Number(data.quota) || 0) });
      })
      .catch(function () {
        // 记不上账不打扰用户：下一条带提醒的事项保存时再攒
      });
  },

  // 点了「N 条提醒未送达」：说清楚为什么，以及怎么补。
  // 这里只解释、不代劳 —— 额度只能在用户真正保存一条带提醒的事项时攒，
  // 单独开个按钮去 requestSubscribeMessage 属于「无触发场景的订阅」，微信不认。
  onExplainMissed() {
    const n = this.data.subMissed;
    wx.showModal({
      title: '为什么没送达',
      content:
        '微信的一次性订阅：点一次「允许」才有一条推送权，用完就没。\n\n' +
        '这 ' + n + ' 条提醒到点的时候额度不够，所以没发出来。\n\n' +
        '下次保存带提醒的事项时点「允许」，就能继续攒额度。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  // 从分享卡片进来（path 里挂 ?code=XXXXXX）：首屏加载完自动尝试加入，
  // 省掉让家人手抄 6 位码再手动输入这一步。
  handlePendingInvite() {
    const code = this._invite;
    if (!code) return;
    this._invite = '';
    this.doJoin(code, true);
  },

  /* ================= 自动同步 =================
     共享清单的核心体验是「家人改了，我这边不用手动刷」。
     做法是轮询：每 SYNC_MS 带着本地 rev 问一次云函数，没变就只回一个数字。
     为什么不用云数据库的 watch() 做真·推送：watch 要求把集合读权限放开给客户端，
     等于把「云函数是唯一数据出口」这条底线破掉 —— 为一个几秒的延迟改善，
     换一个「任何人可遍历全库」的口子，不划算。
     真要上推送，正确顺序是**先给集合配自定义安全规则**（语法与限制需核实官方文档、
     注意 get() 只能按文档 ID 精确取，所以成员记录得用 openid 当文档 _id），
     再用 watch，不要跳步。 */
  startSync() {
    const that = this;
    this.stopSync();
    this._syncTimer = setInterval(function () {
      that.syncTick();
    }, SYNC_MS);
  },

  stopSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  },

  syncTick() {
    if (!this.data.ready) return;
    // 三种情况下不拉：还没首屏、正在拖排序、本地还有没落库的写。
    // 后两种会把用户手上的操作冲掉（乐观更新被服务端快照覆盖，看着像「点不动」）。
    if (this.data.sortMode || pendingWrites > 0 || this.data.sheetOpen) return;
    const that = this;
    callCloud('sync', { rev: this.rev })
      .then(function (data) {
        if (!data || !data.changed) return;
        that.cats = data.categories || [];
        that.items = data.items || [];
        that.adoptFamily(data.family);
        that.adoptSub(data.sub);
        that.fixCatId();
        that.render();
      })
      .catch(function () {
        // 同步失败静默：下一轮再来。共享清单是「尽量及时」而不是「必须实时」，
        // 为一次失败弹 toast 只会打扰用户。
      });
  },

  // 版本握手：bootstrap 会带回云端的协议版本。
  // 云端没带 fnVer（旧包）或版本对不上，就把「重新部署」直接说清楚 ——
  // 否则要等用户拖一次列表、看到「未知 action: reorder」才知道云函数没上传。
  // 只提示、不阻断：旧包大部分功能仍可用，没必要把人挡在门外。
  checkFnVer(data) {
    if (fnVerWarned) return;
    const got = data ? data.fnVer : undefined;
    if (got === FN_VER) return;
    fnVerWarned = true;
    wx.showModal({
      title: '云函数版本过旧',
      content:
        '本端需要 fqTodo v' + FN_VER + '，云端当前是 ' +
        (got === undefined ? '旧版本（未上报版本号）' : 'v' + got) +
        '。\n\n解决：左侧展开 cloudfunctions 目录 → 右键 fqTodo → ' +
        '「上传并部署：云端安装依赖」，完成后重新编译。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  fatal(msg) {
    const that = this;
    // 首次运行最常见的两类报错，直接把「怎么办」写进弹窗，省得回头查文档
    let hint = '';
    if (msg.indexOf('尚未部署') >= 0) {
      hint =
        '\n\n解决：① 开发者工具左侧展开 cloudfunctions 目录' +
        '\n② 右键 fqTodo → 「上传并部署：云端安装依赖」' +
        '\n③ 回模拟器点「重试」';
    } else if (msg.indexOf('环境') >= 0) {
      hint = '\n\n解决：确认 app.js 里的 env 与云开发控制台的环境 ID 完全一致。';
    }
    wx.showModal({
      title: '加载失败',
      content: msg + hint,
      confirmText: '重试',
      cancelText: '知道了',
      success(res) {
        if (res.confirm) {
          that.setData({ ready: false });
          that.load();
        }
      },
    });
  },

  /* ================= 派生数据（视图模型） ================= */

  catName(id) {
    for (let i = 0; i < this.cats.length; i++) {
      if (this.cats[i]._id === id) return this.cats[i].name;
    }
    return '未分类';
  },

  // 当前分类下的全部事项
  scoped() {
    const cid = this.state.catId;
    return this.items.filter(function (it) {
      return !cid || it.catId === cid;
    });
  },

  inQuad(quad, onlyUndone) {
    return this.scoped().filter(function (it) {
      if (it.quad !== quad) return false;
      if (onlyUndone && it.done) return false;
      return true;
    });
  },

  // 当前筛选下，「可见的那几项」在完整列表里的下标。
  // 拖动排序只改可见项的相对顺序，隐藏项（如筛选「待办」时的已完成项）
  // 原地不动 —— 否则一拖动就会把它们挤到别处。
  visibleIdx(full) {
    const f = this.state.filt;
    const identity = this.state.view !== 'detail' || f === 'all';
    const out = [];
    for (let i = 0; i < full.length; i++) {
      if (identity) out.push(i);
      else if (f === 'todo' && !full[i].done) out.push(i);
      else if (f === 'done' && full[i].done) out.push(i);
    }
    return out;
  },

  rowVM(it) {
    return {
      _id: it._id,
      q: it.quad,
      done: !!it.done,
      title: it.title,
      note: it.note || '',
      priLabel: 'P' + it.priority,
      catName: this.catName(it.catId),
      remindText: remindText(it.remindAt),
      // 拖动排序时其他卡片的让位位移（px）。始终给数字，
      // 否则 WXML 会渲染出 translateY(px) 这种非法值。
      shift: 0,
    };
  },

  buildCatPills() {
    const that = this;
    const cur = this.state.catId;
    return this.cats.map(function (c) {
      return {
        id: c._id,
        name: c.name,
        count: that.items.filter(function (it) {
          return it.catId === c._id;
        }).length,
        on: c._id === cur,
      };
    });
  },

  buildStats() {
    const list = this.scoped();
    let undone = 0;
    let done = 0;
    let remind = 0;
    list.forEach(function (it) {
      if (it.done) done++;
      else undone++;
      if (it.remindAt && !it.done) remind++;
    });
    return [
      { k: '总计', v: list.length },
      { k: '待办', v: undone },
      { k: '已完成', v: done },
      { k: '待提醒', v: remind },
    ];
  },

  buildGrid() {
    const that = this;
    return QUADS.map(function (q, i) {
      const list = that.inQuad(q.key, true);
      let lines = [];
      let empty = false;
      if (!list.length) {
        empty = true;
      } else {
        lines = list.slice(0, 2).map(function (it, n) {
          return { idx: n, text: it.title, more: false };
        });
        if (list.length > 2) {
          lines.push({ idx: 2, text: '还有 ' + (list.length - 2) + ' 项', more: true });
        }
      }
      return {
        key: q.key,
        name: q.name,
        hint: q.hint,
        count: list.length,
        lines: lines,
        empty: empty,
        // 第二行（q3/q4）不再留底边距，避免矩阵下方多出一截空隙
        nb: i >= 2,
      };
    });
  },

  buildFilters() {
    const all = this.inQuad(this.state.quad, false);
    let undone = 0;
    all.forEach(function (it) {
      if (!it.done) undone++;
    });
    const cur = this.state.filt;
    return [
      { k: 'all', label: '全部 ' + all.length, on: cur === 'all' },
      { k: 'todo', label: '待办 ' + undone, on: cur === 'todo' },
      { k: 'done', label: '已完成 ' + (all.length - undone), on: cur === 'done' },
    ];
  },

  buildRows() {
    const that = this;
    const all = this.inQuad(this.state.quad, false);
    const f = this.state.filt;
    const list = all.filter(function (it) {
      if (f === 'todo') return !it.done;
      if (f === 'done') return !!it.done;
      return true;
    });
    return list.map(function (it) {
      return that.rowVM(it);
    });
  },

  buildSections() {
    const that = this;
    return QUADS.map(function (q) {
      const list = that.inQuad(q.key, false);
      return {
        key: q.key,
        name: q.name,
        count: list.length,
        rows: list.map(function (it) {
          return that.rowVM(it);
        }),
      };
    }).filter(function (s) {
      return s.count > 0;
    });
  },

  buildCatPillsForSheet(curId) {
    return this.cats.map(function (c) {
      return { id: c._id, name: c.name, on: c._id === curId };
    });
  },

  buildQpicks(cur) {
    return QUADS.map(function (q) {
      return { key: q.key, name: q.name, hint: q.hint, sel: q.key === cur };
    });
  },

  buildPriPills(cur) {
    const out = [];
    for (let p = 1; p <= 4; p++) {
      out.push({ p: p, on: p === cur });
    }
    return out;
  },

  /* ================= 渲染 ================= */

  render() {
    const v = this.state.view;
    const patch = { view: v };

    if (v === 'overview') {
      patch.catTabs = this.buildCatPills();
      patch.stats = this.buildStats();
      patch.grid = this.buildGrid();
      patch.pageTitle = '四象限';
      patch.pageMeta = todayMeta() + ' · ' + this.catName(this.state.catId);
    } else if (v === 'detail') {
      const q = this.state.quad;
      let undone = 0;
      const all = this.inQuad(q, false);
      all.forEach(function (it) {
        if (!it.done) undone++;
      });
      patch.quad = q;
      patch.quadName = QUAD_MAP[q].name;
      patch.quadHint = QUAD_MAP[q].hint;
      patch.quadUndone = undone;
      patch.quadCap = '项待办 · 当前分类「' + this.catName(this.state.catId) + '」';
      patch.filters = this.buildFilters();
      patch.filt = this.state.filt;
      patch.rows = this.buildRows();
    } else if (v === 'all') {
      patch.sections = this.buildSections();
      patch.pageTitle = '全部事项';
      patch.pageMeta = '按象限分段 · ' + this.catName(this.state.catId);
    } else if (v === 'mine') {
      const items = this.items;
      let done = 0;
      let remind = 0;
      items.forEach(function (it) {
        if (it.done) done++;
        if (it.remindAt && !it.done) remind++;
      });
      patch.mineStats = [
        { k: '总计', v: items.length },
        { k: '待办', v: items.length - done },
        { k: '已完成', v: done },
        { k: '待提醒', v: remind },
      ];
      const that = this;
      patch.catRows = this.cats.map(function (c) {
        return {
          id: c._id,
          name: c.name,
          count: items.filter(function (it) {
            return it.catId === c._id;
          }).length,
          on: c._id === that.state.catId,
        };
      });
      patch.pageTitle = '我的';
      patch.pageMeta = '数据已同步至云端';
    }

    // 切视图时收掉滑开状态与拖动状态，避免残留
    patch.swipeKey = '';
    patch.swipeX = 0;
    patch.dragId = '';
    patch.dragY = 0;
    patch.dragOn = false;
    patch.dropQuad = '';

    this.applyStatusBarText();
    // FAB 的偏移只跟 tab 高度和安全区有关，与当前视图无关，不必每次渲染重算
    this.setData(patch);
  },

  // 详情态整屏是象限色，状态栏文字需要切成白色才能读
  applyStatusBarText() {
    const dark = this.state.view !== 'detail';
    try {
      wx.setNavigationBarColor({
        frontColor: dark ? '#000000' : '#ffffff',
        backgroundColor: '#000000',
        fail() {},
      });
    } catch (e) {
      /* 自定义导航下部分端不支持，忽略 */
    }
  },

  /* ================= 通用操作包装 ================= */

  // 本地先改、再落库；落库失败就把服务端状态拉回来
  commit(mutate, promise) {
    mutate();
    this.render();
    const that = this;
    promise.catch(function (err) {
      wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
      that.load();
    });
  },

  /* ================= 交互：视图切换 ================= */

  onTab(e) {
    const key = e.currentTarget.dataset.k;
    if (key === this.state.view) return;
    this.state.view = key;
    this.state.filt = 'all';
    this.exitSort();
    this.render();
  },

  onOpenQuad(e) {
    this.state.quad = e.currentTarget.dataset.k;
    this.state.filt = 'all';
    this.state.view = 'detail';
    this.exitSort();
    this.render();
  },

  onBack() {
    this.state.view = 'overview';
    this.exitSort();
    this.render();
  },

  onFilter(e) {
    if (this.data.sortMode) return; // 排序模式下筛选被锁
    this.state.filt = e.currentTarget.dataset.k;
    this.render();
  },

  onPickCat(e) {
    this.state.catId = e.currentTarget.dataset.k;
    this.render();
  },

  onGotoMine() {
    this.state.view = 'mine';
    this.exitSort();
    this.render();
  },

  /* ================= 交互：排序模式 =================
     为什么要有独立的排序模式（而不是长按直接拖）：
     长按可以把手势分开，但没有任何视觉提示，新用户发现不了；
     「整屏按下即拖」则更糟 —— 列表再也滚不动了（拖动和滚动抢同一串 touchmove）。
     折中方案 = 显式的模式开关 + 卡片右侧的拖动手柄：
     点「调整顺序」进入，期间**只有手柄**能拖卡片，卡片其余区域照常滚列表；
     底部换成固定的「完成」条，随时可退出。
     （早期版本是把 scroll-y 关掉来避免冲突，代价是排序模式完全不能滚；
       现在把两种手势分派到不同元素上，两个都要。） */

  onSortToggle() {
    const next = !this.data.sortMode;
    // 切换模式时把可能存在的拖动状态一起丢掉：留着 _dg 就是一个「僵尸拖动」，
    // 之后的每一次 touchmove 都会被 applyDragMove 吃掉（见 startDrag 的说明）。
    this._dg = null;
    this._drag = null;
    this.stopAutoScroll();
    if (next) {
      // 进入排序模式的反馈：一次轻震动 + 卡片整体抖一下（.row.pulse 的动画）。
      // 抖动只在「点调整顺序」这一下发生，拖动过程中不抖。
      try {
        wx.vibrateShort({ type: 'light', fail() {} });
      } catch (e) {
        /* 部分端不支持柔和震动，忽略 */
      }
    }
    this.setData({
      sortMode: next,
      sortPulse: next,
      swipeKey: '',
      swipeX: 0,
      dragId: '',
      dragY: 0,
      dragOn: false,
      dropQuad: '',
    });
    // 抖动是一次性的：动画放完就把标记摘掉，否则后面任何一次 re-render
    // 都可能让这个 class 重新参与 diff，动画又放一遍。
    if (this._pulseT) {
      clearTimeout(this._pulseT);
      this._pulseT = null;
    }
    if (next) {
      const that = this;
      this._pulseT = setTimeout(function () {
        that._pulseT = null;
        if (that.data.sortPulse) that.setData({ sortPulse: false });
      }, 380);
    }
  },

  // 注意：render() 里不重置 sortMode —— 拖动结束会走 commitOrder → render()，
  // 若在那里重置，每拖一次就会被踢出排序模式。
  exitSort() {
    // 切视图时把拖动状态一并清掉。只把 sortMode 置假是不够的：
    // 万一量行位置的回调还在路上，它会补上一个 _dg —— 也就是僵尸拖动，
    // 之后每一次纵向手势都会被 applyDragMove 吃掉，用过期坐标重排整个列表。
    this._dg = null;
    this._drag = null;
    this.stopAutoScroll();
    if (this.data.sortMode) this.setData({ sortMode: false });
  },

  /* ================= 交互：滑动与卡片 ================= */

  onBlankTap() {
    if (this.data.swipeKey) {
      this.setData({ swipeKey: '', swipeX: 0 });
    }
  },

  // 左滑面板宽度：两种视图都是「完成 / 删除」两个操作
  swipeMax() {
    return LAYOUT.SWIPE_W;
  },

  onRowStart(e) {
    const ds = e.currentTarget.dataset;
    this._drag = {
      id: ds.id,
      sx: e.touches[0].clientX,
      sy: e.touches[0].clientY,
      base: this.data.swipeKey === ds.id ? this.data.swipeX : 0,
    };
    this._moved = false;
    // ⚠️ 这里刻意**不**推 dragging。
    //    dragging 唯一的作用是给这一行加「关掉过渡动画」的类，而它必须与第一帧位移
    //    同时到场才对。早先在 touchstart 就置真，等于每次碰卡片（点一下、想滚列表、
    //    按手柄）都白白触发一次全列表重渲染 —— 列表卡顿的一个大头。
    //    现在由 onRowMove 在第一次真正产生位移时，随位移一起推（同一个 setData）。
    //
    // 新一次手势开始，把上一轮的「量行位置在途」标记清掉，否则第二次拖动会被它挡住。
    this._dgP = null;
  },

  onRowMove(e) {
    const t = e.touches[0];
    if (!t) return;

    // 已经在拖：纵向移动全部归拖动排序
    if (this._dg) {
      this.applyDragMove(t.clientY);
      return;
    }

    // 排序模式：只有「从手柄上开始的手势」才算拖动（_drag.handle 由
    // onHandleStart 打上）。手指落在卡片别处时纵向移动就是滚列表 ——
    // 这里直接 return，事件继续冒泡给 scroll-view，什么都不用做。
    if (this.data.sortMode) {
      if (!this._drag || !this._drag.handle) return;
      const dy = t.clientY - this._drag.sy;
      const dx = t.clientX - this._drag.sx;
      if (Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
      this._moved = true; // 松手后别再触发 tap 进编辑
      this.startDrag(this._drag.id, t.clientY);
      return;
    }

    if (!this._drag) return;
    const dx = (t.clientX - this._drag.sx) / this.rf; // px → rpx
    if (Math.abs(dx) > 6) this._moved = true;
    const max = this.swipeMax();
    let x = this._drag.base + dx;
    if (x < -max) x = -max;
    if (x > 0) x = 0;
    // 单值 setData 节流：只推一个数字，不动列表。
    // 比较的基准必须是「这一行自己的当前位移」，不能直接拿 data.swipeX ——
    // 另一行正滑开着的时候，data.swipeX 是那一行的值，基准就错了。
    const prev = this.data.swipeKey === this._drag.id ? this.data.swipeX : 0;
    if (Math.abs(x - prev) < 5) return;
    // dragging 与第一帧位移必须同一个 setData 推上去：它是「这一行关掉过渡动画」
    // 的开关，早推没用、晚推会看到一帧回弹。合成一次也省掉一次全列表重渲染。
    this.setData({ dragging: true, swipeKey: this._drag.id, swipeX: x });
  },

  onRowEnd() {
    // 拖动排序收尾
    if (this._dg) {
      this.endDrag();
      return;
    }
    // 排序模式下不存在「滑开」这个状态。
    // 这里必须把拖动残留一起收干净，不能只清 dragOn：手指点一下就抬走时，
    // startDrag 已经把 dragId 推到视图层，而量行位置的回调还在路上（_dg 仍为空）。
    // 只清 dragOn 的话，那张卡片会一直挂着 .lift 的抬起阴影，像被粘住一样。
    if (this.data.sortMode) {
      this._drag = null;
      this._dg = null;
      this._dgP = null;
      this.stopAutoScroll();
      if (this.data.dragging || this.data.dragOn || this.data.dragId) {
        this.setData({ dragging: false, dragOn: false, dragId: '', dragY: 0 });
      }
      return;
    }
    // 兜底：没收到 touchstart 也要把动画恢复回来
    if (!this._drag) {
      if (this.data.dragging) this.setData({ dragging: false });
      return;
    }
    const id = this._drag.id;
    const x = this.data.swipeKey === id ? this.data.swipeX : 0;
    const max = this.swipeMax();
    this._drag = null;
    // 没滑过阈值就整个收掉 swipeKey：操作组是「按 swipeKey 存在」的条件渲染，
    // 留一个 swipeX=0 的 swipeKey，等于把 240rpx 的按钮组白白挂在 DOM 里。
    const open = x < -max * 0.45;
    this.setData({
      dragging: false,
      swipeKey: open ? id : '',
      swipeX: open ? -max : 0,
    });
  },

  /* ---- 拖动手柄：把「拖」从「滚」里摘出来 ----
     历史：排序模式一度把 scroll-y 关掉，理由是「卡片整块都能拖，拖动和滚动
     抢同一串 touchmove，同时开着就会一边滚一边重排卡片」—— 判断没错，
     但因此牺牲了排序模式下的滚动，长列表里够不着目标位置。

     现在拖动只认这个手柄：它 catch 掉 touch 事件，scroll-view 根本收不到，
     卡片其余区域照常把手势交给列表。两种手势不再抢同一个事件，也就不用再关滚动。

     三个 handler 直接复用行手势的实现，只在 _drag 上打一个 handle 标记，
     由 onRowMove 决定「这次算不算拖动」—— 这样左滑、拖动、长列表滚动
     仍然只有一份状态机，不会分叉。 */

  onHandleStart(e) {
    this.onRowStart(e);
    if (this._drag) this._drag.handle = true;
  },

  onHandleMove(e) {
    this.onRowMove(e);
  },

  onHandleEnd() {
    this.onRowEnd();
  },

  /* ---- 滚动同步 ----
     拖动期间「行在屏幕上的位置」必须跟着滚动走，否则换位判定会拿过期坐标
     算出错的落点。这里只做一件事：把 bindscroll 报来的真实滚动量
     折算到 _dg.rects 上，然后按最新位置重算一次落点。

     刻意不在这里 setData —— 滚动事件很密，每次都推视图层会把列表拖垮。
     真正要重绘时（落点变了 / 位移变了）由 applyDragMove 决定。 */

  onScrollerScroll(e) {
    const st = Number((e && e.detail && e.detail.scrollTop) || 0);
    const prev = this._scrollTop;
    this._scrollTop = st;

    const dg = this._dg;
    if (!dg || prev === st) return;
    const d = st - prev;
    dg.rects.forEach(function (r) {
      r.top -= d;
    });
    // 手指没动、列表动了：落点可能已经变了，按新位置重算一遍
    if (dg.lastY != null) this.applyDragMove(dg.lastY);
  },

  /* ================= 交互：拖动排序 =================
     触发方式：排序模式下按住卡片**右侧的手柄**（.dh）拖动。
     为什么必须是手柄：拖动与滚动都是纵向手势，让它们落在同一个元素上就必然互斥
     （要么拖不了，要么滚不了）。手柄用 catch 把事件从滚动区手里截走，
     一张卡片于是有了两块互不干扰的区域：手柄负责拖，其余区域负责滚。

     实现要点：
     1. 行位置在拿起时用 boundingClientRect 量一次，之后不再查询；
        列表滚动时按 bindscroll 报来的真实滚动量整体平移这份快照 ——
        拖动期间布局没变，每帧重新查询纯属浪费。
     2. 位移分两条通道推给视图层：dragY（被拖的卡片，每帧变）和
        shift（其余卡片的让位量，只在跨过某行中线时才变）。
        这样高频的 touchmove 只 setData 一个数字，与左滑同一套思路。
     3. 卡片在屏幕上的位置 = 拿起时的位置 + 手指位移，
        不直接累加 clientY —— 列表一滚，后者的基准就漂了。
     4. 手指贴到滚动区上下缘时列表自动滚（runAutoScroll），
        否则长列表里根本够不着屏幕外的落点。 */

  // clientY = 拿起那一刻的纵坐标，作为位移原点（拿起点位移恒为 0）
  startDrag(id, clientY) {
    if (!id || this._dg) return;
    // ⚠️ 第二道闸：正在量行位置时，拒绝重来。
    //    measureRows 要过渲染层一个来回（十几到几十毫秒），这段时间里 _dg 还是空的，
    //    于是 onRowMove 会在**每一个 touchmove** 上再喊一次 startDrag：
    //      · _dragSeq 被反复自增 → 在途的回调全部对不上号，被当「迟到的僵尸回调」丢掉；
    //      · dragY 被反复压回 0，_dgY0 被反复改写。
    //    手指一直在动、touchmove 不停，回调就永远等不到落地 —— 表现正是
    //    「按住拖不动，得停下来缓一下、试好几次才拿得起卡片」。
    //    拿到 _dg 之前只认第一次，后面的一律忽略。
    if (this._dgP) return;
    this._dgP = id;
    if (this.data.swipeKey) this.setData({ swipeKey: '', swipeX: 0 });
    this._dgY0 = clientY;
    // dragOn 只是「拖动中」的内部标记，不控制列表滚动 —— scroll-y 现在常开，
    // 「拖」与「滚」靠手柄分流（手柄 catch 掉事件），不再靠关滚动。
    // 这里刻意不做震动/抖动：反馈统一放在「点调整顺序」那一刻（见 onSortToggle），
    // 拿起卡片已经有抬起阴影 + 跟手位移，够了。
    this.setData({ dragOn: true, dragId: id, dragY: 0, dropQuad: '' });
    // 量一次滚动区上下边（边缘自动滚要用）。异步、不阻塞拖动本身：
    // 量回来之前手指若已经离开边缘，maybeAutoScroll 自然也不会滚。
    this.measureScroller();

    const that = this;
    // 惰性自增：不依赖 onLoad 一定跑过（仿真测试里就用 Object.create 造页面）
    const seq = (this._dragSeq = (this._dragSeq || 0) + 1);
    this.measureRows(function (rects) {
      // ⚠️ 量行位置是异步的，回调回来时这一次拖动可能早就结束了：
      //    手指点一下就抬走、中途切了视图、或者已经开始了新的一次拖动。
      //    早先这里**无条件**写入 _dg，于是留下一个「僵尸拖动」——
      //    此后每一次 touchmove（包括正常滚动列表）都会被 applyDragMove 接管，
      //    拿过期坐标算出错的让位位移，把整个列表重排一遍。
      //    用户看到的就是「滑动时卡片乱跳、滑到的块都消失了」。
      //    三道闸一起关：代号没变 + 仍在拖动中 + 拖的还是同一行。
      if (seq !== that._dragSeq || !that.data.dragOn || that.data.dragId !== id) return;

      const ok = rects.length >= 2;
      const flat = ok ? that.flatList() : [];
      let from = -1;
      for (let i = 0; i < flat.length; i++) {
        if (flat[i].id === id) { from = i; break; }
      }
      // 量到的行数应与视图模型一一对应；对不上就放弃这次拖动，宁可不做也不做错
      if (!ok || from < 0 || flat.length !== rects.length) {
        // 放开闸：这次没量成（多半是量的时候列表正在重排），让后续 touchmove
        // 还有机会重量一次。不放开的话，一次瞬时错位会让整串手势彻底废掉。
        that._dgP = null;
        that.setData({ dragOn: false, dragId: '', dragY: 0 });
        return;
      }
      // 闸的使命到这就结束了：状态机马上装上，之后由 _dg 自己挡重复调用。
      // 不放开的话，万一将来有哪条收尾路径漏了清理，下一轮手势会被一直挡住。
      that._dgP = null;
      that._dg = {
        id: id,
        from: from,
        to: from,
        rects: rects,
        flat: flat,
        dy: 0,
        // 已经推给视图层的 dragY（量化后的整数 px）。高频通道靠它去重，
        // 见 applyDragMove —— 同一像素内的重复推送会被它吃掉。
        pushedY: 0,
        // 拿起那一刻卡片顶边在屏幕上的位置。之后列表不管怎么滚，
        // 「卡片该在哪」都由它 + 手指位移算出，不必再单独补偿滚动量 ——
        // 列表滚多远，rects[from].top 就跟着走多远，两边自动抵消。
        base0: rects[from].top,
        lastY: clientY,
        scrollDir: 0,     // 手指是否停在上下边缘（-1 上 / 0 否 / 1 下）
        asPending: null,  // 自动滚一拍的目标，用来判断「滚到底了没有」
        asDirDone: 0,     // 已经滚到头的方向，别对着墙反复 setData
      };
    });
  },

  // 屏幕左上角为原点的行位置（只含 top / height，都够用）
  measureRows(cb) {
    const q = wx.createSelectorQuery();
    q.selectAll('.row').boundingClientRect();
    q.exec(function (res) {
      const arr = (res && res[0]) || [];
      cb(
        arr
          .filter(function (r) {
            return r && r.height > 0;
          })
          .map(function (r) {
            return { top: r.top, height: r.height };
          })
      );
    });
  },

  // 滚动区在屏幕上的上下边（「拖到边缘自动滚」要用）。
  // 它只跟屏幕尺寸和固定头部的高度有关，列表怎么滚都不变，所以量一次就够。
  // 量不到就置空：那时不自动滚，拖动本身一切照旧 —— 不做降级就会连拖动一起废掉。
  measureScroller() {
    const that = this;
    const q = wx.createSelectorQuery();
    q.select('.scroller').boundingClientRect();
    q.exec(function (res) {
      const r = res && res[0];
      if (!r || !(r.height > 0)) {
        that._scBand = null;
        return;
      }
      that._scBand = { top: r.top, bottom: r.top + r.height };
    });
  },

  // 渲染顺序的扁平快照，用于把「第几个 .row」翻译成「哪条事项 / 哪个象限」。
  // 必须与 WXML 的渲染顺序一致：详情页 = rows 顺序；全部页 = 分段顺序展开。
  flatList() {
    const out = [];
    if (this.state.view === 'detail') {
      this.data.rows.forEach(function (r, i) {
        out.push({ id: r._id, quad: r.q, sec: 0, idx: i });
      });
    } else {
      this.data.sections.forEach(function (sec, si) {
        sec.rows.forEach(function (r, ri) {
          out.push({ id: r._id, quad: sec.key, sec: si, idx: ri });
        });
      });
    }
    return out;
  },

  applyDragMove(clientY) {
    const dg = this._dg;
    if (!dg) return;
    const rects = dg.rects;
    const from = dg.from;
    const n = rects.length;
    const base = rects[from];

    dg.lastY = clientY;

    // 位移夹在列表首尾之间，卡片不会被拖出列表范围。
    // minDy / maxDy 只描述「首尾相对被拖卡片」的关系：列表整体滚动时两者一起位移，
    // 差值是常量，所以它们不随滚动变化 —— 滚过之后依然有效。
    const minDy = rects[0].top - base.top;
    const maxDy = rects[n - 1].top + rects[n - 1].height - (base.top + base.height);

    // ⚠️ 位移原点不能简单写成 clientY - _dgY0。
    //    卡片靠 translateY 相对「自己那一行的当前位置」定位，而那一行会随列表滚动。
    //    所以先算出它**该在屏幕上的位置**（拿起时的顶边 base0 + 手指位移），
    //    再减去它当前的位置，才是要推给视图层的 dy。
    //    列表没滚时 base.top === base0，正好退化成原来的 clientY - _dgY0。
    let dy = dg.base0 + (clientY - this._dgY0) - base.top;
    if (dy < minDy) dy = minDy;
    if (dy > maxDy) dy = maxDy;

    // ⚠️ 位移先量化成整数 px，再参与判定与渲染。
    //    touchmove 在真机上能到 60~120Hz，而 dragY 出现在**每一行**的 style 表达式里：
    //    每 setData 一次，整个列表的样式都要重算一遍。亚像素的位移屏幕上根本看不出来，
    //    却会让每一帧都被判成「变了」而重复推送 —— 这是拖动卡顿的主因。
    //    量化到整数格之后，下面那条去重就能把「同一像素内的连续 touchmove」全吃掉。
    const dyPx = Math.round(dy);

    // 手指停在滚动区上下缘 → 让列表自己滚（长列表里才够得着屏幕外的落点）
    this.maybeAutoScroll(clientY);

    // 换位判定：卡片垂直中心越过了谁的中线，就换到谁那里。
    // 判定基准用 dyPx 而不是 dy —— 屏幕上就是这个整数位置，两者得一致。
    // EPS 不能省：位移被夹在列表首尾之内时，拖到最上/最下那一档的瞬间，
    // 卡片中心正好「等于」首/尾卡片的中线，严格大于会永远差一档，
    // 表现为「怎么拖都放不到第一位 / 最后一位」。
    const EPS = 0.5;
    const center = base.top + base.height / 2 + dyPx;
    let to = from;
    while (to + 1 < n && center > rects[to + 1].top + rects[to + 1].height / 2 - EPS) to++;
    while (to - 1 >= 0 && center < rects[to - 1].top + rects[to - 1].height / 2 + EPS) to--;

    const crossed = to !== dg.to;
    dg.to = to;
    dg.dy = dyPx;

    if (crossed) {
      // 落点变了：让位位置必须整表重算，dragY 顺带一起推
      dg.pushedY = dyPx;
      this.paintDrag(dyPx, to);
    } else if (dyPx !== dg.pushedY) {
      // 高频通道：只推一个数字，且只在真的跨过一个整数像素时才推
      dg.pushedY = dyPx;
      this.setData({ dragY: dyPx });
    }
  },

  /* ---- 拖到边缘时列表自动滚 ----
     手柄解决了「拖动时列表还能不能滚」，但还差一步：手正按着手柄不放，
     腾不出第二根手指去滑列表。所以手指贴到滚动区上下缘时，列表得自己滚 ——
     贴着边缘不松手就一直滚，这样才够得着屏幕外的落点。 */

  maybeAutoScroll(clientY) {
    const dg = this._dg;
    if (!dg) return;
    // 滚动区没量到（或不支持测量）就整段跳过：不自动滚，但拖动本身一切照旧
    const band = this._scBand;
    if (!band) return;

    const edge = LAYOUT.DRAG_EDGE;
    let dir = 0;
    if (clientY < band.top + edge) dir = -1;
    else if (clientY > band.bottom - edge) dir = 1;

    // 手指真的动了就清掉「这个方向已到头」的记录：
    // 位置变了，原来的尽头可能已经不在尽头（列表滚动后下面又露出内容了）。
    // 同时作废掉上一次的比对基准 —— 重新开始尝试，得重新比一次才知道滚没滚动。
    // 不移开就一直不清：免得贴着尽头反复 setData 推一个不变的值。
    if (dg.asY == null || Math.abs(clientY - dg.asY) > 4) {
      dg.asDirDone = 0;
      dg.asPending = null;
      dg.asY = clientY;
    }
    dg.scrollDir = dir;
    if (dir && !this._asTimer) this.runAutoScroll();
  },

  /* 自动滚一拍。为什么用 setTimeout 串成一拍一拍，而不是 setInterval：
     ① 手指离开边缘（scrollDir 归 0）时，下一拍自然就停了，不用去 clearInterval；
     ② 滚到顶/底时能识别出「推了没动」并收手，否则会一直对着墙 setData。
     40ms 一格，接近 25fps，触屏上够跟手。 */
  runAutoScroll() {
    const that = this;
    this._asTimer = setTimeout(function () {
      that._asTimer = null;
      const dg = that._dg;
      if (!dg || !dg.scrollDir || dg.scrollDir === dg.asDirDone) return;

      // 「推下去之后一点没动」＝ 已经滚到顶/底了。
      // ⚠️ 这个判断必须放在**下一拍的开头**：bindscroll 是异步回来的，
      //    在 setData 之后立刻比，_scrollTop 还没更新，会把正常滚动误判成到头。
      if (dg.asPending != null && that._scrollTop === dg.asPending) {
        dg.asDirDone = dg.scrollDir;
        return;
      }

      dg.asPending = that._scrollTop;
      that.setData({ scrollTop: that._scrollTop + dg.scrollDir * LAYOUT.AS_STEP });
      that.runAutoScroll();
    }, LAYOUT.AS_TICK);
  },

  // 拖动一结束就停：定时器活着会一直 setData，跳出排序模式后就成了幽灵滚动
  stopAutoScroll() {
    if (this._asTimer) {
      clearTimeout(this._asTimer);
      this._asTimer = null;
    }
  },

  // 按当前 target 重算每行的让位位移。只在 to 变化时调用。
  paintDrag(dy, to) {
    const dg = this._dg;
    if (!dg) return;
    const flat = dg.flat;
    const from = dg.from;
    const slot = dg.rects[from].height + LAYOUT.ROW_GAP * this.rf;
    const sameSec = flat[to].sec === flat[from].sec;

    // 同段内：被拖卡片让出的空档由 [from, to] 之间的行整体补上一个卡位。
    // 跨段时不做位移（卡片高度各不相同，硬算会错位），改用高亮提示落点。
    function shiftOf(k) {
      if (!sameSec || k === from) return 0;
      if (from < to && k > from && k <= to) return -slot;
      if (from > to && k >= to && k < from) return slot;
      return 0;
    }

    const patch = { dragY: dy, dropQuad: sameSec ? '' : flat[to].quad };

    if (this.state.view === 'detail') {
      patch.rows = this.data.rows.map(function (r, i) {
        return Object.assign({}, r, { shift: shiftOf(i) });
      });
    } else {
      let k = 0;
      patch.sections = this.data.sections.map(function (sec) {
        return Object.assign({}, sec, {
          rows: sec.rows.map(function (r) {
            const s = shiftOf(k);
            k++;
            return Object.assign({}, r, { shift: s });
          }),
        });
      });
    }

    this.setData(patch);
  },

  endDrag() {
    const dg = this._dg;
    this._dg = null;
    this._dgP = null;
    this.stopAutoScroll();
    this.setData({ dragId: '', dragY: 0, dragOn: false, dropQuad: '', dragging: false });

    if (!dg) {
      this.render();
      return;
    }
    const from = dg.from;
    const to = dg.to;
    if (to === from) {
      this.render(); // 只是把位移还原
      return;
    }

    const a = dg.flat[from];
    const b = dg.flat[to];
    const lists = [];

    if (a.sec === b.sec) {
      // 同段内换位：详情页按当前筛选做「可见项重排」，隐藏项原地不动
      const full = this.inQuad(a.quad, false);
      const vis = this.visibleIdx(full);
      const fromPos = vis[a.idx];
      const toPos = vis[b.idx];
      if (fromPos === undefined || toPos === undefined) {
        this.render();
        return;
      }
      const seq = full.slice();
      seq.splice(toPos, 0, seq.splice(fromPos, 1)[0]);
      lists.push({ quad: a.quad, list: seq });
    } else {
      // 跨象限：从源象限摘出来，插到目标象限被悬停那一条的位置上
      const src = this.inQuad(a.quad, false);
      const dst = this.inQuad(b.quad, false);
      const moving = src.splice(a.idx, 1)[0];
      if (!moving) {
        this.render();
        return;
      }
      dst.splice(Math.min(b.idx, dst.length), 0, moving);
      lists.push({ quad: a.quad, list: src });
      lists.push({ quad: b.quad, list: dst });
    }

    this.commitOrder(lists);
  },

  /* ================= 交互：排序落库 ================= */

  // lists: [{ quad, list }]，list 是该象限（当前分类内）事项的新顺序。
  // 整段重写成 0/10/20…，只把真正变了的那几条发给云函数 ——
  // 比「与邻居取中值」稳，也不会因为反复拖动把浮点间距耗光。
  commitOrder(lists) {
    const changed = [];
    const plans = [];
    lists.forEach(function (entry) {
      entry.list.forEach(function (it, i) {
        const o = i * ORDER_STEP;
        if (it.order !== o || it.quad !== entry.quad) {
          changed.push({ id: it._id, order: o, quad: entry.quad });
        }
        plans.push({ it: it, order: o, quad: entry.quad });
      });
    });

    if (!changed.length) {
      this.render();
      return;
    }
    if (changed.length > REORDER_CAP) {
      wx.showToast({ title: '一次最多重排 ' + REORDER_CAP + ' 条', icon: 'none' });
      this.render();
      return;
    }

    const that = this;
    this.commit(
      function () {
        plans.forEach(function (p) {
          p.it.order = p.order;
          p.it.quad = p.quad;
        });
        // 渲染顺序直接来自镜像数组的顺序，改完 order 要重新排一遍
        that.items.sort(function (x, y) {
          return (x.order || 0) - (y.order || 0);
        });
      },
      callCloud('reorder', { items: changed })
    );
  },

  onRowTap(e) {
    if (this.data.sortMode) return; // 排序模式下点卡片不编辑
    const id = e.currentTarget.dataset.id;
    if (this._moved) return; // 刚才是在滑动，不是点击
    // 已滑开时点卡片 = 先收起（操作组是条件渲染，收起要把 swipeKey 一并清掉，
    // 只把 swipeX 归零的话按钮还在 DOM 里，只是被卡片盖住）
    if (this.data.swipeKey === id && this.data.swipeX < -8) {
      this.setData({ swipeKey: '', swipeX: 0 });
      return;
    }
    const it = this.findItem(id);
    if (it) this.openForm(it);
  },

  // 左滑操作组两个动作：未完成 → 完成 / 删除；已完成 → 撤销 / 删除。
  // 撤销就是同一个 toggleDone（当前 done 为 true，取反后落回未完成），
  // 落库和「完成」走同一条路径，不需要另开 action。
  onRowAct(e) {
    if (this.data.sortMode) return; // 排序模式下操作按钮被锁
    const ds = e.currentTarget.dataset;
    if (ds.act === 'done') this.toggleDone(ds.id);
    else this.askDelete(ds.id);
  },

  findItem(id) {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i]._id === id) return this.items[i];
    }
    return null;
  },

  /* ================= 交互：事项增删改 ================= */

  toggleDone(id) {
    const it = this.findItem(id);
    if (!it) return;
    const next = !it.done;

    this.commit(
      function () {
        it.done = next;
      },
      callCloud('updateItem', { id: id, patch: { done: next } })
    );
    this.setData({ swipeKey: '', swipeX: 0 });
  },

  // 编辑抽屉里的「标记为未完成」：和左滑的「撤销」互为快捷入口。
  // 留着的理由是抽屉本来就开着（点卡片进来），不必先滑一下再点。
  onSheetUndone() {
    const id = this.data.form.id;
    if (!id) return;
    this.closeSheet();
    this.toggleDone(id);
  },

  askDelete(id) {
    const it = this.findItem(id);
    if (!it) return;
    const that = this;
    wx.showModal({
      title: '删除事项',
      content: '「' + it.title + '」删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#D9303C',
      success(res) {
        if (!res.confirm) return;
        that.commit(
          function () {
            that.items = that.items.filter(function (x) {
              return x._id !== id;
            });
          },
          callCloud('removeItem', { id: id })
        );
        that.setData({ swipeKey: '', swipeX: 0 });
      },
    });
  },

  /* ================= 交互：象限管理抽屉 ================= */

  onQuadMenu() {
    if (this.data.sortMode) return; // 排序模式下详情菜单被锁
    const q = this.state.quad;
    const n = this.inQuad(q, false).length;
    this.setData({
      sheetOpen: true,
      sheetKind: 'quad',
      sheetTitle: QUAD_MAP[q].name,
      sheetSub: '本象限 ' + n + ' 项 · 当前分类「' + this.catName(this.state.catId) + '」',
    });
  },

  onQuadBulk(e) {
    const op = e.currentTarget.dataset.op;
    const quad = this.state.quad;
    const catId = this.state.catId;
    const that = this;
    const label = {
      markAllDone: '全部标记为已完成',
      clearDone: '清空本象限已完成',
      clearQuad: '删除本象限全部事项',
    }[op];

    const run = function () {
      that.closeSheet();
      that.commit(
        function () {
          if (op === 'markAllDone') {
            that.items.forEach(function (it) {
              if (it.quad === quad && it.catId === catId) it.done = true;
            });
          } else if (op === 'clearDone') {
            that.items = that.items.filter(function (it) {
              return !(it.quad === quad && it.catId === catId && it.done);
            });
          } else {
            that.items = that.items.filter(function (it) {
              return !(it.quad === quad && it.catId === catId);
            });
          }
        },
        callCloud('bulk', { op: op, quad: quad, catId: catId })
      );
    };

    if (op === 'markAllDone') {
      run();
      return;
    }
    wx.showModal({
      title: '确认操作',
      content: label + '，不可恢复。',
      confirmText: '确认',
      confirmColor: '#D9303C',
      success(res) {
        if (res.confirm) run();
      },
    });
  },

  /* ================= 交互：抽屉开关 ================= */

  closeSheet() {
    this.setData({ sheetOpen: false });
  },

  // item 非空 = 编辑；defaultQuad 只用于新建，决定抽屉里预选的象限
  openForm(item, defaultQuad) {
    const q = item ? item.quad : defaultQuad || 'q1';
    const catId = item ? item.catId : this.state.catId;
    const pri = item ? item.priority : 3;
    const ts = item && item.remindAt ? item.remindAt : null;
    const d = ts ? new Date(ts) : null;

    const form = {
      id: item ? item._id : '',
      title: item ? item.title : '',
      note: item ? item.note || '' : '',
      quad: q,
      priority: pri,
      catId: catId,
      date: d
        ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        : todayStr(),
      time: d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '09:00',
      hasRemind: !!d,
      dateLabel: '不提醒',
    };
    if (d) form.dateLabel = remindDayShort(form.date, form.time);

    const isEdit = !!item;
    this.setData({
      sheetOpen: true,
      sheetKind: 'form',
      sheetTitle: isEdit ? '编辑事项' : '新建事项',
      sheetSub: isEdit ? '改动会立即同步到矩阵' : '先写下它，再决定它属于哪一格',
      sheetDone: !!(item && item.done),
      form: form,
      qpicks: this.buildQpicks(q),
      catPills: this.buildCatPillsForSheet(catId),
      priPills: this.buildPriPills(pri),
      saveLabel: isEdit ? '保存修改' : '保存并放入「' + QUAD_MAP[q].name + '」',
    });
  },

  onInputTitle(e) {
    this.setData({ 'form.title': e.detail.value });
  },

  onInputNote(e) {
    this.setData({ 'form.note': e.detail.value });
  },

  onPickQuad(e) {
    const k = e.currentTarget.dataset.k;
    const patch = {
      'form.quad': k,
      qpicks: this.buildQpicks(k),
    };
    if (!this.data.form.id) {
      patch.saveLabel = '保存并放入「' + QUAD_MAP[k].name + '」';
    }
    this.setData(patch);
  },

  onPickPri(e) {
    const p = Number(e.currentTarget.dataset.p);
    this.setData({ 'form.priority': p, priPills: this.buildPriPills(p) });
  },

  onPickSheetCat(e) {
    const id = e.currentTarget.dataset.k;
    this.setData({ 'form.catId': id, catPills: this.buildCatPillsForSheet(id) });
  },

  onDate(e) {
    const date = e.detail.value;
    const f = this.data.form;
    this.setData({
      'form.date': date,
      'form.hasRemind': true,
      'form.dateLabel': remindDayShort(date, f.time),
    });
  },

  onTime(e) {
    const time = e.detail.value;
    const f = this.data.form;
    this.setData({
      'form.time': time,
      'form.hasRemind': true,
      'form.dateLabel': remindDayShort(f.date, time),
    });
  },

  onClearRemind() {
    this.setData({ 'form.hasRemind': false, 'form.dateLabel': '不提醒' });
  },

  onSave() {
    const f = this.data.form;
    const title = String(f.title || '').trim();
    if (!title) {
      wx.showToast({ title: '请先写事项标题', icon: 'none' });
      return;
    }
    const remindAt = f.hasRemind ? toTimestamp(f.date, f.time) : null;
    const payload = {
      title: title,
      note: String(f.note || '').trim(),
      quad: f.quad,
      catId: f.catId,
      priority: f.priority,
      remindAt: remindAt,
    };

    const that = this;
    const isEdit = !!f.id;
    this.closeSheet();

    // 「带提醒的保存」= 顺手攒一条推送额度。
    // 必须在这里同步调用：requestSubscribeMessage 要求「在用户交互后」调，
    // 此刻还在这一次 tap 的调用栈里；挪到 callCloud 的 then 里就会被判不合规。
    if (remindAt) this.askSubscribe();

    if (isEdit) {
      const it = this.findItem(f.id);
      if (!it) return;
      this.commit(
        function () {
          it.title = payload.title;
          it.note = payload.note;
          it.quad = payload.quad;
          it.catId = payload.catId;
          it.priority = payload.priority;
          it.remindAt = payload.remindAt;
        },
        callCloud('updateItem', { id: f.id, patch: payload })
      );
    } else {
      callCloud('addItem', { item: payload })
        .then(function (data) {
          that.items.push({
            _id: data._id,
            title: payload.title,
            note: payload.note,
            quad: payload.quad,
            catId: payload.catId,
            priority: payload.priority,
            done: false,
            remindAt: payload.remindAt,
            // 新事项排在末尾（排序值最大），与云函数 addItem 的写法一致
            order: Date.now(),
          });
          that.items.sort(function (x, y) {
            return (x.order || 0) - (y.order || 0);
          });
          that.render();
        })
        .catch(function (err) {
          wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
        });
    }
  },

  /* ================= 交互：分类 ================= */

  // 小程序没有 window.prompt，用 showModal 的 editable 输入框（基础库 2.17.1+）
  prompt(title, placeholder, value) {
    if (!wx.canIUse || !wx.canIUse('showModal.object.editable')) {
      wx.showModal({
        title: '客户端版本过低',
        content: '「新增分类」需要微信 8.0.16 及以上版本。请升级微信后再试。',
        showCancel: false,
      });
      return Promise.resolve('');
    }
    return new Promise(function (resolve) {
      wx.showModal({
        title: title,
        editable: true,
        placeholderText: placeholder,
        content: value || '',
        success(res) {
          resolve(res.confirm ? String(res.content || '').trim() : '');
        },
        fail() {
          resolve('');
        },
      });
    });
  },

  onAddCategory() {
    const that = this;
    this.prompt('新增分类', '例如：阅读', '').then(function (name) {
      if (!name) return;
      callCloud('addCategory', { name: name })
        .then(function (data) {
          that.cats.push({ _id: data._id, name: data.name, order: Date.now() });
          wx.showToast({ title: '已新增', icon: 'none' });
          // 抽屉里新增分类时直接选中它，省掉一次点击
          if (that.data.sheetOpen && that.data.sheetKind === 'form') {
            that.setData({
              'form.catId': data._id,
              catPills: that.buildCatPillsForSheet(data._id),
            });
          }
          that.render();
        })
        .catch(function (err) {
          wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
        });
    });
  },

  /* ================= 交互：分类管理（长按） =================
     删除入口为什么在这里、为什么用长按：
       · 「我的」页这张分类卡片是分类唯一的管理区，删除入口理所应当在这里；
       · 整行的点击已经被「切到该分类」占了（高频操作），不能再往里塞一个破坏性动作；
       · 长按是移动端次级操作的通用语汇，也不会和列表的纵向滚动抢手势。
     可发现性靠卡片底部那行常驻提示补 —— 比藏一个灰色小图标划算。
     （小程序规定：绑了 longpress 并触发后，tap 不会再触发，所以两种手势不冲突。） */

  onLongPressCat(e) {
    if (this.data.sortMode) return;
    const id = e.currentTarget.dataset.k;
    const cat = this.cats.filter(function (c) {
      return c._id === id;
    })[0];
    if (!cat) return;

    const n = this.items.filter(function (it) {
      return it.catId === id;
    }).length;
    const isOwner = !!(this.fam && this.fam.isOwner);

    this.setData({
      sheetOpen: true,
      sheetKind: 'catmenu',
      sheetTitle: cat.name,
      sheetSub: n + ' 项事项',
      catMenuId: id,
      catDelCount: n,
      // 空分类谁都删得掉（和「新增分类」全员可用对称，删错了再建一个就是了）；
      // 非空分类底下可能躺着家人录的条目，破坏力和「清空全家数据」同级，
      // 所以只留给创建者。云函数侧有一道同样的校验 —— 藏入口只是体验，不是防线。
      catCanDel: n === 0 || isOwner,
    });
  },

  // 分类改名。复用「新增分类」那个输入弹窗（showModal 的 editable）。
  onRenameCategory() {
    const that = this;
    const id = this.data.catMenuId;
    const cat = this.cats.filter(function (c) {
      return c._id === id;
    })[0];
    if (!cat) return;

    this.prompt('重命名分类', '例如：阅读', cat.name).then(function (name) {
      // 没改、或者清空了，都当作用户取消
      if (!name || name === cat.name) return;
      that.closeSheet();
      that.commit(
        function () {
          that.cats.forEach(function (c) {
            if (c._id === id) c.name = name;
          });
        },
        callCloud('renameCategory', { id: id, name: name })
      );
    });
  },

  // 点「删除分类」：空分类问一句就删；非空分类换成「先给这 N 条找个新家」那一步。
  onCatDeleteAsk() {
    const that = this;
    const id = this.data.catMenuId;
    const n = this.data.catDelCount;

    // 云函数侧也拦（total <= 1 直接拒），这里先拦一次是为了不用等一个来回
    if (this.cats.length <= 1) {
      wx.showToast({ title: '至少要保留一个分类', icon: 'none', duration: 2200 });
      return;
    }
    if (!this.data.catCanDel) {
      wx.showToast({
        title: '只有家庭创建者可以删除还有事项的分类',
        icon: 'none',
        duration: 2600,
      });
      return;
    }

    if (n === 0) {
      wx.showModal({
        title: '删除分类',
        content: '「' + this.data.sheetTitle + '」下没有事项，删除后不可恢复。',
        confirmText: '删除',
        confirmColor: '#D9303C',
        success(res) {
          if (res.confirm) that.doCatDelete(id, '');
        },
      });
      return;
    }

    // 非空：不推翻「要删」这个决定，只把「这 N 条去哪」补上。
    // 共享清单里这是最要紧的一点 —— 你删掉的分类里可能有家人录的条目，
    // 所以默认给一个不丢数据的出口，而不是直接问「确定要一起删吗」。
    const rows = this.cats
      .filter(function (c) {
        return c._id !== id;
      })
      .map(function (c) {
        return { id: c._id, name: c.name };
      });

    this.setData({
      sheetKind: 'catdel',
      sheetSub: '「' + this.data.sheetTitle + '」下还有 ' + n + ' 条事项',
      moveRows: rows,
    });
  },

  // 「把这 N 条移到 X」→ 先搬事项、再删分类（云函数里也是这个顺序）
  onPickMoveTo(e) {
    const to = e.currentTarget.dataset.k;
    const id = this.data.catMenuId;
    if (!to || !id) return;
    this.doCatDelete(id, to);
  },

  // 「连同事项一起删除」—— 不可逆，所以比上面那条多一道确认
  onCatDeleteCascade() {
    const that = this;
    const id = this.data.catMenuId;
    const name = this.data.sheetTitle;
    wx.showModal({
      title: '分类与事项一起删除',
      content:
        '「' + name + '」下的 ' + this.data.catDelCount + ' 条事项会一起删除，不可恢复。' +
        '家庭成员录入的也在其中。',
      confirmText: '一并删除',
      confirmColor: '#D9303C',
      success(res) {
        if (res.confirm) that.doCatDelete(id, '');
      },
    });
  },

  // 真正执行。moveTo 为空 = 连同事项一起删；有值 = 先把事项挪过去再删分类。
  doCatDelete(id, moveTo) {
    const that = this;
    this.closeSheet();
    const p = moveTo
      ? callCloud('removeCategory', { id: id, moveTo: moveTo })
      : callCloud('removeCategory', { id: id });
    this.commit(function () {
      that.cats = that.cats.filter(function (c) {
        return c._id !== id;
      });
      if (moveTo) {
        that.items.forEach(function (it) {
          if (it.catId === id) it.catId = moveTo;
        });
      } else {
        that.items = that.items.filter(function (it) {
          return it.catId !== id;
        });
      }
      // 删掉的正好是当前选中的分类时，state.catId 会指着一个不存在的分类 ——
      // 不回落的话整个页面是一片空白，看着像「数据全没了」。fixCatId 就是干这个的。
      that.fixCatId();
    }, p);
    // 成功才提示；失败由 commit 统一弹错误 + 拉回服务端状态
    p.then(function () {
      wx.showToast({ title: moveTo ? '已移动并删除' : '已删除', icon: 'none' });
    });
  },

  /* ================= 交互：数据操作 ================= */

  onClearDoneAll() {
    const that = this;
    wx.showModal({
      title: '清空已完成',
      content: '将删除当前分类下所有已完成事项，不可恢复。',
      confirmText: '清空',
      confirmColor: '#D9303C',
      success(res) {
        if (!res.confirm) return;
        const cid = that.state.catId;
        that.commit(
          function () {
            that.items = that.items.filter(function (it) {
              return !(it.done && (!cid || it.catId === cid));
            });
          },
          callCloud('clearDone', { catId: cid })
        );
      },
    });
  },

  onExportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      categories: this.cats.map(function (c) {
        return { id: c._id, name: c.name };
      }),
      items: this.items.map(function (it) {
        return {
          id: it._id,
          title: it.title,
          note: it.note || '',
          quad: it.quad,
          catId: it.catId,
          priority: it.priority,
          done: !!it.done,
          remindAt: it.remindAt || null,
        };
      }),
    };
    wx.setClipboardData({
      data: JSON.stringify(payload, null, 2),
      success() {
        wx.showToast({ title: 'JSON 已复制到剪贴板', icon: 'none' });
      },
    });
  },

  onClearAll() {
    const that = this;
    const fam = this.fam || {};
    if (!fam.isOwner) {
      wx.showToast({ title: '只有家庭创建者可以清空', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '清空全部数据',
      content:
        '将删除「' + (fam.name || '我的家庭') + '」里**所有成员**的事项（分类保留），不可恢复。' +
        '家庭里其他人录入的也会一起没。',
      confirmText: '全部清空',
      confirmColor: '#D9303C',
      success(res) {
        if (!res.confirm) return;
        that.commit(
          function () {
            that.items = [];
          },
          callCloud('clearAll')
        );
      },
    });
  },

  /* ================= 交互：家庭（共享清单） =================
     模型：一份数据属于一个「家庭」，家庭成员可读可写。
     每个人首次进入自动拥有自己的一个家庭；加入别人的家庭是**切换当前家庭**，
     自己原来那份原地留着，退出就能回去 —— 全程不删任何数据。 */

  // 分享出去的小程序卡片直接带上邀请码，家人点开就自动加入。
  // 只有创建者手里有码，所以非创建者分享出去的是普通卡片。
  onShareAppMessage() {
    const fam = this.fam || {};
    const code = fam.isOwner ? fam.inviteCode : '';
    return {
      title: code ? '加入「' + (fam.name || '我的家庭') + '」的四象限清单' : '四象限事项清单',
      path: code ? 'pages/index/index?code=' + code : 'pages/index/index',
    };
  },

  onRenameMe() {
    const that = this;
    const cur = '';
    this.prompt('我的显示名', '家人看到的名字，例如：小明', cur).then(function (name) {
      if (!name) return;
      callCloud('renameMember', { name: name })
        .then(function () {
          wx.showToast({ title: '已更新', icon: 'none' });
          return that.load();
        })
        .catch(function (err) {
          wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
        });
    });
  },

  onRenameFamily() {
    const that = this;
    const fam = this.fam || {};
    if (!fam.isOwner) {
      wx.showToast({ title: '只有家庭创建者可以改名', icon: 'none' });
      return;
    }
    this.prompt('家庭名称', '例如：我们家', fam.name || '').then(function (name) {
      if (!name) return;
      callCloud('renameFamily', { name: name })
        .then(function () {
          wx.showToast({ title: '已更新', icon: 'none' });
          return that.load();
        })
        .catch(function (err) {
          wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
        });
    });
  },

  // 点一下：有效期内直接复制，没有/过期就生成一个新的再复制。
  onGenInvite() {
    const that = this;
    const fam = this.fam || {};
    if (!fam.isOwner) return;

    if (fam.inviteCode && Number(fam.inviteExpire) > Date.now()) {
      wx.setClipboardData({
        data: fam.inviteCode,
        success() {
          wx.showToast({ title: '邀请码已复制', icon: 'none' });
        },
      });
      return;
    }

    callCloud('genInvite')
      .then(function (d) {
        wx.setClipboardData({
          data: d.inviteCode,
          success() {
            wx.showToast({ title: '邀请码已复制，发给家人', icon: 'none' });
          },
        });
        return that.load();
      })
      .catch(function (err) {
        wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
      });
  },

  onJoinFamily() {
    const that = this;
    this.prompt('加入家人的家庭', '输入对方给你的 6 位邀请码', '').then(function (code) {
      if (!code) return;
      that.doJoin(normCode(code), false);
    });
  },

  // silent：来自分享卡片的自动加入。失败了也不弹大弹窗，改成轻提示 ——
  // 用户只是点了个链接，不该被一个模态框拦住。
  doJoin(code, silent) {
    const that = this;
    if (!code) return;
    wx.showLoading({ title: '加入中', mask: true });
    callCloud('joinFamily', { code: code })
      .then(function () {
        wx.hideLoading();
        wx.showToast({ title: '已加入', icon: 'none' });
        // 换了家庭，当前选中的分类必然失效，load 里的 fixCatId 会重挑一个
        that.state.catId = '';
        return that.load();
      })
      .catch(function (err) {
        wx.hideLoading();
        if (silent) {
          wx.showToast({ title: err.message, icon: 'none', duration: 2600 });
          return;
        }
        wx.showModal({ title: '加入失败', content: err.message, showCancel: false });
      });
  },

  onLeaveFamily() {
    const that = this;
    const fam = this.fam || {};
    wx.showModal({
      title: '退出家庭',
      content:
        '退出后你会回到自己的那份清单。「' +
        (fam.name || '这个家庭') +
        '」里的事项不会被删除，其他人也不受影响。',
      confirmText: '退出',
      success(res) {
        if (!res.confirm) return;
        callCloud('leaveFamily')
          .then(function () {
            that.state.catId = '';
            wx.showToast({ title: '已退出', icon: 'none' });
            return that.load();
          })
          .catch(function (err) {
            wx.showToast({ title: err.message, icon: 'none', duration: 2200 });
          });
      },
    });
  },

  /* ================= 交互：象限内新建 ================= */

  // 详情页底部按钮：预选当前象限
  onNewHere() {
    this.openForm(null, this.state.quad);
  },

  // 总览 FAB：按设计稿从 q1 起手
  onNew() {
    this.openForm(null, 'q1');
  },
});
