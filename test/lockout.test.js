// 登录熔断的单测。
//
// 这是整个项目里唯一"失败会造成真实伤害"的逻辑：学校 SSO 的风控是按账号
// 计数锁定的（密码连错 3 次就进验证码状态，此后正确密码也登不上，约 90 秒
// 恢复）。定时任务每 2 小时跑一次，如果密码被改而程序还在无脑重试，就会
// 把用户自己的账号反复锁死 —— 连手动登录教务都进不去。
//
// 所以这里的行为必须被测试钉死，不能靠"读代码觉得没问题"。
const test = require('node:test');
const assert = require('node:assert');

const {
  lockoutHours, checkLoginLockout, recordLoginFailure, clearLoginFailure, AUTH_FAIL_RE,
} = require('../bin/elec.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ------------------------------------------------------------ 熔断时长

test('熔断时长：首次 6 小时，每次翻倍，上限 24 小时', () => {
  assert.strictEqual(lockoutHours(1), 6);
  assert.strictEqual(lockoutHours(2), 12);
  assert.strictEqual(lockoutHours(3), 24);
  // 翻倍不能突破上限——否则失败多了会熔断一周，用户改完密码也得干等
  assert.strictEqual(lockoutHours(4), 24);
  assert.strictEqual(lockoutHours(99), 24);
});

test('熔断时长：计数异常（0/负数）也不能算出 0 或负数', () => {
  // Math.max(0, fails-1) 兜底，保证至少 6 小时
  assert.strictEqual(lockoutHours(0), 6);
  assert.strictEqual(lockoutHours(-5), 6);
});

// ------------------------------------------------------------ 状态判定

test('熔断判定：没有熔断字段时放行', () => {
  assert.strictEqual(checkLoginLockout({}).locked, false);
  assert.strictEqual(checkLoginLockout({ loginLockedUntil: null }).locked, false);
});

test('熔断判定：未来时间点算熔断中，并给出剩余毫秒', () => {
  const state = { loginLockedUntil: new Date(Date.now() + 2 * HOUR).toISOString() };
  const r = checkLoginLockout(state);
  assert.strictEqual(r.locked, true);
  assert.ok(r.until instanceof Date);
  // 允许 5 秒误差，避免测试本身因运行耗时抖动
  assert.ok(Math.abs(r.remainingMs - 2 * HOUR) < 5000, `剩余 ${r.remainingMs} 应接近 2 小时`);
});

test('熔断判定：已经过去的时间点算解除（时间到了要能自动恢复）', () => {
  const state = { loginLockedUntil: new Date(Date.now() - 1000).toISOString() };
  assert.strictEqual(checkLoginLockout(state).locked, false);
});

test('熔断判定：时间戳损坏时按"未熔断"处理，不能把程序永久卡死', () => {
  // 宁可多试一次登录，也不能因为 state 文件里一个坏字符串就永远不再查询
  assert.strictEqual(checkLoginLockout({ loginLockedUntil: '不是时间' }).locked, false);
  assert.strictEqual(checkLoginLockout({ loginLockedUntil: '' }).locked, false);
});

// ------------------------------------------------------------ 记录与清除

test('记录失败：累加计数、写入熔断时间、保留错误原文', () => {
  const state = {};
  const r = recordLoginFailure(state, '登录失败: 用户名或密码不正确');
  assert.strictEqual(state.loginFailures, 1);
  assert.strictEqual(r.hours, 6);
  assert.strictEqual(state.lastLoginError, '登录失败: 用户名或密码不正确');
  assert.strictEqual(checkLoginLockout(state).locked, true);

  // 第二次失败：计数变 2，熔断翻倍到 12 小时
  const r2 = recordLoginFailure(state, 'again');
  assert.strictEqual(state.loginFailures, 2);
  assert.strictEqual(r2.hours, 12);
});

test('记录失败：错误信息超长要截断（state 文件不能被一行报错撑爆）', () => {
  const state = {};
  recordLoginFailure(state, 'x'.repeat(1000));
  assert.strictEqual(state.lastLoginError.length, 300);
});

test('清除熔断：计数归零且字段被删掉，之后判定为放行', () => {
  const state = {};
  recordLoginFailure(state, '登录失败');
  recordLoginFailure(state, '登录失败');
  assert.strictEqual(checkLoginLockout(state).locked, true);

  clearLoginFailure(state);
  assert.strictEqual(state.loginFailures, 0);
  assert.ok(!('loginLockedUntil' in state), 'loginLockedUntil 应被删除而不是置空');
  assert.ok(!('lastLoginError' in state));
  assert.strictEqual(checkLoginLockout(state).locked, false);
});

// ------------------------------------------------------------ 错误识别

test('识别登录类失败：凭据错与被风控锁定都要算', () => {
  // 这两个是真实抓到的服务端响应，不能只靠中文文案判断
  assert.strictEqual(AUTH_FAIL_RE.test('登录失败: 用户名或密码不正确'), true);
  assert.strictEqual(AUTH_FAIL_RE.test('登录失败次数过多，需要输入验证码'), true);
  assert.strictEqual(AUTH_FAIL_RE.test('{"code":"20119999"}'), true);
  assert.strictEqual(AUTH_FAIL_RE.test('{"code":"30610010"}'), true);
});

test('识别登录类失败：网络抖动不算登录失败（不能因断网就熔断 24 小时）', () => {
  assert.strictEqual(AUTH_FAIL_RE.test('fetch failed'), false);
  assert.strictEqual(AUTH_FAIL_RE.test('ECONNRESET'), false);
  assert.strictEqual(AUTH_FAIL_RE.test('socket hang up'), false);
  assert.strictEqual(AUTH_FAIL_RE.test('接口超时'), false);
});
