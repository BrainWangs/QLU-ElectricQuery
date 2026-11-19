'use strict';
/**
 * 脱敏函数。
 *
 * **这些函数只在生成公开镜像时使用**（scripts/build-mirror.js），
 * 主仓的运行时（快照、日志、通知）一律保留真实值——仓库是私有的，
 * 保留真实房号才方便在 App 上确认是哪一间。
 *
 * 曾经它们是 `cloud.redact` 开关的实现，挂在快照构建路径上。
 * 那个设计有两个问题：
 *   1. 开关默认 false，等于"脱敏这道闸门平时是开着的"——某天仓库转公开时
 *      很容易忘了打开，而忘了的后果是房号直接进公开快照。
 *   2. 它只作用于快照的两个字段（location / custRechNo），而同一个 JSON 里
 *      隔壁的 meterAddress、alert.message 照样写着房号，等于脱了个寂寞。
 *
 * 现在改成"脱敏只在构建镜像那一步、对整个输出树做"，覆盖面从 2 个字段
 * 变成整棵目录，且不依赖任何运行时开关。
 */

/**
 * 位置打码：只保留到楼/区一级，房号替换成 ***。
 * 例：示例校区学生公寓.示例园1号公寓A区.3楼.A101
 *  →  示例校区学生公寓.示例园1号公寓A区.3楼.***
 */
function redactLocation(location) {
  if (!location) return null;
  const parts = String(location).split('.');
  if (parts.length < 2) return String(location);
  // 最后一段通常是房间号（A101 / 101 之类），整段替换
  parts[parts.length - 1] = '***';
  return parts.join('.');
}

/**
 * 电表号（园区#楼号#房号）同样要打码，只留园区和楼号。
 * 例：示例园#1#A101 → 示例园#1#***
 */
function redactMeter(custRechNo) {
  if (!custRechNo) return null;
  const s = String(custRechNo);
  const m = s.match(/^(.*?[#＃])([^#＃]+)$/);
  if (!m) return s;
  return `${m[1]}***`;
}

module.exports = { redactLocation, redactMeter };
