# 4todolist · 查阅型记忆（MEMORY-OPS）

> 本文件是 `MEMORY.md` 的**尾部**：内容重要但不必常驻内存（不参与注入）。
> 涉及云函数细节、部署、发布、自检工具时**必须来读**。
> 完整推导与踩坑过程在 `MEMORY-ARCHIVE-2026-10-01.md`。

---

## 一、云函数 fqTodo 补充

### 1.1 action 清单（19 个）

`bootstrap` / `sync` / `addItem` / `updateItem` / `removeItem` / `reorder` / `bulk`
（markAllDone·clearDone·clearQuad）/ `clearDone` / `clearAll` / `addCategory` / `removeCategory` /
`renameCategory` / `savePlan` / `genInvite` / `joinFamily` / `leaveFamily` / `renameMember` /
`renameFamily` / `grantSub`。

每个 action 第一步都是 `ensureFamily(OPENID)`；入参统一长度截断 + 类型收敛；引用 `catId` 二次校验归属。
返回信封统一 `{ok, data|msg}`，抛异常只回传 message（不透传堆栈）。
`default` 分支的 msg 也带云端版本号。

### 1.2 集合与共享家庭（v3）

**一个家庭 = 一份共享清单。** 首次进入自动拿到「我的家庭」；加入对方家庭 = **切换当前家庭**，
不搬运也不删数据，退出即回自己那份。集合共 **6** 个：

- `fq_family{name,ownerOpenid,inviteCode,inviteExpire,rev,createdAt}`
- `fq_members{_openid,fid,role,name,active,joinedAt}`
- `fq_categories` / `fq_items`（各带 `fid`）/ `fq_subs`
- `fq_plans{_openid,fid,date,text,updatedAt}`（v6 日程，**按人**存，唯一键 `(fid,_openid,date)`，见 §八）

**`_openid` 降级成「谁创建的」（审计用），不参与过滤。** 一个人可属多个家庭，但 `active:true` 只有一条。

**邀请码**：6 位，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（剔掉 `0/O/1/I/L`），24h 有效，上限 20 人。
两端都做归一化（大写、去空格与连字符）。**码只回给创建者**（`familyInfo` 对非创建者返回空串）。
分享路径 `pages/index/index?code=XXXXXX`，`onLoad` 接住、首屏加载完自动加入。

**自动同步：轮询，不用 `watch()`**。页面可见时每 8 秒带 `rev` 问一次；rev 一致只回一个数字
（`SYNC_MS=8000`，随 `onShow`/`onHide` 起停）。
**不用云数据库 `watch()`**：它要求把集合读权限放开给客户端 = 破掉「云函数是唯一数据出口」。
真要上推送，先配自定义安全规则（`get()` 只能按文档 ID 精确取，所以成员记录得用 openid 当 `_id`）。

**三个必须让路的时机**（少一个就会「点一下界面闪回去」）：`sortMode`、`sheetOpen`、`pendingWrites > 0`。
`pendingWrites` 在 `services/cloud.js` 的 `callCloud` 里按 `WRITE_ACTIONS` 名单自增自减，
**成功失败都要减**（只减成功的话一次网络异常会让同步永久静默停摆）；
它对页面只暴露 `cloud.pendingWriteCount()` **取值函数** —— 直接导出数字导出的是快照，永远为 0。

**老数据迁移**：v3 之前的文档只有 `_openid`。首次 `bootstrap` 建家庭 + 把该 openid 名下**所有没有 `fid`
的分类与事项一次性认领**进来，并且**不再播种**（否则老用户会看到自己的数据混进 5 条示例）。第 [11] 组守着。

### 1.3 分类删除与改名（v4）

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
  4. 删掉的刚好是**当前选中**分类时 `state.catId` 会指向不存在的分类 → 必须回落。**复用 `fixCatId()`，别另写一套。**
- `renameCategory` 查重用「查出来再比 `_id`」而不是 `count()`（改成自己原来的名字时 `count` 会命中自己）。
- 客户端字段：`catMenuId`（**被长按的那一行**，不是 `state.catId` —— 两者经常不同，拿错就删错行）、
  `catDelCount`、`catCanDel`、`moveRows`。

### 1.4 提醒推送（v5）

**独立云函数 `fqRemind`，绝不塞进 `fqTodo`**：定时触发器里 `getWXContext()` 没有任何用户上下文，
混进去就是给「每个 action 第一步 `ensureFamily`」这条铁律开例外；且一个云函数只支持一个定时触发器。

| 文件 | 内容 |
|---|---|
| `index.js` | 每轮：**先回填老数据**（`backfillPushAt`）→ 按 `pushAt` 扫 → 抢锁 → 扣额度 → 下发 → 记结果；末尾按 `fid` 去重推 `rev` |
| `config.json` | `permissions.openapi:['subscribeMessage.send']` + `triggers:[{type:'timer',config:'0 * * * * * *'}]` |

**四条官方事实（照抄，别凭记忆改）**：

- 触发器**时区固定 UTC+8**，cron 七段式（秒 分 时 日 月 星期 年），最小粒度分钟。
- **会重复触发 → 必须抢锁**：`where({_id, done:_.neq(true), pushed:_.neq(true)}).update({pushed:true})`，
  只有 `stats.updated === 1` 的那次才真发。去重的全部实现就是这一句，不需要锁表。
- 扫描条件必须 `pushAt: _.and(_.gt(0), _.lte(now))`，**不能只写 `_.lte`** —— `pushAt` 为 `null`
  的文档（选了「不提醒」或压根没设提醒时间）在 `$lte` 下也会被捞出来（null 在类型序里排在数字之前），
  白占分页窗口。⚠️ v8 起条件里的字段是 `pushAt` **不是 `remindAt`**（见下面 1.4.1）。
- `pushed` 的排除必须写 **`_.neq(true)` 而不是等值 `false`** —— 升级上来的老文档压根没这个字段，
  等值条件挑不到它们 → 那批提醒**永远发不出去、而且一点报错都没有**。

**时间格式化写死 +8 偏移再取 `getUTC*`**，不信任容器时区（第 [8] 组拿 ICU 时区库做对照，
并反向断言它不是 UTC 裸值 —— 同一套算法自证没有意义）。

**自己加的三个设计**：迟到 5 分钟内补发、超过记 `expired`（不能静默丢弃）｜扣不到额度时**仍然标记 `pushed`**
（否则每分钟重试到天荒地老）｜结果按 `fid` 去重后 `bumpRev`（「未送达」计数要跟着刷）。

- **`MINI_STATE = 'trial'`**：体验期必须这么设，否则用户点通知跳「该小程序未发布」。
  **正式发布后要改成 `'formal'`**（第 [12] 组断言它当前是 `trial`）。
- **额度是自己记的账，微信侧没有查询接口**。「还剩几条」只能自己维护（`fq_subs.quota` 存在的唯一理由）。
  两处查看入口：小程序「我的」页「提醒」卡片（`subQuota`）、云开发控制台 → 数据库 → `fq_subs`。
  它是**保守估计**，不等于微信真实余额。
- **模板**「待办事项提醒」`templateId = 1AaZ3iSMfGpplGMUIVArXIPssCKAj2p3hHFxJPpOmlM`，
  5 个槽位 key **编号毫无规律**（`thing26` 名称 / `thing15` 象限名 / `thing12` 备注 /
  `thing1` 分类名 / `time23` 提醒时间）—— 必须逐字从「我的模板 → 详情 → 详细内容」抄，
  `{{thing26.DATA}}` 里去掉 `.DATA` 才是 key。**勾了几个槽就得赋几个非空值**，少一个整条 47003。
  `thing` 类 ≤20 字符（按字符截断）；`time` 是 `YYYY-MM-DD HH:MM`。
  模板与小程序之间**不存在任何绑定**，每个槽灌什么完全由发消息的代码决定。
- 额度记账与防刷：`grantSub` 校验 `templateId` 必须等于本项目的、**加多少由服务端定（客户端传 999 也只 +1）**、
  总量封顶 `MAX_QUOTA = 50`、两次间隔 < `GRANT_MIN_MS = 300` 视为连点（**不报错**）。
  扣减也原子：`where({_openid, quota:_.gt(0)}).update({quota:_.inc(-1)})`，扣到了才发。
- `pushed` 字段安全性不用额外操心：`updateItem` 是白名单写法，客户端天然改不了它。
- **首次保存带提醒的事项时**客户端才请求授权（`wx.requestSubscribeMessage`），
  且**必须由用户真的点一次触发**才攒得到额度（「设了提醒」本身不产生额度）。
  单独放一个「补授权」按钮属于「无触发场景的订阅」，微信不认。
  ⚠️ v8 起触发条件收紧为 `remindAt && leadMin !== -1`（选了「不提醒」就不弹订阅框），
  且**拒绝时当场 toast**（理由见 1.4.1）。

### 1.4.1 提前量的可配置化（v8，2026-10-13）

**数据模型**：`fq_items` 多出 `leadMin` / `pushAt` 一对。`leadMin` = 提前多少分钟（白名单，
`-1` = 不提醒）；`pushAt` = `remindAt - leadMin * 60000`（预算好的推送时刻）。
`leadMin` 只在有 `remindAt` 时有值；`leadMin === -1` 或没提醒时间 → `pushAt` 落 `null`。

- ⚠️ **落库 `pushAt` 不是优化，是唯一可行解**：逐条提前量**表达不成单一扫描窗口**
  （A 提前 5 分钟、B 提前 7 天，该发时刻之间毫无关系）。看似可行的替代（窗口放宽到 30 天
  + 内存里逐条过滤）会撞 `CAP = 500` 分页上限 → 排在后面的**静默漏推**。
  落成 `pushAt` 后条件回到 `pushAt <= now`，语义与索引都干净，代价只是变化时重算一次。
- ⚠️ **`-1` 而非 `0` 作「不提醒」哨兵**：`toLead()` 把白名单外的值一律回落默认档；
  若 `0` 合法，一个脏值（老数据的 `null`、手滑传的字符串）就会把提醒**静默关掉** ——
  用户以为开着、实际永远不发，这是最糟的失败方向。用 `-1` 后失败方向是「发得比预期早」。
- **三份白名单**：`utils/const.js` 的 `LEAD_OPTIONS`、`fqTodo` / `fqRemind` 的 `LEAD_ALLOWED`
  （10 档：`-1/5/10/30/60/180/1440/4320/10080/43200`）；`LEAD_DEFAULT = 30` 同样三处一致。
  两个云函数各留一份 `toLead` / `toPushAt`（**逐字一致**），`test-remind.js` 读源码比对。
- ⚠️ **`remindAt` / `leadMin` / `pushAt` 是一组**：`updateItem` 里任一进来就三个一起重算
  （分开更新必然算出中间态）。**「提前量真的变了」也要复位 `pushed` / `pushedAt` / `pushOk` / `pushErr`**，
  否则改完那条提醒永远不再排队（表现是「改了没用」，不报错）。只改标题**不**复位。
- ⚠️ **`updateItem` 必须先把旧值读出来**：客户端每次保存都会把 `remindAt` / `leadMin` 一起带上
  （哪怕没动过），不比对旧值就会每次都复位推送状态、白发一条。老数据没有 `leadMin`，
  读旧值时要 `toLead(old.leadMin)` 按默认档补齐而不是落 `null`（落 `null` 会让「只改个标题」
  因为「提前量从 30 变成 null」白白复位）。
- **客户端**：抽屉里条件渲染的「提前提醒」行（`wx:if="{{form.hasRemind}}"`），
  `form.leadIdx` / `form.leadLabel`，`LEAD_DEFAULT_IDX` 用 `findIndex` 算**不写死下标**；
  `openForm` 的 `leadIndex(item ? item.leadMin : LEAD_DEFAULT)` **只读 `leadMin`、不看 `pushAt`**
  （拿结果反推输入等于把同一件事算两遍）；`onClearRemind` 一并复位提前量；
  小字授权说明是 `.subhint`（22rpx / `var(--ink3)`），配套 `.rowline .ico-chev-r` 那条通用规则。
- ⚠️ **本地镜像也要写 `leadMin`**（编辑分支 `it.leadMin = payload.leadMin`、新建 push 的那条
  带 `leadMin: payload.leadMin`）：抽屉重开读的就是它。漏了的表现是「刚选的提前量，重开一次
  就变回默认档」—— **与「云端还是旧包」那个故障长得一模一样**，所以那条断言的价值不只是
  守乐观更新，更是把两个成因分开。
- **老数据回填 `backfillPushAt()`**：`exports.main` 第一步就跑（**先回填、再扫描**，反了升级那轮
  整批漏掉）。单轮最多 5 页 × `PAGE = 100`。判据是 **`leadMin: _.exists(false)`**，
  不是 `pushAt` 缺失（「不提醒」的 `pushAt` 是 `null`、字段在 → 无限回填）。
  ⚠️ **这条判据的区分力测试守不住**（两种判据挑出同一批文档，差异只在容器对 `null` 字段是否算缺失），
  别声称测试守住了它 —— 结论写在 `mutate-lead.js` 与 `test-remind.js` 第 [14] 组注释里。
  副作用**有意**：存量事项提前量 10 → 30 分钟。
- **假 SDK 补了 `_.exists`**（`fake-cloud.js` 的 `exists(v)` + `test(cond, val, has)` 的
  `__exists` 分支 + `match` 传 `Object.prototype.hasOwnProperty.call`）。
- **授权行为**：只在「有提醒时间且提前量 ≠ 不提醒」时 `askSubscribe()`；被拒（`reject`/`ban`/`filter`）
  时**当场 toast「未授权，这条提醒不会推送到微信」**（只用 toast：不改数据、不弹 modal、不拦流程 ——
  用户可能只是手滑）；环境不支持则静默跳过。提醒时间与提前量**照常保存**，
  到点由 `fqRemind` 记 `no-quota`。
- **测试位置**：`test-cloudfn.js` 第 [22] 组（白名单 / 脏值回落方向 / `pushAt` 预算 /
  改它也复位 / 老数据补齐）；`test-remind.js` 第 [12] 组（三份白名单与默认值的跨文件比对 +
  `pushAt` 扫描 / 排序 / 到期判据）、第 [13] 组（回填）、第 [14] 组（「不提醒」不回填不进候选）；
  `test-reorder.js` 第 [23] 组（授权条件 / `leadMin` 只算在有提醒时间时 / 本地镜像）。
- **变异验证**：`.workbuddy/tmp/mutate-lead.js`，**19/19 符合预期**（18 红 + 1 对照组绿）。
  其中「回填判据 `leadMin` ↔ `pushAt`」那条变异**已被证伪并删除**（理由见上）。
- **部署**：`FN_VER` 7 → 8；`fq_items` 的提醒索引从 `remindAt` **改建到 `pushAt`**；
  ⚠️ **`fqRemind` 必须单独重新部署**（不在 action 清单里，握手管不到它，旧包**一条都不发**）。

## 二、首屏种子

`bootstrap` 发现**当前家庭**分类数为 0 时写入「工作 / 生活」+ 5 条示例事项（含一条「明天 09:00」提醒）。
分类 id 由数据库生成，种子事项挂在「工作」下，都带 `fid`。（老用户走「认领」分支，不走播种。）

---

## 三、部署

点「编译」**只编译小程序端**。云函数必须手动右键 → **上传并部署：云端安装依赖**。
现有**两个**云函数：`fqTodo`（数据出口）与 `fqRemind`（提醒推送）；
⚠️ **`fqRemind` 还要额外右键点一次「上传触发器」** —— 只「上传并部署」不会带上 `config.json` 里的
定时触发器，表现为「提醒永远不发、而且一点报错都没有」。
新环境要先建 **6 个集合**（见 §一 1.2），权限都设「仅创建者可读写」
（注意这条对云函数无效，真正的防线是 `MEMORY.md` §八 8.1 的 `fid` 铁律）。
⚠️ 改提醒链路还要**改建 `fq_items` 的提醒索引**（v8 起是 `pushAt`，见 1.4.1）。

**同一个坑有两种长相，别搞混：**

| 现象 | 含义 |
|---|---|
| 报「云函数 fqTodo 尚未部署」 | 云端**根本没有**这个函数 |
| 报「未知 action: reorder」（或别的已实现的 action） | 云端有函数，但跑的是**旧包** |
| 首屏弹窗「云函数版本过旧」 | 云端没上报 `fnVer` 或版本不等 → 同上，主动预警 |

**判断「旧包」还是「真 bug」**：跑 `test-cloudfn.js`。它绿 → 代码是对的，问题只在部署。

## 四、发布

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

## 五、无 IDE 自检工具明细

```bash
node .workbuddy/tools/check-all.js
```

一串 **11 步**，末尾汇总「全部通过 / 有 N 项未通过」：

| 工具 | 规模（2026-10-13 v8 实测） | 覆盖 |
|---|---|---|
| `arch-check.js` | **469** class / **314** 选择器 / 15 份 wxss | **重构等价性**：展平组件后比 class 序列（多重集 + 位置）+ 跨全部 wxss 的「选择器→声明体」映射 |
| `event-check.js` | 组件 13 / 出口 15 / 页面 bind 18 | 事件接线五条：组件自带 / 页面自带 / **出口闭合** / **取值形状** / 同名同形 |
| `component-audit.js` | 13 个宿主 | **组件解析**：标签注册 / 四个文件齐 / `component:true` / 文件名同名 / WXML 标签配平 |
| `mp-check.js` | class 215 / WXSS 221、data 14 作用域 / 119 键 | class 契约（全局）、data 契约（按目录）、结构配对、**固定头部契约** |
| `class-collision.js` | 页面级选择器 **79** 个 | 图标内部 class 与页面级 class 重名 |
| `test-reorder.js` | **24 组 / 360 条** | 页面逻辑：拖动 / 左滑 / 排序模式 / 拖动竞态 / 起动闸与位移量化 / 视图层静态约定 / 自动滚 / 版本握手 / 同步避让 / 家庭视图 / 分类管理 / 提醒推送契约 / **提前量的本地镜像** / 一屏装满 + **悬浮按钮的落点** |
| `test-cloudfn.js` | **22 组 / 277 条** | 云函数 fqTodo：reorder / 越权 / 家庭与邀请码 / 老数据认领 / rev 同步 / 分类删改与分权 / 订阅额度 / 推送状态 / 进度耦合 / **提前量白名单与 `pushAt` 预算** / 种子 / 握手 |
| `test-remind.js` | **14 组 / 129 条** | 云函数 fqRemind：去重（含并发）/ 额度不足 / 窗口与迟到边界 / 五槽位 / 北京时间 / 跨用户跨家庭 / 触发器配置契约 / **按 `pushAt` 扫描 + 三份白名单比对** / **老数据回填** |
| `test-water.js` | **5 组 / 36 条** | 今日饮水：吸附 / 夹紧 / 事件时机 / 去重 / observer 夹紧 + 页面侧存储与跨天契约 |
| `test-sched.js` | **17 组 / 193 条** | 日程：42 格月历排布 / 跨月跨年闰年 / 本地时区（不走 UTC）/ 今天-明天标签 / 圆点与列表同口径 / 计划卡与保存 / adoptPlans 容错 / **页眉固定今天** / 接线契约 |
| `fake-cloud.js` | — | 上面两份云函数测试**共用**的假 `wx-server-sdk`（内存库 + `db.command` + **`_.exists`** + 云调用记录） |

- **`mp-check` 的两处白名单别忘**：新视图（如 `sched`）是 `view` 的状态值，
  要同时加进 `ROOT_WHITELIST` 与 `CLASS_WHITELIST`，否则会报「WXML 用到但没有任何 WXSS 规则」。
- **`mp-check` 匹配前会先剥 WXML 注释**（2026-10-09 补）：`rootsInWxml` 与 `classesInWxml` 都加了
  `stripWxmlComments`。补之前不剥，于是「说明注释里抄了一句插值语法」会被当成真引用，
  报出一个**根本不存在的**错。反过来更危险（注释满足掉一条该报的检查），两头同一病根。
  写注释时仍然别抄「已经不存在的标识符 / 插值片段」—— 这个检查器剥了，别的 grep 式检查未必剥。
- **`arch-check` 的 class 提取不需要剥注释**：`wxml-flatten.js` 摊平时每个文件都先剥过一遍，
  守卫在摊平器那一侧。在 `classTokens` 里再加一遍是**装饰**（2026-10-09 一度加过，
  靠「删掉摊平器那句 → 同一份注释立刻让它报计数变了」这条反向对照才认出是冗余）。
- **变异验证器**：`.workbuddy/tmp/mutate-sched.js`、`mutate-bugfix.js` 是可抄的模板
  （改一处 → 跑测试 → 必须变红 → 还原），含一个「只改注释」的**对照组**：对照组也报红就说明验证器在瞎报。
  两个必须做到的点：① 每条变异先**核对变异点命中**（源码里找不到那段 = 脚本写错了，不是「通过」）；
  ② 验「检查器有没有剥注释」这类改动，**正/反向必须成对做** —— 只删守卫而不在源码里放地雷，会得到假的绿。

- 辅助工具：`wxml-flatten.js`（组件就地展开 / `allWxss()` / `clientJs()` 一律**遍历目录**，不写死文件名）、
  `mk-component.js`（按清单机械搬段；**所有区间都是同一份原文上的坐标，必须收集齐再统一从后往前切**）。
- `mp-check.js` 第 4 条断言 `dhead`/`filters`/`sortrow` **不在** `.scroller` 区间内。
- 两份仿真测试都**加载真实源码 + 假环境**跑真实方法，不复制逻辑。
- **`test-reorder.js` 桩的五个必踩坑**：
  ① **`select` 与 `selectAll` 返回结构不同**（单点 `res[0]` 是 rect，批量 `res[0]` 是 rect 数组）——
     写错会让页面一直走降级分支而测试仍绿。**降级路径要有正反两组断言。**
  ② 异步生效的东西要能「挂起 + 手动 flush」（`setTimeout` 桩成可 flush；`createSelectorQuery`
     要能选「回调迟到」，否则竞态类断言永远绿）。
  ③ 假滚动区要会**夹取** `scrollTop`（`SC` + `flushScroll()`），夹取才能体现「滚到底」。
  ④ ⚠️ **结算点只有一个，在 [19] 的 promise 链尾**（`finish()` 带一次性闸门）。
     ⇒ **写进 `.then` 里的断言根本轮不到执行** —— 那份 promise 排在 [19] 之后，
     `finish()` 已经 `process.exit` 了。这种断言不报错、不失败、也**永远不会红**，
     比没有断言更糟（它会让你以为守住了）。**要断言异步分支，就走 [18]/[19] 那种「在链尾
     结算」的写法**；做不到就别写，改成静态断言并把原因写进注释。
  ⑤ **变异验证里的「排序类」断言要用顺序相反的夹具**：`[9]` 组原来三条夹具的 `pushAt` 与
     `remindAt` **同向递增**，于是把 `orderBy` 改回 `remindAt` 也得到相同顺序 —— 断言是摆设。
     改成两字段顺序相反（A 的 `pushAt` 最早、`remindAt` 最晚）才守得住。
     **同理**：夹具的默认值别贴着边界（`test-remind` 的 `pushAt` 默认取 `Date.now()`，
     别由 `remindAt - 10min` 折算 —— 那会恰好落在 `LATE_MS` 边界上，偶发失败）。
- **CommonJS 测试脚本不能有顶层 `await`**（`ERR_AMBIGUOUS_MODULE_SYNTAX`）；排空微任务用
  `new Promise(r => setImmediate(r))`，**别连写几个 `Promise.resolve().then`**。
- `wx.showModal({editable:true})` 的返回值是 **promise**，手工调 `success()` 只是 resolve；
  桩 `wx` 上必须补 `canIUse`。
- 源码有四种来源，断言前先问「我在断言什么」（写在 `test-reorder.js` 顶部）：
  `PAGE_JS`（页面方法）/ `CONST_JS`（协议常量）/ `CLIENT_JS`（页面+utils+services，断言「客户端**没有**做某事」用）/
  `PAGE_WXML`（摊平后的页面，断言「页面长什么样」用）。
  **别为了让断言变绿而把 `CLIENT_JS` 换成 `PAGE_JS` —— 那正好把覆盖面砍掉。**

---

## 六、拖动引擎实现要点（从 `MEMORY.md` §九 迁出）

> 引擎在 `utils/drag.js`，完整推导在 `MEMORY-ARCHIVE-2026-10-01.md`。
> `MEMORY.md` §九 只留手势契约——**这一节是"改拖动前必读"**。

- `render()` **故意不重置 `sortMode`**（落库走 `commitOrder→commit→render()`）；改在
  `onTab/onOpenQuad/onBack/onGotoMine` 里 `exitSort()`。
- **抖动只在点「调整顺序」那一刻**：`data.sortPulse` 置 true、380ms 后摘。动画只能加在 `.tx` 上
  （加 `.row-in` 会和跟手位移的内联 `transform` 打架），**不能挂 `sortMode`**（那状态整段为真）。
- **异步量行位置必须设双重闸**：`_dragSeq` **惰性自增**（`++undefined` 得 NaN，仿真不走 `onLoad` 会全判过期）
  + `_dgP` 在途闸（`measureRows` 异步期间 `_dg` 还空，`onRowMove` 每个 touchmove 都再喊一次 `startDrag`）。
  漏清 = **僵尸拖动**：此后每次 touchmove（含正常滚动）都被 `applyDragMove` 接管 →「滑动时卡片乱跳、滑到的块消失」。
  ⚠️ 只在真机复现，必须把测量改成排队（第 22 组）。
- **跟手位移量化 + 去重**：`dragY` 出现在每一行 style 里，touchmove 能到 60~120Hz → `Math.round` 成整数 px
  + `dg.pushedY` 去重。`onRowStart` 不要推 `dragging`（要与第一帧位移同时到场）；`.row-in.lift` 加 `will-change:transform`。
- **两条 setData 通道别合并**：`dragY`（每帧一个数字）+ `shift`（跨行中线才整表 setData）。
- 行位置拿起时量一次，之后**只按 `bindscroll` 的滚动量整体平移**（`_dg.rects[i].top -= d`），不再重查。
- **拖到边缘自动滚**三个不能省的细节：① `measureScroller()` 量不到就 `_scBand=null` 降级不滚；
  ② 卡片屏幕位置 = `dg.base0 + (clientY-_dgY0) - rects[from].top`（**别把 `clientY` 当位移累计**）；
  ③ 滚到顶/底要**下一拍**才判 `that._scrollTop === dg.asPending`（`bindscroll` 异步回来）；
  手指移动 >4px 清 `asDirDone/asPending`。定时器 `setTimeout` 自串；`endDrag/exitSort/onRowEnd` 都要 `stopAutoScroll()`。
- `onSortToggle()/exitSort()` 都要清 `_dg` + `_drag`；`onRowEnd` 排序分支还要清 `dragId/dragY`。
- `onRowStart/Move/End` **留在页面**（左滑/拖动/滚动三者共同入口）；拖动中的卡片挂 `.row.liftrow`。
- **`onRowMove` 节流基准取这一行自己的位移**：`const prev = data.swipeKey===this._drag.id ? data.swipeX : 0`。
- 已完成样式只有两件事：标题 `line-through` + `.row-in` 的 `opacity:0.5`。**不要再动左侧色条**（用户明确要求）。

### 6.2 左滑操作组：只有 2 个动作，且「滑开才渲染」

- 渲染条件 `wx:if="{{!sortMode && swipeKey===item._id}}"` —— **`swipeKey` 就是渲染闸门**。
  **要「看不见」就别渲染，不要靠遮挡**（遮挡只在静止时成立，卡片一 `translateY` 就露馅；已完成行 `opacity:.5`
  还会直接透出来）。排序模式整组不渲染，并给 `.row` 挂 `.sorting{background:transparent}`。
- 已完成行左滑是**实的**（撤销 / 删除），共用 `data-act="done"`，云函数不必新增 action。
- **「收起」必须是真收起**：位移不到 45% 阈值就把 `swipeKey` 一并清空（`open ? id : ''`）。
- **`onRowMove` 节流基准取这一行自己的位移**：`const prev = data.swipeKey===this._drag.id ? data.swipeX : 0`。

## 七、UI 像素级诊断手法（从 `MEMORY.md` §十三 迁出）

量法：① 目标色包围盒（判等分）；② 逐行像素计数（找水平线/越界）；③ 裁切放大 4~8 倍肉眼看；
④「逐列主色 + ROI 逐行字符画」定位小图标偏心。先算 **1rpx = 截图宽 ÷ 750**。

**没有 PIL 也能量**：临时写纯 Node 的 PNG 解码器（`zlib.inflateSync` + 逐行反滤波，~60 行）输出逐行深色像素剖面；
判据见 `MEMORY.md` §2.5。⚠️ 先裁掉手机边框/刘海列，否则深色像素污染剖面。

**Edge 无头截图的坑**：截图是**异步落盘**的（命令返回后文件可能还没写完，要 sleep 再查存在性）；
headless 的 `innerHeight` **比 `--window-size` 小 139px** —— 要精确模拟机型高度，
用 `.screen{position:absolute;height:Npx}`，别依赖窗口尺寸。

### 7.3 界面整块空白的排查顺序（原 `MEMORY.md` §2.5）

场景：`arch-check` 绿 + `event-check` 绿 + 仿真全绿，**矩阵仍空白**。按序查：

① **先分清「没渲染」还是「渲染了但不可见」** —— 量**下面**那个元素被推到哪
   （紧贴上方 = 该块高度 0 = 没产出 DOM）；
② **数据**：假沙箱跑真 `index.js`，dump `render()`；
③ **解析**：跑 `component-audit.js`；
④ **构建态**：以上全绿就怀疑**开发者工具的增量编译** —— 热重载对**新增组件目录**经常只更新半边，
   页面引用了新标签而注册表还是旧的 → 未知标签渲染成空节点 = 整块空白，**磁盘上查不出任何问题**。
   **解法：全量「编译」(Ctrl+B) → 「清缓存 → 全部清除」 → 重启工具。**

## 八、日程版块（v6，2026-10-09）

### 8.1 为什么手写日历（三方案实测对比）

用户问过「有没有现成日历组件」——结论是**手写**，依据：

| 方案 | 结论 |
|---|---|
| 官方内置 `calendar` 组件 | **不存在**。网传「基础库 2.25.0 起有 calendar」是错的，官方组件索引（视图容器/基础内容/表单/Skyline/导航/媒体/地图/画布/开放能力/原生组件/无障碍/导航栏）里没有它 |
| `picker mode="date"` | 可靠，但只是**滚轮选择器、无圆点标记** —— 而圆点正是设计稿的核心价值 |
| 第三方（Vant Weapp `calendar` / wx-calendar） | 要引入本项目**没有的 npm 构建链**（`package.json` / `miniprogram_npm` / `node_modules` 全无）+ 包体积膨胀（当前 ~143 KB、零图片） |

自绘成本约 150 行**纯函数**日期运算，可单测。

### 8.2 `fq_plans` 与 `savePlan`

- 字段 `{ fid, _openid, date, text, updatedAt }`；唯一键 `(fid, _openid, date)` —— **按人存**。
- `MAX_PLAN = 300`（云函数）↔ `PLAN_MAX`（`utils/const.js`）**成对**，客户端 `textarea maxlength` 读后者。
- `toDate()` **字符级**校验 `^\d{4}-\d{2}-\d{2}$`：日期是唯一键，放过 `2026-10-9` 会存出两条记录。
- **upsert 语义**：空文本 = 删除；**内容没变就不写**（避免 `rev` 无谓自增引发全端轮询同步）。
- `bootstrap` / `sync` 都返回 `plans`；`plansFor()` **必须带 `_openid` 过滤**，否则会看到家人的计划、
  且两边用同一个日期键 upsert 打架。
- `clearAll` 只删调用者自己的 plans，返回值多了 `plans` 计数。

### 8.3 客户端结构

- 新组件 `fq-cal`（月历，props `label`/`cells`/`attoday`，出口 `prev`/`next`/`today`/`pick`）
  与 `fq-plan`（计划卡，props `kind`/`label`/`dateShort`/`text`/`placeholder`，出口 `edit`）。
- 页面 `buildCal()` 生成 42 格（含上月尾/下月头，`lead=(getDay()+6)%7`）、`buildSchedRows()`（按 `remindAt` 取当天事项）、
  `buildPlan(date, which)`、`buildCalLabel()`。
- `adoptPlans(list)` **整体重建** `this.plans`（服务端删除要能传过来），且 `if (!list) return` 兼容旧云函数。
- `checkWaterDay()` 顺带在 `sched` 视图重渲染（跨零点时"今天"环和文案要滚），但**不动 `schedDate`**。
- `shiftMonth(n)`：选中日若落在新月之外，落到 `next + '-01'`。

---

## 九、尺寸与样式全文（从 `MEMORY.md` §四 迁出）

> `MEMORY.md` §四 只留「最会咬人的几条」，**动手改 CSS 前来这里读全文**。
> 全部 13 条都是「就差几像素」的坑，且都用截图像素测量定位过，不是猜的。

1. **设计稿 px × 2 = rpx**（设计稿画布 375px）；**1rpx = 截图宽 ÷ 750**。
2. **固定高度写在两处，必须成对改**：`index.wxss` 顶部常量表 ↔ `utils/const.js` 的 `LAYOUT`
   （导航 88 / 分类条 88 / 统计条 112 / Tab 120 / 底栏 134）。拖动也成对：`ROW_GAP 16` ↔ `.row{margin-bottom}`；
   `SWIPE_W 240` ↔ `.rowacts .act` 宽 120×2。
3. ⚠️ `app.wxss` 全局 `box-sizing:border-box` → 所有 `height` 都是**含 padding 的总高**。
4. 底部定位靠 **flex 自动分配**（主体 `flex:1;min-height:0`）。**禁止用 JS 算滚动区高度**
   （Android 的 `screenHeight` 含虚拟导航条，算偏就把 Tab 顶出屏幕）。
   ⚠️ 自 2026-10-09 起 `LAYOUT` **一个常量都不参与运行期计算**（`TAB_H` 原是给悬浮按钮算 `bottom` 的，
   那个按钮已挪进矩阵容器、偏移量成了常数）。
   **凡是「算出来的 px」都值得怀疑：先问能不能改成 flex + 常数偏移。**
5. **安全区不能与固定 `height` 同元素**：border-box 会把 `padding-bottom:env(safe-area-inset-bottom)` 从 `height` 里抠掉。
   高度写 `.tb`(120rpx)、安全区加在 `.tabbar`。无固定高度的 `.bottombar`/`.sheet-foot` 直接加 padding 是安全的。
6. **flex 间距一律 `margin-right` + `:last-child{margin-right:0}`**（旧 Android WebView 的 `gap` 不可靠）；
   `gap` 只留给 `display:grid`。
7. **要等分就必须清 `min-width:auto`**：`1fr` = `minmax(auto,1fr)`，会被 nowrap 长文本顶宽 ——
   所有需要收缩 / 省略号的 flex、grid 子项都要 `min-width:0`。
8. **自绘图标改尺寸必须连 `flex-basis` 一起改**；伪元素定位用 `calc(50% - 2rpx)`，别写死 rpx。
9. **单行垂直居中用 `height` + 等值 `line-height`**；**flex item 被 `stretch` 拉高后内容默认贴顶**，
   要居中得自己写 `flex-direction:column;justify-content:center`（`text-align:center` 只管左右）。
10. **flex 容器不能放在 `scroll-view` 自己身上**（`enable-flex` 靠不住）：会被 `overflow:hidden` 削掉顶部约 26rpx，
    正解是内套一层。**要让它作为 flex 子项横向滚动，必须给 `min-width:0`**。
11. **纵向 flex 容器别用 `max-height` 当高度**（主轴尺寸不确定时 flex 不分配空间，内容会溢出盖住底部按钮）。
    抽屉让「主体自己封顶」：`.sheet-body{max-height:calc(88vh - 330rpx - env(safe-area-inset-bottom))}`。
12. **不要给滚动容器里「静止的元素」挂 `transform` 或裁剪**：会被提升成独立图层，长列表滚动时新暴露区域来不及
    重绘 → 「整块不绘制」的白洞（数据 / 高度 / 占位全对，静态检查抓不到）。位移改**条件渲染**（静止写 `none`）；
    裁剪只挂真需要的那一行（`.row.sw`），`.row` 不得常驻 `overflow:hidden`。
13. ⚠️ **共享控件只定「规格」，策略留给宿主**（v7 新增）：`.wtrack/.wbar/.wfill/.wknob` 从 `fq-water.wxss`
    上提到 `app.wxss` 后，`touch-action` 与 `overflow` **一律不写** —— 前者在长列表里造成「按着滑不动」的死区，
    后者会裁掉圆点在 0% / 100% 时「到头了」的悬空提示。
    **同类控件的第二份样式出现时立刻上提 + 参数化**，否则迟早出现「两处各自漂移」这种谁都不报错的错。

---

## 十、象限色与图标细则（从 `MEMORY.md` §六 迁出）

`app.wxss` 定义 `--q1..--q4`，`.q1/.q2/.q3/.q4` 把 `--qc` 指向对应色
（q1 `#d9303c` / q2 `#9e6c00` / q3 `#c04e18` / q4 `#6b7280`）；色块、左侧色条、详情页底色、进度条填充
都读 `var(--qc)`。⚠️ `--qc` 已是**通用设施**（日程页的事项行也读 `var(--qc, var(--ink3))`），
四色只允许存在于 `app.wxss`。**不要**用属性选择器 `[data-q="q1"]`（WXSS 支持不稳）。
四色对比度 ≥4.5:1（WCAG AA），改色必须重算。

**不用 `<image>` 加载本地 `.svg`**（Android 不可靠）。两条路线（**都在 `app.wxss`**）：
① **CSS 自绘** `ico-grid/list/user/chev-l/chev-r/check/undo/plus(.big/.sm)/trash/dots/sliders/sort/drag/cal`；
② **内联 SVG data URI**（`#` 写 `%23`，颜色**烧进 URI**——`background-image` 不吃 `currentColor`）：
火焰 / 闪电 / 灯泡 / 咖啡杯 / 太阳 / 月亮。

- `ico-drag` **必须写在 `.ico{display:block}` 之后**（同权重单类靠先后定胜负）。
- `ico-undo` 占位 28rpx 与 `ico-check` 的**逐像素相等** —— 同按钮两态占位不同会跳。
- `ico-trash`/`ico-cal` 是「一个元素 + 伪元素」，**零内层 `<view>`**（旧那个 `class="body"` 撞页面级 `.body`，
  border-box 下把 22rpx 桶身撑到 ~70rpx、偏右 21rpx）。
- ⚠️ **图标内层 class 不得与页面级重名**；零件一律「显式 `width` + `left:calc(50% - w/2)`」。
  上线前跑 `class-collision.js`（只认「单类名、无组合符」的页面级规则 → 组合选择器 + 前缀命名都安全）。

---

## 十一、事项进度条实现细则（v7，从 `MEMORY.md` §十 迁出）

> `MEMORY.md` §十 留的是**不变量**；这里补「代码长什么样、为什么这么写」。

- **共享块上提**：`.wtrack`(触区 48rpx) / `.wbar`(轨道 14rpx) / `.wfill` / `.wknob`(圆点 32rpx)
  + `.wtrack.on`（抓取反馈：轨道加深 + 圆点放大 1.24×）全在 **`app.wxss`**；颜色靠 `var(--wt)` 注入，
  共享资产**不认识任何具体颜色**。`fq-water.wxss` 只剩 `.water .wtrack{margin-top; touch-action:none}`
  与 `.water.full` 的两条深蓝覆盖；`index.wxss` 只剩 `.prog` / `.prog.full` / `.prog .wtrack` / `.rpv` 四条。
- **`w` 前缀是历史**：这套类最早长在饮水卡（water）里，上提时保留了原名。改名要同时动 `fq-water` 的 wxml
  与两个 wxss，而买不到任何东西 —— 这几个类名在全局是唯一的。
- **饮水卡那边只挪了一个 class**：`.wdrag` 由 `.water` 挪到 `.wtrack` 上（`class="wtrack {{wdrag ? 'on' : ''}}"`），
  于是抓取反馈由共享块统一提供。`test-water.js` 有一条断言专钉这个字符串。
- **客户端读点只有一个**：模块级 `itemPct(it)`（`progress` 缺失回落 `done ? 100 : 0`）；`rowVM` 给它挂 `pct`
  与视图态 `pgOn`。
- **手势状态 `this._pg`**：`onProgStart` 建、`onProgMove` 用、`onProgEnd` 清（`onRowStart` 与 `render()` 也清 ——
  切视图 / 弹抽屉 / 换手势都不能把它漏下去）。字段 `{id, x0, y0, dx, dy, armed, rect}`。
- **拿起判据**：位移 > 5px **且** `|dx| > |dy|` 才 `armed`，拿到才给抓取反馈（不在 touchstart 就给 ——
  否则每次「落在进度条上往下滑列表」都会先闪一下放大）。
- **两种「没拖动」的分辨**（`onProgEnd` 里 `!armed` 分支）：位移 ≤6px → 视为「点一下」，圆点跳到手指处；
  否则是在这一条上往下滑列表，**绝不能顺手把进度改掉**。
- **`measureTrack` 一次手势只量一次**（`select('#rpt-'+id).boundingClientRect(fn).exec()`）：
  每帧都量等于每帧一次视图层往返，拖动会肉眼可见地滞后。
- **`progPath(id)` 只认当前视图那一棵数据树**（`rows[i]` 或 `sections[j].rows[i]`），扫两棵会在
  切视图那一瞬改错一棵。`paintProgress` 与 `setRowFlag` 都走它。
- **`setRowFlag` 不进镜像**：`pgOn` 是纯视图态，`render()` 重建行数据时会被 `rowVM` 复位成 `false` ——
  这是一层免费的兜底，任何中断都不会让它粘住。
- **构建期没有新增 action**：协议版本 +1 但没有 `WRITE_ACTIONS` 变化（进度条走的是既有的 `updateItem`）。
- **测试位置**：`test-cloudfn.js` 第 [21] 组（24 条，耦合与夹取/取整/非数字/矛盾输入 + 全集合不变式扫描）；
  `test-reorder.js` 第 [22] 组（51 条，读写口径 + 手势契约 + 两棵数据树的路径 + 纵滑让路）。
- **像素验收**：`.workbuddy/tmp/final-progress.html`（1rpx = 1px 复刻页 + 页内 18 项自审计 + `#audit` 大字号页）。
  实测：轨道宽 560rpx、圆点圆心与 pct% 偏心 0px、卡片高 199.2rpx（对照组 137.2，差 62 = 48 + 14）、
  完成绿 `#12a150` 对白 3.4:1（够图形 3:1、不够正文 4.5:1）。

---

## 十二、排序语义全文（从 `MEMORY.md` §八.3 迁出）

> `MEMORY.md` §八.3 只留两条最会咬人的；**改 `reorder` / 拖动落库前来这里读全文**。

- **粒度是「象限 × 分类」**：重排只影响当前分类下、同一个象限里的事项。别的分类（甚至别的象限）
  即使 `order` 撞值也不影响显示，因为它们从不会同时出现在一个列表里。
- **落库是整段重写 `0/10/20…`**（`ORDER_STEP = 10`），只把 `order` / `quad` **真变了**的行发给 `reorder`
  （一次拖动通常只写 3 条左右）。
  ⚠️ **不要改成「相邻取中值」** —— 反复拖动会把浮点间距耗光；整段重写结果确定，人工在控制台里也一眼看得懂。
- **筛选下只重排可见项**：`visibleIdx(full)` 把可见下标映射回完整下标再 splice。
- **跨象限拖只发生在「全部」页**：`.row` 的测量顺序必须与 `flatList()` 一一对应（对不上就放弃本次拖动）。
  各行高度不一，跨段**不做让位动画** —— 改为整段高亮 + 「松手移到这里」，松手后 `quad` 跟着改、
  源 / 目标两个象限一起重排。
- **换位判定留容差 `EPS = 0.5`**：拖到最上 / 最下一档时，卡片中心正好等于首 / 尾中线，不留容差就判不出来。
- 新建事项用 `order: Date.now()`（天然最大 → 排到象限末尾）。

---

## 十三、组件分层全文（从 `MEMORY.md` §二 迁出）

> `MEMORY.md` §二 只留结论与最常咬人的一条；**动手加 / 改组件前来这里读全文**。

**13 个展示型组件**（以 `index.json` 注册表为准）+ `utils/{const,format,drag}.js` + `services/cloud.js`。
已抽：`appbar stats fab sortdone bottombar tabbar` + `dhead cats quad filters` + `water` + `cal plan`（日程）。
**剩 2 个**：`fq-mine`、`fq-sheet`（`fq-mine` 动手前先 **hoist**：`.mecard*`/`.func*` 是「我的」页与抽屉**共享**的）。

### 13.1 两条硬约定（每个组件 js 头部都写了）

- **`options.virtualHost: true`** —— 组件不产生额外节点。**必须**：`.screen` 是纵向 flex，固定块靠
  `flex:0 0 auto` 占高度；组件一旦成为真实 flex item，布局就靠运气了。
  ⚠️ 推论：**组件根节点会「上浮」成宿主的子节点** —— 绝对定位参照系、`:first-child` 都按这一条算。
- **`options.styleIsolation: 'apply-shared'`** —— `app.wxss` 的共享资产（`.ico-*`/`.qmark`/`.btn*`/`.lock`/进度条）
  才进得来。官方：「除继承样式外，`app.wxss` 中的样式对自定义组件无效（除非更改组件样式隔离选项）」。**实测有效**。
  可继承的东西（`page` 上的 `--q1..--q4`、标签选择器 `box-sizing`）本来就能穿透。

### 13.2 数据与事件

- 数据只走 **properties**（`type:null` 不限类型）；交互只走 **`triggerEvent`**；不碰 `wx.cloud`、不读写页面实例。
- ⚠️ **组件内 handler 保留页面原方法名** —— WXML 是**逐字搬来**的（连 `bindtap="onX"`），不该反过来改 WXML 迁就 js。
- **出口统一 `triggerEvent('x', e.currentTarget.dataset)`，页面读 `e.detail.*`**（形状统一，`event-check` E 管）。
  页面 handler 若被内部复用（如 `onPickCat`），则两边都认：
  `e.detail && e.detail.k !== undefined ? e.detail.k : e.currentTarget.dataset.k`。
- 组件**可以不收任何入参**（`fq-fab`）：位置/尺寸全是常数时，空 `properties` 比「留个页面算好再传下来」更诚实。

### 13.3 ⚠️ 组件化制造的静默故障（全都不报错）

| 故障 | 现象 | 守卫 |
|---|---|---|
| WXML 里的方法名与 js 对不上 | **点了没反应**（Batch 1 一次造出 5 个） | `event-check` A/B |
| 页面 `bind:x` 与出口不闭合 / 取值形状不对 | 没反应、拿到 `undefined` | `event-check` C/D/E |
| 标签没注册 / 切片切坏 | **整块安静地变空白** | `component-audit` |

**每加一层间接 / 一类文件，都要问「哪条既有检查现在成了盲区」。**

### 13.4 刻意不抽的边界

- **`fq-sortbar` 不抽**：`.screen.detail-mode .swipecue` 是跨越组件边界的后代选择器
  （官方警告「极端情况下会有非预期的表现」）。
- **`.row` 事项卡片不抽**（用户拍板）：与左滑 / 拖动 / 滚动 / 进度条绑得太紧。
