// miniprogram/utils/format.js
// 纯函数：日期时间格式化、提醒文案、邀请码归一化。
//
// 共同点：**入参出参，不碰任何状态**。所以它们可以脱离页面单独推理，
// 也是这个项目里唯一适合抽出来复用的部分（组件化之后多个组件都要格式化日期，
// 留在页面里就得靠 apply-shared 蹭页面的方法，那就白分层了）。
//
// 约定：全部按**手机本地时区**解释日期。云端那边（fqRemind）是另一套
// 「固定 +8 偏移」的算法，因为容器时区不可信 —— 两边的取舍不同，别互相抄。

const { WEEK } = require('./const.js');

/* ---------------- 基础 ---------------- */

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

/* ---------------- 提醒时间 ---------------- */

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

// 表单里选完日期后那一行短文案。只关心「今天 / 明天 / 后天 / 具体日期」，
// 不显示时分（时分已经在旁边的 picker 里了）。
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

/* ---------------- 日期（日程版块用） ---------------- */

// 'YYYY-MM-DD' → 本地零点的 Date。
// 手动拼，不用 new Date('2026-10-09')：那种写法在 iOS 上按 UTC 解释，
// 东八区会整体退一天（10 月 9 日变成 10 月 8 日 16:00），日历会整体错位一格。
function parseDay(dateStr) {
  const p = String(dateStr).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

// 本地今晨零点。日程里所有「差几天」的比较都以它为基准。
function today0() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// 加/减天数，回 'YYYY-MM-DD'。
// 用 Date 自己做进位，不手算月份天数 —— 闰年、跨月、跨年它都管。
function addDays(dateStr, n) {
  const d = parseDay(dateStr);
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 选中日相对今天差几天：0 = 今天，1 = 明天，-1 = 昨天。
// 以「两个本地零点」相减而不是拿当前时刻直接减，否则同一天不同时刻会算出 ±1。
// round 是刻意的：中国没有夏令时，但这条写法不依赖那个前提。
function dayDiff(dateStr) {
  return Math.round((parseDay(dateStr).getTime() - today0().getTime()) / 86400000);
}

// 'YYYY-MM-DD' → 'YYYY-MM'（月份的键）
function ymOf(dateStr) {
  return String(dateStr).slice(0, 7);
}

// 'YYYY-MM' → '2026 年 10 月'
function monthLabel(ym) {
  const p = String(ym).split('-');
  return Number(p[0]) + ' 年 ' + Number(p[1]) + ' 月';
}

// '10/9' —— 计划卡右上角那个小日期
function mdShort(dateStr) {
  const d = parseDay(dateStr);
  return d.getMonth() + 1 + '/' + d.getDate();
}

// '10月9日 周五'
function dateCN(dateStr) {
  const d = parseDay(dateStr);
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
}

// 毫秒时间戳 → 'YYYY-MM-DD'（**本地**那一天）。
// 日程要拿它把带提醒的事项按天归堆。不能用 toISOString()：
// 那是 UTC，东八区晚上 8 点之后的时间戳会被算到第二天去，
// 于是「今晚 21:00 的提醒」会跑到明天的格子里。
function dayKey(ts) {
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 毫秒时间戳 → 'HH:MM'。日程列表右槽那个短时刻。
function hhmm(ts) {
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// '今天 / 明天 / 后天 / 这一天'。凡是「指代某一天」的短文案都走它，
// 免得每处各写一遍 if —— 日程的两张计划卡就是靠它把「明天」这个词说准的。
function dayWord(diff) {
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return '这一天';
}

// 两张计划卡的标题。
// 为什么按差值推、而不是写死「今天 / 明天」：日历能选任意一天，写死的文案
// 在选中 10月15日 时照样显示「今天要做什么」—— 一个不报错但会让人读错的谎。
// 过去的日子再给一套「做了什么」，时态才对得上。
function planLabels(diff) {
  if (diff === 0) return ['今天要做什么', '明天准备做什么'];
  if (diff === 1) return ['明天要做什么', '后天准备做什么'];
  if (diff === -1) return ['昨天做了什么', '今天要做什么'];
  if (diff < 0) return ['这天做了什么', '次日做了什么'];
  return ['这天要做什么', '次日准备做什么'];
}

/* ---------------- 邀请码 ---------------- */

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

module.exports = {
  pad2: pad2,
  todayStr: todayStr,
  todayMeta: todayMeta,
  remindText: remindText,
  remindDayShort: remindDayShort,
  toTimestamp: toTimestamp,
  parseDay: parseDay,
  addDays: addDays,
  dayDiff: dayDiff,
  dayKey: dayKey,
  hhmm: hhmm,
  dayWord: dayWord,
  ymOf: ymOf,
  monthLabel: monthLabel,
  mdShort: mdShort,
  dateCN: dateCN,
  planLabels: planLabels,
  normCode: normCode,
  inviteLabel: inviteLabel,
};
