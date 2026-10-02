# 项目长期记忆 · 4todolist（四象限事项待办中心）

> **这是精炼索引**：只放「改代码前必须知道的不变量」。每条都尽量短。
> - 完整推导 / 像素实测证据 / 18 轮的踩坑过程 →
>   `.workbuddy/memory/MEMORY-ARCHIVE-2026-10-01.md`（动手前若涉及某块的**为什么**，去那里 grep 小节号）
> - 逐轮工作日志 → `.workbuddy/memory/YYYY-MM-DD.md`
> - 仓库里的 `README.md` 是给「跑起来 / 发布」看的门面文档，两者互补。

## 项目定位

微信**原生**小程序 + **云开发**。艾森豪威尔矩阵待办中心，移动端重构自 PC 版。
单页状态机：只有 `pages/index/index`，四个视图（overview / detail / all / mine）走内存状态，不走路由。

- 环境 ID `cloud1-d0gaaaa6g7f0f1b61`（在 `miniprogram/app.js`）；AppID `wx79dda4a1dd5964fc`
- **`cloudfunctions/fqTodo` 是唯一数据出口**，客户端永不直连数据库（所以放弃 `watch()`，用 8 秒轮询）
- `cloudfunctions/fqRemind` 是第二个云函数，只做定时推送，不碰 fqTodo 的 action 体系
- 设计稿：WorkBuddy 资料库 nodeId `QXEFcvAMk44AziumpEiVDs`，本地快照 `.workbuddy/tmp/four-quadrant-mobile.html`
- 包体积 ~143 KB、零图片（图标全是自绘或内联 SVG），不用分包

---

## 一、尺寸与样式

1. **设计稿 px × 2 = rpx**（设计稿画布 375px，小程序 750rpx = 屏宽）。
2. **固定高度同时写在两处，必须成对改**：`index.wxss` 顶部注释的常量表 ↔ `index.js` 的 `LAYOUT`。
   导航 88 / 分类条 88 / 统计条 112 / Tab 120 / 底栏 134（rpx）。
   拖动相关也成对：`ROW_GAP 16` ↔ `.row{margin-bottom}`；`SWIPE_W 240` ↔ `.rowacts .act` 宽 120×2。
3. ⚠️ **`app.wxss` 全局 `box-sizing:border-box`**（view/text/button/input/textarea/scroll-view）。
   所有 `height` 都是**含 padding 的总高**。改任何高度相关样式前先确认这条。
4. 底部定位靠 **CSS flex 自动分配**（`.screen` 纵向 flex + `.scroller{flex:1;min-height:0}`），
   **禁止用 JS 算滚动区高度** —— Android 的 `screenHeight` 含虚拟导航条，算偏就把 Tab 顶出屏幕。
   `LAYOUT` 里现在只有 `TAB_H` 还参与计算（算 FAB 的 bottom 偏移）。
5. **安全区不能和固定 `height` 撞在同一元素上**：border-box 会把 `padding-bottom:env(safe-area-inset-bottom)`
   从 `height` 里抠掉。高度写在 `.tb`（120rpx），安全区加在 `.tabbar` 上（在 120rpx 之外）。
   `.bottombar` / `.sheet-foot` 没有固定高度，安全区直接加 padding 是安全的。
6. **flex 造间距一律 `margin-right` + `:last-child{margin-right:0}`**（旧 Android WebView 对 flex `gap` 不可靠）。
   `gap` 只留给 `display:grid` 的 `.qpick`。
7. **要严格等分就必须清掉 `min-width:auto`**：`.q{flex:0 0 calc(50% - 7rpx);min-width:0}`。
   `grid-template-columns:1fr 1fr` **不是等分**（`1fr` = `minmax(auto,1fr)`，被 nowrap 长文本顶宽）。
8. **自绘图标改尺寸必须连 `flex-basis` 一起改**（只覆盖 width/height 会让 flex item 的宽留在旧值，
   伪元素按错的盒子定位 → 加号变「†」）。伪元素定位用 `calc(50% - 2rpx)` 百分比居中，别写死 rpx。
9. **一行文字垂直居中用 `height` + 等值 `line-height`**，别用上下不对称的 padding。
10. **flex item 被 `stretch` 拉高后内容默认贴顶**：要居中就自己写
    `display:flex;flex-direction:column;align-items:center;justify-content:center`（`.stat` 就是这么治的）。
    `text-align:center` 只管左右，管不了上下。
11. **flex 容器不能放在 `scroll-view` 自己身上**（`enable-flex` 靠不住）：胶囊会按行内盒排在文字基线上、
    被 `overflow:hidden` 削掉顶部约 26rpx。正解是 scroll-view 内部再套一层容器：
    `<scroll-view><view class="cats-inner">{display:flex;align-items:center;height:60rpx;width:max-content}</view></scroll-view>`。
12. **要让 `scroll-view` 自己作为 flex 子项横向滚动，必须给它 `min-width:0`**（否则被内容顶宽、滚不起来）。
    分类栏的结构就是：左 `<scroll-view class="cats">` + `flex:1 1 auto;min-width:0`，右 `.cats-add` `flex:0 0 auto`。
13. **纵向 flex 容器不要用 `max-height` 当高度**（主轴尺寸不确定时 flex 不分配空间，内容直接溢出容器，
    盖到底部按钮上）。抽屉要让「主体自己封顶」：
    `.sheet-body{max-height:78vh; max-height:calc(88vh - 330rpx - env(safe-area-inset-bottom))}`，
    容器只留 `overflow:hidden` 兜底，`.sheet-foot` 加不透明白底。
14. **不要给滚动容器里「静止的元素」挂 `transform` 或裁剪**：带 transform 的元素会被提升成独立图层，
    长列表滚动时新暴露的区域来不及重绘 → 「整块不绘制」的白洞（数据、高度、占位全对，静态检查也抓不到）。
    行位移改**条件渲染**（静止写 `none`，不写 `translateX(0) translateY(0)`），
    裁剪只挂「真的需要它的那一行」（`.row.sw`），`.row` 不得常驻 `overflow:hidden`。

## 二、布局：头部固定

`.screen` 是纵向 flex，`.scroller{flex:1;min-height:0}` 吃掉剩余高度。
**凡是「列表再长也不该滚走」的块，都写在 `<scroll-view class="scroller">` 之前**：

| 视图 | 固定头部 | 滚动主体 |
|---|---|---|
| detail | `dhead` → `filters` → `sortrow` → `.swipecue` | `.rows-wrap` |
| all | （appbar 在外面）→ `sortrow` → `.swipecue` | `.sec` |
| overview | `appbar` / `catsrow` / `stats` | 矩阵网格 |

- **每个固定块必写 `flex:0 0 auto`**（默认 `0 1 auto` 会被 `flex:1` 的 `.scroller` 挤扁）。
- **提示行与它上面那行左对齐**：详情/全部页的 `.swipecue` 挂 `.left{text-align:left;padding:0 32rpx}`；
  **总览页那条矩阵说明不挂 `.left`，保持居中**（语义不同，别一刀切）。
- `mp-check.js` 第 4 条会拦「头部又被写回滚动区」（这类回归语法完全合法，只能靠契约拦）。

## 三、象限色

`app.wxss` 定义 `--q1..--q4`，`.q1/.q2/.q3/.q4` 把 `--qc` 指向对应色（q1 `#d9303c` / q2 `#9e6c00` /
q3 `#c04e18` / q4 `#6b7280`）。色块、左侧色条、详情页整屏底色都读 `var(--qc)`，
所以只需给元素挂一个象限类。**不要**用属性选择器 `[data-q="q1"]`（WXSS 支持不稳）。
四色都验过对比度 ≥4.5:1（WAAG AA），改色必须重新验算。

## 四、图标

**不用 `<image>` 加载本地 `.svg`**（Android 上不可靠）。两条可用路线：

1. **CSS 自绘**（`index.wxss` 末尾）：`ico-grid / ico-list / ico-user / ico-chev-l / ico-chev-r /
   ico-check / ico-undo / ico-plus(.big/.sm) / ico-trash / ico-dots / ico-sliders / ico-sort / ico-drag`。
2. **内联 SVG 的 `data:` URI 背景图** —— 画具象图形（火焰/闪电/灯泡/咖啡杯这类）时用它，
   形状表达力远好于拼 border。不经过文件协商，WebView 直接按图片渲染，稳。

- `ico-drag` **必须写在 `.ico{display:block}` 之后**：同权重单类选择器靠先后定胜负，写前面会被盖掉。
- `ico-undo`（左滑「撤销」）纵向占位 16+12=28rpx，与 `ico-check` 的 22+6 **逐像素相等** ——
  同一个按钮的两种状态，占位不同会在切换瞬间上下跳一下。
- `ico-trash` 是「一个元素 + `::before`（盖）/`::after`（身）」，**没有内层 `<view>`**。

⚠️ **图标内部子元素的 class 名不能和页面级 class 重名**。`.ico-trash` 原来的 `class="body"`
撞上页面级 `.body{padding:24rpx 32rpx 0}`，border-box 下左右 padding 64rpx 把 22rpx 宽的桶身
撑到 ~70rpx，删除图标整体偏右约 21rpx（同一图标里 `.lid` 无冲突、渲染正确 —— 这组对照就是铁证）。
**规矩**：图标内部不用会和页面 class 重名的名字，最好删掉内层 `<view>` 改用伪元素；
图标零件一律「显式 `width` + `left:calc(50% - w/2)`」，**不写 `left`/`right` 对**。
上线前跑 `class-collision.js`。

### 象限图标 `.qmark`（第 19 轮加）

总览矩阵的四个象限标题、以及详情页头部，各带一个**白圆底 + 同象限色字形**的图标：

| 象限 | 字形 | 颜色 |
|---|---|---|
| q1 重要且紧急 | 火焰 | `#d9303c` |
| q2 不重要但紧急 | 闪电 | `#9e6c00` |
| q3 重要不紧急 | 灯泡 | `#c04e18` |
| q4 不重要也不紧急 | 咖啡杯 | `#6b7280` |

- 结构：`.qrow`（flex 行）里放 `.qmark` + `.qname`；详情页是 `.dmeta` 里放 `.qmark` + `.hintpill`。
- `.qmark` 是 **56rpx 白圆 + `background-size:32rpx` 的 data URI 字形**，一个元素画完，无内层 `<view>`。
- ⚠️ **字形颜色是烘焙进 data URI 的**（`%23d9303c` 这种），不是 `currentColor`/`var(--qc)` ——
  data URI 是独立文档，拿不到外部 CSS 变量。**改上面四色时必须同步改 `index.wxss` 里那 4 条 URL 的色值。**
- 字形靠**祖先类**选：`.q1 .qmark { background-image: … }`。总览卡片是 `.q.q1`、详情头部是 `.dhead.q1`，
  两处都命中，所以 **WXML 不用传 key**。
- `.qrow .qname{flex:1 1 auto;min-width:0}`：不清 `min-width:auto`，最长标题「不重要也不紧急」
  会把图标挤出卡片。
- 详情页头部的顺序是 **`bar` → `dmeta`(图标+性质胶囊) → `big` 数字 → `cap`**。
  `.dmeta .hintpill{margin-top:0}` —— `.hintpill` 原来的 `margin-top:18rpx` 是它独占一行时的间距，
  进了 flex 行必须清掉。
- 验证手法：把 WXSS 里的值 ÷2 写成一份等尺寸 HTML，用
  `msedge --headless=new --screenshot=… file:///…` 截图肉眼看（比读代码猜形状可靠得多）。

## 五、数据流

`this.cats` / `this.items` 是服务端数据的内存镜像（**不在 `data` 里**，避免无谓 setData）。
`Page.data` 只放视图模型。改数据 → 先改镜像 → `render()` 推视图模型 → 异步落库；
失败走 `commit()` 里的 `load()` 回滚。派生数据的方法都叫 `buildXxx()`，`render()` 按当前视图挑字段 patch。

## 六、手势契约

| 手势 | 结果 |
|---|---|
| 横向滑动卡片（非排序模式） | 左滑露出 2 个操作（240rpx）：未完成 → 完成/删除；已完成 → 撤销/删除（撤销 = `toggleDone` 取反） |
| 点卡片（非排序模式） | 进编辑抽屉；若该行正滑开着，这一下只收起 |
| 点列表上方「调整顺序」 | 进排序模式：只允许拖**手柄**，其他按钮全锁；震动 + 卡片抖一下；**列表照常滚动** |
| 按住卡片**右侧手柄**拖动（仅排序模式） | 位移 > 5px 拿起，纵向换位，松手落库；不震不抖 |
| 在卡片**本体**上纵向滑（仅排序模式） | 就是滚列表 |

- ⚠️ **拖动与滚动都是纵向手势，落在同一元素上必然互斥。正解是分元素，不是分时机**：
  `.dh` 手柄用 `catchtouchstart/move/end` 把事件从滚动区手里截走，卡片本体保持 `bind`。
  手柄误用 `bind` → 一边滚一边拖；本体误用 `catch` → 列表再也滚不动。测试第 [15] 组钉死这两条。
- **`scroll-y` 常开**，任何模式任何时刻都不去动它。靠改 `scroll-y` 抢手势是抢不赢的 ——
  滚动由视图层在 touchmove 那一刻先启动，`setData` 关得晚半拍。
- 长按拖动已在第 4 轮废弃，改用**显式的排序模式开关**（`data.sortMode`）。

### 拖动实现要点

- `render()` **故意不重置 `sortMode`**（拖动落库会走 `commitOrder → commit → render()`，
  在那里重置会导致每拖一次就被踢出排序模式）；改在 `onTab/onOpenQuad/onBack/onGotoMine` 里 `exitSort()`。
- 抖动只在**点「调整顺序」那一刻**：`data.sortPulse` 置 true、380ms 后摘掉，
  CSS 挂 `.row.pulse .row-in .tx{animation:txShake}`。**不能挂 `sortMode` 上**（那状态整段为真）。
  **动画只能加在 `.tx` 上**，加在 `.row-in` 上会和跟手位移的内联 `transform` 打架。
- **异步量行位置必须设双重闸**。`startDrag` 每次 `this._dragSeq = (this._dragSeq||0)+1`
  （**惰性自增**：`++undefined` 得 NaN，仿真环境不走 `onLoad`，会把每次合法拖动都判成过期）；
  回调里校验 `seq !== _dragSeq || !data.dragOn || data.dragId !== id` 就丢弃。
  另加 **`_dgP` 在途闸**：`measureRows` 异步期间 `_dg` 还是空的，`onRowMove` 会在**每个 touchmove**
  上再喊一次 `startDrag` → `_dragSeq` 被反复自增、在途回调全废、`dragY` 反复压回 0 →
  表现是「按住拖不动，要试好几次」。在途期间只认第一次调用，拿到 `_dg` 后自动松开，
  `onRowStart`/`endDrag`/收尾分支也要清（防漏清卡死）。
  ⚠️ **这个坑只在真机出现**，测试桩默认同步回调永远复现不了，必须把测量改成排队（第 22 组）。
- 漏了闸的后果是**僵尸拖动**：`_dg` 装上再没人清，此后每次 touchmove（含正常滚动）都被
  `applyDragMove` 接管，用过期坐标重排整个列表 → 「列表一多，滑动时卡片乱跳、滑到的块都消失」。
- **跟手位移必须量化 + 去重**：`dragY` 出现在**每一行**的 style 表达式里，每次 setData 整个列表样式重算；
  而 touchmove 能到 60~120Hz。`Math.round` 成整数 px + `dg.pushedY` 去重，落点判定也用这个整数位移。
  `onRowStart` **不要**在 touchstart 就推 `dragging`（它只是「关过渡动画」的开关，必须与第一帧位移同时到场）；
  `.row-in.lift` 加 `will-change:transform`（28px 模糊的抬起阴影跟每帧重绘太贵）。
- **两条 setData 通道**（别合并）：`dragY`（被拖卡片跟手，每帧一个数字）+ `shift`（其余卡片让位量，
  只在跨过某行中线时才 setData 整个 rows/sections）。
- 行位置在「拿起」时用 `boundingClientRect` 量一次，之后**只按 `bindscroll` 报来的滚动量整体平移**
  （`_dg.rects[i].top -= d`），不再重查。
- **拖到边缘自动滚**（`maybeAutoScroll`/`runAutoScroll`）：手指进入滚动区上下缘 `DRAG_EDGE=96px` 内，
  每 `AS_TICK=40ms` 推 `AS_STEP=14px`。三个不能省的细节：
  ① 滚动区上下边由 `measureScroller()` 拿起时量一次，量不到就 `_scBand=null` → 不自动滚（只降级增强）；
  ② 卡片屏幕位置 = `dg.base0 + (clientY - _dgY0) - rects[from].top`，**别把 `clientY` 当位移累计**；
  ③ 滚到顶/底要收手：`setData({scrollTop})` **之后不能立刻判断**（`bindscroll` 异步回来），
  放到**下一拍开头**比 `that._scrollTop === dg.asPending`；手指移动 >4px 就清 `asDirDone` 与 `asPending`。
  定时器用 `setTimeout` 自串（不是 `setInterval`）；`endDrag`/`exitSort`/`onRowEnd` 都要 `stopAutoScroll()`。
- `onSortToggle()`/`exitSort()` 都要清 `_dg` 与 `_drag`；`onRowEnd` 的排序模式分支还要清 `dragId/dragY`
  （点一下就抬走时 `dragId` 已推到视图层，只清 `dragOn` 会让那张卡一直挂着抬起阴影）。
- 拖动中的卡片挂 `.row.liftrow` 抬 z-index。

### 左滑操作组：只有 2 个动作，且「滑开才渲染」

- 渲染条件 `wx:if="{{!sortMode && swipeKey===item._id}}"` —— **`swipeKey` 就是渲染闸门**。
  **要「看不见」就别渲染，不要靠遮挡**：遮挡只在布局静止时成立，卡片一 `translateY` 就露馅；
  已完成行 `.row-in` 是 `opacity:.5`，常驻的操作组还会直接透出来。
- 已完成行左滑是**实的**（撤销/删除），不是空面板。两者共用 `data-act="done"`，云函数不必新增 action。
- **「收起」必须是真收起**：位移不到 45% 阈值就把 `swipeKey` 一并清空（`open ? id : ''`）。
  只把 `swipeX` 归零的话按钮还挂在 DOM 里、只是被盖住。
- **`onRowMove` 的节流基准要取这一行自己的位移**：
  `const prev = data.swipeKey===this._drag.id ? data.swipeX : 0`。
- 排序模式整组不渲染，并给 `.row` 挂 `.sorting{background:transparent}`（否则露出 `.row` 自己的浅灰底衬）。

### 已完成事项的样式只有两件事

标题 `text-decoration:line-through` + `.row-in` 的 `opacity:0.5`。**不要再动左侧色条**（用户明确要求去掉）。

## 七、云函数 fqTodo

### action 清单（18 个）

`bootstrap` / `sync` / `addItem` / `updateItem` / `removeItem` / `reorder` / `bulk`
（markAllDone·clearDone·clearQuad）/ `clearDone` / `clearAll` / `addCategory` / `removeCategory` /
`renameCategory` / `genInvite` / `joinFamily` / `leaveFamily` / `renameMember` / `renameFamily` / `grantSub`。

每个 action 第一步都是 `ensureFamily(OPENID)`；入参统一长度截断 + 类型收敛；引用 `catId` 二次校验归属。
返回信封统一 `{ok, data|msg}`，抛异常只回传 message（不透传堆栈）。

### 7.1 协议版本握手（FN_VER）

两端各一份 `FN_VER`，**必须始终相等**（当前都是 **5**；v2→v3 共享家庭，v3→v4 分类删改，v4→v5 提醒推送）。
`bootstrap` 返回 `fnVer` + `actions`；客户端 `load()` 交给 `checkFnVer(data)`，不一致就首屏弹
「云函数版本过旧」+ 部署步骤（模块级 `fnVerWarned` 保证一个会话只弹一次）。
`default` 分支 msg 也带云端版本：`'未知 action: X（云端 fqTodo v5，若本端代码更新过请重新上传部署云函数）'`。
**约定：改 action 清单 → 两端 `FN_VER` 一起 +1。** `test-reorder` 第 [17] 组读两份源码比对。
⚠️ **测试里别再写死版本号数字**，从源码读。

### 7.2 排序语义

- **粒度是「象限 × 分类」**：重排只影响当前分类下、同一象限内的事项。
- **落库是整段重写成 `0/10/20…`**（`ORDER_STEP=10`），只把 `order` 或 `quad` 真变了的行发给 `reorder`
  （一次通常 3 条）。**不要改成「相邻取中值」**（反复拖动会把浮点间距耗光）。
- **筛选下只重排可见项**：`visibleIdx(full)` 把可见下标映射回完整下标再 splice，
  否则一筛一拖就把隐藏项挤走。
- **跨象限拖只发生在「全部」页**：`.row` 的测量顺序必须与 `flatList()` 一一对应（对不上就放弃本次拖动）。
  跨段不做让位动画（各行高度不一必错位），改为整段高亮 + 「松手移到这里」，松手后改 `quad`
  并重排源/目标两个象限。
- **换位判定留容差 `EPS = 0.5`**：位移被夹在首尾内，拖到最上/最下一档时卡片中心**正好等于**首/尾中线，
  严格大于会永远差一档。
- 新建事项用 `order: Date.now()`（天然最大 → 排到象限末尾）。

### 7.3 共享家庭（v3）：归属键是 `fid`，不是 `_openid`

**一个家庭 = 一份共享清单。** 首次进入自动拿到「我的家庭」，现有待办就在里面；
加入对方的家庭 = **切换当前家庭**，不搬运也不删数据，退出即回自己那份。

- 集合：`fq_family{name,ownerOpenid,inviteCode,inviteExpire,rev,createdAt}`、
  `fq_members{_openid,fid,role,name,active,joinedAt}`、`fq_categories`、`fq_items`、`fq_subs`（共 **5** 个）。
  `fq_items`/`fq_categories` 各带 `fid`。**`_openid` 降级成「谁创建的」（审计用），不参与过滤。**
  一个人可属多个家庭，但 `active:true` 的只有一条。

#### ⚠️ 铁律：`fid` 只能由服务端推导

**这是全项目唯一会出安全事故的地方。** 云函数用管理员权限、**绕过数据库安全规则** ——
「集合权限设成仅创建者可读写」这道防线对云函数形同虚设，真正的防线全在代码里：

- 每个 action 第一步 `ensureFamily(OPENID)` 从 `fq_members` 反查 `fid`，到不了就 fail closed；
- 所有 where 用 `{_id: id, fid: ctx.fid}` 双条件，**没有一处从入参取 `fid`**；
- 分权也在服务端：`clearAll`/`genInvite`/`renameFamily` 校验 `fam.ownerOpenid === openid`。
  客户端藏入口只是体验，不是防线。

**谁把 `fid` 改成客户端传参，就等于把全部家庭的数据敞开。** 第 [12] 组专钉这条。

#### 邀请码

6 位，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（剔掉 `0/O/1/I/L`），24h 有效，上限 20 人。
两端都做归一化（大写、去空格与连字符）。**码只回给创建者**（`familyInfo` 对非创建者返回空串）。
分享路径 `pages/index/index?code=XXXXXX`，`onLoad` 接住、首屏加载完自动加入。

#### 自动同步：轮询，不用 `watch()`

页面可见时每 8 秒带 `rev` 问一次；rev 一致只回一个数字（`SYNC_MS=8000`，随 `onShow`/`onHide` 起停）。
**不用云数据库 `watch()`**：它要求把集合读权限放开给客户端 = 破掉「云函数是唯一数据出口」。
真要上推送，先配自定义安全规则（`get()` 只能按文档 ID 精确取，所以成员记录得用 openid 当 `_id`），再改 `watch`。

**三个必须让路的时机**（少一个就会「点一下界面闪回去」）：`sortMode`、`sheetOpen`、`pendingWrites > 0`。
`pendingWrites` 在 `callCloud` 里按 `WRITE_ACTIONS` 名单自增自减，**成功失败都要减**
（只减成功的话一次网络异常会让同步永久静默停摆）。

#### 老数据迁移

v3 之前的文档只有 `_openid`。首次 `bootstrap` 建家庭 + 把该 openid 名下**所有没有 `fid` 的分类与事项
一次性认领**进来，并且**不再播种**（否则老用户会看到自己的数据混进 5 条示例）。第 [11] 组守着。

### 7.4 分类删除与改名（v4）

- **入口**：我的页「分类」卡片**长按**（`bindlongpress`）——「点整行 = 切分类」是高频手势，不能被侵占；
  小程序规定绑了 `longpress` 且触发后 `tap` 不再触发，两者不打架。卡片底部有常驻提示补可发现性。
- **交互**：长按 → 底部抽屉 `catmenu`（重命名/删除）；空分类走 `showModal` 一次确认；
  非空分类切到 `catdel`（选事项新家 / 连同删除）。
- **权限按破坏力分两层**：空分类**任何家庭成员**可删；非空分类**仅家庭创建者**可删
  （对齐 `addCategory` 全员可用 / `clearAll` 仅创建者）。
- **四条不能省的约束**：
  1. **「非空」必须服务端自己 `count()` 重算**，绝不采信客户端 —— 否则构造一个不带 `moveTo` 的请求
     就能绕过确认直接抹掉整个分类。
  2. **先搬事项、后删分类**。反过来中途失败会把事项连同归属一起弄丢；现在最坏是「分类还在、事项已搬走」，可恢复。
  3. **家里至少留一个分类**（`total <= 1` 直接拒），否则「新建事项」因无分类可选而卡死。两端都拦。
  4. 删掉的刚好是**当前选中**分类时，`state.catId` 会指向不存在的分类 → 必须回落。
     **复用已有的 `fixCatId()`，别另写一套。**
- `renameCategory` 查重用「查出来再比 `_id`」而不是 `count()`（改成自己原来的名字时 `count` 会命中自己）。
- 客户端字段：`catMenuId`（**被长按的那一行**，不是 `state.catId` —— 两者经常不同，拿错就删错行）、
  `catDelCount`、`catCanDel`、`moveRows`。

### 7.5 提醒推送（v5）

**独立云函数 `fqRemind`，绝不塞进 `fqTodo`**：定时触发器里 `getWXContext()` 没有任何用户上下文，
混进去就是给「每个 action 第一步 `ensureFamily`」这条铁律开例外；且一个云函数只支持一个定时触发器。

| 文件 | 内容 |
|---|---|
| `index.js` | 每分钟扫一次：抢锁 → 扣额度 → 下发 → 记结果；末尾按 `fid` 去重推 `rev` |
| `config.json` | `permissions.openapi:['subscribeMessage.send']` + `triggers:[{type:'timer',config:'0 * * * * * *'}]` |

**四条官方事实（照抄，别凭记忆改）**：

- 触发器**时区固定 UTC+8**，cron 七段式（秒 分 时 日 月 星期 年），最小粒度分钟。
- **会重复触发 → 必须抢锁**：`where({_id, done:_.neq(true), pushed:_.neq(true)}).update({pushed:true})`，
  只有 `stats.updated === 1` 的那次才真发。去重的全部实现就是这一句，不需要锁表。
- 扫描条件必须 `remindAt: _.and(_.gt(0), _.lte(t))`，**不能只写 `_.lte`** —— `remindAt` 为 `null`
  的文档在 `$lte` 下也会被捞出来（null 在类型序里排在数字之前）。
- `pushed` 的排除必须写 **`_.neq(true)` 而不是等值 `false`** —— 升级上来的老文档压根没有这个字段，
  等值条件挑不到它们 → 那批提醒**永远发不出去、而且一点报错都没有**。

**时间格式化写死 +8 偏移再取 `getUTC*`**，不信任容器时区（第 [8] 组拿 ICU 时区库做对照，
并反向断言它不是 UTC 裸值 —— 同一套算法自证没有意义）。

**自己加的三个设计**：

| 设计 | 为什么 |
|---|---|
| 迟到 5 分钟内补发，超过记 `expired` | 容器冷启动/漏跑会过点。补发几小时前的提醒只会让人困惑，但也不能静默丢弃 —— 记成「未送达」让用户看得见 |
| 扣不到额度时**仍然标记 `pushed`** | 否则每分钟重试到天荒地老。代价是补了额度也不补发（那条时间已经过去了） |
| 结果按 `fid` 去重后 `bumpRev` | 「未送达」计数变了，我的页那行字要跟着刷 |

- **`MINI_STATE = 'trial'`**：体验期必须这么设，否则用户点通知跳「该小程序未发布」。
  **正式发布后要改成 `'formal'`**（第 [12] 组断言它当前是 `trial`）。
- **额度是自己记的账，微信侧没有查询接口**。用户端「服务通知」只能看到收到的消息；
  开发者端也没有查询接口，下发接口不回剩余次数 —— 所以「还剩几条」只能自己维护
  （`fq_subs.quota` 存在的唯一理由）。两处查看入口：小程序「我的」页「提醒」卡片（`subQuota`）、
  云开发控制台 → 数据库 → `fq_subs`。它是**保守估计**，不等于微信真实余额
  （用户在别处对同一模板授权、或下发被拒仍扣额度，这两处都会差一两条）。
- **模板**「待办事项提醒」`templateId = 1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM`，
  5 个槽位 key **编号毫无规律**（`thing26` 名称 / `thing15` 象限名 / `thing12` 备注 /
  `thing1` 分类名 / `time23` 提醒时间）—— 必须逐字从「我的模板 → 详情 → 详细内容」抄，
  `{{thing26.DATA}}` 里去掉 `.DATA` 才是 key。**勾了几个槽就得赋几个非空值**，少一个整条 47003。
  `thing` 类 ≤20 字符（按字符截断，不是 UTF-16 单元）；`time` 是 `YYYY-MM-DD HH:MM`。
  模板与小程序之间**不存在任何绑定**，每个槽灌什么完全由发消息的代码决定。
- 额度记账与防刷：`grantSub` 校验 `templateId` 必须等于本项目的、**加多少由服务端定（客户端传 999 也只 +1）**、
  总量封顶 `MAX_QUOTA = 50`、两次间隔 < `GRANT_MIN_MS = 300` 视为连点（**不报错**，正当的快速保存不该弹错）。
  扣减也原子：`where({_openid, quota:_.gt(0)}).update({quota:_.inc(-1)})`，扣到了才发。
- `pushed` 字段的安全性不用额外操心：`updateItem` 是白名单写法，客户端天然改不了它。
- **首次保存带提醒的事项时**客户端才请求授权（`wx.requestSubscribeMessage`），
  且**必须由用户真的点一次触发**才攒得到额度（「设了提醒」本身不产生额度）。
  单独放一个「补授权」按钮属于「无触发场景的订阅」，微信不认。

## 八、首屏种子

`bootstrap` 发现**当前家庭**分类数为 0 时写入「工作 / 生活」+ 5 条示例事项（含一条「明天 09:00」提醒）。
分类 id 由数据库生成，种子事项挂在「工作」下，都带 `fid`。（老用户走「认领」分支，不走播种。）

## 九、原「布局铁律 12 条」已并入 §一

不再重复列出。可执行的规则全部在 §一；每条背后的**像素实测证据与推导**在归档文件
`.workbuddy/memory/MEMORY-ARCHIVE-2026-10-01.md` 的「布局铁律」一节。
留一句备忘：这 12 条都是**「语法完全合法、只在特定条件下才暴露」**的坑，光读代码看不出来
—— 所以才有下面 §十 的「先量截图别猜」。

## 十、诊断手法：UI 像素级 bug 先量截图，别猜

本机 managed python 只有 PIL（**没有 numpy**），脚本用纯 PIL 写。
四件最有效的事：① 目标色包围盒（判等分）；② 逐行像素计数（找水平线、看越界）；
③ 裁切放大 4~8 倍肉眼看；④ 「逐列主色 + ROI 逐行字符画」定位小图标偏心。
先算 **1rpx = 截图宽 ÷ 750**，测量值就能换算回 rpx 与 WXSS 对齐。
**最关键的：找一个「同族但没被污染」的元素做对照**（桶盖正常/桶身跑偏 → 直接锁定「class 重名」）。

**验证 CSS 图标形状 / 版式**（第 19 轮）：把 WXSS 的值 ÷2 写成一份等尺寸 HTML，
用 Edge 无头截图肉眼看，比读代码猜可靠得多：

```
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu \
  --force-device-scale-factor=2 --screenshot="<out>.png" --window-size=375,860 "file:///<in>.html"
```

## 十一、部署

点「编译」**只编译小程序端**。云函数必须手动右键 → **上传并部署：云端安装依赖**。
现有**两个**云函数：`fqTodo`（数据出口）与 `fqRemind`（提醒推送）；
⚠️ **`fqRemind` 还要额外右键点一次「上传触发器」** —— 只「上传并部署」不会带上 `config.json` 里的
定时触发器，表现为「提醒永远不发、而且一点报错都没有」。
新环境要先建 **5 个集合**：`fq_family` / `fq_members` / `fq_categories` / `fq_items` / `fq_subs`，
权限都设「仅创建者可读写」（注意这条对云函数无效，真正的防线是 §7.3 的 `fid` 铁律）。

**同一个坑有两种长相，别搞混：**

| 现象 | 含义 |
|---|---|
| 报「云函数 fqTodo 尚未部署」 | 云端**根本没有**这个函数 |
| 报「未知 action: reorder」（或别的已实现的 action） | 云端有函数，但跑的是**旧包** |
| 首屏弹窗「云函数版本过旧」 | 云端没上报 `fnVer` 或版本不等 → 同上，主动预警 |

**判断「旧包」还是「真 bug」**：跑 `test-cloudfn.js`。它绿 → 代码是对的，问题只在部署。

## 十二、发布

| 路径 | 要不要备案 | 谁能用 |
|---|---|---|
| **体验版** | **不用**（备案卡的是「上架/发布」） | 后台加的体验成员（个人主体上限 15 名） |
| **正式版** | **必须先备案**（微信初审 1~2 天 → 工信部短信核验 24h → 管局 1~20 工作日） | 任何人 |

- 云开发**免掉了域名备案**，但**小程序自身的 ICP 备案照样要办** —— 两件事别混。
- 代码侧发布前：**5 个集合建好 + 两个云函数都重新部署**（`FN_VER` 当前 5），`fqRemind` 还要**上传触发器**。
  **没有**定位/相册/手机号/用户信息等隐私接口 → 不需要 `requiredPrivateInfos`，隐私指引可勾「不收集」。
- ⚠️ **正式发布后记得把 `fqRemind` 的 `MINI_STATE` 从 `'trial'` 改成 `'formal'`**。
- ⚠️ **最大的审核风险是 UGC**：家庭共享 = 一个人写的事项另一个人能看到。
  对策：审核备注说明是家庭内私密共享；必要时给 `addItem`/`updateItem` 接 `security.msgSecCheck`。
- **体验版迭代无次数限制、不审核**。改动类型决定跑哪条管道：

| 改了什么 | 重新上传小程序 | 重新部署云函数 | 其他 |
|---|---|---|---|
| 界面 / 样式 / 页面逻辑 | ✅ | ❌ | — |
| `fqTodo/index.js`（不改 action 清单） | ❌ | ✅ | — |
| 增删 / 改了 action 清单 | ✅ | ✅ | **两端 `FN_VER` 一起 +1** |
| 新增数据库集合 | ❌ | ✅ | 还要去云开发控制台手工建集合 |
| `fqRemind/config.json`（触发器/云调用权限） | ❌ | ✅ | **还要单独点「上传触发器」** |

**体验版「传了却没更新」几乎都是手机端代码缓存**：下拉删除小程序 → 重新扫体验版二维码。

## 十三、无 IDE 自检

```bash
node .workbuddy/tools/check-all.js
```

一条命令串起 5 个工具 + JSON 校验，末尾汇总「全部通过 / 有 N 项未通过」：

| 工具 | 断言规模 | 覆盖 |
|---|---|---|
| `mp-check.js` | class 161 / WXSS 165、data 68 键 | class 契约、data 契约、结构配对、**固定头部契约** |
| `class-collision.js` | 页面级选择器 89 个 | 图标内部 class 与页面级 class 重名 |
| `test-reorder.js` | **23 组 / 273 条** | 页面逻辑：拖动 / 左滑 / 排序模式 / 拖动竞态 / 起动闸与位移量化 / 视图层静态约定 / 自动滚 / 版本握手 / 同步避让 / 家庭视图 / 分类管理 / **提醒推送契约** |
| `test-cloudfn.js` | **20 组 / 214 条** | 云函数 fqTodo：reorder / 越权 / 家庭与邀请码 / 老数据认领 / rev 同步 / 分类删改与分权 / **订阅额度 / 推送状态** / 种子 / 握手 |
| `test-remind.js` | **12 组 / 107 条** | 云函数 fqRemind：去重（含并发）/ 额度不足 / 窗口与迟到边界 / 五槽位 / 北京时间 / 跨用户跨家庭 / 触发器配置契约 |
| `fake-cloud.js` | — | 上面两份云函数测试**共用**的假 `wx-server-sdk`（内存库 + `db.command` + 云调用记录） |

- `mp-check.js` 第 4 条「固定头部契约」断言 `dhead`/`filters`/`sortrow` **不在** `.scroller` 区间内。
- 两份仿真测试都**加载真实源码 + 假环境**跑真实方法，不复制逻辑。
- **`test-reorder.js` 桩的三个必踩坑**：
  ① **`select` 与 `selectAll` 返回结构不同**（单点 `res[0]` 是 rect，批量 `res[0]` 是 rect 数组）——
     写错会让页面一直走降级分支而测试仍绿。**降级路径要有正反两组断言。**
  ② 异步生效的东西要能「挂起 + 手动 flush」（`setTimeout` 桩成可 flush；`createSelectorQuery`
     要能选「回调迟到」，否则竞态类断言永远绿）。
  ③ 假滚动区要会**夹取** `scrollTop`（`SC` + `flushScroll()`），夹取才能体现「滚到底」。
- **CommonJS 测试脚本不能有顶层 `await`**（Node 报 `ERR_AMBIGUOUS_MODULE_SYNTAX`）；
  排空微任务用 `new Promise(r => setImmediate(r))`，**别连写几个 `Promise.resolve().then`**。
- `wx.showModal({editable:true})` 的返回值是 **promise**，手工调 `success()` 只是 resolve，
  断言要接一个微任务（`Promise.resolve().then(…)`）；桩 `wx` 上必须补 `canIUse`。
- 每次加新的关键判断，按同样思路做**变异验证**（把判断逐个改坏，确认测试能变红）——
  **一份永远绿的测试和没有测试是一样的。**

## 十四、改码纪律

**同一条消息里不要对同一个文件发两个编辑。** 两次「读—改—写」会并发，后写的把先写的覆盖掉，
**而工具两次都返回成功**。已因此三次丢改动（页面 JS、云函数 JS、测试）。
改同一个文件必须**一次一处、逐个确认**；收尾用「特征字符串扫描」复核落盘
（标记要挑**唯一**片段 —— `sortPulse: false` 就假阳性过，它同时匹配 `setData({sortPulse:false})`）。

## 十五、有意偏离设计稿的地方

见 `README.md`「六、与设计稿的差异」。改动前先看那张表，别把有意为之的偏离当 bug 改回去。
