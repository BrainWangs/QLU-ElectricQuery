// 纯函数单测：验签、快照统计、等级判定。
// 用 node:test，不引额外依赖（项目本身只依赖 sm-crypto + undici，MD5 用内置 crypto）。
//
// 说明：这里的期望值不是我"觉得应该"的样子，全部是先跑一遍真实代码
// 再抄回来的。凡是有明确坑的地方，注释里写了为什么这么断言。
const test = require('node:test');
const assert = require('node:assert');

const cloud = require('../lib/cloud');
const { signToken } = require('../lib/qlgydx');

// ---------------------------------------------------------------- 验签
//
// 这两条向量的 rand/结构来自对真实请求的抓包，但 body 里的 userInfoId 与电表号
// 已替换成占位值、期望 token 用同一实现重算过，避免把个人身份写进公开仓库。
// 算法本身早在开发阶段用真实抓包对照验证过（token 与浏览器发出的一致）。

test('验签：真实抓包向量 1', () => {
  const body = JSON.stringify({
    merchantId: 111267, userInfoId: 12345678, rechMerMapId: 338, custRechNo: '示例园#1#A101',
  });
  assert.strictEqual(signToken(body, 'eaitfeneaisw7'), 'a7da7f32e34062622a6d1bb410be10bb');
});

test('验签：真实抓包向量 2（换 rand 结果必须变）', () => {
  const body = JSON.stringify({
    merchantId: 111267, userInfoId: 12345678, rechMerMapId: 338, custRechNo: '示例园#1#A101',
  });
  assert.strictEqual(signToken(body, '7vx7lbmsv6omp'), 'fd0f891fd0b95310f9e4b89fb0c907e6');
});

test('验签：rand 只有后 6 位参与计算（前缀随便改不影响结果）', () => {
  const body = '{"a":1}';
  // 两者后 6 位都是 "xyz789"
  assert.strictEqual(
    signToken(body, 'aaaaaaaaaaaxyz789'),
    signToken(body, 'xyz789'),
  );
  // 后 6 位只要有一个字符不同，结果就应该不同
  assert.notStrictEqual(
    signToken(body, 'aaaaaaaaaaaxyz789'),
    signToken(body, 'aaaaaaaaaaaxyz788'),
  );
});

test('验签：body 不同则 token 不同', () => {
  assert.notStrictEqual(
    signToken('{"a":1}', 'abcdef123456'),
    signToken('{"a":2}', 'abcdef123456'),
  );
});

// ---------------------------------------------------------------- 统计

/** 造一批相对"现在"的样本，避免测试随日期失效。 */
function makeHistory(points, startMinutesAgo) {
  const now = Date.now();
  const stepMs = (startMinutesAgo * 60 * 1000) / Math.max(points.length - 1, 1);
  return points.map((balance, i) => ({
    balance,
    queriedAt: new Date(now - startMinutesAgo * 60 * 1000 + i * stepMs).toISOString(),
  }));
}

// 这个用例锁住一个真实发生过的 bug：最初用「窗口首尾相减」算消耗，
// 遇到中间有充值就得出负数消耗（-9.51 元），改成逐样本求差才对。
test('统计：窗口内有充值时，消耗与充值分别累计（不出现负数消耗）', () => {
  const history = makeHistory([52.40, 51.20, 68.30, 68.30], 600);
  const s = cloud.summarize(history, 68.30, 24);

  assert.strictEqual(s.samples, 4);
  assert.ok(s.consumed >= 0, `消耗不能为负，实际 ${s.consumed}`);
  assert.strictEqual(s.consumed, 1.2);     // 52.40 → 51.20
  assert.strictEqual(s.recharged, 17.1);   // 51.20 → 68.30
  assert.ok(s.perDay === null || s.perDay >= 0);
});

test('统计：样本不足 2 条时各统计量为 null（不是 0，避免误报"没用电"）', () => {
  const s = cloud.summarize(makeHistory([10], 60), 10, 24);
  assert.strictEqual(s.samples, 1);
  assert.strictEqual(s.consumed, null);
  assert.strictEqual(s.recharged, null);
  assert.strictEqual(s.perDay, null);
});

test('统计：空历史不报错', () => {
  const s = cloud.summarize([], 68.30, 24);
  assert.strictEqual(s.samples, 0);
  assert.strictEqual(s.consumed, null);
});

test('统计：窗口外的旧样本被排除', () => {
  const now = Date.now();
  const history = [
    { balance: 100, queriedAt: new Date(now - 72 * 3600 * 1000).toISOString() }, // 72h 前，排除
    { balance: 80, queriedAt: new Date(now - 3600 * 1000).toISOString() },
    { balance: 70, queriedAt: new Date(now).toISOString() },
  ];
  const s = cloud.summarize(history, 70, 24);
  assert.strictEqual(s.samples, 2, '只应统计 24h 内的 2 条');
  assert.strictEqual(s.consumed, 10);
});

test('统计：坏样本（缺 balance / 坏时间戳）被跳过而不是崩', () => {
  const now = Date.now();
  const history = [
    { balance: 50, queriedAt: new Date(now - 3600 * 1000).toISOString() },
    { balance: 'abc', queriedAt: new Date(now).toISOString() },   // balance 不是数字
    { queriedAt: new Date(now).toISOString() },                    // 缺 balance
    { balance: 40, queriedAt: 'not-a-date' },                      // 坏时间戳
    { balance: 30, queriedAt: new Date(now).toISOString() },
  ];
  const s = cloud.summarize(history, 30, 24);
  assert.strictEqual(s.samples, 2);
  assert.strictEqual(s.consumed, 20);
});

// ---------------------------------------------------------------- 预测

test('预测：perDay 为 0 / 空时返回 null 而不是 Infinity', () => {
  assert.strictEqual(cloud.forecast(68.30, 0), null);
  assert.strictEqual(cloud.forecast(68.30, null), null);
  assert.strictEqual(cloud.forecast(68.30, undefined), null);
});

test('预测：余额不是数字时返回 null', () => {
  assert.strictEqual(cloud.forecast(null, 7.81), null);
  assert.strictEqual(cloud.forecast(undefined, 7.81), null);
});

test('预测：正常情况返回保留一位小数的 number', () => {
  assert.strictEqual(cloud.forecast(68.30, 7.81), 8.7);
});

// ---------------------------------------------------------------- 等级

test('等级：按阈值判 critical / warn / ok / unknown', () => {
  const cfg = { alert: { threshold: 10, criticalThreshold: 5 } };
  assert.strictEqual(cloud.levelOf(3, cfg), 'critical');
  assert.strictEqual(cloud.levelOf(5, cfg), 'warn');      // 5 不 < 5，落到 warn 档
  assert.strictEqual(cloud.levelOf(9.99, cfg), 'warn');
  assert.strictEqual(cloud.levelOf(10, cfg), 'ok');       // 10 不 < 10
  assert.strictEqual(cloud.levelOf(68.30, cfg), 'ok');
  assert.strictEqual(cloud.levelOf(null, cfg), 'unknown');
});

// ---------------------------------------------------------------- 快照

const baseCfg = { alert: { threshold: 10, criticalThreshold: 5 }, meter: { custRechNo: '示例园#1#A101' } };
const baseResult = {
  balance: 68.30,
  location: '示例校区学生公寓.示例园1号公寓A区.3楼.A101',
  meterAddress: '152200063392',
  unit: '开户',
  custRechNo: '示例园#1#A101',
  queriedAt: new Date().toISOString(),
};

test('快照：字段齐全，recent 倒序且最多 48 条', () => {
  const history = makeHistory(
    Array.from({ length: 100 }, (_, i) => 100 - i),
    3000,
  );
  const snap = cloud.buildSnapshot({ result: baseResult, cfg: baseCfg, history, alerts: [], state: {} });

  assert.strictEqual(snap.version, cloud.SNAPSHOT_VERSION);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.balance, 68.30);
  assert.strictEqual(snap.level, 'ok');
  assert.strictEqual(snap.recent.length, 48, 'recent 应截断到 48 条');
  assert.ok(
    Date.parse(snap.recent[0].at) >= Date.parse(snap.recent[1].at),
    'recent 必须是倒序（最新在前）',
  );
  assert.ok(snap.stats.last24h, 'stats.last24h 必须存在');
  assert.ok('forecastDays' in snap.stats);
});

test('快照：查询失败时保留上次余额，ok=false', () => {
  const snap = cloud.buildFailureSnapshot({
    cfg: baseCfg,
    error: '网络超时',
    lastOk: { balance: 52.40, location: '示例校区', queriedAt: '2026-10-31T14:55:00.000Z' },
  });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, '网络超时');
  assert.strictEqual(snap.balance, 52.40, '失败时应保留上次余额，别让 App 显示空');
  assert.strictEqual(snap.level, 'unknown');
});

test('快照：从未成功过时 balance 为 null 而不是崩', () => {
  const snap = cloud.buildFailureSnapshot({ cfg: baseCfg, error: 'x', lastOk: null });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.balance, null);
});

// ---------------------------------------------------------------- 短地址

test('短地址：长路径压成「校区-园区楼号房号」', () => {
  // 站点实际返回的长路径
  assert.strictEqual(
    cloud.shortLocation('示例校区学生公寓.示例园1号公寓A区.3楼.A101'),
    '示例校区-示例园1A101',
  );
  assert.strictEqual(
    cloud.shortLocation('示例校区学生公寓.示例园1号公寓B区.12楼.B102'),
    '示例校区-示例园1B102',
  );
});

test('短地址：没有区字母时不重复拼', () => {
  // A 区 + 301 房 → 区字母不能丢
  assert.strictEqual(
    cloud.shortLocation('示例校区学生公寓.示例园1号公寓A区.3楼.301'),
    '示例校区-示例园1A301',
  );
  // 房号本身已带 B，B 区不再重复
  assert.strictEqual(
    cloud.shortLocation('示例校区学生公寓.示例园1号公寓B区.5楼.B501'),
    '示例校区-示例园1B501',
  );
});

test('短地址：缺 location 时退回电表号，不返回 null', () => {
  assert.strictEqual(cloud.shortLocation(null, '测试园#1#A101'), '测试园#1#A101');
  assert.strictEqual(cloud.shortLocation('', '测试园#1#A101'), '测试园#1#A101');
});

test('短地址：段数不足时原样返回，不瞎猜', () => {
  assert.strictEqual(cloud.shortLocation('示例校区'), '示例校区');
});

// ---------------------------------------------------------------- 掉电检测窗口

test('掉电检测：只比 24h 内的样本，7 天前的高余额不参与', () => {
  const store = require('../lib/alert');
  const cfg = {
    alert: { threshold: 10, criticalThreshold: 5, dailyChangePercent: 40, cooldownMinutes: 180, repeatWhileCriticalMinutes: 720 },
  };
  const now = Date.now();
  // 7 天前余额 200（不能作为基准），24h 内余额 60 → 61
  const history = [
    { queriedAt: new Date(now - 7 * 86400000).toISOString(), balance: 200 },
    { queriedAt: new Date(now - 20 * 3600000).toISOString(), balance: 60 },
    { queriedAt: new Date(now - 2 * 3600000).toISOString(), balance: 59 },
  ];
  const state = store.emptyState();
  const alerts = store.evaluate(
    { balance: 59, location: '示例校区学生公寓.示例园1号公寓A区.3楼.A101', custRechNo: '测试园#1#A101' },
    cfg, state, history,
  );
  // 相对 24h 内的 60 只跌了 1.7%，不该报掉电；若拿 7 天前的 200 当基准会误报
  assert.ok(!alerts.some((a) => a.rule === 'drop'), '不该把 7 天前的余额当 24h 基准');
});
