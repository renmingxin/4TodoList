// miniprogram/utils/drag.js
// 拖动排序的整套状态机：排序模式开关、拖动手柄、行位置测量、跟手位移、
// 跨行让位、拖到屏幕边缘自动滚、松手落库。
//
// 为什么单独成文件：
//   它原本是页面里最长的一段（约 450 行），而且与「视图状态机」几乎不耦合 ——
//   只用 this.data 和几个 this._* 实例状态，正好可以整块独立出来 review。
//   页面那边用 Object.assign 把它合并回页面定义，方法与写在对象字面量里
//   完全等价（同一份 this、同一套实例状态），所以**调用点一处都不用改**。
//
// 留在页面里的部分不是漏掉的：
//   onRowStart / onRowMove / onRowEnd 是左滑、拖动、滚动**三种手势共用的入口**，
//   属于事件编排而非拖动引擎，所以留在页面。拖动引擎由它们调用
//   （this.startDrag / applyDragMove / endDrag），靠同一个原型链解析。
//
// 本文件不引入任何新状态：_dg / _dgP / _dragSeq / _scrollTop / _scBand /
// _asTimer / _asDirDone / _asPending / _pulseT 全挂在页面实例上，
// 与搬走之前一模一样 —— 这也是「零行为改动」的关键。

const { LAYOUT, ORDER_STEP, REORDER_CAP } = require('./const.js');
const { callCloud } = require('../services/cloud.js');

module.exports = {

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
};
