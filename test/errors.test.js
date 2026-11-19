// 错误类型化（lib/errors.js）的夹具。
//
// 这组测试的目标不是"错误消息好看"，而是**控制流所依赖的 kind 判得对**。
// 改造前三处判断全靠正则，任何一个文案变动都会让熔断/重登/DoH 兜底静默失效。
//
// 阶段 2 的硬验收：给 8 个假响应，断言 8 个 kind。
//
// 这里最需要钉住的两条"反向"语义（判反了会出真实事故）：
//   1. **断网不能被判成登录失败** —— 否则断一次网就触发 24 小时熔断，
//      自己把自己锁一整天，而且期间不会自动恢复。
//   2. **认不出的错误不能默认判成 auth-failed** —— 同理，默认值必须有攻击性
//      最低的那一侧，宁可"不熔断"，也不要"因为看不懂就熔断"。
const test = require('node:test');
const assert = require('node:assert');

const {
  ElecError, fromLoginResponse, fromBusinessCode, fromNetworkError, normalize,
  isAuthFailure, isSessionGone, isRetryable, isNetwork,
} = require('../lib/errors');

// ------------------------------------------------------------ 8 个假响应 → 8 个 kind

test('kind 1：密码错误 → auth-failed', () => {
  const e = fromLoginResponse({ code: '20119999', message: '用户名或密码不正确' }, '');
  assert.strictEqual(e.kind, 'auth-failed');
  assert.ok(isAuthFailure(e), '必须被判为登录失败（触发熔断）');
});

test('kind 2：被锁定 → auth-locked', () => {
  const e = fromLoginResponse({ code: '30610010', message: '登录失败次数过多，需要输入验证码' }, '');
  assert.strictEqual(e.kind, 'auth-locked');
  assert.ok(isAuthFailure(e), '被锁定同样属于登录失败');
});

test('kind 3：会话过期 → auth-expired', () => {
  const e = fromBusinessCode('40320001', '未登录或登录超时');
  assert.strictEqual(e.kind, 'auth-expired');
  assert.ok(isSessionGone(e), '应当触发"重登后重试"');
});

test('kind 4：没拿到 SESSION → session-missing', () => {
  const e = fromLoginResponse(null, '未获得 SESSION cookie');
  assert.strictEqual(e.kind, 'session-missing');
  assert.ok(isSessionGone(e), '属于会话类，可重登');
});

test('kind 5：网络超时 → network-timeout', () => {
  const e = fromNetworkError({ message: 'fetch failed', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  assert.strictEqual(e.kind, 'network-timeout');
  assert.ok(isNetwork(e));
  assert.ok(isRetryable(e), '超时值得重试（DoH 兜底就是干这个的）');
});

test('kind 6：网络错误 → network-error', () => {
  const e = fromNetworkError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } });
  assert.strictEqual(e.kind, 'network-error');
  assert.ok(isNetwork(e));
});

test('kind 7：业务错误 → bad-response', () => {
  const e = fromBusinessCode('40001', '参数错误');
  assert.strictEqual(e.kind, 'bad-response');
  assert.strictEqual(e.code, '40001');
});

test('kind 8：认不出的错误 → unknown（且不得是 auth-failed）', () => {
  const e = fromLoginResponse(null, '服务器开小差了');
  assert.strictEqual(e.kind, 'unknown');
  assert.ok(!isAuthFailure(e), '认不出就熔断 = 断网也能锁死账号，这条绝不能反');
});

// ------------------------------------------------------------ 反向语义（防事故）

test('断网绝不能被判成登录失败（否则断一次网锁 24 小时）', () => {
  for (const text of ['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    const e = fromLoginResponse(null, text);
    assert.ok(!isAuthFailure(e), `"${text}" 不能触发熔断，实际 kind=${e.kind}`);
  }
});

test('断网必须被识别成网络类，而不是笼统的 unknown', () => {
  // 只断言"不熔断"是不够的：把所有东西都归成 unknown 也能满足那一条，
  // 但会丢掉 retryable —— 而 DoH 兜底正是靠它决定"要不要再试一次"。
  // 变异 E2（删掉网络层识别）就是靠这条被杀死。
  for (const text of ['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    const e = fromLoginResponse(null, text);
    assert.ok(
      e.kind === 'network-timeout' || e.kind === 'network-error',
      `"${text}" 应归为网络类，实际 ${e.kind}`,
    );
    assert.ok(isRetryable(e), `"${text}" 应标记为可重试（DoH 兜底依据）`);
  }
});

test('未知错误默认不熔断、不重试（保守默认值）', () => {
  const e = normalize(new Error('某个我没见过的错误'));
  assert.strictEqual(e.kind, 'unknown');
  assert.strictEqual(isRetryable(e), false, '不认识的错误不该自动重试');
});

test('ElecError 默认不可重试（可重试必须显式标）', () => {
  assert.strictEqual(new ElecError('auth-failed', 'x').retryable, false);
  assert.strictEqual(new ElecError('network-timeout', 'x', { retryable: true }).retryable, true);
});

// ------------------------------------------------------------ 从原始文本里取 code

test('只给原始文本时也能识别业务码（JSON 没解析成功的情况）', () => {
  assert.ok(isAuthFailure(fromLoginResponse(null, '{"code":"20119999"}')));
  assert.ok(isAuthFailure(fromLoginResponse(null, '{"code":"30610010"}')));
});

test('服务端改文案导致认不出时，业务码仍能兜住', () => {
  // 文案全变了，但 code 还是 20119999 —— 必须仍判为登录失败
  const e = fromLoginResponse({ code: '20119999', message: '完全不同的新文案' }, '');
  assert.strictEqual(e.kind, 'auth-failed');
});

test('成功码被误当失败时不熔断', () => {
  const e = fromLoginResponse({ code: '00000000' }, '');
  assert.strictEqual(e.kind, 'unknown');
  assert.ok(!isAuthFailure(e));
});

// ------------------------------------------------------------ 会话类

test('会话类判定：auth-expired / session-missing 都算，其他不算', () => {
  assert.ok(isSessionGone(new ElecError('auth-expired', 'x')));
  assert.ok(isSessionGone(new ElecError('session-missing', 'x')));
  assert.ok(!isSessionGone(new ElecError('auth-failed', 'x')), '密码错误不能靠重登解决');
  assert.ok(!isSessionGone(new ElecError('network-timeout', 'x')));
  assert.ok(!isSessionGone(null));
});

test('isAuthFailure / isSessionGone 对非 ElecError 安全返回 false', () => {
  for (const v of [null, undefined, 'auth-failed', new Error('x'), 42]) {
    assert.strictEqual(isAuthFailure(v), false);
    assert.strictEqual(isSessionGone(v), false);
    assert.strictEqual(isRetryable(v), false);
    assert.strictEqual(isNetwork(v), false);
  }
});

// ------------------------------------------------------------ normalize

test('normalize：已是 ElecError 时原样返回', () => {
  const e = new ElecError('auth-failed', 'x');
  assert.strictEqual(normalize(e), e);
});

test('normalize：把 parse.js 的 bad-amount / multi-meter 保留下来', () => {
  const a = Object.assign(new Error('金额无法解析'), { kind: 'bad-amount', rawValue: '--' });
  assert.strictEqual(normalize(a).kind, 'bad-amount');

  const m = Object.assign(new Error('多个表具'), { kind: 'multi-meter', count: 3 });
  const n = normalize(m);
  assert.strictEqual(n.kind, 'multi-meter');
  assert.strictEqual(n.count, 3);
});

test('normalize：带业务码的普通 Error 按码推断成会话类', () => {
  const e = Object.assign(new Error('x'), { code: '40320001' });
  assert.strictEqual(normalize(e).kind, 'auth-expired');
});

test('normalize：fetch failed 的普通 Error 归为网络类，不是登录失败', () => {
  const e = new Error('fetch failed');
  e.cause = { code: 'ECONNRESET' };
  const n = normalize(e);
  assert.ok(isNetwork(n), `应为网络类，实际 ${n.kind}`);
  assert.ok(!isAuthFailure(n));
});

test('normalize：完全不认识的东西安全降级为 unknown', () => {
  for (const v of [null, undefined, 'x', 42, {}]) {
    const n = normalize(v);
    assert.strictEqual(n.kind, 'unknown', `normalize(${JSON.stringify(v)}) 的 kind`);
  }
});

// ------------------------------------------------------------ 映射表可审计

test('映射表是可被测试审计的（改了映射会立刻被发现）', () => {
  const { __test } = require('../lib/errors');
  // 这几条是"必须有"的，删掉就会让对应场景失效
  assert.ok(__test.LOGIN_FAILURE_CODES.has('20119999'));
  assert.ok(__test.LOGIN_FAILURE_CODES.has('30610010'));
  assert.ok(__test.SESSION_GONE_CODES.has('40320001'));
  // 登录失败映射不能包含"网络"字样，否则断网会被误熔断
  for (const { re } of __test.LOGIN_FAILURES) {
    assert.ok(!/网络|fetch|timeout|ECONN/i.test(String(re)), `登录失败规则不该匹配网络错误: ${re}`);
  }
});
