// 配置 schema 与时段语义（lib/config.js 阶段 4 部分）的夹具。
//
// 两条主线：
//  1. `validateSchema` 必须能挡住"看起来是数字、其实是 NaN"这类配置错误。
//     旧的 validate 只查 4 个必填项，`QLGYDX_USERINFOID=abc` 会把 NaN
//     原样发给学校接口——而 NaN 在比较里恒为 false，表现为"永远不告警"。
//  2. `inHourRange` 的区间语义是左闭右开 [a, b)，且必须支持跨夜。
//     这条被两份代码各写了一遍（bin 的 inActiveHours 和这里的注释），
//     现在统一到一处，测试钉住语义。
const test = require('node:test');
const assert = require('node:assert');

const {
  validate, validateSchema, inHourRange, SCHEMA, __test,
} = require('../lib/config');
const { emptyState } = require('../lib/store');

/** 造一份最简合法配置 */
function baseCfg() {
  return __test.deepMerge(__test.DEFAULTS, {
    account: { username: 'u', password: 'p' },
    meter: { custRechNo: '示例园#1#A101' },
  });
}

// ------------------------------------------------------------ schema 校验

test('schema：合法配置零错误', () => {
  assert.deepStrictEqual(validateSchema(baseCfg()), []);
});

test('schema：必填项缺失逐条报出来（不是只报第一条）', () => {
  const cfg = __test.deepMerge(__test.DEFAULTS, {});
  const errs = validateSchema(cfg);
  assert.ok(errs.length >= 3, `应至少报 3 条，实际 ${errs.length}`);
  assert.ok(errs.some(e => /account\.username/.test(e)));
  assert.ok(errs.some(e => /account\.password/.test(e)));
  assert.ok(errs.some(e => /custRechNo/.test(e)));
});

test('schema：NaN 必须被挡住（typeof NaN 也是 number，光看类型会放过）', () => {
  for (const key of ['alert.threshold', 'alert.criticalThreshold', 'meter.userInfoId', 'schedule.windowMinutes']) {
    const cfg = baseCfg();
    const parts = key.split('.');
    let cur = cfg;
    for (const p of parts.slice(0, -1)) cur = cur[p];
    cur[parts[parts.length - 1]] = NaN;
    const errs = validateSchema(cfg);
    assert.ok(errs.some(e => e.includes(key)), `${key}=NaN 应报错，实际: ${JSON.stringify(errs)}`);
  }
});

test('schema：字符串 "abc" 冒充数字要报错', () => {
  const cfg = baseCfg();
  cfg.alert.threshold = 'abc';
  assert.ok(validateSchema(cfg).some(e => /alert\.threshold/.test(e)));
});

test('schema：范围检查生效', () => {
  const cases = [
    ['schedule.windowMinutes', -1, /不能小于/],
    ['schedule.windowMinutes', 99999, /不能大于/],
    ['alert.dailyChangePercent', -1, /不能小于/],
    ['alert.cooldownMinutes', 0, /不能小于/],
  ];
  for (const [key, val, re] of cases) {
    const cfg = baseCfg();
    const parts = key.split('.');
    let cur = cfg;
    for (const p of parts.slice(0, -1)) cur = cur[p];
    cur[parts[parts.length - 1]] = val;
    assert.ok(validateSchema(cfg).some(e => re.test(e)), `${key}=${val} 应报错`);
  }
});

test('schema：userInfoId 允许 null（表示尚未发现），但不允许 0 或负数', () => {
  const cfg = baseCfg();
  cfg.meter.userInfoId = null;
  assert.deepStrictEqual(validateSchema(cfg), [], 'null 是合法值');

  cfg.meter.userInfoId = 0;
  assert.ok(validateSchema(cfg).some(e => /userInfoId/.test(e)), '0 不是有效 userInfoId');

  cfg.meter.userInfoId = -3;
  assert.ok(validateSchema(cfg).some(e => /userInfoId/.test(e)));

  cfg.meter.userInfoId = 12345678;
  assert.deepStrictEqual(validateSchema(cfg), []);
});

test('schema：userInfoId 被破坏成对象（历史 bug 的形态）必须报错', () => {
  // 这是真实发生过的故障：deepMerge 的 null→{} 让 userInfoId 变成 {}
  const cfg = baseCfg();
  cfg.meter.userInfoId = {};
  assert.ok(validateSchema(cfg).some(e => /userInfoId/.test(e)), '{} 必须被挡住');
});

test('schema：未知顶层键要报错（防止配置长出拼错的野字段）', () => {
  const cfg = baseCfg();
  cfg.alart = { threshold: 5 }; // 拼错：alert → alart
  const errs = validateSchema(cfg);
  assert.ok(errs.some(e => /未知配置项 alart/.test(e)), `实际: ${JSON.stringify(errs)}`);
});

test('schema：__root/__file 这类内部字段不参与"未知键"检查', () => {
  const cfg = baseCfg();
  cfg.__root = '/tmp';
  cfg.__file = '/tmp/config.json';
  assert.deepStrictEqual(validateSchema(cfg), []);
});

test('schema：criticalThreshold 高于 threshold 要报错（否则严重预警永不触发）', () => {
  const cfg = baseCfg();
  cfg.alert.threshold = 5;
  cfg.alert.criticalThreshold = 10;
  const errs = validateSchema(cfg);
  assert.ok(errs.some(e => /criticalThreshold/.test(e) && /永不触发/.test(e)), `实际: ${JSON.stringify(errs)}`);
});

test('schema：时段数组必须两个元素、且是 0-24 的整数', () => {
  const cfg = baseCfg();
  cfg.schedule.pushHours = [8];
  assert.ok(validateSchema(cfg).some(e => /pushHours/.test(e)));

  cfg.schedule.pushHours = [8, 30];
  assert.ok(validateSchema(cfg).some(e => /pushHours/.test(e)));

  cfg.schedule.pushHours = [8, 22.5];
  assert.ok(validateSchema(cfg).some(e => /pushHours/.test(e)));

  cfg.schedule.pushHours = [8, 22];
  assert.deepStrictEqual(validateSchema(cfg), []);
});

test('validate 现在就是 schema 校验（旧入口不断链）', () => {
  const cfg = baseCfg();
  assert.deepStrictEqual(validate(cfg), validateSchema(cfg));
});

// ------------------------------------------------------------ inHourRange 语义

test('时段：左闭右开 [8,24) —— 8 点在内，0 点不在', () => {
  assert.strictEqual(inHourRange(8, [8, 24]), true);
  assert.strictEqual(inHourRange(23, [8, 24]), true);
  assert.strictEqual(inHourRange(24, [8, 24]), false, '24 点等于次日 0 点，不含');
  assert.strictEqual(inHourRange(0, [8, 24]), false);
  assert.strictEqual(inHourRange(7, [8, 24]), false);
});

test('时段：[8,22) —— 21 点在内，22 点整不在', () => {
  assert.strictEqual(inHourRange(8, [8, 22]), true);
  assert.strictEqual(inHourRange(21, [8, 22]), true);
  assert.strictEqual(inHourRange(22, [8, 22]), false, '右端不含');
});

test('时段：跨夜 [22,6) 正确跨越零点', () => {
  assert.strictEqual(inHourRange(22, [22, 6]), true);
  assert.strictEqual(inHourRange(23, [22, 6]), true);
  assert.strictEqual(inHourRange(0, [22, 6]), true);
  assert.strictEqual(inHourRange(5, [22, 6]), true);
  assert.strictEqual(inHourRange(6, [22, 6]), false);
  assert.strictEqual(inHourRange(12, [22, 6]), false);
});

test('时段：[0,24) 与 [n,n] 都表示全天（历史写法兼容）', () => {
  for (let h = 0; h < 24; h += 1) {
    assert.strictEqual(inHourRange(h, [0, 24]), true, `[0,24) 应含 ${h} 点`);
  }
  assert.strictEqual(inHourRange(3, [0, 0]), true, '[0,0] 是"不限制"的历史写法');
  assert.strictEqual(inHourRange(15, [9, 9]), true);
});

test('时段：非法输入退化为全天，不抛错', () => {
  // 配置可能被手改成垃圾。此时"不限制"比"整天不推送"更安全。
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.strictEqual(inHourRange(12, bad), true, `inHourRange(12, ${JSON.stringify(bad)}) 应为 true`);
  }
});

// ------------------------------------------------------------ pushHours 默认值

test('默认配置：pushHours 是 [8,22]，与 activeHours 分离', () => {
  const d = __test.DEFAULTS;
  assert.deepStrictEqual(d.schedule.pushHours, [8, 22]);
  assert.deepStrictEqual(d.schedule.activeHours, [8, 24]);
  // 两者必须能独立配置：否则"只查不推"的时段无法表达
  assert.notDeepStrictEqual(d.schedule.pushHours, d.schedule.activeHours);
});

test('默认配置：cloud 不再有 redact（脱敏移交镜像构建器）', () => {
  assert.strictEqual(__test.DEFAULTS.cloud.redact, undefined);
});

test('SCHEMA 覆盖了 DEFAULTS 里的每一个叶子键', () => {
  // 漏登记 = 那个键永远不会被校验。这条防止新增配置项时忘了写 schema。
  const missing = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
      if (isObj && !SCHEMA[key]) { walk(v, key); continue; }
      if (!SCHEMA[key]) missing.push(key);
    }
  };
  walk(__test.DEFAULTS, '');
  assert.deepStrictEqual(missing, [], `这些键没有 schema: ${missing.join(', ')}`);
});
