// 状态层（state.json）的读取安全与 dry-run 零副作用。
//
// 这两条都来自"静默失败"家族，报错信息里看不出问题：
//
// 1. `state.json` 损坏时，旧实现 catch 后返回空状态 —— 等于把登录熔断清零。
//    学校 SSO 错 3 次密码锁号 90 秒且按账号锁，所以"熔断被清零"不是数据问题，
//    是会把账号反复锁死的操作事故。
// 2. `--dry-run` 曾经真的改状态：`evaluate()` 内部会 mark() 写 `lastAlertAt`，
//    dry-run 跑一次就吃掉随后 3 小时的冷却窗口，之后真跑该发的预警一条都不发，
//    而且完全不报错。docs/github-actions.md 还教用户"先 --dry-run 验证一次"。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadState, evaluate, emptyState } = require('../lib/alert');

const NOW = 1700000000000;

function tmpState(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elec-state-'));
  const file = path.join(dir, 'state.json');
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8');
  return {
    file,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ------------------------------------------------------------ 损坏的安全模式

test('loadState：坏 JSON 必须进入安全模式，不得把熔断清零', () => {
  const t = tmpState('{ 这不是合法 JSON');
  try {
    const s = loadState(t.file, { now: NOW });
    assert.strictEqual(s.stateCorrupt, true, '必须带 stateCorrupt 标记，不能静默');
    assert.ok(s.loginLockedUntil, '必须给出熔断截止时间，否则会立刻重试登录');
    assert.ok(Date.parse(s.loginLockedUntil) > NOW, '熔断截止时间必须在未来');
    assert.ok(s.loginFailures > 0, 'loginFailures 不得被清零');
  } finally { t.cleanup(); }
});

test('loadState：安全模式的熔断时长为 24 小时封顶值', () => {
  const t = tmpState(']]]');
  try {
    const s = loadState(t.file, { now: NOW });
    const ms = Date.parse(s.loginLockedUntil) - NOW;
    assert.strictEqual(ms, 24 * 3600 * 1000);
  } finally { t.cleanup(); }
});

test('loadState：损坏时 onCorrupt 回调必须被调用（便于上层告警）', () => {
  const t = tmpState('{bad');
  try {
    let seen = null;
    loadState(t.file, { now: NOW, onCorrupt: e => { seen = e; } });
    assert.ok(seen instanceof Error, 'onCorrupt 应收到解析异常');
  } finally { t.cleanup(); }
});

test('loadState：文件不存在 = 首次运行，不是损坏', () => {
  const t = tmpState(undefined);
  try {
    const s = loadState(t.file, { now: NOW });
    assert.ok(!s.stateCorrupt, '不存在的文件不能算损坏（首次运行很常见）');
    assert.ok(!s.loginLockedUntil, '首次运行不该被熔断');
  } finally { t.cleanup(); }
});

test('loadState：空文件 / 纯空白 = 首次运行，不是损坏', () => {
  const t = tmpState('   \n\t ');
  try {
    const s = loadState(t.file, { now: NOW });
    assert.ok(!s.stateCorrupt);
    assert.ok(!s.loginLockedUntil);
  } finally { t.cleanup(); }
});

test('loadState：顶层是数组也算损坏（不能当成对象展开）', () => {
  const t = tmpState('[1,2,3]');
  try {
    assert.strictEqual(loadState(t.file, { now: NOW }).stateCorrupt, true);
  } finally { t.cleanup(); }
});

test('loadState：lastAlertAt 被污染成字符串时重置为 {}（否则 evaluate 崩溃）', () => {
  const t = tmpState(JSON.stringify({ lastAlertAt: 'oops', loginFailures: 2 }));
  try {
    const s = loadState(t.file, { now: NOW });
    assert.deepStrictEqual(s.lastAlertAt, {});
    assert.strictEqual(s.loginFailures, 2, '正常的熔断计数要保留');
    assert.ok(!s.stateCorrupt, '这种情况不算整个文件损坏');
  } finally { t.cleanup(); }
});

test('loadState：正常文件原样读出，不被安全模式误伤', () => {
  const t = tmpState(JSON.stringify({ lastAlertAt: { low: 123 }, loginFailures: 0, lastBalance: 65 }));
  try {
    const s = loadState(t.file, { now: NOW });
    assert.ok(!s.stateCorrupt);
    assert.deepStrictEqual(s.lastAlertAt, { low: 123 });
    assert.strictEqual(s.lastBalance, 65);
  } finally { t.cleanup(); }
});

// ------------------------------------------------------------ dry-run 零副作用

test('evaluate 确实会写 state（所以 dry-run 必须传副本）', () => {
  // 这条不是测 evaluate"应该"改 state，而是钉住"它一定会改"这个事实。
  // 只要它还会改，dry-run 就不能把真实 state 传进去。
  const cfg = {
    alert: {
      threshold: 10, criticalThreshold: 5, dailyChangePercent: 40,
      cooldownMinutes: 180, repeatWhileCriticalMinutes: 720,
    },
  };
  const st = emptyState();
  const r = { balance: 3.2, custRechNo: '测试园#1#A101', location: '测试校区.测试园1号.3楼.A101' };

  const before = JSON.stringify(st);
  const alerts = evaluate(r, cfg, st, []);
  assert.notStrictEqual(JSON.stringify(st), before, 'evaluate 应当写 lastAlertAt');
  assert.ok(alerts.length > 0, '低于严重阈值应当有告警');
});

test('dry-run 的隔离手法：传副本时真实 state 不被污染，且告警结果一致', () => {
  const cfg = {
    alert: {
      threshold: 10, criticalThreshold: 5, dailyChangePercent: 40,
      cooldownMinutes: 180, repeatWhileCriticalMinutes: 720,
    },
  };
  const r = { balance: 3.2, custRechNo: '测试园#1#A101', location: '测试校区.测试园1号.3楼.A101' };

  // 真实路径
  const real = emptyState();
  const realAlerts = evaluate(r, cfg, real, []);

  // dry-run 路径（bin/elec.js 用的就是 structuredClone）
  const dry = emptyState();
  const snapshotBefore = JSON.stringify(dry);
  const dryAlerts = evaluate(r, cfg, structuredClone(dry), []);
  assert.strictEqual(JSON.stringify(dry), snapshotBefore, 'dry-run 后真实 state 必须一字不变');

  // 但 dry-run 必须能看到"将会发什么"
  assert.deepStrictEqual(
    dryAlerts.map(a => a.level),
    realAlerts.map(a => a.level),
    'dry-run 的预演结果必须与真跑一致',
  );
});
