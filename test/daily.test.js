// 按天聚合与热力图（lib/daily.js + scripts/render-heatmap.js）的夹具。
//
// 这一层的存在原因（真实观测，不是假想）：
// 上游电费服务**每天只更新一次余额**。实测同一天 10 次查询拿到的余额完全相同
// （例如 2026-11-07 的 10 条样本全是 44.27）。
// 直接把这些样本画成折线，点会在同一水平线上重合、数值标注互相压住。
//
// 所以必须按时区对齐到"天"，每天只取一个点。
// 而"每天消耗了多少"的口径也随之确定：**当天日末 与 前一天日末 的差**，
// 不能用"当天首尾差"（同一天内余额不变，首尾差恒为 0）。
const test = require('node:test');
const assert = require('node:assert');

const {
  dayKeyOf, groupByDay, dailyLast, dailyConsumption, detectRecharges, TZ_OFFSET_MS,
} = require('../lib/daily');
const { renderHeatmap, buildScale, SCALE_COLORS, COLOR_NULL } = require('../scripts/render-heatmap');

/** 造一条样本 */
const row = (iso, balance) => ({ queriedAt: iso, balance });

/** 北京时间的某天某点 → UTC ISO 字符串 */
function bj(day, hour = 12, minute = 0) {
  const [y, m, d] = day.split('-').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hour, minute) - TZ_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

// ------------------------------------------------------------ 时区对齐

test('dayKeyOf：北京时间凌晨 0 点仍算当天（不能按 UTC 切）', () => {
  // 北京 2026-11-07 00:30 = UTC 2026-11-06 16:30
  // 若按 UTC 切，这条会被算成 11-06，导致"每天一个点"错位一天
  const iso = bj('2026-11-07', 0, 30);
  assert.strictEqual(dayKeyOf(iso), '2026-11-07');
});

test('dayKeyOf：北京时间 23:59 仍算当天', () => {
  assert.strictEqual(dayKeyOf(bj('2026-11-07', 23, 59)), '2026-11-07');
});

test('dayKeyOf：非法输入返回空串而不是崩', () => {
  for (const bad of [null, undefined, '', 'not-a-date', NaN]) {
    assert.strictEqual(dayKeyOf(bad), '');
  }
});

// ------------------------------------------------------------ 按天分组

test('groupByDay：同一天多条只留一个组，first/last 正确', () => {
  const rows = [
    row(bj('2026-11-07', 8), 50),
    row(bj('2026-11-07', 12), 48),
    row(bj('2026-11-07', 20), 44),
    row(bj('2026-11-08', 12), 40),
  ];
  const g = groupByDay(rows);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].day, '2026-11-07');
  assert.strictEqual(g[0].samples, 3);
  assert.strictEqual(g[0].first.balance, 50, 'first 应是当天最早那条');
  assert.strictEqual(g[0].last.balance, 44, 'last 应是当天最晚那条');
});

test('groupByDay：输入乱序也能正确找出 first/last', () => {
  const rows = [
    row(bj('2026-11-07', 20), 44),
    row(bj('2026-11-07', 8), 50),
    row(bj('2026-11-07', 12), 48),
  ];
  const g = groupByDay(rows);
  assert.strictEqual(g[0].first.balance, 50);
  assert.strictEqual(g[0].last.balance, 44);
});

test('groupByDay：坏样本被跳过，不影响其它行', () => {
  const rows = [
    row(bj('2026-11-07', 8), 50),
    { queriedAt: bj('2026-11-07', 9), balance: NaN },
    { queriedAt: 'bad', balance: 10 },
    null,
    { queriedAt: bj('2026-11-07', 10) },   // 缺 balance
    row(bj('2026-11-07', 12), 48),
  ];
  const g = groupByDay(rows);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].samples, 2);
});

test('groupByDay：兼容 render-chart 的 {t, balance} 形态', () => {
  // render-chart 的 parseHistory 返回 { t: 毫秒, balance }。
  // 若只认 queriedAt，两个模块拼接时会静默返回 0 天（实测踩过）。
  const rows = [
    { t: Date.parse(bj('2026-11-07', 8)), balance: 50 },
    { t: Date.parse(bj('2026-11-07', 20)), balance: 44 },
  ];
  const g = groupByDay(rows);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].last.balance, 44);
});

// ------------------------------------------------------------ dailyLast

test('dailyLast：每天只留一个点，且带 renderChart 需要的 t 字段', () => {
  const rows = [
    row(bj('2026-11-07', 8), 50),
    row(bj('2026-11-07', 12), 48),
    row(bj('2026-11-07', 20), 44),
    row(bj('2026-11-08', 12), 40),
  ];
  const out = dailyLast(rows);
  assert.strictEqual(out.length, 2, '4 条样本 → 2 天 → 2 个点');
  assert.strictEqual(out[0].balance, 44, '取当天最后一条');
  assert.strictEqual(typeof out[0].t, 'number', '必须有 t（毫秒），否则 renderChart 画不出来');
  assert.ok(Number.isFinite(out[0].t));
});

// ------------------------------------------------------------ dailyConsumption（核心口径）

test('日消耗：用「前一天日末 - 当天日末」，不是当天首尾差', () => {
  // 这是本项目最容易搞错的一处。上游每天只更新一次，
  // 同一天内余额完全相同 → 当天首尾差恒为 0，热力图会一片空白。
  const rows = [
    row(bj('2026-11-06', 12), 50),
    row(bj('2026-11-07', 8), 44),    // 同一天两条，值相同
    row(bj('2026-11-07', 20), 44),
    row(bj('2026-11-08', 12), 40),
  ];
  const days = dailyConsumption(rows, { days: 3, now: new Date(bj('2026-11-08', 23)) });
  const d07 = days.find(x => x.day === '2026-11-07');
  const d08 = days.find(x => x.day === '2026-11-08');
  assert.strictEqual(d07.consumed, 6, '50 - 44 = 6');
  assert.strictEqual(d08.consumed, 4, '44 - 40 = 4');
});

test('日消耗：充值为负值（当天涨了），不能当消耗', () => {
  const rows = [
    row(bj('2026-11-07', 12), 10),
    row(bj('2026-11-08', 12), 60),   // 充了 50
  ];
  const days = dailyConsumption(rows, { days: 2, now: new Date(bj('2026-11-08', 23)) });
  const d08 = days.find(x => x.day === '2026-11-08');
  assert.strictEqual(d08.consumed, -50, '上涨应表示为负数，由调用方渲染成"充值"');
});

test('日消耗：缺失前一天数据时 consumed 为 null（不是 0）', () => {
  // null 和 0 必须区分：0 表示"真的没用电"，null 表示"算不出来"。
  // 混在一起会让热力图把"没数据"画成"没用电"，误导用户。
  const rows = [row(bj('2026-11-08', 12), 40)];
  const days = dailyConsumption(rows, { days: 2, now: new Date(bj('2026-11-08', 23)) });
  const d08 = days.find(x => x.day === '2026-11-08');
  assert.strictEqual(d08.consumed, null);
});

test('日消耗：返回的日期序列连续，且以 now 那天结尾', () => {
  const now = new Date(bj('2026-11-10', 23));
  const days = dailyConsumption([], { days: 5, now });
  assert.strictEqual(days.length, 5, '5 天窗口应返回 5 条（含无数据的）');
  assert.strictEqual(days[days.length - 1].day, '2026-11-10', '最后一条应是今天');
  // 日期必须连续递增
  for (let i = 1; i < days.length; i += 1) {
    assert.ok(days[i].day > days[i - 1].day, '日期应递增');
  }
});

test('日消耗：窗口外的老数据不参与', () => {
  const rows = [
    row(bj('2026-10-01', 12), 100),
    row(bj('2026-11-09', 12), 50),
    row(bj('2026-11-10', 12), 45),
  ];
  const days = dailyConsumption(rows, { days: 3, now: new Date(bj('2026-11-10', 23)) });
  assert.strictEqual(days.find(x => x.day === '2026-11-10').consumed, 5);
});

// ------------------------------------------------------------ 充值检测（回答问题"能不能识别充值"）

test('充值检测：余额上涨判为充值，金额正确', () => {
  const rows = [
    row(bj('2026-11-07', 12), 10),
    row(bj('2026-11-08', 12), 60),
    row(bj('2026-11-09', 12), 55),
  ];
  const r = detectRecharges(rows);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].amount, 50);
  assert.strictEqual(r[0].from, 10);
  assert.strictEqual(r[0].to, 60);
});

test('充值检测：微小上涨不算充值（可能是上游数值抖动）', () => {
  const rows = [
    row(bj('2026-11-07', 12), 50),
    row(bj('2026-11-07', 20), 50.2),   // 涨 0.2，低于默认阈值 0.5
  ];
  assert.deepStrictEqual(detectRecharges(rows), []);
});

test('充值检测：可自定义阈值', () => {
  const rows = [
    row(bj('2026-11-07', 12), 50),
    row(bj('2026-11-07', 20), 50.2),
  ];
  assert.strictEqual(detectRecharges(rows, { minAmount: 0.1 }).length, 1);
});

test('充值检测：连续下跌不产生充值记录', () => {
  const rows = [
    row(bj('2026-11-07', 12), 50),
    row(bj('2026-11-08', 12), 45),
    row(bj('2026-11-09', 12), 40),
  ];
  assert.deepStrictEqual(detectRecharges(rows), []);
});

test('充值检测：gapDays 记录跨了几天，便于判断延迟', () => {
  const rows = [
    row(bj('2026-11-06', 12), 10),
    row(bj('2026-11-08', 12), 60),
  ];
  const r = detectRecharges(rows);
  assert.strictEqual(r[0].gapDays, 2);
});

// ------------------------------------------------------------ 热力图分档（自适应）

test('分档：按窗口内实际最大值线性分档', () => {
  const days = [{ consumed: 0 }, { consumed: 2.5 }, { consumed: 5 }, { consumed: 7.5 }, { consumed: 10 }];
  const s = buildScale(days, 5);
  assert.strictEqual(s.max, 10);
  assert.deepStrictEqual(s.thresholds, [0, 2, 4, 6, 8]);
  assert.strictEqual(s.levelOf(10), 4, '最大值应落在最高档');
  assert.strictEqual(s.levelOf(0.1), 0, '接近 0 落最低档');
});

test('分档：用电量小的窗口也能分出层次（这是自适应的意义）', () => {
  // 若写死「<2 浅绿 / <5 中绿」，这一周全是浅绿，看不出差异。
  const days = [{ consumed: 0.1 }, { consumed: 0.3 }, { consumed: 0.6 }, { consumed: 0.9 }, { consumed: 1.2 }];
  const s = buildScale(days, 5);
  const levels = days.map(d => s.levelOf(d.consumed));
  assert.strictEqual(new Set(levels).size, 5, `用电少的一周也应分出 5 档，实际 ${JSON.stringify(levels)}`);
});

test('分档：null 返回 -1（无数据），与 0 区分', () => {
  const s = buildScale([{ consumed: 5 }], 5);
  assert.strictEqual(s.levelOf(null), -1);
  assert.strictEqual(s.levelOf(0), 0);
  assert.notStrictEqual(s.levelOf(null), s.levelOf(0), '无数据与零消耗必须可区分');
});

test('分档：负值（当天净充值）返回 -2，不复用消耗色阶', () => {
  const s = buildScale([{ consumed: 5 }], 5);
  assert.strictEqual(s.levelOf(-50), -2, '充值不能用"消耗很低"的颜色');
});

test('分档：全窗口无正消耗时不除零', () => {
  const s = buildScale([{ consumed: 0 }, { consumed: null }], 5);
  assert.strictEqual(s.max, 1);
  assert.ok(s.thresholds.every(t => Number.isFinite(t)));
});

// ------------------------------------------------------------ 热力图 SVG

test('热力图：纯白不透明背景（深色模式下也要可读）', () => {
  const svg = renderHeatmap([{ day: '2026-11-07', consumed: 3, samples: 2 }]);
  assert.match(svg, /<rect[^>]*fill="#ffffff"/, '必须有纯白底');
});

test('热力图：30 天渲染出 30 个格子', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    consumed: i % 3,
    samples: 2,
  }));
  const svg = renderHeatmap(days);
  const cells = (svg.match(/<rect[^>]*rx="6"/g) || []).length;
  assert.strictEqual(cells, 30, `应有 30 个格子，实际 ${cells}`);
});

test('热力图：无数据的格子用灰底 + 斜线，与零消耗可区分', () => {
  const svg = renderHeatmap([
    { day: '2026-11-07', consumed: null, samples: 0 },
    { day: '2026-11-08', consumed: 0, samples: 2 },
  ]);
  assert.ok(svg.includes(COLOR_NULL), '无数据应用灰色');
  assert.match(svg, /<line[^>]*stroke="#9ca3af"/, '无数据应加斜线纹理');
});

test('热力图：不含 NaN（数值异常时 SVG 会整张坏掉）', () => {
  const cases = [
    [],
    [{ day: '2026-11-07', consumed: null, samples: 0 }],
    [{ day: '2026-11-07', consumed: 0, samples: 1 }],
    [{ day: '2026-11-07', consumed: -50, samples: 2 }],
    Array.from({ length: 30 }, () => ({ day: '2026-11-07', consumed: 1, samples: 1 })),
  ];
  for (const c of cases) {
    const svg = renderHeatmap(c);
    assert.ok(!svg.includes('NaN'), 'SVG 里出现了 NaN');
    assert.ok(!svg.includes('undefined'), 'SVG 里出现了 undefined');
  }
});

test('热力图：空数组也能渲染出合法 SVG（新装用户）', () => {
  const svg = renderHeatmap([]);
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>$/);
});

test('热力图：图例包含"无数据"与"充值"（自适应分档必须自解释）', () => {
  const svg = renderHeatmap([{ day: '2026-11-07', consumed: 3, samples: 2 }]);
  assert.ok(svg.includes('无数据'), '图例缺"无数据"');
  assert.ok(svg.includes('充值'), '图例缺"充值"');
  assert.ok(svg.includes('每档约'), '自适应分档必须标出每档对应多少元');
});

// ------------------------------------------------------------ 分位数分档的边界

test('分档：分位数模式下，最小与最大都能各占一档', () => {
  // 这是分位数实现最容易踩的坑：
  //  - 最小值会被"第 0 档下界=0"挤掉 → 与次小值同档
  //  - 最大值会因分位点等于它 → 与次大值同档
  const days = [0.1, 0.3, 0.6, 0.9, 1.2].map(v => ({ consumed: v }));
  const s = buildScale(days, 5);
  assert.strictEqual(s.method, 'quantile');
  const levels = days.map(d => s.levelOf(d.consumed));
  assert.strictEqual(levels[0], 0, '最小值应在最低档');
  assert.strictEqual(levels[levels.length - 1], 4, '最大值应在最高档');
  assert.deepStrictEqual(levels, [0, 1, 2, 3, 4], '5 个点应各占一档');
});

test('分档：真实数据分布下不再"全部挤在同一档"', () => {
  // 实测数据：多数日子 3.4~4.6 元，少数 0.78 / 6.39。
  // 线性等分时它们会全落进同一档——这正是改用分位数的原因。
  const vals = [0.78, 3.73, 3.82, 3.91, 4.24, 4.58, 4.64, 6.39];
  const days = vals.map(v => ({ consumed: v }));
  const s = buildScale(days, 5);
  const levels = days.map(d => s.levelOf(d.consumed));
  assert.ok(new Set(levels).size >= 4, `应至少分出 4 档，实际 ${JSON.stringify(levels)}`);
});

test('分档：所有正消耗都相同时全部同一档（不能全是最深色）', () => {
  const days = [3, 3, 3, 3, 3].map(v => ({ consumed: v }));
  const s = buildScale(days, 5);
  const levels = days.map(d => s.levelOf(d.consumed));
  assert.deepStrictEqual(levels, [0, 0, 0, 0, 0], '无法区分高低时不该显示成"每天都用很多"');
});

test('分档：阈值严格递增（否则档位判定会跳过某些档）', () => {
  const cases = [
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    [1, 1, 1, 2, 2, 3],
    [0.01, 100],
    [5, 5, 5, 5, 5, 5],
  ];
  for (const arr of cases) {
    const s = buildScale(arr.map(v => ({ consumed: v })), 5);
    for (let i = 1; i < s.thresholds.length; i += 1) {
      assert.ok(s.thresholds[i] > s.thresholds[i - 1],
        `阈值非递增: ${JSON.stringify(s.thresholds)}（输入 ${JSON.stringify(arr)}）`);
    }
  }
});

test('分档：负数（充值）与 null（无数据）在任何方法下都不落进消耗色阶', () => {
  for (const arr of [[1, 2, 3, 4, 5], [3, 3, 3, 3, 3]]) {
    const s = buildScale([...arr.map(v => ({ consumed: v })), { consumed: null }, { consumed: -10 }], 5);
    assert.strictEqual(s.levelOf(null), -1);
    assert.strictEqual(s.levelOf(-10), -2);
    assert.ok(s.levelOf(1) >= 0, '正常消耗不该是负档位');
  }
});

test('热力图尺寸：30 天时应约为 460x438（1.5 倍放大后的既定尺寸）', () => {
  // 用户实测觉得原尺寸（302x292）偏小，明确要求放大 1.5 倍。
  // 这里锁住尺寸，避免以后调布局时无意改回去。
  const days = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, '0')}`,
    consumed: 3,
    samples: 2,
  }));
  const svg = renderHeatmap(days);
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  assert.ok(m, 'SVG 缺 width/height');
  const [w, h] = [Number(m[1]), Number(m[2])];
  // 允许 ±4px 的布局微调裕度
  assert.ok(Math.abs(w - 460) <= 4, `宽度应约 460，实际 ${w}`);
  assert.ok(Math.abs(h - 438) <= 4, `高度应约 438，实际 ${h}`);
});
