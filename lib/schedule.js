'use strict';
/**
 * 时段占位：决定"这一次触发该不该真去查"。
 *
 * 背景（这是整个设计的原因，不要删）：
 * GitHub 的 schedule 不可靠。实测 11-03~11-07 五天里应触发 40 次，
 * 实际只创建了 9 次任务，而且分钟数在 :10~:53 之间随机分布、排队时间 0 秒、
 * 没有一条 cancelled 记录。这说明 GitHub 是**合并 + 丢弃**，不是"延迟补跑"。
 *
 * 所以两个错误的做法：
 *   1. 只写 4 条 cron（8/12/16/20 点各一条）——丢弃率 78%，很可能一天只成 1 次。
 *   2. 按"距上次成功不足 N 分钟就跳过"节流——延迟会把节奏打乱，
 *      比如 8 点那次拖到 9:40 才跑，下一次 10:10 就被判"太近"跳过，
 *      结果 12 点那个时段整个落空。
 *
 * 正确做法是**按时段占位**：
 *   - 一天切成 4 个时段（8/12/16/20 点各一个），每个时段有明确的起止；
 *   - 时段内可以触发很多次，但只要有一次查成功，这个时段就算完成；
 *   - 后续触发发现"本时段已完成"就直接退出，不浪费请求也不重复推送。
 *
 * 这样即使 78% 的触发被丢弃，只要每个时段里**至少有一次**活下来就够了。
 */

/**
 * 两种触发方式各自的默认窗口宽度（分钟）。``提前量`` 越大 = 越宽松。
 *
 * 为什么要分开：
 *  - GitHub 自带 cron 实测 78% 的触发被丢弃，且时间随机（:10~:53）。
 *    窗口必须留宽，否则绝大多数触发都落在窗口外白白浪费。
 *  - 外部服务（Cloudflare Workers）的 cron 是准点的，窗口收窄到 10 分钟
 *    就足够吸收"GitHub 收到请求后启动虚拟机"的几秒延迟，
 *    同时避免在错误的时间段（比如 7:40）就跑去查。
 */
const WINDOW_BY_MODE = {
  github: 30,
  external: 10,
};

/** 按 mode 取该用的窗口宽度；mode 非法时退回最宽松的那个 */
function windowForMode(mode, fallback = 30) {
  return Object.prototype.hasOwnProperty.call(WINDOW_BY_MODE, mode)
    ? WINDOW_BY_MODE[mode]
    : fallback;
}

/**
 * 把一天切成若干时段。
 *
 * @param {number[]} slots        时段基准小时（北京），升序，如 [8,12,16,20]
 * @param {number} windowMinutes  提前量：时段从"基准前 N 分钟"开始
 * @param {number} closeMinutes   当天服务关闭时刻（分钟数），如 23:40 → 1420
 * @returns {Array<{hour:number, start:number, end:number}>} start/end 均为分钟数
 */
function buildWindows(slots, windowMinutes = 30, closeMinutes = 23 * 60 + 40) {
  const list = (Array.isArray(slots) ? slots : [])
    .filter(h => Number.isInteger(h) && h >= 0 && h <= 24)
    .slice()
    .sort((a, b) => a - b);
  if (!list.length) return [];

  // 窗口**以准点为中心**，而不是"从准点前 N 分钟开始一路开到下一次"。
  //
  // 为什么改：旧写法是 [h*60-N, nextStart)，于是 external 模式（N=10）下
  // 7:50 就落进 8 点时段、立刻开查——比 8:00 早了 10 分钟，不符合"准点"。
  // 改成 [h*60-N, h*60+N) 后，7:50 开窗、8:10 关窗，中枢正好是 8:00。
  //
  // 代价：两个时段之间的间隙不再被覆盖（如 8:10–11:50 没人管）。
  // 这正好是我们想要的——那两个时段本来就该空着，不该在中间乱查。
  return list.map((hour, i) => {
    const center = hour * 60;
    const start = Math.max(0, center - windowMinutes);
    // 最后一个时段受服务关闭时刻约束；非最后一个也不能越过自己的中心
    const isLast = i + 1 >= list.length;
    const end = isLast
      ? Math.max(start + 1, Math.min(center + windowMinutes, closeMinutes))
      : center + windowMinutes;
    return { hour, start, end, center };
  });
}

/**
 * 当前时刻落在哪个时段。
 *
 * @param {{minutesOfDay:number}} parts  北京时间的时/分（见 time.beijingParts）
 * @param {Array<{hour:number,start:number,end:number}>} windows
 * @returns {{hour:number,start:number,end:number}|null} 不在任何时段内返回 null
 */
function currentWindow(parts, windows) {
  const m = parts && Number(parts.minutesOfDay);
  if (!Number.isFinite(m)) return null;
  for (const w of windows) {
    if (m >= w.start && m < w.end) return w;
  }
  return null;
}

/**
 * 时段完成标记的键：`日期@小时`，如 `2026/11/07@8`。
 * 带日期是因为要"每天每时段各一次"，不能跨天复用。
 */
function slotKey(dayKeyText, hour) {
  return `${dayKeyText}@${hour}`;
}

/**
 * 这次触发是否该真的去查。
 *
 * @param {object} opts
 * @param {{minutesOfDay:number, dayKey:string}} opts.parts
 * @param {number[]} opts.slots
 * @param {number} [opts.windowMinutes]
 * @param {number} [opts.closeMinutes]
 * @param {string} [opts.lastSlotKey]  state 里记的上次完成时段键
 * @param {boolean} [opts.force]
 * @returns {{run:boolean, window:object|null, key:string|null, reason:string}}
 */
function decide({ parts, slots, windowMinutes, mode, closeMinutes, lastSlotKey, force = false } = {}) {
  // 优先级：显式 windowMinutes > mode 推导 > 默认 30。
  // 这样既支持"按模式自动定宽"，也支持测试里直接钉死窗口。
  const win = Number.isFinite(windowMinutes) ? windowMinutes : windowForMode(mode, 30);
  const windows = buildWindows(slots, win, closeMinutes);

  if (force) {
    const w = currentWindow(parts, windows);
    return { run: true, window: w, key: w ? slotKey(parts.dayKey, w.hour) : null, reason: 'force' };
  }

  const w = currentWindow(parts, windows);
  if (!w) {
    return { run: false, window: null, key: null, reason: 'outside-window' };
  }
  const key = slotKey(parts.dayKey, w.hour);
  if (lastSlotKey === key) {
    return { run: false, window: w, key, reason: 'already-done' };
  }
  return { run: true, window: w, key, reason: 'due' };
}

module.exports = {
  buildWindows, currentWindow, slotKey, decide,
  windowForMode, WINDOW_BY_MODE,
};
