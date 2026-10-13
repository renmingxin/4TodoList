// pages/index/index.js
// 四象限事项中心 · 单页状态机
//
// 视图状态完全在内存里切换（overview / detail / all / mine），不走路由，
// 这样象限详情可以继承象限色铺满整屏，也不会出现 tabBar 闪烁。
//
// 数据源：云函数 fqTodo（唯一出口）。本地只做一次内存镜像 + 乐观更新，
// 每次改动先改本地立即重绘，再异步落库；落库失败回滚到服务端状态。

/* ---------------- 依赖 ---------------- */

// 本文件只负责「页面」这一件事：视图状态机 + data 装配 + 事件编排。
// 常量去 utils/const.js，纯函数去 utils/format.js，云调用去 services/cloud.js，
// 拖动排序的状态机去 utils/drag.js（文件末尾 Object.assign 进来）。
//
// ⚠️ 拆文件不改变「谁是唯一出口」这类约定：云调用仍然只经 services/cloud.js，
// 页面里不会出现第二处 wx.cloud.callFunction。
const {
  QUADS,
  QUAD_MAP,
  LAYOUT,
  ORDER_STEP,
  REORDER_CAP,
  FN_VER,
  SYNC_MS,
  LEAD_OPTIONS,
  LEAD_DEFAULT,
  WATER_GOAL,
  WATER_KEY,
  PLAN_MAX,
  CAL_CELLS,
} = require('../../utils/const.js');

/* ---------------- 提前提醒（v8）：三个顶层换算 ----------------
   存的是**下标**而不是分钟值：picker 的 value 本来就吃下标，来回换算一次只会
   多一个出错的地方；真正要落库的分钟值在 onSave 里由下标取出来。

   ⚠️ 默认档用 findIndex 找，不写死 3 —— 将来往枚举中间插一档（比如「提前 45 分钟」），
   写死的下标会**静默**指到别的档位上，而 findIndex 不会。 */
const LEAD_LABELS = LEAD_OPTIONS.map(function (o) {
  return o.label;
});

const LEAD_DEFAULT_IDX = Math.max(
  0,
  LEAD_OPTIONS.findIndex(function (o) {
    return o.v === LEAD_DEFAULT;
  })
);

// 分钟值 → 文案。渲染「我的」页那行提示、以及抽屉里当前档位都要用。
// 查不到（存的是一个已下架的档位，或老数据的 undefined）就退回默认档的文案，
// 宁可显示「提前 30 分钟」也不要给用户看一个空白。
function leadLabel(v) {
  const n = Number(v);
  const hit = LEAD_OPTIONS.filter(function (o) {
    return o.v === n;
  })[0];
  return hit ? hit.label : LEAD_LABELS[LEAD_DEFAULT_IDX];
}

// 分钟值 → 下标。老数据没有 leadMin（undefined）→ 回落默认档，
// 这正是「默认 30 分钟」对存量数据生效的地方。
function leadIndex(v) {
  const n = Number(v);
  const i = LEAD_OPTIONS.findIndex(function (o) {
    return o.v === n;
  });
  return i >= 0 ? i : LEAD_DEFAULT_IDX;
}
const {
  pad2,
  todayStr,
  todayMeta,
  remindText,
  remindDayShort,
  toTimestamp,
  normCode,
  inviteLabel,
  addDays,
  dayDiff,
  dayKey,
  hhmm,
  dayWord,
  ymOf,
  monthLabel,
  mdShort,
  dateCN,
  planLabels,
} = require('../../utils/format.js');
const cloud = require('../../services/cloud.js');
const drag = require('../../utils/drag.js');

// 保持 callCloud(...) 的调用点原样。它在本文件里出现三十多次，
// 逐个改成 cloud.callCloud 只会制造三十多处与行为无关的 diff。
const callCloud = cloud.callCloud;

// 握手弹窗只弹一次，别每次 load 都糊用户一脸。
// 留在页面这一侧：它描述的是「本次页面会话已经提示过」，是一份会话状态，
// 不是协议常量，所以不跟 FN_VER 一起搬进 utils/const.js。
let fnVerWarned = false;

/* ---------------- 事项进度 ---------------- */

// 一条事项的进度（0~100 整数）的**唯一读法**。
// 有 progress 就用它（夹紧 + 取整），没有就按 done 推 —— v7 之前入库的老数据
// 没有这个字段，一条已完成的事项若显示 0%，「进度与完成是同一条状态线」
// 这句话当场就破产了。
// ⚠️ 两种来源必须在这里合流。散到各处写 `item.progress || (item.done ? 100 : 0)`，
//    早晚有一处漏掉那个回退分支，而漏掉的那一处只会安静地显示错数字。
function itemPct(it) {
  const p = it && it.progress;
  if (typeof p === 'number' && isFinite(p)) {
    return Math.max(0, Math.min(100, Math.round(p)));
  }
  return it && it.done ? 100 : 0;
}

/* ---------------- Page ---------------- */

const pageDef = {
  data: {
    // 布局
    ready: false,
    statusBarHeight: 20,
    capsuleReserve: 100,
    safeBottom: 0,
    // 注：这里原本还有一个「悬浮按钮距底部多少 px」的键。按钮挪进矩阵容器、
    //     改成常数偏移之后它就没有产生者了，一并删掉 —— 页面 data 只放视图模型。
    //     （注释里故意不写那个键名：文本匹配式的检查会把它当成还在用。）
    // 视图
    view: 'overview',
    pageTitle: '四象限',
    pageMeta: '',
    // 总览
    catTabs: [],
    stats: [],
    grid: [],
    // 今日饮水（本机存储，按日期各一条；跨天读到空 key 就等于清零）。
    // 卡片在总览页矩阵之下，见 components/fq-water。
    waterMl: 0,
    waterGoal: WATER_GOAL,
    // 日程（第 2 个 Tab）：月历选一天，写那天的计划，并列出那天有提醒的事项。
    // 42 格日历、选中日期、两张计划卡、当天事项列表全部由 render() 现算
    // （见 buildCal / buildPlan / buildSchedRows），这里只放视图模型。
    calLabel: '',
    calCells: [],
    calAtToday: false,   // 选中的就是今天 → 「今天」按钮反色
    schedDayLabel: '',
    schedBadge: '',      // 「今天」那个小胶囊；不是今天就空串
    schedCount: '',
    planDay: { label: '今天要做什么', dateShort: '', text: '', placeholder: '还没写，点一下记一笔' },
    planNext: { label: '明天准备做什么', dateShort: '', text: '', placeholder: '顺手把明天的重点记下来' },
    schedRows: [],
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
    // 计划抽屉（sheetKind === 'plan'）：planDate 是正在改的那一天，
    // planDraft 是输入框里的草稿（保存才落库，中途关掉不留痕）。
    // planMax 直接读 const.js 的 PLAN_MAX，与云函数的 MAX_PLAN 成对 —— 不在 WXML 里写死数字。
    planDate: '',
    planDraft: '',
    planMax: PLAN_MAX,
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
      // 提前提醒时长（v8）。只在 hasRemind 为真时才出现在界面上 ——
      // 没有提醒时间就谈不上「提前多久」。这里先落默认档占位，
      // 真正的回填在 openForm 里按每条事项自己的 leadMin 做。
      leadIdx: LEAD_DEFAULT_IDX,
      leadLabel: LEAD_LABELS[LEAD_DEFAULT_IDX],
    },
    saveLabel: '保存',
    // 「提前提醒」picker 的 range 吃一个字符串数组，而模板里做不了 map，
    // 所以在 data 里摊平一次。它整场不变，setData 也就只在初始化时带上一次。
    leadLabels: LEAD_LABELS,
  },

  /* ================= 生命周期 ================= */

  onLoad(options) {
    this.cats = [];   // 服务端分类镜像
    this.items = [];  // 服务端事项镜像
    // 日程计划镜像：{ 'YYYY-MM-DD': '这一天要做什么' }，服务端下发后摊成一张表。
    // 用表而不是数组：日历要按 42 个日期逐个问「这天写过计划吗」，
    // 数组每次都得多扫一遍；而且查不到时天然给出 undefined，省掉「有没有这条」的分支。
    this.plans = {};
    // 家庭信息与数据版本号。同样放内存镜像：syncTick 每 8 秒要用 rev 做一次比对，
    // 放 data 里会白白走一层 setData。
    this.fam = null;
    this.rev = 0;
    // schedYm / schedDate 是日历的「看哪个月 / 选中哪天」，跟着视图状态一起放内存：
    // 它们只在日程页用，放 data 里会让每次切 Tab 都多一轮无意义的 setData。
    const todayD = todayStr();
    this.state = {
      view: 'overview',
      catId: '',
      quad: 'q1',
      filt: 'all',
      schedYm: ymOf(todayD),
      schedDate: todayD,
    };
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

    // 今日饮水：与云端无关，纯本机，首屏直接读出来。
    // _waterDay 记住「当前显示的是哪一天的水」—— syncTick 每拍拿它和今天比一次，
    // 跨零点就把量换掉（见 checkWaterDay）。
    this._waterDay = todayStr();
    this.loadWater();

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

    // ⚠️ 这里**没有回调**：底部 tab / 主按钮靠 .screen 的纵向 flex 天然贴底，
    //    悬浮按钮的偏移量在 fq-fab.wxss 里是个常数，都不需要测量结果。
    //    早期版本在这里算 FAB 的 bottom（tab 高 + 安全区）并内联给组件，
    //    更早还算过 scrollerH 内联给 scroll-view —— 但 Android 的 screenHeight
    //    含底部虚拟导航条，算出来偏大就会把 tabbar 顶出屏幕 / 按钮压到饮水条上。
    //    「靠 flex 分配 + 常数偏移」把这两个数都消掉了。
    this.setData({
      statusBarHeight: statusBarHeight,
      capsuleReserve: Math.round(reserve),
      safeBottom: safeBottom,
    });
  },

  /* ================= 数据加载 ================= */

  load() {
    const that = this;
    return callCloud('bootstrap')
      .then(function (data) {
        that.cats = data.categories || [];
        that.items = data.items || [];
        that.adoptPlans(data.plans);
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

  // 服务端下发的日程计划 → 一张「日期 → 文本」的表。
  // 整表重建而不是逐条合并：云端就是权威快照，某天被清空（记录被删掉）
  // 时，只有重建才能让它跟着消失 —— 增量合并会留下一条永远删不掉的幽灵。
  // 服务端没回这个字段（旧版云函数）就原样保留现状，别把用户写的计划擦掉。
  adoptPlans(list) {
    // ⚠️ 用 Array.isArray 而不是 `if (!list)`：云函数下发的是**数组**
    // （`plansFor()` 里 map 成 `{date, text}`）。哪天回了个对象而不是数组，
    // `!list` 拦不住，紧接着的 `list.forEach` 会直接抛 —— 首屏白屏。
    // 判成「不是数组就当作旧版云函数没给」是唯一不会炸的读法。
    if (!Array.isArray(list)) return;
    const m = {};
    list.forEach(function (p) {
      if (p && p.date) m[p.date] = p.text || '';
    });
    this.plans = m;
  },

  /* 请求一次订阅授权，用户点了「允许」才回来记账。
     个人主体只有一次性订阅：一次允许 = 一条发送权，攒够几条就能发几条。
     用户勾过「总是保持以上选择」之后，这里**不再弹窗**、但授权次数照常 +1，
     所以体感就是「点一下保存就完事」。

     ⚠️ v8 起调用方只在「设了提醒时间、且提前量不是『不提醒』」时才进来
     （见 onSave）。选了「不提醒」还弹订阅框，既是骚扰，也不符合微信对
     「订阅要有真实触发场景」的要求。 */
  askSubscribe() {
    const tpl = this.subTpl;
    if (!tpl || !wx.requestSubscribeMessage) return;  // 首屏还没回来就静默跳过
    const that = this;
    wx.requestSubscribeMessage({
      tmplIds: [tpl],
      success(res) {
        // 只有 accept 才算攒到一条。reject（用户点了拒绝）/ ban（被后台限制）
        // / filter 都不给额度 —— 给了的话，第 N 次发送会被微信直接拒掉。
        if (res && res[tpl] === 'accept') {
          that.grantQuota();
          return;
        }
        // v8：拒绝时给一次明确反馈。以前这里是纯静默的，理由是「没额度」会在
        // 「我的」页聚合成一条「N 条提醒未送达」—— 但那要等**提醒到点之后**才
        // 看得见。中间这几天用户会一直以为提醒是好的，直到没收到才回头怀疑，
        // 而那时已经错过一次了。把反馈提前到「设的那一刻」。
        //
        // ⚠️ 只用 toast：不弹 modal、更不改数据。用户可能只是手滑点了拒绝，
        // 拦一个弹窗逼他重新选，比不提醒本身还烦人。
        wx.showToast({
          title: '未授权，这条提醒不会推送到微信',
          icon: 'none',
          duration: 2600,
        });
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

  /* ================= 今日饮水 =================
     只存本机（wx.setStorageSync），按日期各存一条：
         fq_water_2026-10-09 -> 1200
     于是「每天零点清零」不需要任何定时任务 —— 跨天读到的就是一个空 key。
     为什么不进云函数：饮水是个人身体指标，没有全家共享的意义，
     而且它完全离线就能成立，没必要为它占一个 action、抬一次 FN_VER。

     旧日期的 key 不做清理：一天几十字节，留着还能做「最近几天喝了多少」。
     真要做历史曲线时，这里是唯一需要改的地方。 */

  waterKey() {
    return WATER_KEY + todayStr();
  },

  // 读出今天的量。首次进入与跨天都走这里。
  loadWater() {
    let ml = 0;
    try {
      ml = Number(wx.getStorageSync(this.waterKey())) || 0;
    } catch (e) {
      // 读失败当 0：不因为一条本地记录把首屏打断。
    }
    ml = Math.max(0, Math.min(WATER_GOAL, ml));
    if (ml !== this.data.waterMl) this.setData({ waterMl: ml });
  },

  // 组件松手时回调（见 components/fq-water）。值已按目标夹紧，这里再夹一次兜底。
  onWaterChange(e) {
    const ml = Math.max(0, Math.min(WATER_GOAL, Number(e.detail && e.detail.ml) || 0));
    this.setData({ waterMl: ml });
    try {
      wx.setStorageSync(this.waterKey(), ml);
    } catch (e2) {
      // 写失败不回滚界面：今天喝到多少本来就以用户拖到的为准；
      // 下次进来读不到旧值也只是回到 0，不会串到别的日期上去。
    }
  },

  // 跨零点：页面一直开着时，靠轮询的节拍把「今天」换掉。
  // 不单开定时器 —— 页面可见时 syncTick 本来就在跑，页面不可见时也不该刷新
  // （用户看不到，白费一次 setData）。 */
  checkWaterDay() {
    const d = todayStr();
    if (d === this._waterDay) return;
    this._waterDay = d;
    this.loadWater();
    // 顺带把日程页的「今天」也推一次：日历上的今天圈、两张计划卡的
    // 「今天 / 明天」文案、当天事项列表，全是渲染时按当前日期现算的，
    // 不重绘就还停在昨天。
    // ⚠️ 选中的日期**故意不动** —— 用户正盯着某一天看，
    //    系统在零点把他选的日子换掉，比让他自己点一下「今天」更糟。
    if (this.data.ready && this.state.view === 'sched') this.render();
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
    // 跨零点检查放在最前：它不该被下面那三个让路条件挡掉 ——
    // 那三条说的是「先别拉云端数据」，和本机日期无关。
    this.checkWaterDay();
    if (!this.data.ready) return;
    // 三种情况下不拉：还没首屏、正在拖排序、本地还有没落库的写。
    // 后两种会把用户手上的操作冲掉（乐观更新被服务端快照覆盖，看着像「点不动」）。
    // 写计数问 services/cloud.js 要 —— 记账钉在唯一的云出口上，这里只读。
    if (this.data.sortMode || cloud.pendingWriteCount() > 0 || this.data.sheetOpen) return;
    const that = this;
    callCloud('sync', { rev: this.rev })
      .then(function (data) {
        if (!data || !data.changed) return;
        that.cats = data.categories || [];
        that.items = data.items || [];
        that.adoptPlans(data.plans);
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
      // 进度条读数。它和 done 是同一条状态线的两种读法，落库后必然一致
      // （耦合在云函数 updateItem 里，见那边的注释）。拖动期间这一对会被
      // paintProgress 用路径 setData 单独改写，不走这个函数。
      pct: itemPct(it),
      // 「这一条正被按住拖」——只驱动进度条那个抓取反馈（轨道加深 + 圆点放大）。
      // 走行内路径 setData 单独改写，和 pct 一样不走 render()。
      pgOn: false,
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

  /* ---------------- 日程 ---------------- */

  // 日历表头那行：'2026 年 10 月'
  buildCalLabel() {
    return monthLabel(this.state.schedYm);
  },

  // 「这一天有事项」的日期表。
  // ⚠️ 口径与下面 buildSchedRows 的「这天的事项」**完全一致**（都是
  //    「有提醒时间且落在那一天」）—— 日历上的圆点和点进去看到的列表
  //    必须是同一件事，否则会出现「有圆点但列表是空的」这种没人解释得通的状态。
  // 为什么不看完成态：完成的条目也仍然算「那天有过安排」，圆点讲的是
  // 「那天有没有内容」，不是「那天还剩多少活」。
  itemDays() {
    const map = {};
    this.items.forEach(function (it) {
      if (!it.remindAt) return;
      const k = dayKey(it.remindAt);
      if (k) map[k] = true;
    });
    return map;
  },

  // 42 个格子。
  // 起点取「当月 1 号所在那一周的周一」，然后**连排 42 天** ——
  // 于是上月补格、下月补格、闰年、跨年全都不用单独判：它就是一段连续的日子。
  // （getDay() 里 0 是周日，要拿周一当第一列，就得把周日挪到末尾：(0+6)%7 = 6。）
  buildCal() {
    const ym = this.state.schedYm;
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;

    const today = todayStr();
    const sel = this.state.schedDate;
    const hasItem = this.itemDays();
    const plans = this.plans;

    const out = [];
    for (let i = 0; i < CAL_CELLS; i++) {
      // 用 Date 自己进位：1 - lead + i 可能是 0 或负数（上月）、也可能 > 当月天数
      const d = new Date(y, m - 1, 1 - lead + i);
      const k = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      out.push({
        k: k,
        n: d.getDate(),
        other: d.getMonth() !== m - 1,
        today: k === today,
        sel: k === sel,
        hi: !!hasItem[k],
        hp: !!plans[k],
      });
    }
    return out;
  },

  // 一张计划卡。which: 0 = 这一天，1 = 次日。
  // ⚠️ `date` 永远是**页面正在看的那一天**（即 schedDate），次日由这里自己算 ——
  //    别让调用方把「次日」提前算好再传进来：那样 `planLabels(...)[which]` 会在
  //    已经前进过一天的基准上再前进一天，第二张卡的标题整整说错一天
  //    （选中今天，卡上写「后天准备做什么」，而它记的其实是明天）。
  //    标题随差值变（见 format.js 的 planLabels），不能写死「今天 / 明天」。
  buildPlan(date, which) {
    const d = which ? addDays(date, 1) : date;
    return {
      label: planLabels(dayDiff(date))[which],
      dateShort: mdShort(d),
      text: this.plans[d] || '',
      // 占位文案跟着「这张卡指的是哪一天」走：选中昨天时第二张卡是
      // 「今天要做什么」，写死「顺手把明天的重点记下来」就自相矛盾了。
      placeholder:
        which === 0
          ? '还没写，点一下记一笔'
          : '顺手把' + dayWord(dayDiff(date) + which) + '的重点记下来',
    };
  },

  // 「这天的事项」：提醒时间落在那一天的事项。
  // ⚠️ 口径是「那天的提醒」，不是「那天的排期」—— fq_items 里没有日期字段，
  //    只有 remindAt。所以这一段的语义照实写，不假装它是排期表。
  //    等哪天真的给事项加上 dueDate，改的是这一个函数 + 日历的圆点口径。
  // 不受当前分类筛选影响：日程是跨分类的「时间视图」，
  // 分类筛选属于总览/详情那条线（见 memory 里「矩阵管哪一格、日程管哪一天」）。
  buildSchedRows() {
    const date = this.state.schedDate;
    const out = [];
    this.items.forEach(function (it) {
      if (!it.remindAt) return;
      if (dayKey(it.remindAt) !== date) return;
      out.push({
        _id: it._id,
        q: it.quad,
        title: it.title,
        done: !!it.done,
        ts: it.remindAt,
        // 右槽：未完成给具体时刻，已完成给状态 —— 两者都是「这一条现在怎么样」
        tail: it.done ? '已完成' : hhmm(it.remindAt),
      });
    });
    // 未完成在前，同状态按时刻先后。与详情页「待办在前」的读法一致。
    out.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return a.ts - b.ts;
    });
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
    } else if (v === 'sched') {
      const date = this.state.schedDate;
      const diff = dayDiff(date);
      const rows = this.buildSchedRows();
      let undone = 0;
      rows.forEach(function (r) {
        if (!r.done) undone++;
      });
      patch.calLabel = this.buildCalLabel();
      patch.calCells = this.buildCal();
      patch.calAtToday = diff === 0;
      patch.schedDayLabel = dateCN(date);
      patch.schedBadge = diff === 0 ? '今天' : '';
      if (!rows.length) patch.schedCount = '无待办';
      else if (undone) patch.schedCount = undone + ' 项待办';
      else patch.schedCount = '都已完成';
      patch.planDay = this.buildPlan(date, 0);
      // ⚠️ 传的就是 date（选中日），不是 addDays(date,1)：见 buildPlan 里的说明 ——
      //    提前算好次日会让标题在已经前进一天的基准上再前进一天。
      patch.planNext = this.buildPlan(date, 1);
      patch.schedRows = rows;
      patch.pageTitle = '日程';
      // ⚠️ 顶部这行小标题**固定是今天**，不跟选中日走（点下个月 15 号它也不变）。
      //    它和下面 .dayh 那行分工不同：.dayh 回答「我现在在看哪一天」，
      //    这一行回答「今天是几号」—— 页面级的参照。
      //    两行都跟着点日历变的话，屏幕上就没有任何一处能告诉你日历上那个
      //    描边圈（今天）到底是几号了。
      patch.pageMeta = dateCN(todayStr());
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
    // 进度条手势不跨重绘存活：render() 之后行对象可能是新的，
    // 手里那份 `_pg.rect` 已经指不到屏幕上的东西了。
    this._pg = null;

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
    // 这个 handler 只由组件 fq-tabbar 触发（页面上没有别的调用点），
    // 取值走 e.detail —— 组件把被点 tab 的 dataset 原样塞进了 detail
    // （见 components/fq-tabbar/fq-tabbar.js）。原先是页面自己的元素上带
    // data-k、直接读 e.currentTarget.dataset，搬进组件后那条路就不通了：
    // 组件标签上没有 data-k，读出来是 undefined，会把 state.view 设成 undefined。
    const key = e.detail.k;
    if (key === this.state.view) return;
    this.state.view = key;
    this.state.filt = 'all';
    this.exitSort();
    this.render();
  },

  onOpenQuad(e) {
    // 只由组件 fq-quad 触发（页面上没有别的调用点），取值走 e.detail ——
    // 组件把被点象限的 dataset 原样塞进了 detail。
    this.state.quad = e.detail.k;
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

  /* ================= 交互：日程 ================= */

  // 翻月。选中的那天如果不在新月份里，就落到新月份的 1 号 ——
  // 否则会出现「网格里一个选中格都没有，下面两张卡却在讲另一天」的脱节。
  shiftMonth(n) {
    const ym = this.state.schedYm;
    // 交给 Date 进位，省掉手写「12 月 +1 = 次年 1 月」这类边界
    const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1);
    const next = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    this.state.schedYm = next;
    if (ymOf(this.state.schedDate) !== next) this.state.schedDate = next + '-01';
    this.render();
  },

  onCalPrev() {
    this.shiftMonth(-1);
  },

  onCalNext() {
    this.shiftMonth(1);
  },

  onCalToday() {
    const t = todayStr();
    this.state.schedDate = t;
    this.state.schedYm = ymOf(t);
    this.render();
  },

  onCalPick(e) {
    // 只由组件 fq-cal 触发（页面里没有别的调用点），取值走 e.detail ——
    // 组件把被点那格的 dataset 原样交给了 detail（见 components/fq-cal/fq-cal.js）。
    const k = e.detail && e.detail.k;
    if (!k) return;
    this.state.schedDate = k;
    // 点到上/下月的补格时，把显示的月份也跟过去 —— 否则那只是网格边缘上的
    // 一个数，用户以为点不动。
    this.state.schedYm = ymOf(k);
    this.render();
  },

  // 「这天的事项」里点一行 → 直接进那条事项的编辑抽屉。
  // 复用 openForm，不另开一条入口（左滑、卡片点击走的都是它）。
  onSchedRow(e) {
    const it = this.findItem(e.currentTarget.dataset.id);
    if (it) this.openForm(it);
  },

  // 点计划卡 → 打开抽屉写「这一天 / 次日」的计划。
  // which 由组件 fq-plan 通过 e.detail.kind 给出（'day' | 'next'）。
  // 注意页面内部没有第二个调用点，两条路都从这里算日期，
  // 「次日」永远是相对**选中日**而不是相对今天。
  onPlanEdit(e) {
    const date =
      (e.detail && e.detail.kind) === 'next'
        ? addDays(this.state.schedDate, 1)
        : this.state.schedDate;
    this.setData({
      sheetOpen: true,
      sheetKind: 'plan',
      sheetTitle: planLabels(dayDiff(date))[0],
      sheetSub: dateCN(date),
      planDate: date,
      planDraft: this.plans[date] || '',
    });
  },

  onInputPlan(e) {
    this.setData({ planDraft: e.detail.value });
  },

  // 保存计划。**空文本 = 删掉这一天的计划**（云函数 savePlan 是同一套语义），
  // 所以不需要再给一个「删除」按钮：清空再保存就是删除。
  onSavePlan() {
    const date = this.data.planDate;
    if (!date) return;
    // 再切一次长度兜底：textarea 的 maxlength 是客户端限制，
    // 云函数那边还有一道 MAX_PLAN（两道都要有，前端拦不住手动构造的请求）。
    const text = String(this.data.planDraft || '').slice(0, PLAN_MAX);
    this.closeSheet();
    const that = this;
    this.commit(
      function () {
        if (text) that.plans[date] = text;
        else delete that.plans[date];
      },
      callCloud('savePlan', { date: date, text: text })
    );
  },

  onFilter(e) {
    if (this.data.sortMode) return; // 排序模式下筛选被锁
    // 只由组件 fq-filters 触发，取值走 e.detail。
    this.state.filt = e.detail.k;
    this.render();
  },

  onPickCat(e) {
    // ⚠️ 这个 handler 有**两个来源**，取值方式不同：
    //   ① 组件 fq-cats（总览的分类胶囊）→ triggerEvent 把被点元素的 dataset
    //      放进 e.detail，所以读 e.detail.k；
    //   ② 页面自己的分类行（「我的」页）→ 仍然是原生事件，读 currentTarget.dataset。
    //   两处共用一个 handler（逻辑一致，没必要分两份），所以两边都认一下。
    const k = e.detail && e.detail.k !== undefined ? e.detail.k : e.currentTarget.dataset.k;
    this.state.catId = k;
    this.render();
  },

  onGotoMine() {
    this.state.view = 'mine';
    this.exitSort();
    this.render();
  },

  /* ================= 交互：排序模式 / 拖动排序 =================
     这一整块搬去了 utils/drag.js：
       排序模式开关（onSortToggle / exitSort）、拖动手柄（onHandle*）、
       滚动同步（onScrollerScroll）、拖动状态机（startDrag 起）、
       行位置测量、拖到边缘自动滚、松手落库（commitOrder）。
     它是全项目最长的一段状态机（约 450 行），且只跟 this.data 与 this._*
     打交道，正好可以整块独立出来 review。文件末尾 Object.assign 回页面。

     留在本文件里的是三种手势**共用的入口** onRowStart / onRowMove / onRowEnd：
     它们同时服务左滑、拖动、滚动，属于事件编排，不是拖动引擎。 */

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
    // 同理清掉进度条手势。正常路径走不到这里（`.prog` 用 catchtouchstart
    // 截住了自己的手势，卡片这一层根本收不到），留着是防止某次中断
    // （touchend 丢失）把 `_pg` 遗传给下一次手势。
    this._pg = null;
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

  /* 拖动手柄 / 滚动同步 / 拖动引擎 → utils/drag.js（文件末尾合并进来） */


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
    // 进度与完成是同一条状态线：完成 = 进度 100%，撤销 = 归零
    // （设计稿 §06 「点撤销 → 完成取消，进度归零」）。撤销若保留 100%，
    // 卡片会显示满格却不算完成 —— 那等于没撤销。
    //
    // 落库只送 done：progress 由云函数按 done 推（见 updateItem 那段耦合）。
    // 两边各推一次的话，就成了两个真相来源，迟早对不上。
    const pct = next ? 100 : 0;

    this.commit(
      function () {
        it.done = next;
        it.progress = pct;
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

  /* ---------------- 交互：事项进度条 ----------------
     横向拖动改进度，拖到 100% 即完成，拖回来即自动撤销（设计稿 §06）。

     ⚠️ 与卡片左滑的冲突必须在这一层解决，不能靠「谁先响应」——
        两者都是横向手势，浏览器只会判给先到的那一方：
        · `.prog` 用 **catchtouchstart** 截住手势，`.row-in` 的 onRowStart 收不到，
          左滑从第一帧起就不会启动（和 `.dh` 手柄同一个手法）；
        · `.prog` 用 **catchtap** 吸掉点击，否则「点一下改进度」会同时弹出编辑抽屉；
        · touchmove 用 **bind** 而不是 catch —— 横滑才吃这一串手势，
          纵滑原样放过给 scroll-view。若这里也 catch，每张卡片底部就会多出
          一条 48rpx 高、按着滑不动的死区，长列表里非常难受。
          （反过来也证明 catchtouchstart 不会挡住 scroll-view 自己滚动：
            真要挡滚动，社区里就不必到处用 catchtouchmove 了。） */

  onProgStart(e) {
    // 排序模式下只允许拖手柄，进度条不响应（但手势照旧被 catch 截住，
    // 所以也不会误触发卡片左滑）。
    this._pg = null;
    if (this.data.sortMode) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    // 顺手清掉上一次手势的残留：`.row-in` 的 onRowMove 是 bind，这条 touchmove
    // 会照样冒泡上去；`_drag` 若还留着旧起点，它会拿旧基准去判滑动的阈值。
    this._drag = null;
    this._pg = {
      id: e.currentTarget.dataset.id,
      x0: t.clientX,
      y0: t.clientY,
      dx: 0,
      dy: 0,
      armed: false,
      rect: null,
    };
    this.measureTrack(this._pg.id);
  },

  onProgMove(e) {
    const pg = this._pg;
    if (!pg) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    pg.dx = t.clientX - pg.x0;
    pg.dy = t.clientY - pg.y0;
    if (!pg.armed) {
      if (Math.abs(pg.dx) < 5) return;
      // 方向判别：横向位移压过纵向才算「拖进度」，否则这串手势属于列表滚动。
      // 与左滑用的是同一个判据（见 onRowMove），区别是这里必须显式让路 ——
      // 纵滑由视图层直接处理，我们唯一要做的是别去动它。
      // 一旦判成纵向就永久放弃这一次手势（armed 保持 false），
      // 免得用户「先往下滑、再往右滑」时把列表滚动硬生生掰成改进度。
      if (Math.abs(pg.dx) <= Math.abs(pg.dy)) return;
      pg.armed = true;
      // 抓取反馈（轨道底色加深 + 圆点放大），与饮水卡那一条同款。
      // 等判成横向拖动才给，不在 touchstart 就给 —— 否则每次「落在进度条上
      // 往下滑列表」都会先闪一下放大，像是碰到了什么。
      this.setRowFlag(pg.id, 'pgOn', true);
    }
    const v = this.progPctAt(pg.rect, t.clientX);
    // 量不到轨道（还没量完 / 节点被回收）就跳过这一帧，而不是拿 0 顶上 ——
    // 0 会把进度条当场拽回最左端，比不动更糟。
    if (v === null) return;
    this.paintProgress(pg.id, v);
  },

  onProgEnd() {
    const pg = this._pg;
    this._pg = null;
    if (!pg) return;
    // 抓取反馈先收掉。下面几条 return 分支（比如这条事项已经不在镜像里）
    // 都走不到 commit，漏掉就会留下一个永远放大的圆点。
    if (pg.armed) this.setRowFlag(pg.id, 'pgOn', false);
    const it = this.findItem(pg.id);
    if (!it) return;

    if (!pg.armed) {
      // 没进入拖动，有两种可能，靠位移分辨：
      //   位移很小 → 「点一下」：按住轨道任意位置，圆点直接跳过去（设计稿 §06 第一行）。
      //              圆点只有 30rpx，不要求用户先精确按住它。
      //   位移不小 → 其实是在这一条上往下滑列表，绝不能顺手把进度改掉。
      if (Math.abs(pg.dx) > 6 || Math.abs(pg.dy) > 6) return;
      const v = this.progPctAt(pg.rect, pg.x0);
      if (v === null) return;
      this.paintProgress(pg.id, v);
    }

    const pct = itemPct(it);
    // 松手才落库。拖动期间每帧发一次云函数的话，就是几十个并发请求，
    // 而且它们还可能乱序到达 —— 最后到的那个不一定是你最后拖到的值。
    this.commit(
      function () {
        it.progress = pct;
        it.done = pct >= 100;
      },
      callCloud('updateItem', { id: pg.id, patch: { progress: pct } })
    );
  },

  // 存在的唯一目的是**吸掉**这次点击：`.row-in` 上的 catchtap（点卡片进编辑）
  // 在拖动结束后的那一下会跟着触发，于是「拖完成」会顺带弹出编辑抽屉。
  onProgTap() {
    /* 有意为空 —— 这是事件屏障，不是忘了实现 */
  },

  // 量一次这条进度条的**轨道**矩形（不含右侧读数区），把手指的 x 换算成百分比。
  // 一次手势只量一次：每帧都量等于每帧一次视图层往返，拖动会肉眼可见地滞后。
  measureTrack(id) {
    const that = this;
    wx.createSelectorQuery()
      .select('#rpt-' + id)
      .boundingClientRect(function (r) {
        // 回调是异步的，回来时这一串手势可能已经结束、甚至换了一条事项
        if (that._pg && that._pg.id === id) that._pg.rect = r || null;
      })
      .exec();
  },

  // 手指的 x → 百分比。rect 由调用方传进来，**不要**让它自己去读 this._pg ——
  // onProgEnd 在落库前会先把手势状态清掉，那时候再读就什么都读不到了，
  // 而这条路径恰好是「点一下，圆点跳过去」，它会整条静默失效
  // （不报错、不落库、进度也不动，看起来跟没点到一样）。测试抓到的就是这个。
  progPctAt(rect, clientX) {
    if (!rect || !rect.width) return null;
    const v = ((clientX - rect.left) / rect.width) * 100;
    return Math.max(0, Math.min(100, Math.round(v)));
  },

  // 拖动中每一帧都调它：镜像 + 这一行的路径 setData。
  // 这是设计稿那句「拖动过程中不做整页重绘」在 WXML 侧的等价写法 ——
  // 不走 render()，所以列表不重排、统计条不重算、其它卡片一个字节都不动。
  paintProgress(id, pct) {
    const it = this.findItem(id);
    if (!it) return;
    // 镜像先改：松手落库读的是它，统计与筛选也读它
    it.progress = pct;
    it.done = pct >= 100;
    const path = this.progPath(id);
    if (!path) return;
    const patch = {};
    patch[path + '.pct'] = pct;
    patch[path + '.done'] = it.done;
    this.setData(patch);
  },

  // 只改某一行的一个布尔位（进度条的「正被按住」标记走这里）。
  // 不进镜像 —— 它是纯视图态，render() 重建行数据时会被 rowVM 复位成 false，
  // 这正好是一层免费的兜底：任何中断都不会让它粘住。
  setRowFlag(id, key, val) {
    const path = this.progPath(id);
    if (!path) return;
    const patch = {};
    patch[path + '.' + key] = val;
    this.setData(patch);
  },

  // 这一行在 data 里的 setData 路径。详情页是 rows[i]，「全部」页是 sections[j].rows[i]
  // —— 两个视图共用同一个模板，却落在两棵不同的数据树上。
  // ⚠️ 只看当前视图那一棵：两棵都扫的话切视图的瞬间可能同时命中同一个 id，
  //    改错一棵的表现是「数据对了，屏幕没动」，最难查的那种。
  progPath(id) {
    const v = this.state.view;
    if (v === 'detail') {
      const rows = this.data.rows || [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]._id === id) return 'rows[' + i + ']';
      }
      return '';
    }
    if (v === 'all') {
      const secs = this.data.sections || [];
      for (let j = 0; j < secs.length; j++) {
        const rs = secs[j].rows || [];
        for (let i = 0; i < rs.length; i++) {
          if (rs[i]._id === id) return 'sections[' + j + '].rows[' + i + ']';
        }
      }
    }
    return '';
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
      // 老数据（v8 之前）没有 leadMin → leadIndex 回落默认档，这就是
      // 「默认提前 30 分钟」对存量事项生效的位置。
      // ⚠️ 只读 item.leadMin，**不看** item.pushAt：pushAt 是从它推出来的，
      // 拿结果反推输入等于把同一件事算两遍，迟早对不上。
      leadIdx: leadIndex(item ? item.leadMin : LEAD_DEFAULT),
      leadLabel: leadLabel(item ? item.leadMin : LEAD_DEFAULT),
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

  // 提前提醒时长（v8）。picker 给的本来就是下标，直接存下标 ——
  // 分钟值只在 onSave 里由下标取一次，省掉「存进去再换算回来」这条容易对不上的路。
  // 越界（理论上来不了，但 picker 的 value 是数字）回落默认档，不写 undefined 进 data。
  onLead(e) {
    const i = Number(e.detail.value);
    const idx = Number.isFinite(i) && LEAD_OPTIONS[i] ? i : LEAD_DEFAULT_IDX;
    this.setData({
      'form.leadIdx': idx,
      'form.leadLabel': LEAD_OPTIONS[idx].label,
    });
  },

  onClearRemind() {
    // 一并把提前量复位成默认档：清除提醒时间后，云函数会把 remindAt / leadMin /
    // pushAt 一起落成 null，抽屉里整块选择器也随之消失。
    // 留个残值在 form 里没意义，下次打开又是另一个事项的数据。
    this.setData({
      'form.hasRemind': false,
      'form.dateLabel': '不提醒',
      'form.leadIdx': LEAD_DEFAULT_IDX,
      'form.leadLabel': LEAD_LABELS[LEAD_DEFAULT_IDX],
    });
  },

  onSave() {
    const f = this.data.form;
    const title = String(f.title || '').trim();
    if (!title) {
      wx.showToast({ title: '请先写事项标题', icon: 'none' });
      return;
    }
    const remindAt = f.hasRemind ? toTimestamp(f.date, f.time) : null;
    // 提前量只在真有提醒时间时才有意义。没有提醒时间 → null，
    // 云函数那边是同一套判断（它还会再净化一次，这里只是不主动送脏值）。
    const leadMin = remindAt
      ? (LEAD_OPTIONS[f.leadIdx] || LEAD_OPTIONS[LEAD_DEFAULT_IDX]).v
      : null;
    const payload = {
      title: title,
      note: String(f.note || '').trim(),
      quad: f.quad,
      catId: f.catId,
      priority: f.priority,
      remindAt: remindAt,
      leadMin: leadMin,
    };

    const that = this;
    const isEdit = !!f.id;
    this.closeSheet();

    // 「带提醒的保存」= 顺手攒一条推送额度。
    // 必须在这里同步调用：requestSubscribeMessage 要求「在用户交互后」调，
    // 此刻还在这一次 tap 的调用栈里；挪到 callCloud 的 then 里就会被判不合规。
    //
    // ⚠️ v8：选了「不提醒」就**根本不请求授权**。两条理由，一条体验一条合规：
    //   ① 用户已经明说不要通知了，再弹订阅框是纯粹的骚扰，而且他会犯嘀咕
    //      「我都选不提醒了，怎么还非要我授权」；
    //   ② 微信要求 requestSubscribeMessage 有真实触发场景，拿一个不会用来推送的
    //      事项去换一次授权，属于滥用订阅能力。
    if (remindAt && leadMin !== -1) this.askSubscribe();

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
          // ⚠️ leadMin 也必须一起落到本地镜像：抽屉重开时读的就是它（openForm 只看
          // item.leadMin）。漏了这一行不会报任何错，只是「刚选的提前量，重开一次就
          // 变回 30 分钟」—— 而那正是 v8 握手专门要拦的那个故障现象，
          // 区别只在于这次是客户端自己把镜像写漏了。
          it.leadMin = payload.leadMin;
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
            // 与上面编辑分支同理：镜像里得有 leadMin，否则「刚建好就去改」会看到默认档
            leadMin: payload.leadMin,
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
};

/* 拖动排序的状态机从 utils/drag.js 合并进来。
   方法与原先写在对象字面量里完全等价（同一份 this、同一套 _* 实例状态），
   所以调用点一处都不用改；WXML 上的 bindtap="onSortToggle" 等也照原样生效。 */
Object.assign(pageDef, drag);

Page(pageDef);
