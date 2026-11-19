'use strict';
/**
 * 按天聚合历史样本。
 *
 * 为什么需要它：
 * 上游服务每天只更新一次余额（实测：同一天 10 条查询的余额完全相同）。
 * 所以历史里大量样本是同一天内的重复值，直接画折线会导致：
 *   1. 数据点在同一水平线上重合，看起来像一条粗线；
 *   2. 数值标注互相重叠，读不出来。
 * 按天取"当天最后一次"的余额，才能得到一条真正有信息量的曲线。
 *
 * 同时也为热力图提供"每天消耗了多少"的基础数据。
 *
 * **本文件是纯函数**：不读文件、不看系统时钟（时区与"今天"由调用方注入），
 * 这样测试才能完全确定化。
 */

/** 北京时区偏移（毫秒）。学校在国内，所有"哪一天"都按北京时间算。 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 取某个时间戳对应的北京日期键（YYYY-MM-DD）。
 * @param {number|string|Date} t
 * @returns {string}
 */
function dayKeyOf(t) {
  const ms = t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : Date.parse(t));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 把样本按北京日期分组，每天保留**最后一条**与**第一条**。
 *
 * 为什么两个都要：
 *  - 折线图要"每天最后一条"（当天最新的余额）
 *  - 热力图要算"当天消耗" = 当天第一条 - 当天最后一条
 *    （用第一条而不是前一天最后一条，因为跨天那一刻的差值已经把两天的量混在一起了）
 *
 * @param {Array<{queriedAt:string, balance:number}>} rows
 * @returns {Array<{day:string, last:object, first:object, samples:number, max:number, min:number}>}
 *          按日期升序
 */
function groupByDay(rows) {
  const byDay = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.balance !== 'number' || !Number.isFinite(r.balance)) continue;
    // 兼容两种入参形态：
    //   history.jsonl 的行 → { queriedAt: ISO字符串 }
    //   render-chart 的 parseHistory → { t: 毫秒时间戳 }
    // 只认一种会让调用方白白绕一圈转换，也容易像这样静默返回空。
    const t = Number.isFinite(r.t) ? r.t : Date.parse(r.queriedAt);
    if (!Number.isFinite(t)) continue;
    const day = dayKeyOf(t);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ ...r, _t: t, queriedAt: r.queriedAt || new Date(t).toISOString() });
  }

  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day).sort((a, b) => a._t - b._t);
    const first = list[0];
    const last = list[list.length - 1];
    out.push({
      day,
      first,
      last,
      samples: list.length,
      max: Math.max(...list.map(x => x.balance)),
      min: Math.min(...list.map(x => x.balance)),
    });
  }
  return out;
}

/**
 * 取每天最后一条，作为折线图的数据点。
 *
 * 返回格式与 render-chart 的 parseHistory 保持一致（`t` 是毫秒时间戳），
 * 这样调用方拿到就能直接传给 renderChart，不必再转换。
 *
 * @param {Array} rows
 * @returns {Array<{t:number, balance:number, queriedAt:string, custRechNo:string}>}
 */
function dailyLast(rows) {
  return groupByDay(rows).map(g => ({
    t: g.last._t,
    balance: g.last.balance,
    queriedAt: g.last.queriedAt,
    custRechNo: g.last.custRechNo,
  }));
}

/**
 * 计算最近 N 天每天的净消耗。
 *
 * **口径：当天日末余额 与 前一天日末余额 的差**
 *   当天消耗 = 前一天日末余额 - 当天日末余额
 *
 * 为什么不用"当天首尾差"（第一版我就是这么写的，实测全是 0）：
 * 上游服务**每天只更新一次余额**，同一天内多次查询拿到的余额完全相同。
 * 所以"当天第一次 - 当天最后一次" = 0，热力图会一片空白。
 * 真正有意义的是跨天变化——那才是这一天用掉的电。
 *
 * 返回值语义：
 *   consumed > 0  当天下跌，净消耗这么多
 *   consumed < 0  当天上涨，净充值（绝对值 = 充值额）
 *   consumed = 0  余额没变
 *   consumed = null 无法计算：当天或前一天没有有效样本
 *                  **null 和 0 必须区分**，混在一起会显示成"这天没用电"，误导用户
 
 * 局限（必须诚实说明）：
 *   若某天既充了值又用了电，这里只能看到**净变化**。
 *   例如早上充 50 元、当天用掉 4 元，净变化是 +46 元，
 *   本函数会显示"充值 46 元"，看不出真实的 50 元充值和 4 元消耗。
 *   要拆开必须依赖"相邻两次查询之间"的上涨/下跌（见 detectRecharges），
 *   而那又受"上游一天只更新一次"的限制。
 *
 * @param {Array} rows
 * @param {{days?:number, now?:number|Date}} [opts]
 * @returns {Array<{day:string, consumed:number|null, from:number|null, to:number|null, samples:number}>}
 */
function dailyConsumption(rows, opts = {}) {
  const days = Number.isFinite(opts.days) ? opts.days : 30;
  const nowMs = opts.now instanceof Date ? opts.now.getTime()
    : (typeof opts.now === 'number' ? opts.now : Date.now());

  const groups = groupByDay(rows);
  const byDay = new Map(groups.map(g => [g.day, g]));

  // 需要往前多取一天才能算出第一天的消耗
  const dayList = [];
  for (let i = days; i >= 0; i -= 1) {
    dayList.push(dayKeyOf(nowMs - i * 86400000));
  }

  const out = [];
  for (let i = 1; i < dayList.length; i += 1) {
    const day = dayList[i];
    const prevDay = dayList[i - 1];
    const cur = byDay.get(day);
    const prev = byDay.get(prevDay);
    if (!cur || !prev) {
      out.push({ day, consumed: null, from: prev ? prev.last.balance : null, to: cur ? cur.last.balance : null, samples: cur ? cur.samples : 0 });
      continue;
    }
    out.push({
      day,
      consumed: Number((prev.last.balance - cur.last.balance).toFixed(2)),
      from: prev.last.balance,
      to: cur.last.balance,
      samples: cur.samples,
    });
  }
  return out;
}

/**
 * 检测充值事件：相邻两天之间余额出现的正向跳变。
 *
 * 这是回答"能不能识别充值"的核心函数。**判据与局限都很明确**：
 *
 * 能识别的：
 *   - 两次查询之间余额上涨 ≥ 阈值 → 判为充值
 *   - 金额 = 上涨量。若上涨跨了多天，仍能算出总充值额，但无法定位到具体哪一刻
 *
 * **不能识别的（必须诚实说明）**：
 *   - 同一天内"先消耗后充值"且最终余额低于当天首次余额时，看不出充过值
 *   - 一次充值恰好被同期的消耗完全抵消时，净变化为负或零，看不出来
 *   - 上游每天只更新一次，所以充值最多延迟一天才被发现
 *
 * @param {Array} rows 原始样本（按时间升序）
 * @param {{minAmount?:number}} [opts] minAmount = 判定为充值的最小涨幅，默认 0.5 元
 *        （低于这个数的"上涨"更可能是上游数值抖动，不是真充值）
 * @returns {Array<{at:string, from:number, to:number, amount:number, gapDays:number}>}
 */
function detectRecharges(rows, opts = {}) {
  const minAmount = Number.isFinite(opts.minAmount) ? opts.minAmount : 0.5;
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r.balance === 'number' && Number.isFinite(Date.parse(r.queriedAt)))
    .sort((a, b) => Date.parse(a.queriedAt) - Date.parse(b.queriedAt));

  const out = [];
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1];
    const cur = list[i];
    const diff = cur.balance - prev.balance;
    if (diff < minAmount) continue;
    const gapMs = Date.parse(cur.queriedAt) - Date.parse(prev.queriedAt);
    out.push({
      at: cur.queriedAt,
      from: prev.balance,
      to: cur.balance,
      amount: Number(diff.toFixed(2)),
      gapDays: Number((gapMs / 86400000).toFixed(2)),
    });
  }
  return out;
}

module.exports = {
  dayKeyOf, groupByDay, dailyLast, dailyConsumption, detectRecharges, TZ_OFFSET_MS,
};
