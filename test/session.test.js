// 会话编排（lib/session.js）的夹具。
//
// 这是全仓库**最危险的几十行**：它决定什么时候拿真实密码去打学校 SSO。
// 打错了不是显示错误，是把账号锁死——学校 SSO 账号级风控，
// 连错 3 次锁约 90 秒，按账号不按 IP，换网络没用。
//
// 所以这里几乎全在测"不该尝试登录的时候真的没尝试"。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const session = require('../lib/session');
const { ElecError } = require('../lib/errors');
const store = require('../lib/store');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-07T08:00:00Z');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elec-sess-')), 'state.json');
}
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** 造一个 cfg + 可控的 client */
function rig(over = {}) {
  const file = tmpFile();
  const calls = { login: 0 };
  const client = {
    userName: '测试用户',
    login: async () => { calls.login += 1; if (over.loginThrows) throw over.loginThrows; },
  };
  const cfg = {
    paths: { state: file },
    account: { username: 'u', password: 'p' },
    cloud: { stateless: false },
    ...over.cfg,
  };
  const state = { ...store.emptyState(), ...over.state };
  return { cfg, client, state, calls, store, log: silentLog, now: NOW };
}

// ------------------------------------------------------------ 退避曲线

test('退避：6h → 12h → 24h 封顶', () => {
  assert.strictEqual(session.nextLockoutMs(1), 6 * HOUR);
  assert.strictEqual(session.nextLockoutMs(2), 12 * HOUR);
  assert.strictEqual(session.nextLockoutMs(3), 24 * HOUR);
  assert.strictEqual(session.nextLockoutMs(4), 24 * HOUR, '必须封顶在 24 小时');
  assert.strictEqual(session.nextLockoutMs(99), 24 * HOUR);
});

test('退避：异常输入不产生 NaN（NaN 会让熔断彻底失效）', () => {
  for (const bad of [0, -5, null, undefined, NaN, 'x', {}]) {
    const ms = session.nextLockoutMs(bad);
    assert.ok(Number.isFinite(ms) && ms > 0, `nextLockoutMs(${JSON.stringify(bad)}) = ${ms}`);
  }
});

test('退避：单调不减（失败越多只会更久，不会变短）', () => {
  let prev = 0;
  for (let n = 1; n <= 8; n += 1) {
    const ms = session.nextLockoutMs(n);
    assert.ok(ms >= prev, `n=${n} 时退避变短了`);
    prev = ms;
  }
});

// ------------------------------------------------------------ 熔断判定

test('熔断判定：未熔断时不锁', () => {
  assert.strictEqual(session.lockoutStatus({}, NOW).locked, false);
  assert.strictEqual(session.lockoutStatus({ loginLockedUntil: null }, NOW).locked, false);
  assert.strictEqual(session.lockoutStatus({ loginLockedUntil: '' }, NOW).locked, false);
  assert.strictEqual(session.lockoutStatus({ loginLockedUntil: '不是时间' }, NOW).locked, false);
});

test('熔断判定：未来时间点算熔断中，并给出剩余毫秒', () => {
  const until = new Date(NOW + 2 * HOUR).toISOString();
  const r = session.lockoutStatus({ loginLockedUntil: until, loginFailures: 2 }, NOW);
  assert.strictEqual(r.locked, true);
  assert.strictEqual(r.remainingMs, 2 * HOUR);
  assert.ok(r.until instanceof Date);
  assert.strictEqual(r.failures, 2);
});

test('熔断判定：过期时间点不算熔断', () => {
  const until = new Date(NOW - 1000).toISOString();
  assert.strictEqual(session.lockoutStatus({ loginLockedUntil: until }, NOW).locked, false);
});

test('P1-B：状态损坏时必须判为熔断（不能拿可能失效的密码去试）', () => {
  const corrupt = store.corruptState(new Error('坏文件'), NOW);
  const r = session.lockoutStatus(corrupt, NOW);
  assert.strictEqual(r.locked, true, '损坏状态必须阻止登录尝试');
  assert.strictEqual(r.corrupt, true);
  assert.ok(r.remainingMs > 0);
});

// ------------------------------------------------------------ ensure：熔断拦截

test('熔断期内直接抛错，且**一次都不调用 login**', async () => {
  const r = rig({ state: { loginLockedUntil: new Date(NOW + HOUR).toISOString(), loginFailures: 1 } });
  await assert.rejects(() => session.ensure(r.cfg, r), /熔断/);
  assert.strictEqual(r.calls.login, 0, '熔断期内绝不允许碰登录接口');
});

test('熔断错误带 remainingMinutes，方便提示', async () => {
  const r = rig({ state: { loginLockedUntil: new Date(NOW + 2 * HOUR).toISOString(), loginFailures: 1 } });
  try {
    await session.ensure(r.cfg, r);
    assert.fail('应当抛出');
  } catch (e) {
    assert.strictEqual(e.kind, 'lockout-active');
    assert.strictEqual(e.remainingMinutes, 120);
  }
});

// ------------------------------------------------------------ ensure：失败路径

test('凭据错 → 记录失败并落盘，且错误原样抛出', async () => {
  const r = rig({ loginThrows: new ElecError('auth-failed', '用户名或密码不正确') });
  await assert.rejects(() => session.ensure(r.cfg, r), /密码不正确/);
  assert.strictEqual(r.state.loginFailures, 1);
  assert.ok(r.state.loginLockedUntil, '必须写入熔断截止时间');
  // 关键：状态必须真的写进磁盘，不只是改内存
  const onDisk = store.loadState(r.cfg.paths.state, { now: NOW });
  assert.strictEqual(onDisk.loginFailures, 1, '熔断状态必须落盘');
});

test('被锁定 → 同样记录并落盘', async () => {
  const r = rig({ loginThrows: new ElecError('auth-locked', '登录失败次数过多') });
  await assert.rejects(() => session.ensure(r.cfg, r));
  assert.strictEqual(r.state.loginFailures, 1);
  assert.ok(fs.existsSync(r.cfg.paths.state));
});

test('P1-A：stateless 模式下熔断状态**仍然**必须落盘', async () => {
  // 这是阶段 3 的核心修复。旧代码 persistState 在 stateless 时直接 return，
  // 于是失败计数只在内存里涨、从不落盘 → 每次运行都从零开始试登录。
  const r = rig({
    cfg: { cloud: { stateless: true } },
    loginThrows: new ElecError('auth-failed', '密码错误'),
  });
  await assert.rejects(() => session.ensure(r.cfg, r));
  assert.ok(fs.existsSync(r.cfg.paths.state), 'stateless 不是"不记熔断"，安全状态必须落盘');
  assert.strictEqual(store.loadState(r.cfg.paths.state, { now: NOW }).loginFailures, 1);
});

test('网络类失败不计入熔断（断网不是密码错，惩罚账号没有意义）', async () => {
  const r = rig({ loginThrows: new ElecError('network-timeout', '连接超时', { retryable: true }) });
  await assert.rejects(() => session.ensure(r.cfg, r));
  assert.strictEqual(r.state.loginFailures || 0, 0, '网络错误不该抬高失败计数');
  assert.ok(!r.state.loginLockedUntil);
});

test('认不出的错误也不计入熔断（保守默认值）', async () => {
  const r = rig({ loginThrows: new ElecError('unknown', '说不清') });
  await assert.rejects(() => session.ensure(r.cfg, r));
  assert.strictEqual(r.state.loginFailures || 0, 0);
});

test('连续失败时退避递增', async () => {
   const r = rig({ loginThrows: new ElecError('auth-failed', '密码错误') });
  await assert.rejects(() => session.ensure(r.cfg, r));
  assert.strictEqual(r.state.loginFailures, 1);
  const first = Date.parse(r.state.loginLockedUntil);
  // 绕过熔断（模拟时间流逝后再次失败）
  delete r.state.loginLockedUntil;
  await assert.rejects(() => session.ensure(r.cfg, r));
  assert.strictEqual(r.state.loginFailures, 2);
  assert.ok(Date.parse(r.state.loginLockedUntil) > first, '第二次失败应锁更久');
});

// ------------------------------------------------------------ ensure：成功路径

test('登录成功 → 清零熔断并落盘', async () => {
  const r = rig({ state: { loginFailures: 2, lastLoginError: '上次失败' } });
  await session.ensure(r.cfg, r);
  assert.strictEqual(r.calls.login, 1);
  assert.strictEqual(r.state.loginFailures, 0);
  assert.ok(!('loginLockedUntil' in r.state), 'loginLockedUntil 应被删除而不是置空');
  assert.ok(!('lastLoginError' in r.state));
  const onDisk = store.loadState(r.cfg.paths.state, { now: NOW });
  assert.strictEqual(onDisk.loginFailures, 0, '清零也必须落盘（P1-A 的另一半）');
});

test('P1-A（成功侧）：stateless 模式下"清零"同样必须落盘', async () => {
  // 只测失败侧会漏掉这一半：如果成功时不清零，计数只增不减，
  // 退避会从 6h 一路涨到 24h 并且**永不回落**——密码改对了也再也进不去。
  const r = rig({
    cfg: { cloud: { stateless: true } },
    state: { loginFailures: 3, lastLoginError: '之前失败过三次' },
  });
  await session.ensure(r.cfg, r);
  const onDisk = store.loadState(r.cfg.paths.state, { now: NOW });
  assert.strictEqual(onDisk.loginFailures, 0, 'stateless 下登录成功也必须把计数清零并落盘');
});

test('损坏状态下光删时间戳不够，必须显式清标记（--reset-lockout 的语义）', async () => {
  const r = rig({ state: store.corruptState(new Error('坏'), NOW) });
  // 只删 loginLockedUntil：仍然熔断 —— 损坏标记本身就该拦住登录，
  // 否则"手改一个字段"就能绕过安全模式，那安全模式形同虚设。
  await assert.rejects(() => session.ensure(r.cfg, r), /熔断/);
  assert.strictEqual(r.calls.login, 0);

  // 完整清除（等价于 check --reset-lockout）后才能正常登录
  session.clearLoginFailure(r.state);
  await session.ensure(r.cfg, r);
  assert.strictEqual(r.calls.login, 1);
  assert.strictEqual(r.state.stateCorrupt, undefined);
  assert.ok(!('stateCorruptReason' in r.state));
});

test('返回值带 client 与 state，供调用方继续使用', async () => {
  const r = rig();
  const out = await session.ensure(r.cfg, r);
  assert.strictEqual(out.client, r.client);
  assert.strictEqual(out.state, r.state);
});

test('损坏状态下的计数不会再往上加（超出安全整数会丢精度）', () => {
  const s = store.corruptState(new Error('坏'), NOW);
  assert.strictEqual(s.loginFailures, Number.MAX_SAFE_INTEGER);
  session.recordLoginFailure(s, '又失败一次', NOW);
  assert.strictEqual(s.loginFailures, Number.MAX_SAFE_INTEGER, '必须停在安全整数上限，不能溢出成不精确值');
  // 仍然封顶 24 小时
  assert.strictEqual(Date.parse(s.loginLockedUntil) - NOW, 24 * HOUR);
});

test('落盘失败不能掩盖原始登录错误', async () => {
  const r = rig({ loginThrows: new ElecError('auth-failed', '密码错误') });
  // 造一个不可写路径
  r.cfg.paths.state = path.join(tmpFile(), 'deep', 'state.json');
  fs.writeFileSync(tmpFile(), '');
  let threw = null;
  try { await session.ensure(r.cfg, r); } catch (e) { threw = e; }
  assert.ok(threw, '必须抛出');
  assert.match(threw.message, /密码错误/, '应是原始登录错误，不是落盘错误');
});
