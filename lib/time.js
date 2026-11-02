/**
 * 统一时区工具 —— 所有"给人看的时间"一律用北京时间。
 *
 * 为什么需要它：
 * GitHub Actions 的 runner 时区是 UTC（日志已验证：本地时间 == UTC 时间戳），
 * 代码里若直接用 new Date().getHours() / toLocaleDateString('zh-CN')，
 * 在 CI 上判断/显示的都是 UTC 时间，比北京时间慢 8 小时。
 * 典型事故：activeHours [8,24] 在 runner 上过滤的是 UTC 8–24 点 = 北京 16:00–次日 08:00，
 * 导致北京早上 8 点的定时查询被"不在生效时段"跳过。
 *
 * 用法：
 *   const { beijingHour, dayKey, beijingNowText, fmtBeijing } = require('./time');
 *   beijingHour()            // => 8   （0-23 整数，北京当前小时）
 *   dayKey()                 // => '2026/11/02'（北京日期键，日报去重用）
 *   beijingNowText()         // => '2026/11/02 09:30:00'（日志时间戳风格）
 *   fmtBeijing(date)         // 同上，格式化任意 Date
 *   beijingLabel(date)       // => '11/02 09:30'（图表 X 轴短标签）
 */

const TZ = 'Asia/Shanghai';

/** 北京当前小时（0-23 整数） */
function beijingHour(now = new Date()) {
  // en-GB + hour12:false 输出 "08" 这种两位小时，24 点输出 "00"（en-GB 的 24 小时制午夜是 00）
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false,
  }).format(now));
}

/** 北京日期键（YYYY/MM/DD），供「每天只发一次报告」去重 */
function dayKey(now = new Date()) {
  // zh-CN 的 toLocaleDateString 输出 YYYY/MM/DD
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ }).format(now);
}

/** 北京时间的完整时间文本（YYYY/MM/DD HH:mm:ss），日志/通知用 */
function beijingNowText(now = new Date()) {
  const s = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(now);
  return s.replace(/\//g, '/'); // zh-CN 已是 YYYY/MM/DD，无需处理
}

/** 同 beijingNowText，可传任意 Date */
const fmtBeijing = beijingNowText;

/** 北京时间短标签（MM/DD HH:mm），图表 X 轴用 */
function beijingLabel(date) {
  const p = (n) => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

module.exports = { TZ, beijingHour, dayKey, beijingNowText, fmtBeijing, beijingLabel };
