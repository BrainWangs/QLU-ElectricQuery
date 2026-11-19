// 持久化层（lib/store.js）的夹具。
//
// 这一层的价值不在"能存能读"，而在**失败时的行为**：
// state.json 里存的是登录熔断计数，读不出来就等于"从没熔断过"，
// 程序会拿可能已失效的密码继续打学校 SSO，把账号锁死。
// 所以这里的重点全是异常路径。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STATE_VERSION, StoreCorrupt, migrate, emptyState, corruptState,
  loadState, saveState, appendHistory, readHistory, MIGRATIONS,
} = require('../lib/store');

const NOW = Date.parse('2026-11-07T08:00:00Z');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elec-store-'));
}
function tmpFile(name = 'state.json') {
  return path.join(tmpDir(), name);
}

// ------------------------------------------------------------ 版本与迁移

test('版本号：当前是 2，且每个旧版本都有迁移函数', () => {
  assert.strictEqual(STATE_VERSION, 2);
  for (let v = 1; v < STATE_VERSION; v += 1) {
    assert.strictEqual(typeof MIGRATIONS[v], 'function', `缺少 v${v} 的迁移函数`);
  }
});

test('迁移：无 version 字段的老数据按 v1 处理，升到当前版本', () => {
  const out = migrate({ lastAlertAt: { low: 1 }, lastBalance: 12.5 });
  assert.strictEqual(out.version, STATE_VERSION);
  assert.strictEqual(out.lastBalance, 12.5);
  assert.deepStrictEqual(out.lastAlertAt, { low: 1 });
});

test('迁移：v1 升级后补上 v2 才有的字段', () => {
  const out = migrate({ version: 1, lastAlertAt: {} });
  assert.strictEqual(out.consecutiveErrors, 0);
  assert.ok('lastAlertLevel' in out);
});

test('迁移：已经是当前版本时原样通过（幂等）', () => {
  const data = { version: STATE_VERSION, lastBalance: 5 };
  assert.strictEqual(migrate(data).version, STATE_VERSION);
  assert.strictEqual(migrate(migrate(data)).lastBalance, 5);
});

test('迁移：未来版本必须拒绝，不能瞎猜', () => {
  // 旧程序读新文件时若"尽力而为"，会把新字段写丢
  assert.throws(() => migrate({ version: STATE_VERSION + 1 }), StoreCorrupt);
});

// ------------------------------------------------------------ 损坏 vs 首次运行

test('首次运行：文件不存在 → 空状态，不是损坏', () => {
  const s = loadState(tmpFile('not-exist.json'));
  assert.strictEqual(s.stateCorrupt, undefined);
  assert.strictEqual(s.version, STATE_VERSION);
  assert.ok(!s.loginLockedUntil);
});

test('空文件 / 全空白 → 空状态，不是损坏', () => {
  for (const body of ['', '   ', '\n\t\n']) {
    const f = tmpFile();
    fs.writeFileSync(f, body);
    const s = loadState(f);
    assert.strictEqual(s.stateCorrupt, undefined, `"${body}" 不该被判损坏`);
  }
});

test('内容损坏 → 安全模式，且不清零熔断', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ 这不是合法 JSON');
  const s = loadState(f, { now: NOW });
  assert.strictEqual(s.stateCorrupt, true);
  assert.ok(s.loginLockedUntil, '必须给出熔断截止时间，否则会立刻重试登录');
  assert.ok(Date.parse(s.loginLockedUntil) > NOW, '熔断截止时间必须在未来');
  assert.ok(s.loginFailures > 0, 'loginFailures 不得被清零');
});

test('顶层是数组也算损坏（不能当成状态对象）', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '[1,2,3]');
  assert.strictEqual(loadState(f, { now: NOW }).stateCorrupt, true);
});

test('损坏时 onCorrupt 回调必须被调用（不能静默）', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'broken');
  let called = 0;
  loadState(f, { now: NOW, onCorrupt: () => { called += 1; } });
  assert.strictEqual(called, 1);
});

test('corruptState：熔断时长是封顶的 24 小时', () => {
  const s = corruptState(new Error('x'), NOW);
  const ms = Date.parse(s.loginLockedUntil) - NOW;
  assert.strictEqual(ms, 24 * 3600 * 1000);
});

// ------------------------------------------------------------ 原子写

test('原子写：正常写入后可完整读出', () => {
  const f = tmpFile();
  saveState(f, { ...emptyState(), lastBalance: 44.27 });
  const s = loadState(f);
  assert.strictEqual(s.lastBalance, 44.27);
});

test('原子写：不留下临时文件（成功路径必须清理干净）', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'state.json');
  saveState(f, emptyState());
  const leftovers = fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `残留临时文件: ${leftovers.join(', ')}`);
});

test('原子写：覆盖写入不会产生半个文件（旧内容要么在、要么被整体替换）', () => {
  const f = tmpFile();
  saveState(f, { ...emptyState(), lastBalance: 1 });
  saveState(f, { ...emptyState(), lastBalance: 2 });
  // 关键是能被完整解析 —— 非原子写在这里可能出现截断
  const s = loadState(f);
  assert.strictEqual(s.lastBalance, 2);
  assert.strictEqual(s.stateCorrupt, undefined);
});

test('原子写：目录不存在时自动创建', () => {
  const f = path.join(tmpDir(), 'nested', 'deep', 'state.json');
  saveState(f, emptyState());
  assert.ok(fs.existsSync(f));
});

test('原子写：写失败时不留临时文件，且原文件不受损', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'state.json');
  saveState(f, { ...emptyState(), lastBalance: 7 });
  // 造一个循环引用让 JSON.stringify 抛错
  const bad = { ...emptyState() };
  bad.self = bad;
  assert.throws(() => saveState(f, bad));
  const s = loadState(f);
  assert.strictEqual(s.lastBalance, 7, '旧内容必须完好');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
});

// ------------------------------------------------------------ 历史 I/O

test('历史：追加与按时间窗读取', () => {
  const f = tmpFile('history.jsonl');
  appendHistory(f, { queriedAt: '2026-11-07T07:00:00Z', balance: 50 });
  appendHistory(f, { queriedAt: '2026-11-06T07:00:00Z', balance: 60 });
  const rows = readHistory(f, 24, { now: NOW });
  assert.strictEqual(rows.length, 1, '只应返回 24 小时内的');
  assert.strictEqual(rows[0].balance, 50);
});

test('历史：坏行被跳过，不影响其它行', () => {
  const f = tmpFile('history.jsonl');
  fs.writeFileSync(f, [
    '{"queriedAt":"2026-11-07T07:00:00Z","balance":50}',
    '{ 坏行',
    '',
    '{"queriedAt":"2026-11-07T07:30:00Z","balance":40}',
  ].join('\n'));
  const rows = readHistory(f, 24, { now: NOW });
  assert.strictEqual(rows.length, 2);
});

test('历史：文件不存在时返回空数组而不是崩', () => {
  assert.deepStrictEqual(readHistory(tmpFile('nope.jsonl'), 24), []);
});

test('历史：没有 queriedAt 的行被丢弃（无法判断时间窗）', () => {
  const f = tmpFile('history.jsonl');
  appendHistory(f, { balance: 50 });
  assert.deepStrictEqual(readHistory(f, 24, { now: NOW }), []);
});
