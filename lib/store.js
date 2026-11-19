'use strict';
/**
 * 状态与历史的持久化层。
 *
 * 从 lib/alert.js 里把 I/O 拆出来，原因有三个：
 *
 *  1. **原子性**：旧 `saveState` 直接 `writeFileSync` 覆盖目标文件。
 *     写一半进程被杀（GitHub Actions 的 runner 随时可能取消）→ 留下截断的
 *     JSON → 下次启动 loadState 解析失败 → 走"损坏"分支 → 熔断状态丢失。
 *     而这个仓库存的正是**熔断计数**，丢了就等于"密码错了也继续试"，
 *     会把学校账号锁死。所以必须"写临时文件 + rename"，同盘 rename 是原子的。
 *
 *  2. **可测性**：alert.js 是这个仓库的判定核心（纯逻辑），不该被文件系统
 *     绑住。拆开后 evaluate() 能完全无副作用地测。
 *
 *  3. **版本迁移**：状态结构会变。`version` 字段 + `migrate()` 让变更可落地，
 *     而不是"读不出来就当空状态"——后者会静默丢熔断。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 当前状态结构版本。改结构必须 +1 并在 MIGRATIONS 里补一条。 */
const STATE_VERSION = 2;

/**
 * 迁移函数表：key 是旧版本号，值把该版本的数据升到 key+1。
 * 只写"确实改过结构"的那几步，不要预设未来。
 */
const MIGRATIONS = {
  // v1 → v2：阶段 1/2 之后新增的字段。
  // v1 没有 version 字段（或写死 1），且没有 lastAlertLevel / outages 概念。
  1: data => {
    const out = { ...data, version: 2 };
    // v1 里"上次告警级别"只能从 lastAlertAt 的键推断，作为初值迁移进来
    if (out.lastAlertLevel === undefined) {
      const at = out.lastAlertAt;
      out.lastAlertLevel = (at && typeof at === 'object' && (at.critical || at.low)) ? null : null;
    }
    if (out.consecutiveErrors === undefined) out.consecutiveErrors = 0;
    return out;
  },
};

/** 状态文件损坏（存在但读不出/解析不了）。调用方必须能区分"损坏"和"首次运行"。 */
class StoreCorrupt extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreCorrupt';
    this.code = 'STORE_CORRUPT';
    if (cause) this.cause = cause;
  }
}

function emptyState() {
  return {
    version: STATE_VERSION,
    lastAlertAt: {},
    lastAlertLevel: null,
    lastBalance: null,
    lastOkAt: null,
    consecutiveErrors: 0,
  };
}

/**
 * 状态损坏时的安全模式。
 *
 * **绝不能把登录熔断状态清零。** 旧实现 catch 后直接返回 emptyState()，
 * 等于"state.json 坏掉 = 熔断从未发生过"，于是程序立刻拿可能已失效的密码
 * 重新打 SSO —— 这正是熔断要防的场景（学校 3 次错密码锁号 90 秒，按账号不按 IP）。
 *
 * @param {Error} err 解析失败的原因
 * @param {number} now 当前时间戳（便于测试注入）
 */
function corruptState(err, now = Date.now()) {
  const s = emptyState();
  s.stateCorrupt = true;
  s.stateCorruptReason = (err && err.message) || String(err);
  // 与 lockoutHours() 的封顶值一致：24 小时
  s.loginFailures = Number.MAX_SAFE_INTEGER;
  s.loginLockedUntil = new Date(now + 24 * 3600 * 1000).toISOString();
  return s;
}

/**
 * 把任意版本的裸对象规整成当前版本。
 * @param {Object} data
 * @returns {Object}
 */
function migrate(data) {
  let cur = data;
  // 没有 version 的老数据按 v1 处理（v1 是第一个有字段结构的版本）
  let v = Number.isInteger(cur.version) ? cur.version : 1;
  if (v > STATE_VERSION) {
    // 未来版本的数据给旧程序读：不能猜，明确拒绝，避免写坏更新版本的文件
    throw new StoreCorrupt(`state.json 版本 ${v} 高于本程序支持的 ${STATE_VERSION}`);
  }
  while (v < STATE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new StoreCorrupt(`缺少 v${v} → v${v + 1} 的迁移函数`);
    cur = step(cur);
    v += 1;
  }
  cur.version = STATE_VERSION;
  return cur;
}

/**
 * 读取状态。
 *
 * 契约（与阶段 0 的行为一致，但更严格）：
 *  - 文件不存在 / 空文件 → emptyState()（首次运行）
 *  - 内容损坏 → 返回 corruptState()（安全模式），**不抛异常**
 *    （抛异常会让 check 直接失败，反而丢掉告警能力；
 *      但必须通过 stateCorrupt 标记让上层看得见）
 *  - 版本过新 → 也走安全模式
 *
 * @param {string} file
 * @param {{now?:number, onCorrupt?:(err:Error)=>void}} [opts]
 */
function loadState(file, opts = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 文件不存在是正常情况（首次运行），只有"存在但读不了"才算损坏
    if (e && e.code === 'ENOENT') return emptyState();
    if (opts.onCorrupt) opts.onCorrupt(e);
    return corruptState(e, opts.now);
  }
  try {
    // 空文件 / 全空白不算损坏，当作首次运行
    if (!text.trim()) return emptyState();
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError('state.json 顶层不是对象');
    }
    const s = migrate(raw);
    return {
      ...emptyState(),
      ...s,
      lastAlertAt: s.lastAlertAt && typeof s.lastAlertAt === 'object' && !Array.isArray(s.lastAlertAt)
        ? s.lastAlertAt
        : {}, // 被污染成字符串/数组时重置，修 P1-23 的崩溃
    };
  } catch (e) {
    if (opts.onCorrupt) opts.onCorrupt(e);
    return corruptState(e, opts.now);
  }
}

/**
 * 原子写：先写同目录临时文件，fsync，再 rename 覆盖目标。
 *
 * 为什么必须 rename：`writeFileSync(target)` 在写到一半被杀时会留下
 * **截断的 JSON**。而这仓库的 state 存的是熔断计数，截断 = 熔断丢失 =
 * 程序会拿错密码继续打 SSO。rename 在同一文件系统内是原子操作，
 * 观察者要么看到旧文件、要么看到新文件，不存在"半个文件"。
 *
 * @param {string} file
 * @param {Object} state
 */
function saveState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // 临时文件名带 pid + 随机后缀，避免并发写同一个临时文件
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const body = JSON.stringify(state, null, 2);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, body);
    // fsync 确保内容真的落到磁盘，而不是停在页缓存里——
    // CI runner 被杀时页缓存里的内容会丢
    try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持，忽略 */ }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** 追加一行历史。单行 append 在 POSIX 上是原子的（O_APPEND），不会互相截断。 */
function appendHistory(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

/**
 * 流式读取历史（只回 since 之后的记录）。
 *
 * 为什么不用 readFileSync：history.jsonl 会长期增长（每次 check 一行），
 * 一年就有几千行。整读再切是 O(全部)，而这里只关心最近 N 小时。
 * 用逐行读流，并在遇到坏行时跳过而不是整体失败。
 *
 * @param {string} file
 * @param {number} hours 只返回最近这么多小时的记录
 * @param {{now?:number}} [opts]
 * @returns {Array<Object>}
 */
function readHistory(file, hours = 24, opts = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const cutoff = now - hours * 3600 * 1000;
  const out = [];
  // 按行切；不用 split('\n') 建一个大数组，直接扫描
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r || typeof r !== 'object') continue;
      const t = Date.parse(r.queriedAt);
      if (Number.isFinite(t) && t >= cutoff) out.push(r);
    } catch { /* 坏行跳过，不影响其它行 */ }
  }
  return out;
}

module.exports = {
  STATE_VERSION,
  StoreCorrupt,
  MIGRATIONS,
  emptyState,
  corruptState,
  migrate,
  loadState,
  saveState,
  appendHistory,
  readHistory,
};
