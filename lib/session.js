'use strict';
/**
 * 会话编排：熔断、登录、状态落盘的唯一入口。
 *
 * 从 bin/elec.js 搬出来，因为原来这几十行是"最不能错、又完全测不到"的一段：
 * 它决定**什么时候拿真实密码去打学校 SSO**。打错了不是显示错误，是把账号锁死
 * ——学校 SSO 是账号级风控，连错 3 次锁约 90 秒，按账号不按 IP，换网络没用。
 *
 * 本文件修掉三个 P1：
 *
 *   P1-A 熔断成功后 `clearLoginFailure` 没落盘。
 *        旧代码 clearLoginFailure() 之后调 persistState()，而 persistState 在
 *        `cloud.stateless` 时直接 return —— 等于"登录成功了但失败计数没清零"，
 *        计数只增不减，退避从 6h 一路上涨到 24h 并且**永不回落**。
 *        修法：状态落盘与 stateless 解耦。stateless 的语义是"不发布快照"，
 *        不是"不记熔断"。熔断计数是安全设施，任何模式都必须落盘。
 *
 *   P1-B state.json 损坏时静默清零熔断。已由 store.corruptState() 处理，
 *        这里确保"损坏状态"不会被当普通状态继续用（不重试登录）。
 *
 *   P1-C `checkSession()` 的 catch 把网络错误也判成"会话失效"。
 *        已于阶段 2 修：kind === 'auth-expired' 才算会话没了；网络错误
 *        应当向上抛，而不是 silently 重登（重登也连不上，还会白白消耗登录次数）。
 */
const errors = require('./errors');

/** 熔断封顶 24 小时 */
const MAX_LOCKOUT_HOURS = 24;
/** 首次失败熔断 6 小时 */
const BASE_LOCKOUT_HOURS = 6;

/**
 * 第 n 次失败该熔断多少毫秒：6h → 12h → 24h 封顶。
 * 纯函数，可直接测。
 *
 * @param {number} failures 累计失败次数（>=1）
 * @returns {number} 毫秒
 */
function nextLockoutMs(failures) {
  const n = Math.max(1, Math.floor(Number(failures) || 1));
  // 用 2 的幂而不是循环累乘：溢出边界更清楚，也避免大数时的精度问题
  const hours = Math.min(MAX_LOCKOUT_HOURS, BASE_LOCKOUT_HOURS * Math.pow(2, n - 1));
  return hours * 3600 * 1000;
}

/** 兼容旧名（bin 与测试里都按 hours 用） */
function lockoutHours(fails) {
  return nextLockoutMs(fails) / 3600000;
}

/**
 * 当前熔断状态。
 *
 * @param {Object} state
 * @param {number} [now] 注入时钟，便于测试
 * @returns {{locked:boolean, remainingMs:number, until?:string, failures:number, lastError?:string}}
 */
function lockoutStatus(state, now = Date.now()) {
  const s = state || {};
  const failures = Number(s.loginFailures) || 0;
  if (s.stateCorrupt) {
    // 状态损坏 → 按"已熔断"处理（安全模式）。这是 P1-B 的落点：
    // 损坏时宁可少查一次，也不能拿可能已失效的密码去打 SSO。
    const until = s.loginLockedUntil ? Date.parse(s.loginLockedUntil) : now + MAX_LOCKOUT_HOURS * 3600000;
    return {
      locked: true,
      remainingMs: Math.max(0, until - now),
      until: new Date(until),
      failures,
      lastError: s.stateCorruptReason || '状态文件损坏',
      corrupt: true,
    };
  }
  const until = s.loginLockedUntil ? Date.parse(s.loginLockedUntil) : 0;
  if (!until || Number.isNaN(until)) return { locked: false, remainingMs: 0, failures };
  const remainingMs = until - now;
  if (remainingMs <= 0) return { locked: false, remainingMs: 0, failures };
  return {
    locked: true,
    remainingMs,
    until: new Date(until),
    failures,
    lastError: s.lastLoginError,
  };
}

/** 记录一次登录失败：累加计数、顺延熔断 */
function recordLoginFailure(state, message, now = Date.now()) {
  state.loginFailures = (Number(state.loginFailures) || 0) + 1;
  // 状态损坏时计数是 MAX_SAFE_INTEGER，别再往上加（会丢精度）
  if (!Number.isSafeInteger(state.loginFailures)) state.loginFailures = Number.MAX_SAFE_INTEGER;
  const ms = nextLockoutMs(state.loginFailures);
  state.loginLockedUntil = new Date(now + ms).toISOString();
  state.lastLoginError = String(message).slice(0, 300);
  return { hours: ms / 3600000, until: state.loginLockedUntil };
}

/** 登录成功：清空熔断相关字段 */
function clearLoginFailure(state) {
  state.loginFailures = 0;
  delete state.loginLockedUntil;
  delete state.lastLoginError;
  delete state.stateCorrupt;
  delete state.stateCorruptReason;
  return state;
}

/**
 * 唯一的登录入口。所有命令都必须走这里。
 *
 * @param {Object} cfg
 * @param {{client:Object, store:Object, state:Object, now?:number, log?:Object}} deps
 * @returns {Promise<{client:Object, state:Object}>}
 */
async function ensure(cfg, deps) {
  const { client, store, state } = deps;
  const now = typeof deps.now === 'number' ? deps.now : Date.now();
  const log = deps.log || { info() {}, warn() {}, error() {}, debug() {} };

  const lock = lockoutStatus(state, now);
  if (lock.locked) {
    const mins = Math.ceil(lock.remainingMs / 60000);
    throw new errors.ElecError(
      'lockout-active',
      `登录已熔断（${lock.failures} 次失败后暂停），还剩约 ${mins} 分钟。`
      + `上次错误：${lock.lastError || '未知'}。`
      + `若是密码改了就更新配置，然后删除 state 里的 loginLockedUntil 或运行 check --reset-lockout`,
      { meta: { remainingMinutes: mins } },
    );
  }

  try {
    await client.login();
  } catch (e) {
    const err = errors.normalize(e);
    if (errors.isAuthFailure(err)) {
      recordLoginFailure(state, err.message, now);
      // P1-A：熔断状态**必须落盘**，与 stateless 无关。
      // 落盘失败不能掩盖原始登录错误，但也不能静默——两条都记。
      try {
        store.saveState(cfg.paths.state, state);
      } catch (saveErr) {
        log.error('熔断状态落盘失败（下次可能从零开始重试）:', saveErr.message);
      }
      log.error(`登录失败，已熔断 ${lockoutHours(state.loginFailures)} 小时，期间不再尝试登录（避免把账号锁死）`);
      log.error('如果是改了密码，请更新 QLGYDX_PASS 后清除熔断：node bin/elec.js check --reset-lockout');
    } else if (errors.isRetryable(err)) {
      // 网络类失败不计入熔断：断网不是"密码错了"，惩罚账号没有意义
      log.warn(`登录未完成（网络类，不计入熔断）: ${err.message}`);
    }
    throw err;
  }

  clearLoginFailure(state);
  // 同理：成功后清零也必须落盘，否则计数只增不减（P1-A 的另一半）
  try {
    store.saveState(cfg.paths.state, state);
  } catch (saveErr) {
    log.error('登录成功但状态落盘失败:', saveErr.message);
  }
  log.info(`登录成功: ${client.userName || cfg.account.username}`);
  return { client, state };
}

module.exports = {
  ensure,
  lockoutStatus,
  nextLockoutMs,
  lockoutHours,
  recordLoginFailure,
  clearLoginFailure,
  MAX_LOCKOUT_HOURS,
  BASE_LOCKOUT_HOURS,
};
