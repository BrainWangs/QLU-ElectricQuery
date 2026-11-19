'use strict';
// 时区工具与 workflow 时区约定的回归测试。
// 背景：GitHub Actions 的 runner 时区是 UTC，on.schedule 的 cron 也只按 UTC 解析。
// 2026-11 事故：cron 写成 '0 8-23/2 * * *' + 无效的 timezone 字段，
// 导致北京早上 8 点永远不触发、凌晨反而查询 4 次。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { TZ, beijingHour, dayKey, beijingNowText, beijingLabel } = require('../lib/time');

test('time：beijingHour 对固定时刻给出北京小时', () => {
  // 2026-11-02 01:11:31 UTC = 北京 09:11
  assert.strictEqual(beijingHour(new Date('2026-11-02T01:11:31Z')), 9);
  // 2026-11-01 17:32:11 UTC = 北京 2026-11-02 01:32（跨日）
  assert.strictEqual(beijingHour(new Date('2026-11-01T17:32:11Z')), 1);
  // 2026-11-02 16:00:00 UTC = 北京 2026-11-03 00:00（跨日到 0 点）
  assert.strictEqual(beijingHour(new Date('2026-11-02T16:00:00Z')), 0);
  // 2026-11-02 14:17:00 UTC = 北京 22:17
  assert.strictEqual(beijingHour(new Date('2026-11-02T14:17:00Z')), 22);
});

test('time：dayKey 按北京日期换日（UTC 同一天但北京已跨日）', () => {
  // UTC 2026-11-01 17:32 = 北京 2026-11-02 01:32 → 日期键应是 11/02
  assert.ok(dayKey(new Date('2026-11-01T17:32:11Z')).includes('11/2') || dayKey(new Date('2026-11-01T17:32:11Z')).includes('11/02'),
    `实际: ${dayKey(new Date('2026-11-01T17:32:11Z'))}`);
});

test('time：beijingNowText / beijingLabel 输出北京时间的文本', () => {
  const t = beijingNowText(new Date('2026-11-02T01:11:31Z'));
  assert.ok(t.includes('09:11:31'), `应含北京 09:11:31，实际: ${t}`);
  const lbl = beijingLabel(new Date('2026-11-02T01:11:31Z'));
  assert.ok(lbl.includes('09:11'), `应含 09:11，实际: ${lbl}`);
});

test('time：TZ 常量是 Asia/Shanghai', () => {
  assert.strictEqual(TZ, 'Asia/Shanghai');
});

// ---------------- workflow 的 cron 必须按 UTC 写且等价于北京 8–24 点

test('workflow：cron 必须是高频试探（每天 >=24 次），把频率交给代码里的时段占位', () => {
  // 语义在本次改动后**反转**了，所以这条测试也重写了。
  //
  // 原来：cron 直接写 8 个时间点（8/10/.../22），每个点代表一次查询。
  //       但实测五天应触发 40 次只成 9 次（22%），少写几个点就等于少几次查询。
  // 现在：cron 只负责「多给机会」（每 30 分钟一次），
  //       「一天到底查几次、在几点查」交给 lib/schedule.js 的时段占位。
  //       这样即使 75% 的触发被 GitHub 丢掉，每个时段仍能覆盖到。
  const file = path.join(__dirname, '..', '.github', 'workflows', 'elec-check.yml');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/cron:\s*'([^']+)'/);
  assert.ok(m, '找不到 cron 表达式');
  const parts = m[1].trim().split(/\s+/);
  assert.strictEqual(parts.length, 5, `cron 应为 5 段，实际 ${parts.length}`);
  const [min, hours] = parts;

  // 分钟不能是 0：官方文档说整点是调度高峰，容易被延迟甚至丢弃
  const mins = min.split(',').map(Number);
  assert.ok(mins.every(n => n >= 1 && n <= 59), `分钟非法: ${min}`);
  assert.ok(!mins.includes(0), '分钟含 0 会撞整点高峰');

  // 小时必须是 * （全天），否则又回到「少写几个点就少几次机会」的老问题
  assert.strictEqual(hours, '*', `cron 小时应为 *（全天试探），实际 ${hours}`);

  // 频率下限：每天至少 24 次机会。低于这个数，75% 丢弃后就覆盖不住 4 个时段了。
  const perDay = mins.length * 24;
  assert.ok(perDay >= 24, `每天只有 ${perDay} 次机会，太少`);
});

test('workflow：cron 频率与代码里的时段配置必须自洽', () => {
  // 这条防止「改了 cron 忘了改 slots」或反之。
  // 判据：每天的触发次数 >= 时段数 * 4（每个时段至少 4 次机会，
  //       才能在 75% 丢弃率下仍有较大概率覆盖到）。
  const file = path.join(__dirname, '..', '.github', 'workflows', 'elec-check.yml');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/cron:\s*'([^']+)'/);
  const [min, hours] = m[1].trim().split(/\s+/);
  const perDay = min.split(',').length * (hours === '*' ? 24 : hours.split(',').length);

  const { __test } = require('../lib/config');
  const slots = __test.DEFAULTS.schedule.slots;
  assert.ok(perDay >= slots.length * 4,
    `每天 ${perDay} 次机会，不足以覆盖 ${slots.length} 个时段（需要 >= ${slots.length * 4}）`);
});

test('workflow：不得出现无效的 timezone 字段（on.schedule 不支持）', () => {
  const file = path.join(__dirname, '..', '.github', 'workflows', 'elec-check.yml');
  const text = fs.readFileSync(file, 'utf8');
  // timezone: 只允许出现在注释里
  const lines = text.split('\n');
  for (const line of lines) {
    if (/^\s*timezone:/.test(line)) {
      assert.fail(`on.schedule 不支持 timezone 字段，这行会被忽略并造成误判: ${line}`);
    }
  }
});

// ---------------- workflow 的缓存修复（orphan checkout 前备份 data/）

test('workflow：发布步骤必须备份 data/（orphan 清空后还原，否则缓存永远存不上）', () => {
  const file = path.join(__dirname, '..', '.github', 'workflows', 'elec-check.yml');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('cp -r data /tmp/elec-data-backup'),
    '发布步骤应在 orphan checkout 之前备份 data/ 到 /tmp/elec-data-backup');
  assert.ok(text.includes('cp -r /tmp/elec-data-backup data'),
    '发布步骤应在推送后把 data/ 放回工作区（post-job 缓存保存依赖它）');
});
