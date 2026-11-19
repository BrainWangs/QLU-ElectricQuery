'use strict';
/**
 * 类型化错误层。
 *
 * 为什么需要它：原来判断"这是哪一类错误"全靠**三处字符串正则**，分散在
 * `bin/elec.js:112`、`bin/elec.js:199`、`lib/qlgydx.js:153`。这带来两个后果：
 *
 *   1. 服务端改一句文案，熔断/重登/DoH 兜底就**静默失效**——没有任何测试会红。
 *   2. 同一个错误在三个地方可能被判成三种类型，互相矛盾。
 *
 * 本模块把"哪些 code/文案代表什么"收进**唯一一个映射点**。
 * 它内部仍然要用中文文案兜底（因为服务端只给文案），但映射只决定 `kind`，
 * **控制流只看 kind**。这样：
 *   - 服务端改文案时，最坏情况是 kind 判错；
 *   - 而 kind 判错是**可被测试覆盖的**——给 8 个假响应断言 8 个 kind 即可。
 *
 * @typedef {'auth-failed'|'auth-locked'|'auth-expired'|'session-missing'
 *          |'network-timeout'|'network-error'|'bad-response'|'multi-meter'
 *          |'config-invalid'|'lockout-active'|'unknown'} ErrorKind
 */

class ElecError extends Error {
  /**
   * @param {ErrorKind} kind
   * @param {string} message
   * @param {{cause?:Error, code?:string|number, retryable?:boolean, meta?:object}} [opts]
   */
  constructor(kind, message, opts = {}) {
    super(message);
    this.name = 'ElecError';
    this.kind = kind;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.code !== undefined) this.code = opts.code;
    // 默认不可重试：只有明确"重一次可能好"的错误才标记可重试。
    // 这个默认值很重要——把认证失败误标成可重试就是"反复把账号打锁"。
    this.retryable = opts.retryable === true;
    if (opts.meta) Object.assign(this, opts.meta);
    // 保留原始错误的 stack 线索
    if (opts.cause && opts.cause.stack) this.originalStack = opts.cause.stack;
  }
}

// ---------------------------------------------------------------- 判定谓词
// 控制流只许用这些，不许再写正则。

const isAuthFailure = e => e instanceof ElecError && (e.kind === 'auth-failed' || e.kind === 'auth-locked');
const isSessionGone = e => e instanceof ElecError && (e.kind === 'auth-expired' || e.kind === 'session-missing');
const isRetryable = e => e instanceof ElecError && e.retryable === true;
const isNetwork = e => e instanceof ElecError && (e.kind === 'network-timeout' || e.kind === 'network-error');

// ---------------------------------------------------------------- 映射表
// **这是全仓库唯一知道"服务端文案/业务码 ⇔ 错误类型"的地方。**
// 新增一种失败形态时只改这里，并同步加一条夹具。

/** 登录接口失败：凭据错 / 被锁定。重试只会让账号更接近被锁死。 */
const LOGIN_FAILURES = [
  { kind: 'auth-locked', re: /登录失败次数过多|需要输入验证码/ },
  { kind: 'auth-failed', re: /用户名或密码不正确|密码错误|账号或密码/ },
];

/** 业务码层面的登录失败 */
const LOGIN_FAILURE_CODES = new Set(['20119999', '30610010']);

/** 会话失效：值得重登一次再试 */
const SESSION_GONE = [
  { kind: 'auth-expired', re: /未登录|登录超时|会话.*(?:过期|失效)/ },
  { kind: 'session-missing', re: /未获得 SESSION/ },
];

const SESSION_GONE_CODES = new Set(['40320001']);

/** 网络层错误码（undici / 系统） */
const NETWORK_CODES = /UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE/i;

// ---------------------------------------------------------------- 工厂

/**
 * 把"登录接口返回了什么"翻译成 ElecError。
 *
 * **默认值必须保守**：只有明确命中"凭据错/被锁定"的文案或业务码才判
 * `auth-failed`/`auth-locked`。其余一律 `unknown`。
 * 反例（真实踩过）：默认返回 auth-failed 时，一条 `fetch failed`（断网）
 * 会被判成"登录失败"→ 触发 24 小时熔断，断一次网就锁自己一整天。
 *
 * @param {Object|null} json 解析后的 JSON（可能为 null）
 * @param {string} text 原始响应文本（JSON 解析失败时用来兜底判断）
 * @param {Object} [meta] 附加信息
 * @returns {ElecError}
 */
function fromLoginResponse(json, text = '', meta = {}) {
  const code = json && json.code !== undefined ? String(json.code) : '';
  const msg = (json && (json.message || json.msg)) || '';
  const haystack = `${msg}\n${text}`;

  // 调用方可能只给了原始响应文本（JSON 没解析成功，或只是把一段日志丢进来）。
  // 这时从文本里把 code 捞出来，否则 {"code":"20119999"} 会被漏判。
  let textCode = '';
  if (!code) {
    const m = /\bcode\s*["']?\s*[:=]\s*["']?([A-Za-z0-9]{4,})/.exec(text)
      || /"(?:code|errorCode)"\s*:\s*"?(\d{4,})/.exec(text);
    if (m) textCode = m[1];
  }
  const effCode = code || textCode;

  if (effCode && effCode === '00000000') {
    // 正常返回，不该走到这里；交给调用方当成功处理
    return new ElecError('unknown', '登录接口返回成功码，但被当成失败处理', { ...meta, code: effCode });
  }

  for (const { kind, re } of LOGIN_FAILURES) {
    if (re.test(haystack)) {
      return new ElecError(kind, `登录失败: ${msg || text.slice(0, 200)}`, { ...meta, code: effCode || undefined });
    }
  }
  if (LOGIN_FAILURE_CODES.has(effCode)) {
    return new ElecError('auth-failed', `登录失败: ${msg || effCode}`, { ...meta, code: effCode });
  }
  // 登录流程里也会出现"会话没建立起来"的失败，它们属于会话类（可重登），
  // 不是凭据错（不该熔断）。这条必须在 unknown 兜底之前判。
  for (const { kind, re } of SESSION_GONE) {
    if (re.test(haystack)) {
      return new ElecError(kind, `登录失败: ${msg || text.slice(0, 200)}`, { ...meta, code: effCode || undefined });
    }
  }
  if (SESSION_GONE_CODES.has(effCode)) {
    return new ElecError('auth-expired', `登录失败: ${msg || effCode}`, { ...meta, code: effCode });
  }
  // 网络层失败不是登录失败 —— 不要自动熔断。
  if (NETWORK_CODES.test(effCode) || /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(haystack)) {
    return fromNetworkError(json || { message: text }, meta);
  }
  // 其余（含"看不出是什么"）一律 unknown：不熔断、不重试，交给上层决定
  return new ElecError('unknown', `登录失败: ${msg || text.slice(0, 200) || '未知原因'}`, { ...meta, code: effCode || undefined });
}

/**
 * 把业务码 + 文案翻译成 ElecError（用于 /api/ 调用）。
 *
 * @param {string|number} code
 * @param {string} message
 * @param {Object} [meta]
 * @returns {ElecError}
 */
function fromBusinessCode(code, message = '', meta = {}) {
  const c = code === undefined || code === null ? '' : String(code);
  const haystack = `${message}`;

  for (const { kind, re } of SESSION_GONE) {
    if (re.test(haystack)) return new ElecError(kind, message || `会话失效(${c})`, { ...meta, code: c || undefined });
  }
  if (SESSION_GONE_CODES.has(c)) {
    return new ElecError('auth-expired', message || `会话失效(${c})`, { ...meta, code: c });
  }
  return new ElecError('bad-response', message || `业务错误 ${c}`, { ...meta, code: c || undefined });
}

/**
 * 把网络异常（fetch 抛出的、带 cause.code 的）翻译成 ElecError。
 *
 * @param {Error} e
 * @param {{elapsedMs?:number}} [meta]
 * @returns {ElecError}
 */
function fromNetworkError(e, meta = {}) {
  const cause = e && e.cause;
  // undici 把真正的错误码放在 e.cause.code 上，有时只有 message
  const raw = (cause && (cause.code || cause.message)) || (e && (e.code || e.message)) || '';
  const code = String(raw);
  const message = String((e && e.message) || '');
  const isTimeout = /TIMEOUT|ETIMEDOUT/i.test(code);
  // `fetch failed` 是 Node 全局 fetch 在**连接层失败**时抛的通用消息，
  // 它本身不含具体错误码（码在 e.cause 里，但有时 cause 也没有）。
  // 不把这种情况算作网络错误的话，它会被降级成 unknown 而丢掉 retryable，
  // 于是 DoH 兜底不会触发——断网/坏 IP 时表现为"查询失败且不再重试"。
  const looksLikeNetwork = NETWORK_CODES.test(code)
    || NETWORK_CODES.test(message)
    || /fetch failed|network error|socket hang up/i.test(message);
  const kind = isTimeout ? 'network-timeout' : (looksLikeNetwork ? 'network-error' : 'unknown');
  return new ElecError(kind, (e && e.message) || '网络请求失败', {
    cause: e,
    code: code || undefined,
    // 超时与网络错误可重试（DoH 兜底就是干这个的）；纯 unknown 不鼓励重试
    retryable: kind === 'network-timeout' || kind === 'network-error',
    meta: { elapsedMs: meta.elapsedMs },
  });
}

/**
 * 把一个"来历不明"的异常规整成 ElecError。
 * 已经是 ElecError 就原样返回；带 code/kind 的普通 Error 按码推断；
 * 其余归为 unknown。
 *
 * @param {*} e
 * @returns {ElecError}
 */
function normalize(e) {
  if (e instanceof ElecError) return e;
  if (e && typeof e === 'object') {
    if (e.kind === 'bad-amount' || e.kind === 'bad-response') {
      return new ElecError(e.kind, e.message || '响应无法解析', { cause: e, code: e.code, meta: { rawValue: e.rawValue } });
    }
    if (e.kind === 'multi-meter') {
      return new ElecError('multi-meter', e.message || '响应里有多个表具', { cause: e, meta: { count: e.count } });
    }
    if (e.code !== undefined && e.code !== null && String(e.code) !== '') {
      return fromBusinessCode(e.code, e.message || '');
    }
  }
  const code = String((e && (e.code || (e.cause && (e.cause.code || e.cause.message)))) || '');
  if (NETWORK_CODES.test(code) || /fetch failed/i.test(String(e && e.message))) {
    return fromNetworkError(e);
  }
  return new ElecError('unknown', (e && e.message) || String(e), { cause: e });
}

module.exports = {
  ElecError,
  fromLoginResponse,
  fromBusinessCode,
  fromNetworkError,
  normalize,
  isAuthFailure,
  isSessionGone,
  isRetryable,
  isNetwork,
  // 供测试直接验映射表，避免"改了映射但没人发现"
  __test: { LOGIN_FAILURES, LOGIN_FAILURE_CODES, SESSION_GONE, SESSION_GONE_CODES, NETWORK_CODES },
};
