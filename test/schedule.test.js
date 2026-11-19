// 时段占位（lib/schedule.js）的夹具。
//
// 这一层是为了对付 GitHub schedule 的「合并 + 丢弃」而存在的。
// 实测数据（写在这里防止后人重新踩）：11-03~11-07 五天应触发 40 次，
// 实际只创建 9 次任务，分钟数在 :10~:53 随机分布、排队 0 秒、无 cancelled 记录。
//
// 因为触发会丢，就不能「按间隔节流」——延迟会打乱节奏：
//   8 点那次拖到 9:40，10:10 的触发被判「距上次太近」跳过，12 点整个落空。
// 正确做法是「按时段占位」：每时段只要有一次活着就够。
const test = require('node:test');
const assert = require('node:assert');

const {
  buildWindows, currentWindow, slotKey, decide, windowForMode,
} = require('../lib/schedule');
const time = require('../lib/time');
const { __test } = require('../lib/config');

const SLOTS = [8, 12, 16, 20];
const CLOSE = 23 * 60 + 40; // 1420

/** 由「北京 h:m」造一个 parts 对象 */
function at(hour, minute) {
  return { hour, minute, dayKey: '2026/11/07', minutesOfDay: hour * 60 + minute };
}

// ------------------------------------------------------------ 时段切分

test('时段：4 个时段，窗口以准点为中心对称展开', () => {
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(w.length, 4);
  // 8 点时段：7:30 —— 8:30（中心 8:00）
  assert.strictEqual(w[0].hour, 8);
  assert.strictEqual(w[0].center, 8 * 60);
  assert.strictEqual(w[0].start, 7 * 60 + 30);
  assert.strictEqual(w[0].end, 8 * 60 + 30);
  assert.strictEqual(w[1].start, 11 * 60 + 30);
  assert.strictEqual(w[2].start, 15 * 60 + 30);
});

test('时段：最后时段的窗口不得越过服务关闭时刻（23:40）', () => {
  // 学校 23:40 关停，之后去查必然报「不在服务时间范围」，没意义。
  // 正常配置（20 点 + 30 分钟 = 20:30）远早于关闭时刻；
  // 但若把 slots 挪到 23 点，窗口必须被 23:40 截断。
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(w[3].start, 19 * 60 + 30);
  assert.strictEqual(w[3].end, 20 * 60 + 30, '20:30 早于 23:40，不受截断');
  const late = buildWindows([23], 60, CLOSE)[0];
  assert.ok(late.end <= CLOSE, `23 点时段的窗口必须收敛到 23:40，实际 ${late.end}`);
});

test('时段：空/非法 slots 返回空数组，不崩', () => {
  assert.deepStrictEqual(buildWindows([], 30, CLOSE), []);
  assert.deepStrictEqual(buildWindows(null, 30, CLOSE), []);
  assert.deepStrictEqual(buildWindows([NaN, 'x', 25], 30, CLOSE), []);
});

test('时段：乱序输入会先排序（配置手写顺序不该影响语义）', () => {
  const w = buildWindows([20, 8, 16, 12], 30, CLOSE);
  assert.deepStrictEqual(w.map(x => x.hour), [8, 12, 16, 20]);
});

// ------------------------------------------------------------ 落在哪个时段

test('定位：8:17 落在 8 点时段', () => {
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(8, 17), w).hour, 8);
});

test('定位：7:45（提前量内）仍算 8 点时段', () => {
  // cron 可能提前十几分钟触发，这段余量就是为它留的
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(7, 45), w).hour, 8);
});

test('定位：7:29 太早，不属于任何时段', () => {
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(7, 29), w), null);
});

test('定位：8:20 在窗口内，9:40 已超出（窗口收窄是有意取舍）', () => {
  // 旧实现是"从 7:30 一路开到 11:30"，能吞下 9:40 这种极端延迟。
  // 但它同时会让 7:31 就开查，与"准点"冲突。
  // 现在的取舍：窗口对称（7:30–8:30），保证准点附近可靠，
  // 超出窗口的极端延迟交给下一个时段，而不是让整个上午都算 8 点。
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(8, 20), w).hour, 8);
  assert.strictEqual(currentWindow(at(9, 40), w), null, '9:40 已不属于任何时段');
});

test('定位：11:31 已经是 12 点时段（窗口 11:30 开）', () => {
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(11, 31), w).hour, 12);
});

test('定位：23:41 超出关闭时刻，不属于任何时段', () => {
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(23, 41), w), null);
});

test('定位：凌晨 3 点不属于任何时段（不查）', () => {
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(at(3, 0), w), null);
});

// ------------------------------------------------------------ 决策

test('决策：时段内且未完成 → 该查', () => {
  const r = decide({ parts: at(8, 17), slots: SLOTS, closeMinutes: CLOSE });
  assert.strictEqual(r.run, true);
  assert.strictEqual(r.reason, 'due');
  assert.strictEqual(r.key, '2026/11/07@8');
});

test('决策：同一时段已完成 → 跳过（不重复查、不重复推）', () => {
  const r = decide({
    parts: at(8, 20), slots: SLOTS, closeMinutes: CLOSE,
    lastSlotKey: '2026/11/07@8',
  });
  assert.strictEqual(r.run, false);
  assert.strictEqual(r.reason, 'already-done');
});

test('决策：不同时段不受上次标记影响', () => {
  const r = decide({
    parts: at(12, 10), slots: SLOTS, closeMinutes: CLOSE,
    lastSlotKey: '2026/11/07@8',
  });
  assert.strictEqual(r.run, true);
  assert.strictEqual(r.key, '2026/11/07@12');
});

test('决策：跨天后旧标记自动失效（key 里带日期）', () => {
  // 昨天的 @8 不能挡住今天的 8 点
  const r = decide({
    parts: { hour: 8, minute: 20, dayKey: '2026/11/08', minutesOfDay: 8 * 60 + 20 },
    slots: SLOTS, closeMinutes: CLOSE,
    lastSlotKey: '2026/11/07@8',
  });
  assert.strictEqual(r.run, true);
  assert.strictEqual(r.key, '2026/11/08@8');
});

test('决策：时段外 → 跳过，reason=outside-window', () => {
  const r = decide({ parts: at(3, 0), slots: SLOTS, closeMinutes: CLOSE });
  assert.strictEqual(r.run, false);
  assert.strictEqual(r.reason, 'outside-window');
});

test('决策：force 忽略一切限制（排查用）', () => {
  const r = decide({
    parts: at(3, 0), slots: SLOTS, closeMinutes: CLOSE,
    lastSlotKey: '2026/11/07@8', force: true,
  });
  assert.strictEqual(r.run, true);
  assert.strictEqual(r.reason, 'force');
});

test('决策：force 在时段外也能跑（key 为 null，不占用时段名额）', () => {
  const r = decide({ parts: at(3, 0), slots: SLOTS, closeMinutes: CLOSE, force: true });
  assert.strictEqual(r.run, true);
  assert.strictEqual(r.key, null, '时段外 force 不该写时段标记，否则会吞掉真正的时段');
});

test('决策：slots 为空 → 永不自动跑（只手动）', () => {
  const r = decide({ parts: at(8, 17), slots: [], closeMinutes: CLOSE });
  assert.strictEqual(r.run, false);
  assert.strictEqual(r.reason, 'outside-window');
});

// ------------------------------------------------------------ 一天 4 次的完整性

test('完整一天：每个时段各命中一次，共 4 次', () => {
  // 模拟一天 48 次触发（每 30 分钟），看会不会正好查 4 次
  const hits = [];
  let lastKey = null;
  for (let m = 0; m < 24 * 60; m += 30) {
    const p = at(Math.floor(m / 60), m % 60);
    const r = decide({ parts: p, slots: SLOTS, closeMinutes: CLOSE, lastSlotKey: lastKey });
    if (r.run) { hits.push(`${p.hour}:${String(p.minute).padStart(2, '0')}`); lastKey = r.key; }
  }
  assert.strictEqual(hits.length, 4, `应正好 4 次，实际 ${hits.join(', ')}`);
  assert.deepStrictEqual(hits, ['7:30', '11:30', '15:30', '19:30']);
});

test('完整一天：丢弃一半触发后仍能覆盖全部 4 个时段', () => {
  // 模拟 GitHub 丢掉一半：只保留偶数索引的触发
  const triggers = [];
  for (let m = 0; m < 24 * 60; m += 30) triggers.push(at(Math.floor(m / 60), m % 60));
  const kept = triggers.filter((_, i) => i % 2 === 0);

  let lastKey = null;
  const hits = [];
  for (const p of kept) {
    const r = decide({ parts: p, slots: SLOTS, closeMinutes: CLOSE, lastSlotKey: lastKey });
    if (r.run) { hits.push(p.hour); lastKey = r.key; }
  }
  assert.strictEqual(hits.length, 4, `丢一半后仍应有 4 次，实际 ${hits.join(',')}`);
});

test('完整一天：只活下来 1/4 触发时，仍能覆盖全部时段', () => {
  // 更严苛：只保留每 4 个中的 1 个（相当于 75% 丢弃率，接近实测的 78%）
  const triggers = [];
  for (let m = 0; m < 24 * 60; m += 30) triggers.push(at(Math.floor(m / 60), m % 60));
  const kept = triggers.filter((_, i) => i % 4 === 0);

  let lastKey = null;
  const hits = [];
  for (const p of kept) {
    const r = decide({ parts: p, slots: SLOTS, closeMinutes: CLOSE, lastSlotKey: lastKey });
    if (r.run) { hits.push(p.hour); lastKey = r.key; }
  }
  assert.strictEqual(hits.length, 4, `75% 丢弃后仍应有 4 次，实际 ${hits.join(',')}`);
});

// ------------------------------------------------------------ 与真实时区衔接

test('beijingParts：CI 的 UTC 时间能正确换算成北京时/分', () => {
  // 这是历史上真实出过的 bug：CI 上 new Date().getHours() 是 UTC，
  // [8,24] 过滤的其实是北京 16:00–次日 08:00，导致早上 8 点被跳过。
  const p = time.beijingParts(new Date('2026-11-07T00:17:00Z')); // 北京 08:17
  assert.strictEqual(p.hour, 8);
  assert.strictEqual(p.minute, 17);
  assert.strictEqual(p.minutesOfDay, 497);
});

test('beijingParts：23:41 的分钟数能正确越过服务关闭线', () => {
  const p = time.beijingParts(new Date('2026-11-07T15:41:00Z')); // 北京 23:41
  assert.strictEqual(p.minutesOfDay, 1421);
  const w = buildWindows(SLOTS, 30, CLOSE);
  assert.strictEqual(currentWindow(p, w), null, '23:41 已过 23:40，不该再查');
});

test('默认配置：slots 是 8/12/16/20，且不再有 intervalMinutes', () => {
  const d = __test.DEFAULTS.schedule;
  assert.deepStrictEqual(d.slots, [8, 12, 16, 20]);
  // windowMinutes 默认 null = 按 mode 自动推导。
  // 若这里写成固定 30，就会盖掉 mode 的作用，改 mode 将完全无效。
  assert.strictEqual(d.windowMinutes, null, 'windowMinutes 默认应为 null（交给 mode 决定）');
  assert.strictEqual(d.closeMinutes, 1420);
  // intervalMinutes 是已删除的 watch 命令的遗留物，从未被任何代码读取
  assert.strictEqual(d.intervalMinutes, undefined, 'intervalMinutes 已删除，不该回来');
});

// ------------------------------------------------------------ 双模式（github / external）
//
// 设计目标：两种触发方式共存、可随时切换，且**共用同一套时段去重逻辑**。
// 差别只在"窗口留多宽"：
//   github   → 30 分钟（它的 cron 会丢 78%，必须放宽才抓得住）
//   external → 10 分钟（外部 cron 准点，收窄才能在"接近准点"时才查）

test('双模式：默认是 github，且是合法值', () => {
  assert.strictEqual(__test.DEFAULTS.schedule.mode, 'github');
});

test('双模式：窗口宽度按 mode 自动推导', () => {
  assert.strictEqual(windowForMode('github'), 30);
  assert.strictEqual(windowForMode('external'), 10);
});

test('双模式：非法 mode 退回最宽松的窗口（宁可多查，不可漏查）', () => {
  assert.strictEqual(windowForMode('nonsense'), 30);
  assert.strictEqual(windowForMode(undefined), 30);
  assert.strictEqual(windowForMode(null), 30);
});

test('双模式：同一时刻，github 会查而 external 不查（窗口宽窄的直接证据）', () => {
  // 7:45 距 8:00 还有 15 分钟：
  //   github 的 30 分钟窗口包含它（7:30 起接受）；
  //   external 的 10 分钟窗口不包含（7:50 起才接受）。
  const parts = { hour: 7, minute: 45, dayKey: '2026/11/08', minutesOfDay: 7 * 60 + 45 };
  const base = { parts, slots: [8, 12, 16, 20], closeMinutes: 1420 };
  assert.strictEqual(decide({ ...base, mode: 'github' }).run, true);
  assert.strictEqual(decide({ ...base, mode: 'external' }).run, false);
});

test('双模式：准点时刻两种模式都该查（8:00 本身）', () => {
  const parts = { hour: 8, minute: 0, dayKey: '2026/11/08', minutesOfDay: 8 * 60 };
  const base = { parts, slots: [8, 12, 16, 20], closeMinutes: 1420 };
  for (const mode of ['github', 'external']) {
    assert.strictEqual(decide({ ...base, mode }).run, true, `${mode} 模式下 8:00 应查`);
  }
});

test('双模式：external 下 8:05 仍该查（吸收 GitHub 启动虚拟机的几秒延迟）', () => {
  const parts = { hour: 8, minute: 5, dayKey: '2026/11/08', minutesOfDay: 8 * 60 + 5 };
  assert.strictEqual(decide({ parts, slots: [8, 12, 16, 20], mode: 'external', closeMinutes: 1420 }).run, true);
});

test('双模式：显式 windowMinutes 优先于 mode（运维可强制覆盖）', () => {
  const parts = { hour: 7, minute: 45, dayKey: '2026/11/08', minutesOfDay: 7 * 60 + 45 };
  // external 默认 10 分钟不包含 7:45，但强制给 60 分钟就该包含
  assert.strictEqual(
    decide({ parts, slots: [8, 12, 16, 20], mode: 'external', windowMinutes: 60, closeMinutes: 1420 }).run,
    true,
  );
  // 反过来：github 默认 30 分钟包含 7:45，强制给 5 分钟就不包含
  assert.strictEqual(
    decide({ parts, slots: [8, 12, 16, 20], mode: 'github', windowMinutes: 5, closeMinutes: 1420 }).run,
    false,
  );
});

test('双模式：切换 mode 不影响时段去重（同一时段仍只查一次）', () => {
  for (const mode of ['github', 'external']) {
    const r = decide({
      parts: { hour: 8, minute: 5, dayKey: '2026/11/08', minutesOfDay: 8 * 60 + 5 },
      slots: [8, 12, 16, 20], mode, closeMinutes: 1420,
      lastSlotKey: '2026/11/08@8',
    });
    assert.strictEqual(r.run, false, `${mode} 模式下同段不应重复查`);
    assert.strictEqual(r.reason, 'already-done');
  }
});

test('双模式：external 模式下按准点触发，一天正好 4 次且都在整点', () => {
  // 注意：这里模拟的是**真实触发模式**——外部 cron 每天只在 8/12/16/20 点各触发一次。
  // 不要写成"逐分钟遍历"：那等于假设每分钟都有触发，而现实中不会，
  // 会让 7:50（窗口刚开）就被算成一次查询，得出"7:50 就查了"的失真结论。
  let lastKey = null;
  const hits = [];
  for (const hour of [8, 12, 16, 20]) {
    const p = { hour, minute: 0, dayKey: '2026/11/08', minutesOfDay: hour * 60 };
    const r = decide({ parts: p, slots: [8, 12, 16, 20], mode: 'external', closeMinutes: 1420, lastSlotKey: lastKey });
    if (r.run) { hits.push(hour); lastKey = r.key; }
  }
  assert.deepStrictEqual(hits, [8, 12, 16, 20], `external 模式应在 8/12/16/20 各查一次，实际 ${hits.join(',')}`);
});

test('双模式：窗口以准点为中心（提前与滞后都留余量）', () => {
  // external: 7:50–8:10，中枢 8:00。
  // 这样 GitHub 早几秒/晚几秒启动都还在窗口内，而 7:40 这种"明显还没到点"不会触发。
  const w = buildWindows([8], windowForMode('external'), 1420)[0];
  assert.strictEqual(w.center, 8 * 60);
  assert.strictEqual(w.start, 7 * 60 + 50);
  assert.strictEqual(w.end, 8 * 60 + 10);
  // github 的窗口更宽，但同样以准点为中心
  const g = buildWindows([8], windowForMode('github'), 1420)[0];
  assert.strictEqual(g.start, 7 * 60 + 30);
  assert.strictEqual(g.end, 8 * 60 + 30);
});

test('双模式：最后时段的窗口不会越过服务关闭时刻', () => {
  // 20 点是最后一个时段，+10 分钟是 20:10，远早于 23:40，正常。
  // 但若有人把 slots 设成 [23]，窗口必须收敛到 23:40 而不是 23:10 之后继续。
  const w = buildWindows([23], 60, 1420)[0];
  assert.ok(w.end <= 1420, `最后时段不得越过 23:40，实际 ${w.end}`);
});
