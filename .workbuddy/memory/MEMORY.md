# 项目长期记忆 · 4todolist（四象限事项待办中心）

## 项目定位

微信原生小程序 + 云开发。做「基于艾森豪威尔矩阵的待办中心」，移动端重构自 PC 版。
界面只有一个页面 `pages/index/index`，四个视图靠内存状态切换。

- 环境 ID：`cloud1-d0gaaaa6g7f0f1b61`（写在 `miniprogram/app.js`）
- 云函数：`cloudfunctions/fqTodo` 是**唯一数据出口**，客户端不直连数据库
- 设计稿：WorkBuddy 资料库 nodeId `QXEFcvAMk44AziumpEiVDs`，本地快照在 `.workbuddy/tmp/four-quadrant-mobile.html`

## 硬约定（改代码前必读）

### 1. 尺寸：设计稿 px × 2 = rpx

设计稿画布 375px 宽，小程序 750rpx = 屏宽。所有固定高度（导航 88、分类条 88、
统计条 112、Tab 120、底栏 134，单位 rpx）**同时写在两处**，必须成对修改：

- `pages/index/index.wxss` 顶部注释里的常量表
- `pages/index/index.js` 的 `LAYOUT`

拖动排序相关常量也是成对的，改一个必须改另一个：
`ROW_GAP 16`（`.row` 的 margin-bottom）、`SWIPE_W 240`（`.rowacts .act` 宽 120rpx × 2：
完成 / 删除，两种视图一致，`swipeMax()` 直接返回它）。

⚠️ **`app.wxss` 全局设了 `view,text,button,input,textarea,scroll-view{box-sizing:border-box}`**，
所以小程序里所有 `height` 都是**含 padding 的总高**。改任何高度相关样式前先确认这条，
否则会平白多/少一截（例如 `.q{height:476rpx;padding:26/22rpx}` 的总高就是 476rpx）。

底部定位已全面改为 CSS flex 自动分配（见 §9），`LAYOUT` 里现在只有 `TAB_H` 还参与计算
（算 FAB 的 bottom 偏移），其余只是样式的说明来源。

### 2. 布局：不用 flex 的 gap

旧 Android WebView 对 flex `gap` 支持不可靠。flex 造间距一律用 `margin-right` +
`:last-child{margin-right:0}`（或用 `justify-content:space-between` 让容器自己算）。
`gap` 现在只剩 `display:grid` 的象限选择器 `.qpick` 在用。

### 2.1 头部固定：详情 / 全部页的头一律放在滚动区外

`.screen` 是纵向 flex，`.scroller` 用 `flex:1; min-height:0` 吃掉剩余高度。
**凡是「列表再长也不该滚走」的块，都写在 `<scroll-view class="scroller">` 之前**：

| 视图 | 固定头部 | 滚动主体 |
|---|---|---|
| detail | `dhead`（返回/象限名/大数字/胶囊）→ `filters` → `sortrow` → `.swipecue` | `.rows-wrap` |
| all | （appbar 本来就在外面）→ `sortrow` → `.swipecue` | `.sec` 分段列表 |
| overview | `appbar` / `catsrow` / `stats` | 矩阵网格 |

两条不成文但必须遵守的写法：

1. **每个固定块写 `flex: 0 0 auto`**。不写就是默认 `flex:0 1 auto`，屏幕不够高时
   会被 `.scroller` 挤扁（它 `flex:1` + `min-height:0`，抢空间最凶）。
2. **文字要垂直居中就用 `height` + 等值 `line-height`**，别用上下不对称的 padding
   （`.swipecue` 曾经是 `padding:4rpx 0 12rpx`，上 4 下 12，文字明显偏上）。
3. **`.swipecue` 要和它上面那一行的 `.shint` 左对齐**（第 10 轮改）：挂
   `.swipecue.left { text-align:left; padding:0 32rpx }`，32rpx 对齐 `.sortrow` 的左内边距。
   居中的写法是「上左下一中」，两行看着像互不相干的两块。
   **总览页那条矩阵说明不挂 `.left`，保持居中**（语义不同，别一刀切改掉）。

`mp-check.js` 第 4 条会拦「头部又被写回滚动区」。

### 3. 象限色：单变量 `--qc` 驱动

`app.wxss` 定义 `--q1..--q4`，`.q1/.q2/.q3/.q4` 类把 `--qc` 指向对应色。
色块、左侧色条、详情页整屏底色都读 `var(--qc)`，所以只需给元素挂一个象限类。
**不要**用属性选择器 `[data-q="q1"]`（WXSS 支持不稳）。

### 4. 图标：全部 CSS 自绘，不用 svg 文件

小程序 `<image>` 对本地 `.svg` 在 Android 上支持不可靠。现有自绘图标在 `index.wxss`
末尾：`ico-grid / ico-list / ico-user / ico-chev-l / ico-chev-r / ico-check /
ico-undo / ico-plus(.big/.sm) / ico-trash / ico-dots / ico-sliders / ico-sort / ico-drag`。
新增图标照此办理。`ico-drag`（第 10 轮加，手柄里的三横线）是「flex 列 + space-between」，
**必须写在 `.ico { display:block }` 之后**：两者同为单类选择器，权重相等靠先后定胜负，
写前面会被 `.ico` 的 `display:block` 盖掉，三根线挤成一坨。`ico-undo`（第 6 轮加，左滑「撤销」用）是「三角箭头 + 尾杆」，
纵向占位刻意做成 16+12=28rpx，与 `ico-check` 的 22+6 相等 —— 两者是同一个按钮的两种状态。

⚠️ **图标内部子元素的 class 名不能和页面级 class 重名**（详见「布局铁律」第 8 条）。
`ico-trash` 现在是「一个元素 + `::before`（桶盖）/ `::after`（桶身）」，
**没有内层 `<view>`**，就是因为原来那个 `class="body"` 撞上了页面级的 `.body`。

### 5. 数据流：本地镜像 + 乐观更新

`this.cats` / `this.items` 是服务端数据的内存镜像（**不在 data 里**，避免无谓的 setData）。
`Page.data` 只放视图模型。改数据 → 先改镜像 → `render()` 推视图模型 → 异步落库，
失败走 `commit()` 里的 `load()` 回滚。

派生数据的方法都叫 `buildXxx()`，`render()` 按当前视图挑需要的字段 patch。

### 6. 手势契约：横向滑动 = 左滑操作，排序模式下才能拖动

| 手势 | 结果 |
|---|---|
| 横向滑动卡片（非排序模式） | 左滑露出 2 个操作（240rpx）：未完成 → 完成 / 删除；已完成 → 撤销 / 删除（撤销就是同一个 `toggleDone` 取反） |
| 点卡片（非排序模式） | 进编辑抽屉；若该行正滑开着，这一下只收起，不进抽屉 |
| 点列表上方「调整顺序」 | 进排序模式：只允许拖**手柄**，其他按钮全锁；同时震动 + 所有卡片抖一下。**列表本身照常滚动** |
| 按住卡片**右侧手柄**拖动（仅排序模式） | 手指位移 > 5px 即拿起卡片，纵向移动换位，松手落库；拿起与拖动都不抖 |
| 在卡片**本体**上纵向滑动（仅排序模式） | 就是滚列表（第 10 轮新增） |

**第 4 轮改掉了长按拖动**：长按无视觉提示、新用户发现不了，且整屏都是卡片时按下即拖
会让列表滚不动。现在用**显式模式开关**：`data.sortMode`，入口在列表上方
（详情页在 `.filters` 之后、全部页紧接 appbar 之后），底部换成固定的 `.sortdone`「完成」条
（同时替掉 `.bottombar` 与 `.tabbar`）。

**第 10 轮给「排序模式滚不动」补上了正解**：拖动收窄到卡片右侧的 `.dh` 手柄
（`catchtouchstart/catchtouchmove/catchtouchend`，把事件从滚动区手里截走），
卡片本体仍是 `bind`，事件照常冒泡给 `scroll-view` —— 一张卡片从此有两块互不干扰的区域。
**手柄必须 `catch`、卡片本体必须 `bind`**：手柄只用 `bind` 拦不住（会一边滚一边拖），
卡片本体误用 `catch` 则列表再也滚不动。测试第 [15] 组把这两条钉死。
**结论：拖动与滚动都是纵向手势，落在同一个元素上必然互斥；靠改 `scroll-y` 去抢是抢不赢的**
（滚动由视图层在 touchmove 那一刻先启动，setData 关得晚半拍），必须分元素。

**第 7 轮起，「调整顺序」这一行与它下面的 `.swipecue` 提示行一起进了固定头部**
（在 `.scroller` 外面，见 §2.1）。原来提示行是列表最后一行，长列表要滑到底才看得到。

- 锁定用 `.lock { pointer-events:none; opacity:.4 }` 挂到 `.filters` 与详情页 `⋮`；
  `onRowTap` / `onRowAct` / `onFilter` / `onQuadMenu` 里都加了 `sortMode` 早退兜底。
- **`render()` 里故意不重置 `sortMode`**：拖动落库会走 `commitOrder → commit → render()`，
  在那里重置会导致每拖一次就被踢出排序模式。改在 `onTab/onOpenQuad/onBack/onGotoMine`
  里调 `exitSort()`。
- 抖动反馈只在**点「调整顺序」那一刻**发生，拖动过程中不抖（用户第 6 轮要求）。
  实现是 `data.sortPulse`：进入时置 true、380ms 后摘掉，CSS 挂在
  `.row.pulse .row-in .tx { animation: txShake … }`。**不能把动画挂在 `sortMode` 上**——
  动画由 class 驱动，`sortMode` 在整段排序期间都是 true，class 不变虽不会重放，
  但任何一次重绘都可能让它参与 diff。`startDrag` 里原有的 `wx.vibrateShort` 也一并去掉。
  **动画只能加在 `.tx` 上**，加在 `.row-in` 上会和跟手位移的内联 `transform` 打架。
- `startDrag(id, clientY)` 取代原 `onRowLong(e)`：`clientY` 作位移原点。
  **`measureRows` 的回调是异步的，必须设防**（第 9 轮的根因 bug）：回调回来时这一次拖动
  可能早已结束（手指点一下就抬走、中途切视图、或已开始新的一次拖动）。`startDrag` 每次
  自增 `this._dragSeq`，回调里三道闸一起关 —— `seq !== _dragSeq || !data.dragOn ||
  data.dragId !== id` 就直接丢弃。**惰性自增**（`(this._dragSeq || 0) + 1`），
  别写成 `++this._dragSeq`：仿真测试用 `Object.create` 造页面、不走 `onLoad`，
  `++undefined` 得到 NaN，会把每一次合法拖动都判成过期。
  早先无条件写 `that._dg` → **僵尸拖动**：此后每一次 touchmove（包括正常滚动列表）都被
  `applyDragMove` 接管，用过期坐标算出错的让位位移、重排整个列表 → 用户看到
  「列表一多，滑动时卡片乱跳、滑到的块都消失」。
- `onSortToggle()` / `exitSort()` 都要清 `_dg` 与 `_drag`；`onRowEnd` 的排序模式分支
  还要清 `dragId/dragY` —— 点一下就抬走时 `dragId` 已经推到视图层，只清 `dragOn`
  会让那张卡一直挂着抬起阴影。
- **第 10 轮起排序模式可以滚了**（见上）。拖动必须从手柄开始，这条写进了 README 的已知限制。
- **第 15 轮修的两个问题（拖不动 / 拖起来卡）**：
  1. **`_dgP` 闸**。`_dragSeq` 只防「迟到的回调」，防不住反面：`measureRows` 异步期间 `_dg`
     还是空的，`onRowMove` 就会在**每个 touchmove** 上再喊一次 `startDrag` → `_dragSeq` 被反复
     自增、在途回调全废、`dragY` 反复压回 0。手指一直动就永远拿不起卡片 ——
     表现是「按住拖不动，要试好几次才成功」。现在在途期间只认第一次调用，拿到 `_dg` 后自动
     松开（`onRowStart` / `endDrag` / 收尾分支也清，防漏清把它永久卡住）。
     ⚠️ **这个坑只在真机出现**：测试桩默认同步回调，永远复现不了，必须把测量改成排队
     （第 22 组就是这么做的，并配了反向对照）。
  2. **跟手位移必须量化 + 去重**。`dragY` 出现在**每一行**的 `style` 表达式里，每 setData 一次
     整个列表样式重算；而 touchmove 能到 60~120Hz，原来是无条件推。现在 `Math.round` 成整数
     px、再用 `dg.pushedY` 去重（同一像素格内的连续 touchmove 直接吃掉），落点判定也改用这个
     整数位移（屏幕上就是它）。两条配套：`onRowStart` 不再在 touchstart 就推 `dragging`
     （它只是「关过渡动画」的开关，必须与第一帧位移同时到场，早推等于每次碰卡片都白重渲染
     一次）；`.row-in.lift` 加 `will-change: transform`（被拖的卡片每帧都在动，
     28px 模糊的抬起阴影跟着每帧重绘太贵）。

**两条 setData 通道**（沿用左滑那套节流思路，别合并成一个）：
`dragY`（被拖卡片跟手，每帧只推一个数字）+ `shift`（其余卡片的让位量，只在跨过某行中线
时才 setData 整个 rows/sections）。行位置在「拿起」时用 `boundingClientRect` 量一次，
之后**只按 `bindscroll` 报来的滚动量整体平移**（`_dg.rects[i].top -= d`），不再重新查询。

**`scroll-y` 现在常开**（第 10 轮定案）：任何模式的任何时刻都不去动它。
第 9 轮曾改成「进排序模式时一次性关掉」（更早还绑过 `dragOn`），那是在给「整卡可拖」让路，
代价是排序模式完全不能滚 —— 用户随后就反馈了。**能滚动 + 能拖动两全的唯一正解是把两种
手势分给不同元素（`.dh` 手柄 `catch` 掉事件），而不是靠改配置抢手势**：滚动由视图层在
touchmove 那一刻先启动，`setData` 关得晚半拍，抢不赢。**只有滑开的那一行裁剪**。

**拖到边缘自动滚**（`maybeAutoScroll` / `runAutoScroll`，第 10 轮加）：手指进入滚动区
上下缘 `LAYOUT.DRAG_EDGE = 96px` 以内时，每 `AS_TICK = 40ms` 推 `AS_STEP = 14px`。
三条不能省的细节：

1. 滚动区上下边由 `measureScroller()` 在**拿起卡片时量一次**（`q.select('.scroller')`
   单点查询）。量不到就 `_scBand = null` → 不自动滚，但拖动一切照旧（只降级一个增强）。
2. 卡片在屏幕上的位置 = **拿起时的位置 + 手指位移**：
   `dy = dg.base0 + (clientY - _dgY0) - rects[from].top`，`base0` = 拿起那一刻的
   `rects[from].top`。列表没滚时它正好退化成原来的 `clientY - _dgY0`；滚了以后
   `rects[from].top` 自动抵消滚动量 —— **别把 `clientY` 直接当位移累计**。
   `minDy/maxDy` 只描述「首尾相对被拖卡片」，滚动时同减同增、是常量，不必重算。
3. 滚到顶/底要收手：**`setData({scrollTop})` 之后不能立刻判断生效没有**
   （`bindscroll` 异步回来，`_scrollTop` 还没更新，会把正常滚动误判成到头），
   要放到**下一拍开头**比 `that._scrollTop === dg.asPending`。手指移动 > 4px 就清
   `asDirDone` 与 `asPending` 允许重试（`asPending` 不清会假阳性判定「没动」）。
   定时器用 `setTimeout` 自串（不是 `setInterval`），`endDrag` / `exitSort` / `onRowEnd`
   都要 `stopAutoScroll()`。

拖动中的卡片挂 `.row.liftrow` 抬 z-index。

`swipeKey/swipeX` 与 `dragId/dragY` 是两套独立状态，`render()` 会把两者一起重置。

### 6.0 左滑操作组：只有 2 个动作，且「滑开才渲染」

`<template name="itemRow">` 里的 `.rowacts` 渲染条件是
`wx:if="{{!sortMode && swipeKey===item._id}}"`——**只有这一行正被滑开时才有这一层**。

- **第 5 轮删掉了「置顶 / 置底」**（用户早就要求删，之前一直漏掉）。`moveToEdge()`、
  `.rowacts .top/.bottom`、`.ico-top/.ico-bottom`、`LAYOUT.SWIPE_W_ALL` 全部清除。
  拖动排序已经覆盖这个需求，两套排序入口并存反而让人不知道用哪个。
- **已完成的行也有这两个按钮**（第 6 轮纠正）：未完成 → 完成 / 删除，已完成 → 撤销 / 删除。
  两者共用 `data-act="done"`，撤销就是 `toggleDone` 取反，云函数不必新增 action。
  图标随状态换 `.ico-check` ↔ `.ico-undo`（左向箭头；占位 16+12=28rpx 与 check 的 22+6
  **逐像素相等**，否则按钮里的文字会在状态切换时上下跳一下）。
  编辑抽屉里仍保留「标记为未完成」当第二个入口（`data.sheetDone` + `onSheetUndone()`）。
- **为什么用 `swipeKey` 当渲染闸门**（而不是「未完成才渲染」）：第 6 轮截图显示
  「已完成的行左滑后是个空面板」——上一条把它们整个排除了。
  而「常驻渲染 + 靠 `.row-in` 盖住」在 done 行又必然漏：`.row.done .row-in` 是 `opacity:.5`，
  按钮会直接透过来。**改成按 `swipeKey` 判定，两个问题一起解决**。
- **「收起」必须是真收起**：`onRowEnd` 里位移不到 45% 阈值就把 `swipeKey` 一并清空
  （`open ? id : ''`），`onRowTap` 收起已滑开的行同理。只把 `swipeX` 归零的话，
  按钮还挂在 DOM 里、只是被卡片盖住 —— 又回到「靠遮挡」。
- **`onRowMove` 的节流基准要取这一行自己的位移**：
  `const prev = data.swipeKey===this._drag.id ? data.swipeX : 0`；
  直接拿 `data.swipeX` 比，在另一行正滑开着时基准是错的。
- **排序模式下整组不渲染**。早先 `.rowacts` 是**常驻**的，靠 `.row-in` 的不透明背景盖住；
  一旦拖动排序让卡片 `translateY` 离开原位，底下的按钮组就整块露出来了
  （用户截图：卡片下方浮出一排按钮）。同时给 `.row` 加 `{{sortMode?'sorting':''}}` →
  `.row.sorting{background:transparent}`，否则拖动时还会露出一条 `.row` 自己的浅灰底衬。
  **教训：需要「看不见」时就别渲染，不要靠遮挡——遮挡只在布局静止时成立。**

### 6.1 已完成事项的样式只有两件事

标题 `text-decoration: line-through` + `.row-in` 的 `opacity: 0.5`。
**不要**再动左侧色条（早先有一条 `.row.done .row-in::before{background:var(--ink3)}`，
用户明确要求去掉：「只需要删除线 + 整块变透明，不需要做其他处理」）。

### 7. 云函数 fqTodo 的 action 清单

18 个：`bootstrap` / `sync` / `addItem` / `updateItem` / `removeItem` / `reorder` / `bulk`
（markAllDone·clearDone·clearQuad）/ `clearDone` / `clearAll` / `addCategory` /
`removeCategory` / `renameCategory` /
`genInvite` / `joinFamily` / `leaveFamily` / `renameMember` / `renameFamily` / `grantSub`。

每个 action 的第一步都是 `ensureFamily(OPENID)`，拿到的 `fid` 决定一切读写归属；
入参统一做长度截断与类型收敛；引用 `catId` 时二次校验归属。
返回信封统一 `{ ok, data | msg }`，抛异常也只回传 message。

### 7.0 协议版本握手（FN_VER）— 修「云端是旧包」那类假 bug

**两端各有一份 `FN_VER`，必须始终相等**：`cloudfunctions/fqTodo/index.js` 与
`miniprogram/pages/index/index.js`（当前都是 **5**；v2→v3 引入共享家庭，
v3→v4 分类支持删除与改名，v4→v5 提醒推送 + `grantSub`）。

- `bootstrap` 返回里带 `fnVer` + `actions` 清单；
- 客户端 `load()` 拿到后交给 `checkFnVer(data)`：一致 → 静默；缺 `fnVer`（旧包）
  或不等 → 首屏弹窗「云函数版本过旧」并写明「右键 fqTodo → 上传并部署」；
  模块级 `fnVerWarned` 保证一个会话只弹一次。
- `default` 分支的 msg 也带上云端版本号：
  `'未知 action: X（云端 fqTodo v5，若本端代码更新过请重新上传部署云函数）'`；
  客户端 `callCloud` 见到 `未知 action` 会翻译成「云函数版本过旧（…），请重新上传部署 fqTodo」。

**约定：只要改 action 清单（新增/删除/改签名），两边 `FN_VER` 一起 +1。**
`test-reorder.js` 第 [17] 组会同时读两份源码比对常量，只改一边必红。
**测试里别再写死版本号数字** —— 从源码读（`PAGE_VER`），写死了每次升版本都要来改测试，
而「把断言改绿」永远是最顺手的那一步。

### 7.1 排序语义（改排序前必读）

- **粒度是「象限 × 分类」**：重排只影响当前分类下、同一个象限内的事项。别的分类或象限
  撞 order 值不影响显示，它们从不进同一个列表。
- **落库方式是整段重写成 `0/10/20…`**（`ORDER_STEP = 10`），只把 `order` 或 `quad`
  真正变了的行发给 `reorder`（一次通常 3 条左右）。**不要**改成「相邻取中值」：
  反复拖动会把浮点间距耗光，collapse 后还得重排。
- **筛选下只重排可见项**：`visibleIdx(full)` 把「可见列表下标」映射回「完整列表下标」
  再 splice，隐藏项（筛「待办」时的已完成项）原地不动。**漏了这层映射，一筛一拖就会把
  隐藏项挤走。**（置顶/置底已删除，不再涉及「只排到可见列表首/尾」那条。）
- **跨象限拖只发生在「全部」页**：`flatList()` 把分段展开成扁平数组，`.row` 的测量顺序
  必须与它一一对应（对不上就放弃本次拖动）。跨段不做让位动画（各行高度不一必错位），
  改为整段高亮 + 「松手移到这里」，松手后改 `quad` 并重排源/目标两个象限。
- **换位判定要留容差**：位移被夹在列表首尾内，拖到最上/最下那一档时卡片中心**正好等于**
  首/尾中线，严格大于会永远差一档（「怎么拖都放不到第一位」）。`EPS = 0.5`。
- 新建事项用 `order: Date.now()`（天然最大 → 排到象限末尾），与云函数 `addItem` 一致。

### 7.2 共享家庭（v3）：归属键是 `fid`，不是 `_openid`

**一个家庭 = 一份共享清单。** 每个人首次进入自动拿到一个「我的家庭」，现有待办就在里面；
加入对方的家庭 = **切换当前家庭**，不搬运也不删任何数据，退出即回自己那份。

新增两个集合（**建库时一共要建 5 个** —— 第 18 轮又加了 `fq_subs`）：

- `fq_family { name, ownerOpenid, inviteCode, inviteExpire, rev, createdAt }`
- `fq_members { _openid, fid, role, name, active, joinedAt }`

`fq_items` / `fq_categories` 各加一个 `fid`。**`_openid` 的含义降级成「谁创建的」（审计用），
不再参与任何过滤。** 一个人可属多个家庭，但 `active:true` 的只有一条。

#### ⚠️ 铁律：`fid` 只能由服务端推导

**这是整个项目唯一会出安全事故的地方。** 云函数用管理员权限，**会绕过数据库安全规则**
—— 所以「集合权限设成仅创建者可读写」这道防线对云函数形同虚设，真正的防线全在代码里：

- 每个 action 第一步 `ensureFamily(OPENID)`：查 `fq_members` 拿 `fid`，到不了就 fail closed；
- 所有 where 用 `{ _id: id, fid: ctx.fid }` 双条件，**没有一处从入参取 `fid`**；
- 分权也在服务端：`clearAll` / `genInvite` / `renameFamily` 校验 `fam.ownerOpenid === openid`。
  客户端藏入口只是体验，不是防线。

**谁要是为了「少查一次库」把 `fid` 改成客户端传参，就等于把全部家庭的数据敞开。**
`test-cloudfn` 第 [12] 组专门钉这条（在请求里硬塞别人的 `fid`，断言改删建批全无效）。

#### 邀请码与加入

6 位，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（剔掉 `0/O/1/I/L`），24 小时有效。
两端都做归一化（大写、去空格与连字符）。**码只回给创建者**（`familyInfo` 对非创建者返回空串），
成员拿不到码就转发不出去；家庭上限 20 人。
分享路径 `pages/index/index?code=XXXXXX`，`onLoad` 接住、首屏加载完自动加入。

#### 自动同步：轮询，不用 `watch()`

页面可见时每 8 秒带 `rev` 问一次；rev 一致只回一个数字，不一致才带数据回来
（`SYNC_MS = 8000`，随 `onShow`/`onHide` 起停）。

**为什么不用云数据库 `watch()`**：它要求把集合读权限放开给客户端 = 破掉「云函数是唯一
数据出口」这条底线。为一个几秒的延迟改善换一个可被任意人遍历全库的口子，不划算。
真要上推送，先配自定义安全规则（`get()` 只能按文档 ID 精确取，所以成员记录得用 openid 当
文档 `_id`），再改 `watch`，不要跳步。

**三个必须让路的时机**（少一个就会出「点一下界面闪回去」）：

| 时机 | 后果 |
|---|---|
| `sortMode` | 整张列表在手指底下被换掉 |
| `sheetOpen` | 列表在身后被换掉，保存落到一条已不存在的行上 |
| `pendingWrites > 0` | 服务端快照盖掉未提交的乐观更新，用户看到刚点的那下被弹回去 |

`pendingWrites` 在 `callCloud` 里按 `WRITE_ACTIONS` 名单自增自减，**成功失败都要减**
（只减成功的话，一次网络异常会让同步永远让路 —— 静默停摆，极难查）。
`test-reorder` 第 [19] 组把一次写操作挂起不 resolve 来验这三条。

#### 老数据迁移

v3 之前的文档只有 `_openid`。首次 `bootstrap` 会建家庭 + 把该 openid 名下**所有没有 `fid`
的分类与事项一次性认领**进来，并且**不再播种**（否则老用户会看到自己的数据混进 5 条示例）。
**漏了这步，老用户升级后会看到空列表、以为数据丢了。** 第 [11] 组守着。

### 7.3 分类删除与改名（第 12 轮，已实现）

**背景缺口**：分类原来只能新增，**不能删也不能改名**（与分类相关的 action 只有 `addCategory`）。
三个新增入口（总览页胶囊条 `+` / 我的页「分类」卡片 / 事项抽屉 pills）都只认新增。

**入口约束**：我的页那张卡片「点整行 = 切分类」是高频手势，**不能被删除入口侵占** ——
所以删除走**长按**。小程序规定绑了 `longpress` 且触发后 `tap` 不再触发，两者不打架。
长按没有视觉提示，靠卡片底部常驻的那行「长按任意分类，可重命名或删除」补可发现性。

**交互**：长按 → 底部抽屉（复用 `sheetOpen` 样式）：`catmenu`（重命名 / 删除）；
点删除后，空分类走 `showModal` 一次确认，非空分类切到 `catdel`（选事项新家 / 连同删除）。

**权限按破坏力分两层**（不是一刀切）：

| 分类状态 | 谁能删 |
|---|---|
| 空分类 | 任何家庭成员（对齐 `addCategory` 全员可用） |
| 非空分类 | **仅家庭创建者**（对齐 `clearAll`，底下可能有家人录的条目） |

**四条不能省的约束**：

1. **「非空」必须服务端自己 `count()` 重算**，绝不采信客户端 —— 否则构造一个不带 `moveTo`
   的请求就能绕过确认直接抹掉整个分类。同 §7.2 的 `fid` 铁律：云函数跑管理员权限、
   绕过数据库安全规则，一切判定都要在服务端重来一遍。
2. **先搬事项、后删分类**。反过来中途失败会把事项连同归属一起弄丢；现在最坏是
   「分类还在、事项已搬走」，可恢复。
3. **家里至少留一个分类**（`total <= 1` 直接拒），否则「新建事项」因无分类可选而卡死。
   客户端先拦一道省个来回，服务端同样拦。
4. 删掉的刚好是**当前选中**分类时，`state.catId` 会指向不存在的分类 → 必须回落，
   否则整页空白、看着像「数据全没了」。**复用已有的 `fixCatId()`，别另写一套。**

`renameCategory` 查重要用「查出来再比 `_id`」而不是 `count()`：改成自己原来的名字时
`count` 会命中自己，「点开又原样确定」会被误判成重名。

**客户端字段**：`catMenuId`（**被长按的那一行**，不是 `state.catId` —— 两者经常不同，
拿错就删错行）、`catDelCount`、`catCanDel`、`moveRows`。

**测试**：`test-cloudfn` 第 [17][18] 组（空删 / 转移 / 级联 / 兜底 / 成员权限 / 跨家庭），
`test-reorder` 第 [21] 组（静态契约 + 真跑交互方法）。

选择理由（别推翻）：长按胜过「行内 `···` 按钮」（行宽紧张、会抢点击）与「点行进详情页」
（要新开视图，且推翻既有「点行切分类」的习惯）；总览页胶囊长按被否 —— 会和横滑抢手势。

### 7.4 提醒推送（第 16~18 轮：方案与实现）

**现状**：`remindAt` 只是存字段，全项目零推送能力（云函数 17 个 action 没有一个和通知有关，
`cloudfunctions/` 下没有 `config.json`）。详情页那个「待提醒」只是本地计数。

**平台硬约束（这是整件事的关键，先看这条再谈方案）**：

- **个人主体只能用「一次性订阅」**，长期订阅仅对政务民生 / 医疗 / 交通 / 金融 / 教育等
  特定二级类目开放 —— 后台「长期订阅」那一栏是空的属正常。
- 一次性订阅：**订阅一次 = 只能下发一条**；官方运营专员原话「订阅一次下发一次，
  **订阅次数可以累积**」「**没有时间限制**」（网文里的「7 天过期」不采信，但以实测为准）。
- **每一条额度都必须由用户点一次触发来攒**。官方 Q&A 明确：勾了「总是保持以上选择」
  ≠ 可以随便发，「用户没有再次点击触发订阅的按钮就不会增加订阅次数」。
  但勾选之后**调用不再弹窗、次数照常 +1** → 体感是「点一下保存就静默攒一条」。
- 推论：**「设一次提醒然后长期每月收到」在个人主体下做不到**，别按这个预期设计。

**体验版能不能推：能。** 订阅消息是服务端按 AppID + openid 下发到用户微信的「服务通知」，
与小程序跑的是哪个版本无关（官方社区有「同一用户同时收到正式版与体验版两条订阅」的实例）。
唯一要处理的是下发接口的 `miniprogramState`（云调用字段）—— 它决定**点击通知后跳哪个版本**，
默认 `formal`。没发正式版就必须显式设 `'trial'`，否则跳「该小程序未发布」。
（网上有「体验版不支持订阅消息」的说法，判定不可信：它称「体验版 appid 与正式版不同」，
而开发/体验/正式本就是同一 AppID；它混淆的是**旧版模板消息的 formId 限制**。）

**第 16 轮已三选确认**：

1. 额度来源 = **保存带提醒的事项时顺带请求一次授权**（1 条额度换 1 次提醒，心智最顺）。
2. 收件人 = **只发给「设置这条提醒的人」**（不全家广播 —— 一条提醒发两人要烧两份额度）。
3. 兜底 = **额度不够时在小程序内显示「N 条提醒未送达」**，引导补授权；不静默吞掉。

**架构：新建独立云函数 `fqRemind`，绝不塞进 `fqTodo`。** 三个理由：

- `fqTodo` 的铁律是「每个 action 第一步 `ensureFamily(OPENID)`」，而**定时触发器里
  `getWXContext()` 没有任何用户上下文** —— 混进去就是给这条铁律开一个例外。
- 官方文档：**一个云函数下只支持一个定时触发器**；且 `config.json` 要**单独
  「上传触发器」**才生效（只「上传并部署」不带触发器 —— 高频坑）。
- `fqRemind` 只读事项 + 只发消息，权限面最小。

**四条官方事实（改这块前照抄，别凭记忆）**：

| 事实 | 出处 |
|---|---|
| 触发器**时区固定 UTC+8**，cron 直接按北京时间写 | 云开发定时触发器文档原文 |
| **会重复触发，必须去重** ——「网络环境不稳定，微信可能会多次推送同一条消息」 | 同文档；做法：`where({_id, pushed:false}).update({pushed:true})`，只有 `stats.updated===1` 那次才真发 |
| cron **七段式**：秒 分 时 日 月 星期 年；`0 * * * * * *` = 每分钟第 0 秒 | 同文档；最小粒度分钟 |
| 触发器来源可用 `getWXContext().SOURCE === 'wx_trigger'` 判断 | 同文档 |

**数据模型**：新增 `fq_subs { _openid, quota, updatedAt }`；`fq_items` 加 `pushed` 布尔。
额度扣减也要原子：`where({_openid, quota: gt(0)}).update({quota: inc(-1)})` —— 扣到了才发，
不要发出去被微信拒。`grantSub` 是新 action，要防同一用户短时间连点刷额度。

**`pushed` 字段的安全性不用额外操心**：`updateItem` 是白名单写法（只认
title/note/quad/priority/remindAt/catId/done），客户端天然改不了它。

**`FN_VER` 4 → 5**（加了 `grantSub`，action 清单变了，两端一起改）。

**硬前置**：代码里要填 `templateId`，且模板字段标识（`thing1` / `time2` 这类）在代码里
必须**逐字对应**，填错消息直接发不出去 → **必须先申请模板再写代码**。

> **已拿到（第 17 轮，字段 key 已齐）**：模板「待办事项提醒」，
> 场景说明「新四象限事项待办消息模板」（正好对口本项目）。
> `templateId = 1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM`
>
> | 槽位（中文名） | **key** |
> |---|---|
> | 事项名称 | `thing26` |
> | 事项类型 | `thing15` |
> | 备注消息 | `thing12` |
> | 事项主题 | `thing1` |
> | 提醒时间 | `time23` |
>
> ⚠️ **编号毫无规律**（26 / 15 / 12 / 1 / 23）—— 正好印证「必须逐字从详情页抄」。
> 若照「thing1~thing5」这类常规推测去写，**5 个字段会全部对不上**，每条消息都 47003。

**🚨 两个易混淆点（用户第 17 轮连卡两次的地方）**：

1. 「公共模板库」**列表页那一列「关键词」是模板的搜索标签，不是 key**。真正的字段标识
   只在**「我的模板」→ 点开详情 → 「详细内容」**里以 `{{thing26.DATA}}` 出现；
   **key = 花括号里去掉 `.DATA` 的那段**。拿中文名当 key 赋值 → 消息发不出去。
2. **模板与小程序之间不存在任何「绑定」。** 模板只是一组带编号的**空槽位**，
   每个槽灌什么完全由**发消息的代码**决定 —— 微信那边不知道你的数据模型长什么样。
   所以「事项类型」这个槽放象限名还是放别的，是**我们说了算**，不是绑定出来的。

**槽位映射（第 17 轮定稿，用户选「语义对号入座」）**：

| 槽位 | key | 灌什么 | 要点 |
|---|---|---|---|
| 事项名称 | `thing26` | `item.title` | 截断 20 字 |
| 事项类型 | `thing15` | `QUAD_MAP[item.quad].name` | 重要且紧急 / 不重要但紧急 / 重要不紧急 / 不重要也不紧急 |
| 备注消息 | `thing12` | `item.note` | 空则填 `-` |
| 事项主题 | `thing1` | 分类名 | `fqRemind` 需按 `catId` 查 `fq_categories` 建 id→name 映射 |
| 提醒时间 | `time23` | `item.remindAt` 格式化为 `YYYY-MM-DD HH:MM` | `time` 类型的格式是写死的 |

⚠️ **勾了几个槽就得赋几个非空值** —— 少一个整条消息 47003。这 5 个槽一个都不能漏。

**申请路径**（第 16 轮核实）：mp.weixin.qq.com → 左侧「功能」→「订阅消息」（首次要「开通」）
→ 「公共模板库」搜索或按分类筛选 → 点「选用」→ **勾选需要的关键词** → 提交
→ 去「我的模板」点详情 → 复制 **模板ID + 每个字段的 key**。

**字段类型与长度上限**（超限或格式错都会报 47003）：

| 前缀 | 限制 | 本项目用途 |
|---|---|---|
| `thing` | ≤ 20 字符 | 事项名称（**超 20 字必须截断**） |
| `time` | `YYYY-MM-DD HH:MM` | 提醒时间 |
| `name` | ≤ 10 字符 | 用不上 |
| `character_string` | ≤ 32 字符 | 用不上 |
| `phrase` | ≤ 5 字符 | 用不上 |

⚠️ **勾了几个字段，代码里就得赋几个非空值** —— 少一个整条消息 47003 发不出去。
所以「事项类型 / 事项主题」这类用不上的字段若被勾了，也得填默认值（如 `-`）。

- ⚠️ **能看到的模板受小程序「服务类目」限制**（设置 → 基本设置 → 服务类目，最多 5 个）。
  搜不到合适的模板时，先怀疑是类目没配，而不是模板不存在。
- 公共模板库搜不到 → 搜索后**翻到最后一页**，有「帮助我们完善模板库」入口可申请自定义模板
  （要填类目/标题/关键词/参数/示例，审核比选用公共模板久）。
- 勾字段**只勾必需的**：每个勾选的字段在代码里都必须赋非空值，多勾纯增工作量。
- 不同小程序选用**同一个**模板，生成的模板ID**不一样** —— 所以必须由他给我，不能抄别人的。

**模板字段类型（决定会不会发失败，写映射代码前必看）**：

| 类型 | 限制 / 格式 | 本项目用途 |
|---|---|---|
| `thing` | **最多 20 个字符** | 事项名称（超长必须截断，否则 47003） |
| `time` | `YYYY-MM-DD HH:MM` | 提醒时间 |
| `name` | 最多 10 字符，仅中英文 | 未用 |
| `number` | 数字 | 未用 |
| `character_string` | 编号 / 单号 | 未用 |

**下发常见错误码**：`43101` 用户未授权（额度用光会撞这个）；`47003` 参数格式非法
（空值 / 超长 / 时间格式不对）；`40037` 模板ID不正确；`43100` 需在真机体验订阅。

#### 实现（第 18 轮，已完成）

**`cloudfunctions/fqRemind/`**（新云函数，3 个文件）：

| 文件 | 内容 |
|---|---|
| `index.js` | 每分钟扫一次：抢锁 → 扣额度 → 下发 → 记结果；末尾按 `fid` 去重推 `rev` |
| `config.json` | `permissions.openapi: ['subscribeMessage.send']` + `triggers: [{type:'timer', config:'0 * * * * * *'}]` |
| `package.json` | `wx-server-sdk`（与 `fqTodo` 同版本） |

**四条硬约束（照官方文档写的，别凭记忆改）**：

- 触发器时区固定 UTC+8，cron 是七段式（秒 分 时 日 月 星期 年），最小粒度就是分钟。
- **会重复触发** → 抢锁：`where({_id, done: _.neq(true), pushed: _.neq(true)}).update({pushed:true})`，
  只有 `stats.updated === 1` 的那一次才真发。这是去重的全部实现，不需要额外的锁表。
- 扫描条件必须是 `remindAt: _.and(_.gt(0), _.lte(t))`，**不能只写 `_.lte`** —— `remindAt` 为
  `null` 的文档在 `$lte` 下也会被捞出来（null 在类型序里排在数字之前），白占分页窗口。
- `pushed` 的排除必须写 **`_.neq(true)` 而不是等值 `false`** —— 升级上来的老文档压根没有这个
  字段，等值条件挑不到它们，那批提醒会**永远发不出去、而且一点报错都没有**
  （`test-remind` 第 [4] 组专门钉这条）。

**时间格式化写死 +8 偏移再取 `getUTC*`**，不信任容器时区。`test-remind` 第 [8] 组拿 ICU
时区库算出的结果做对照，并反向断言它不是 UTC 裸值 —— 同一套算法自证没有意义。

**⚠️ 微信侧没有「额度查询」这个东西，`quota` 是自己记的账。**
用户端「服务通知」只能看到收到的消息，看不到还剩几次；开发者端也没有查询接口，
云调用 `subscribeMessage.send` 也不回剩余次数 —— 所以「还剩几条」只能自己维护
（这就是 `fq_subs.quota` 存在的唯一理由）。两处查看入口：小程序「我的」页「提醒」卡片
（`subQuota`），以及云开发控制台 → 数据库 → `fq_subs`。
推论：`quota` 是**保守估计**，不等于微信真实余额 —— 用户在别处对同一模板授权、或下发被
微信拒（43101）时仍扣了额度，这两处都会让它与真实值差一两条。别拿它当权威值做校验。

**自己加的三个设计（官方没要求，但缺了会难受）**：

| 设计 | 为什么 |
|---|---|
| 迟到 5 分钟以内补发，超过就记 `expired` | 容器冷启动 / 触发器漏跑都会造成过点。补发一条几小时前的提醒只会让人困惑；但也不能静默丢弃 —— 记成「未送达」让用户看得见 |
| 扣不到额度时**仍然标记 `pushed`** | 否则每分钟重试到天荒地老。代价是补了额度也不补发（那条提醒的时间已经过去了） |
| 结果按 `fid` 去重后 `bumpRev` | 「未送达」计数变了，我的页那行字要跟着刷 |

**`MINI_STATE = 'trial'`**：体验期必须这么设，否则用户点通知跳「该小程序未发布」。
**正式发布后要改成 `'formal'`**（`test-remind` 第 [12] 组会断言它当前是 `trial`）。

**假 SDK 抽成了 `.workbuddy/tools/fake-cloud.js`**：`test-cloudfn` 与 `test-remind` 共用一份，
因为两边用的是同一套集合与查询语义。`test-cloudfn.js` 里那块内联假库已改成
`FC.loadFunction()` 薄适配（必须在 require 云函数**之前** install）。关键点：

- `reset()` 会把 5 个集合都建出来（否则「reset 完直接 push 夹具」会撞 undefined）；
- `command` 支持 `inc / gt / gte / lt / lte / neq / in / and / or`；
- **`_.neq(x)` 对「字段不存在」命中，等值 `false` 不命中** —— 这个差别正是本项目
  「老数据也要被定时任务捞到」的关键，假库必须如实还原；
- `openapi.subscribeMessage.send` 记录每次入参，可用 `queue` / `fallback` 预置失败；
- ⚠️ `openapi.calls` 在 `reset()` 里是**整个换掉数组**，测试里要现读 `FC.openapi.calls`，
  别缓存一份（缓存的话后面所有用例都会看到空数组）。

**变异验证**（一次性跑过，脚本已删）：把抢锁、额度检查、窗口条件、时区换算、`trial` 标记、
槽位赋值等 **10 处关键判断逐个改坏**，确认 `test-remind` **每一处都能变红**。
以后加新的判断，按同样思路自查一遍 —— 一份永远绿的测试和没有测试是一样的。

**部署（第 18 轮起共两个云函数）**：`fqRemind` 除了「上传并部署」还要**单独点一次
「上传触发器」** —— 只上传并部署不带 `config.json` 里的定时触发器，表现为
「提醒永远不发、而且一点报错都没有」。`fqTodo` 也要重新部署（`FN_VER` 4→5）。

### 8. 首屏种子数据

`bootstrap` 发现**当前家庭**分类数为 0 时写入「工作 / 生活」+ 5 条示例事项（含一条「明天 09:00」提醒）。
分类 id 由数据库生成，种子事项挂在「工作」下，并且都带上 `fid`。
（老用户走「认领」分支，不走播种 —— 见 §7.2。）

## 布局铁律（十轮 UI bug 换来的，改样式前必读）

十二条都是「就差几像素 / 整块没画出来」的坑，大部分有截图像素测量的实证
（下面的编号有两处历史重复：讲图标 class 重名那条也编了 8，讲统计块居中的是第 11 条）：

1. **底部块靠 flex，禁止 JS 算高度。** `.screen{display:flex;flex-direction:column}`
   + `.scroller{flex:1;min-height:0}`，tabbar / 底栏天然贴底。曾经用 `scrollerH`
   内联给 `scroll-view`，Android 的 `screenHeight` 含虚拟导航条 → 算偏把 Tab 顶出屏幕。

2. **安全区不能和固定 `height` 撞在同一元素上。** 全局 border-box 会把
   `padding-bottom: env(safe-area-inset-bottom)` 从 `height` 里**抠掉**：`.tabbar` 原来的
   `height:120rpx` 在 iPhone 上 88px 被抠掉约 44px，内容区只剩 44px，而图标盒 40rpx +
   间距 8rpx + 文字 20rpx 要 50px+ → 图标顶出上边框，那条 `border-top` 看起来像把工具栏
   拦腰切开（实测图标顶 y=1107 < 边框 y=1111）。
   **现方案：高度写在 `.tb`（120rpx），安全区加在 `.tabbar` 上、位于 120rpx 之外。**
   同理：`.bottombar` / `.sheet-foot` 没有固定高度，安全区直接加 padding 是安全的。

3. **要「严格等分 / 尺寸恒定」就必须清掉 `min-width:auto`。**
   四象限矩阵原用 `grid-template-columns:1fr 1fr`，而 `1fr` = `minmax(auto,1fr)`，
   其 `auto` 下限取内容的 min-content；`.gi .tx` 是 `white-space:nowrap`，长标题把那一列
   顶宽 → 实测左列 215px / 右列 275px，还整体溢出 0.5px。
   **现方案：`.grid{display:flex;flex-wrap:wrap;justify-content:space-between}`，
   `.q{flex:0 0 calc(50% - 7rpx);min-width:0;height:476rpx;margin-bottom:14rpx}`，
   第二行加 `.nb` 去底边距**（`.q.nb` 由 `buildGrid()` 的 `nb` 字段给出）。
   `flex:0 0` = 不放大不收缩；`min-width:0` 是等分成不成立的开关。

4. **自绘图标改尺寸必须连 `flex-basis` 一起改。** `.ico-plus` 基类有 `flex:0 0 28rpx`，
   而 `.big` 只覆盖 `width/height` → 这个 flex item 的**宽**仍是 28rpx、高却是 44rpx，
   伪元素 `left:20rpx` 按 44rpx 的盒子定位 → 竖杠掉到横杠右端，加号成了「†」
   （实测偏心 6px）。**现方案：`.big/.sm` 都显式写 `flex:0 0 <同尺寸>`，
   且伪元素改用 `calc(50% - 2rpx)` 百分比居中，不再写死 rpx。**

5. **要让 flex 里的某个子项自己横向滚动，必须给它 `min-width:0`。**
   分类栏原是「一个 `scroll-view` 装所有胶囊，末尾再放新增按钮」，分类一多新增按钮就被
   一起滚出屏幕，再也点不到。**现结构：`.catsrow`（flex）→ 左 `.cats{flex:1 1 auto;
   min-width:0}` 自己 `scroll-x`，右 `.cats-add{flex:0 0 auto;width:60rpx}` 钉死。**
   不清掉默认的 `min-width:auto`，左半边会被内容顶宽，滚都滚不起来。

6. **flex 容器不能放在 `scroll-view` 自己身上（`enable-flex` 靠不住）。**
   在 `.cats`（scroll-view）上写 `display:flex;align-items:center` + 属性 `enable-flex`，
   胶囊仍按**行内盒排在文字基线上**：真实位置比内容框高约 13px（26rpx），
   顶部被 scroll-view 的 `overflow:hidden` 削平。实测（截图 531×73）深色选中胶囊
   x15..105 / y12..41 —— 顶边是平的、底边是圆的，正是「下半截露出来」的样子；
   同一行里 scroll-view 外面的 `+` 按钮 y12..55（完整 60rpx）不受影响，
   这条对比就是根因的铁证。
   **现结构：scroll-view 内再套一层 `.cats-inner{display:flex;align-items:center;
   height:60rpx;width:max-content}`**——块级 flex 容器没有基线对齐问题。
   凡是要在 `scroll-view` 里做 flex 布局，一律照此办理。

7. **纵向 flex 容器不要用 `max-height` 当高度。**
   抽屉原来是 `.sheet{max-height:88vh;display:flex;flex-direction:column}` +
   `.sheet-body{flex:1 1 auto;min-height:0}`，实测主体**完全没有收缩**：
   容器主轴尺寸不确定时 flex 不分配空间，主体连同内容溢出了容器盒，而容器没有
   `overflow:hidden`、底部按钮区没有背景 → 内容从按钮底下透出来
   （实测截图 546×1077：蓝色按钮 y934..996 与「提醒时间」行叠在一起，
   该行的下半截还画在按钮下面 y1002..1064）。
   **现方案：主体自己封顶**——`.sheet-body{max-height:78vh;max-height:calc(88vh - 330rpx -
   env(safe-area-inset-bottom))}`，容器高度 = 头部 + 主体 + 底部按钮三段之和，
   头部和按钮天然固定；`.sheet` 只留 `overflow:hidden` 兜底、`.sheet-foot` 加白底。
   330rpx = 头部（把手 48 + 标题 45 + 副标题 64 + 内边距 16 ≈ 173）+ 底部（20+88+28 = 136）+ 余量。

8. **该固定的头部不能写在滚动区里，且固定子项必须 `flex: 0 0 auto`。**
   详情页原来是「一个 `.scroller` 装下头部 + 列表」，事项一多，返回键、象限名、
   筛选胶囊、「调整顺序」全被滚走 —— 想调顺序得先滑回顶部。
   **现结构：`dhead` / `filters` / `sortrow` / `.swipecue` 全部搬到 `.scroller` 之外**，
   作为 `.screen` 的固定子项；滚动区里只剩 `.rows-wrap`（detail）与 `.sec`（all）。
   两条配套写法：① 固定块写 `flex:0 0 auto`（默认的 `0 1 auto` 会被 `flex:1` 的
   `.scroller` 挤扁）；② 想加新的固定块，插在 `<scroll-view class="scroller">` 之前。
   `mp-check.js` 第 4 条会拦「头部又被写回滚动区」。

9. **一行文字要垂直居中，用 `height` + 等值 `line-height`，不要用上下不对称的 padding。**
   `.swipecue` 原来是 `padding:4rpx 0 12rpx`（上 4 下 12），文字在那一行里明显偏上。
   现在是 `height:46rpx;line-height:46rpx`，总高不变但严格居中。
   另一条同源的：详情态整屏吃象限色，`.--ink3` 的灰字在上面几乎看不清
   （`.swipecue` 与 `.sortrow .shint`）→ `.screen.detail-mode` 下换成
   `rgba(255,255,255,0.72)`。

11. **flex item 被 stretch 拉高后，内容默认贴顶 —— 要居中就得显式居中。**
   `.stat` 是 `.stats`（`display:flex`，默认 `align-items:stretch`）的子项，会被拉到
   整个 112rpx 高；而「数字 36rpx + 标题 26rpx」只有 62rpx。总览页 `.stats` 有
   `padding-top:24rpx`，垫得刚刚好、看不出问题；「我的」页 `.stats.flat` 把内边距清零，
   多出来的 26rpx 全落在下面 → 用户报「上面四个块的标题、文案没有上下居中」。
   **修法：`.stat` 加 `display:flex;flex-direction:column;align-items:center;
   justify-content:center`**，不再依赖外层内边距刚好凑够高度。
   **`text-align:center` 只管左右，管不了上下。**（第 10 轮）

8. **图标内部子元素的 class 名不能和页面级 class 重名 —— 这是「删除图标不居中」的真凶。**
   `.ico-trash` 原来是 `<view class="ico ico-trash"><view class="lid"></view>
   <view class="body"></view></view>`。那个 `class="body"` 同时命中了页面级的
   `.body{padding:24rpx 32rpx 0}`（滚动内容的内边距容器），而全局是
   `box-sizing:border-box`。绝对定位的桶身原定 `left:5rpx;right:5rpx` → 宽 22rpx，
   但左右 padding 相加 64rpx 远大于它，盒子被撑到约 70rpx 并向右溢出。
   **实测证据（截图 525×160，1rpx ≈ 0.725px）**：桶盖 x464..486（宽 23px = 32rpx，
   中心 475 = 按钮中心 475.5 ✓ 正）；桶身 x468..517（宽 50px ≈ 69rpx，中心 492.5，
   比按钮中心**偏右约 17px ≈ 21rpx** ✗）。同一张图里 `.lid` 没有同名冲突、渲染完全正确
   —— 这就是一组天然对照，直接锁定「class 重名」而不是「定位写法」。
   **现方案：图标内部不用会和页面 class 重名的名字；`.ico-trash` 改成
   一个元素 + `::before`/`::after`，定位用「显式 `width` + `left:calc(50% - w/2)`」，
   不写 `left`/`right` 对。**
   → 推论：任何「绝对定位 + left/right 对」的元素，只要被别的规则塞进了 padding 或
   width，就会静默跑偏。图标这类小元素一律走 `显式 width + calc 居中`。

## 诊断手法：UI 像素级 bug 先量截图，别猜

用户报「不等分 / 没对齐 / 被线贯穿 / 被遮挡」时，用 Pillow 量截图像素，再裁切放大肉眼看。
本机可用的运行时里 **numpy 没装**（`C:\Users\rmx\.workbuddy\binaries\python\versions\3.13.12`
只有 PIL），所以脚本用**纯 PIL** 写，别 import numpy。

两个最有效的输出（`.workbuddy/tmp/ui-probe.py` 那套，用完即删）：

1. **字符画**：按固定步长把图降采样成 `K/W/g/R/B/.`（深色/近白/浅灰/红/蓝/其他），
   一眼就能看出「哪一行的边界是平的、哪一条被切掉了」——胶囊被裁就是靠它发现的：
   顶边平、底边圆 = 只有下半截露出来。
2. **包围盒 + 逐行/逐列像素计数**：目标色（深色块、蓝色按钮、灰色边线）的 bbox，
   以及「横向长线」检测（找删除线、输入框边框）。按钮压住内容是靠「蓝色满宽行 y934..996」
   与「行 line 边框 y1002..1064」这两组数字对出来的。

**量图标偏心用「逐列主色 + ROI 字符画」两步**（第 5 轮找删除图标偏心就是这么干的）：

- 先逐列取中间 40% 行的主色 → 得到按钮的精确分界（`x0..x1 -> G` 表示灰色按钮区）
  → 1rpx = 按钮宽 ÷ 120rpx 反推比例尺，再去拿按钮中心当基准；
- 再对图标所在的小矩形（如 `x 440..522, y 30..130`）打**逐行字符画**，
  每行给出白色像素的 `x 起点..终点 n=`，笔画位置一目了然：
  桶盖那行 `y=57 x 464..486`、桶身左竖 `x468`、右竖 `x517` —— 两个中心一比就锁定了偏心量。

**关键动作：一定要和「没有污染的同族元素」对照。** 同一个图标里 `.lid`（无同名 class）
渲染正确、`.body`（撞名）跑偏，这一组对照直接把嫌疑从「定位写法」转到「class 重名」，
省掉大量试错。同理，同页面的 `+` 按钮完整、scroll-view 里的胶囊被裁，也是靠对照定的性。

先算出 **1rpx = 截图宽 ÷ 750**（实测那张 546px 宽的截图即 0.728px/rpx），
测量值就能换算回 rpx 与 WXSS 对齐；再拿屏高反推 `vh`，能验证 `max-height` 到底生效没有
（88vh 应 = 1040px，当时实测抽屉高度 1049px 说明 max-height 生效了，问题在别处）。

## 部署：云函数不会跟着「编译」上传

点「编译」只编译小程序端。云函数必须**手动右键 → 上传并部署：云端安装依赖**。
两个都要部署：`fqTodo`（数据出口）与 `fqRemind`（提醒推送）；
**`fqRemind` 还要额外右键点一次「上传触发器」** —— 只「上传并部署」不会带上
`config.json` 里的定时触发器，表现为「提醒永远不发、而且一点报错都没有」。

新环境还要先建 5 个集合：`fq_family` / `fq_members` / `fq_categories` / `fq_items` / `fq_subs`，
权限都设「仅创建者可读写」（注意这条对云函数无效，真正的防线是 §7.2 的 `fid` 铁律）。
右键看不到部署菜单 = 开发者工具还没关联云环境。完整排错表见 README 第一节。

**同一个坑有两种长相，别搞混：**

| 现象 | 含义 |
|---|---|
| 报「云函数 fqTodo 尚未部署」 | 云端**根本没有**这个函数 |
| 报「未知 action: reorder」（或别的已实现的 action） | 云端有函数，但是**旧包**：本地加了 action 没重新部署 |
| 首屏弹窗「云函数版本过旧」 | 云端没上报 `fnVer` 或版本不等 → 同上，属主动预警 |

**判断是「旧包」还是「代码写了 bug」的方法**：跑 `.workbuddy/tools/test-cloudfn.js`。
它拦 `require('wx-server-sdk')` 换成内存假库、真跑 `fqTodo/index.js`（214 条断言）。
**它绿 → 代码是对的，问题只在部署；它红 → 才是代码要改。**
第 6 轮就是靠这个把「拖动落库报未知 action」定性成纯部署问题。

## 发布（上线）— 第 13 轮梳理的结论

**两条路，先走体验版就够「俩人先试试」：**

| 路径 | 要不要备案 | 谁能用 | 快慢 |
|---|---|---|---|
| **体验版** | **不用**（备案卡的是「上架/发布」，不是上传与体验版） | 后台加的**体验成员**（个人主体上限 15 名） | 上传即得，当天可用 |
| **正式版** | **必须先备案**（2023-09 起：微信初审 1~2 工作日 → 工信部短信核验 24h 内 → 管局 1~20 工作日） | 任何人 | 最快一两周 |

- **云开发免掉了域名那一整套**（不用买域名、不用域名备案、不用配 HTTPS 白名单），
  但**小程序本身的 ICP 备案照样要办** —— 两件事别混。
- 代码侧发布前的动作：**5 个集合建好 + 两个云函数都重新部署**（`FN_VER` 当前 5，
  老包会在首屏弹「版本过旧」），`fqRemind` 还要**单独点「上传触发器」**。
  **没有**定位/相册/手机号/用户信息等隐私接口，所以不需要 `requiredPrivateInfos`，
  隐私指引可如实勾「不收集」。
- ⚠️ **正式发布后记得把 `fqRemind` 的 `MINI_STATE` 从 `'trial'` 改成 `'formal'`** ——
  否则用户点提醒通知会跳到「该小程序未发布」。
- 包体积 **143 KB**（8 个文件、零图片），离 2 MB 主包上限很远，**不用分包**。
- ⚠️ **最大的审核风险是 UGC**：家庭共享意味着一个人写的事项另一个人能看到，
  严格属于「用户发布信息可被他人查看」。被拒的对策是给 `addItem` / `updateItem`
  接 `security.msgSecCheck` 云调用（家庭内私密共享可在审核备注里说明）。
- 待确认项（我没法从代码侧验证）：体验版有效期、后台《用户隐私保护指引》是否强制、
  个人主体可选服务类目清单 —— **以 mp.weixin.qq.com 后台实际提示与官方文档为准**。

### 体验版迭代（发布后怎么继续改）

**无次数限制、不需审核**（审核只对正式版）。改动类型决定要跑哪条管道：

| 改了什么 | 重新上传小程序 | 重新部署云函数 | 其他 |
|---|---|---|---|
| 界面 / 样式 / 页面逻辑 | ✅ | ❌ | — |
| `fqTodo/index.js`（不改 action 清单） | ❌ | ✅ | — |
| 增删 / 改了 action 清单 | ✅ | ✅ | **两端 `FN_VER` 一起 +1** |
| 新增数据库集合 | ❌ | ✅ | 还要去云开发控制台手工建集合 |
| `fqRemind/config.json`（触发器 / 云调用权限） | ❌ | ✅ | 部署后**还要单独点「上传触发器」** |

**云函数单独部署** —— 点「编译」和「上传」都不会带上 `cloudfunctions/`，必须
右键 `fqTodo` → 上传并部署：云端安装依赖。这是本项目第 1 号坑（见上文部署一节）。

**体验版为什么「传了却没更新」：** 后端一般会自动把最新开发版本作为体验版
（同一开发者上传时），但**手机端有代码缓存**，体验成员必须
**把小程序从列表里下拉删除 → 重新扫体验版二维码**（或彻底杀进程重进）。
官方社区里这类抱怨十有八九是缓存，不是上传失败。

**迭代完不用管这些**：体验成员关系持久、不用重新加；正式版与体验版并行互不影响；
云数据库里的真实数据不会被代码覆盖。

## 无 IDE 自检

**一条命令跑完全部**（改完页面或云函数先跑它，再开开发者工具）：

```bash
node .workbuddy/tools/check-all.js
```

它串起 5 个工具 + JSON 校验，末尾汇总「全部通过 / 有 N 项未通过」：

| 工具 | 断言规模 | 覆盖 |
|---|---|---|
| `mp-check.js` | class 158 / WXSS 162、data 68 键 | class 契约、data 契约、结构配对、**固定头部契约** |
| `class-collision.js` | 页面级选择器 87 个 | 图标内部 class 与页面级 class 重名 |
| `test-reorder.js` | **23 组 / 273 条** | 页面逻辑：拖动 / 左滑 / 排序模式 / 拖动竞态 / **拖动上手体验（启动闸 + 位移量化）** / 视图层静态约定 / 自动滚 / 版本握手 / 自动同步避让 / 家庭视图约定 / 分类管理交互 / **提醒推送契约** |
| `test-cloudfn.js` | **20 组 / 214 条** | 云函数：reorder / 越权隔离 / **家庭与邀请码 / 老数据认领 / rev 同步 / 分类删除与分权 / 订阅额度记账 / 推送状态生命周期** / 种子 / 握手字段 |
| `test-remind.js` | **12 组 / 107 条** | 云函数 fqRemind：**去重（含并发）/ 额度不足 / 窗口与迟到边界 / 五个槽位 / 北京时间 / 跨用户跨家庭 / 触发器配置契约** |
| `fake-cloud.js` | — | 上面两份云函数测试**共用**的假 wx-server-sdk（内存库 + `db.command` 比较命令 + 云调用记录） |

`mp-check.js` 第 4 条「固定头部契约」是第 7 轮加的：断言 `dhead` / `filters` / `sortrow`
**不在** `<scroll-view class="scroller">` 区间内。这类回归语法上完全合法，只能靠这条契约拦。
反向用例验过（把 `sortrow` 塞回滚动区 → 报出 + 退出码 1）。

两份仿真测试都是**加载真实源码 + 假环境**跑真实方法，不复制逻辑 ——
改了实现没改测试就会红。

- `test-reorder.js`：假的 `Page`/`wx`，`setTimeout` 桩成可手动 flush（用来把
  「点调整顺序 → 抖动标记置真 → 380ms 后摘掉」以及自动滚的每一拍走完）；
  `wx.createSelectorQuery` 按当前 `flatList()` 造行位置。
  **单点查询（`select`）和批量查询（`selectAll`）返回结构不同**：单点的 `res[0]`
  就是那个节点的 rect，批量的 `res[0]` 是 rect 数组。桩这里写错，页面会一直走
  「量不到滚动区」的降级分支，而测试以为量到了（第 10 轮就这么踩了一脚）。
  第 [16] 组用一个**会夹取 `scrollTop`、`bindscroll` 异步回来**的假滚动区
  （`SC` + `flushScroll()`）：夹取才能体现「滚到底」，异步才能测出
  「setData 之后立刻判断生效没有」是错的。`SC_MEASURABLE` 默认 false，
  其余各组因此不自动滚，顺带把降级路径覆盖了。
  第 [17][18] 组是第 6 轮加的版本握手（读两份源码比对 `FN_VER` + 走真实 promise 链
  验证 `load()` 把 bootstrap 返回体交给 `checkFnVer`）。
  第 [19] 组是第 11 轮加的自动同步避让：`setInterval` 也桩成可手动 flush
  （不然测试跑完挂着一个 live interval），并把一次写操作**挂起不 resolve**，
  制造真实的「在路上」状态。
  **两个踩过的坑**：① 这一组不能同步跑 —— 前面各组发出的写操作还挂在微任务队列里，
  `pendingWrites` 不为 0，直接跑测到的是上一组的余温。排空要用
  `new Promise(r => setImmediate(r))`，**别连写几个 `Promise.resolve().then`**：
  后者只固定走几步，链路一长就不够。② 文件是 CommonJS，**模块顶层不能出现 `await`**，
  Node 会直接拒绝加载（`ERR_AMBIGUOUS_MODULE_SYNTAX`：同时看到 `require()` 和顶层 await）。
  所以那一组的收尾用 Promise 链，`finish()` 只挂在链尾，并给 `finish` 加了一次性闸门。
  第 [21] 组（第 12 轮加）验分类管理：前半是静态契约（长按绑定、`catCanDel` 闸门、
  无 `fid` 传参、两端动作清单），后半**真调页面方法**（`onLongPressCat` / `onCatDeleteAsk` /
  `onPickMoveTo` / `onCatDeleteCascade` / `doCatDelete` / `onRenameCategory`）。
  **踩到的坑**：`wx.showModal({editable:true})` 那条改名路径（`prompt()`）返回的是 **promise**，
  手工调 `success()` 只是 resolve，`.then` 回调要等下一拍才跑 —— 同步断言会假绿。
  正解是 `modalCalls[0].success(...)` 之后接一个 `Promise.resolve().then(断言)`：
  **只等一个微任务就够**（`.then` 排在 resolve 之后），而且微任务一定排在
  `setImmediate` 之前，不会被 [19] 链尾的 `process.exit()` 截掉。
  另外桩 `wx` 上必须补 `canIUse`（`prompt()` 会用它做版本检查，缺了会走「客户端版本过低」分支）。
- `test-cloudfn.js`：拦 `require('wx-server-sdk')` 换成内存假数据库，
  直接 `fn.main({action})`。**它绿了 = 云函数代码是对的，报错就是没部署。**

## 改码纪律（踩过的坑）

**同一条消息里不要对同一个文件发两个编辑。** 两次「读—改—写」会并发，后写的把先写的
覆盖掉，而且工具**两次都返回成功**。第 6 轮就这样丢了 4 处改动（`.ico-undo` 整段样式、
`data.sortPulse` 声明、`onRowEnd` 的收起逻辑、测试里的 `vibrateCalls` 声明），
第一次跑校验才发现。改同一个文件必须一次一处、逐个确认；改完用「标记字符串扫描」
复核是否真的落盘，别只信编辑工具的返回值。

```bash
# 落盘复核：把本轮所有改动各挑一个特征字符串，逐条 includes 检查
node -e "…marks 表…"     # 见第 6 轮日志里的写法
```

「标记字符串」要挑**唯一**的片段。第 6 轮用 `sortPulse: false` 当标记就假阳性了——
它同时匹配到 `that.setData({ sortPulse: false })` 那一行，差点漏掉 data 里没声明。

## 有意偏离设计稿的地方

见 README「六、与设计稿的差异」。改动前先看那张表，别把有意为之的偏离当 bug 改回去。
