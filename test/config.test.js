// `deepMerge` 的单测。
//
// 这一段历史上有两个真 bug，都是"配置写了却不生效"且**没有任何报错**：
//
// 1. `DEFAULTS.meter.userInfoId` 的默认值是 `null`，而 `typeof null === 'object'`
//    会让它走进"合并对象"分支 —— `{...null}` 得 `{}`，于是用户在 config.json 里
//    填的数字被静默换成空对象，最后以 `"userInfoId":{}` 的形式发给学校接口。
//    更糟的是改写成字符串（`"12345678"`，填 ID 时很自然）会直接抛 TypeError。
// 2. 配置里缺某棵子树时函数 `return base`，返回的是 `DEFAULTS` 的**引用**。
//    调用方一改配置就就地污染了全局默认值，同一进程内第二次 `loadConfig()`
//    会"粘住"上一次的环境变量，表现为"删了 env 也不生效"。
//
// 下面每条用例都对应一个曾经真实发生过的不变量，删掉任何一条都会让对应 bug 复活。
const test = require('node:test');
const assert = require('node:assert');

const { loadConfig, __test } = require('../lib/config');
const { deepMerge, DEFAULTS } = __test;

// ---------------------------------------------------------------- 不变量 1
// base 为 null = "无默认值"，不是"空对象"

test('deepMerge：base 为 null 时，数字覆盖必须原样保留（不能被吞成 {}）', () => {
  assert.strictEqual(deepMerge(null, 12345678), 12345678);
});

test('deepMerge：base 为 null 时，字符串覆盖不能抛 TypeError', () => {
  // 旧实现会在这里抛 "Cannot use \'in\' operator to search for \'0\' in null"
  assert.strictEqual(deepMerge(null, '12345678'), '12345678');
});

test('deepMerge：base 为 null 且 over 也为 null 时，结果是 null', () => {
  assert.strictEqual(deepMerge(null, null), null);
  // 区别于"over 缺省"：那才表示"沿用默认值"
  assert.strictEqual(deepMerge(7, undefined), 7);
});

test('deepMerge：嵌套的 null 默认值被数字覆盖后仍是数字', () => {
  const merged = deepMerge({ meter: { userInfoId: null } }, { meter: { userInfoId: 42 } });
  assert.deepStrictEqual(merged, { meter: { userInfoId: 42 } });
  assert.strictEqual(typeof merged.meter.userInfoId, 'number');
});

// ---------------------------------------------------------------- 不变量 2
// 原始值 / 数组覆盖直接生效，不做对象合并

test('deepMerge：原始值互相覆盖（数字→字符串、数字→布尔）', () => {
  assert.deepStrictEqual(deepMerge({ a: 1 }, { a: 'x' }), { a: 'x' });
  assert.deepStrictEqual(deepMerge({ a: 1 }, { a: false }), { a: false });
  assert.deepStrictEqual(deepMerge({ a: { b: 1 } }, { a: 0 }), { a: 0 });
});

test('deepMerge：数组整体替换，不按键下标合并', () => {
  assert.deepStrictEqual(deepMerge({ activeHours: [8, 24] }, { activeHours: [0, 24] }).activeHours, [0, 24]);
  assert.deepStrictEqual(deepMerge({ activeHours: [8, 24] }, { activeHours: [9] }).activeHours, [9]);
});

test('deepMerge：over 里多出来的键被保留', () => {
  assert.deepStrictEqual(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});

test('deepMerge：base 为 null、over 是对象时，结果就是 over 的内容', () => {
  // 变异测试抓出来的一条：只判 `base === undefined` 的实现在这里会
  // 走 Object.entries(null) 或返回 {}，两种情况都是错的。
  assert.deepStrictEqual(deepMerge(null, { a: 1 }), { a: 1 });
});

test('deepMerge：整个 over 为 undefined 时，返回 base 的深拷贝', () => {
  // 直接调用这一分支（loadConfig 总是传对象，所以只有直接调用能测到）。
  // 变异 M2 把 deepClone 去掉后会在这里返回 base 引用。
  const base = { a: { b: { c: 1 } } };
  const merged = deepMerge(base, undefined);
  assert.deepStrictEqual(merged, base);
  assert.notStrictEqual(merged.a, base.a, '不得返回 base 引用');
  assert.notStrictEqual(merged.a.b, base.a.b, '深层也不得共享引用');
});

test('deepMerge：键值为 undefined 时保留默认值，而不是抹成 undefined', () => {
  // 与顶层 `over === undefined` 语义保持一致：undefined 表示"没提供这一项"。
  const merged = deepMerge({ a: { b: 1 }, c: 2 }, { a: undefined, c: undefined });
  assert.deepStrictEqual(merged, { a: { b: 1 }, c: 2 });
});

test('deepMerge：缺子树时返回的是副本，即使 base 本身非空', () => {
  // 变异 M2（把深拷贝换成直接返回）会在这里存活，所以单独钉一条。
  const base = { a: { b: { c: 1 } } };
  const merged = deepMerge(base, {});
  assert.deepStrictEqual(merged, base);
  assert.notStrictEqual(merged.a, base.a, '不得返回 base 子树引用');
  assert.notStrictEqual(merged.a.b, base.a.b, '深层也不得共享引用');
});

// ---------------------------------------------------------------- 不变量 3
// 绝不返回 DEFAULTS 的引用

test('deepMerge：缺子树时不得返回 base 的引用（否则污染 DEFAULTS）', () => {
  const merged = deepMerge(DEFAULTS, {});
  assert.notStrictEqual(merged.alert, DEFAULTS.alert);
  assert.notStrictEqual(merged.alert.notify, DEFAULTS.alert.notify);
  assert.notStrictEqual(merged.alert.notify.ntfy, DEFAULTS.alert.notify.ntfy);
  assert.notStrictEqual(merged.schedule.activeHours, DEFAULTS.schedule.activeHours);
});

test('deepMerge：改返回值不会污染 DEFAULTS', () => {
  const merged = deepMerge(DEFAULTS, {});
  merged.alert.notify.ntfy.topic = 'POLLUTED';
  merged.schedule.activeHours.push(99);
  assert.strictEqual(DEFAULTS.alert.notify.ntfy.topic, '');
  assert.deepStrictEqual(DEFAULTS.schedule.activeHours, [8, 24]);
});

test('loadConfig：删掉环境变量后再加载，不得"粘住"上一次的值', () => {
  // 旧实现因为共享 DEFAULTS 引用，env 一旦写过就永久生效。此处直接测这条语义，
  // 但不去 touch 真实 config.json —— 用一个只有默认值的空配置文件。
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elec-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}', 'utf8');

  try {
    process.env.QLGYDX_NTFY_TOPIC = 'FIRST_TOPIC';
    assert.strictEqual(loadConfig(file).alert.notify.ntfy.topic, 'FIRST_TOPIC');

    delete process.env.QLGYDX_NTFY_TOPIC;
    assert.strictEqual(loadConfig(file).alert.notify.ntfy.topic, '', 'env 删除后应回到默认空串');
  } finally {
    delete process.env.QLGYDX_NTFY_TOPIC;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 回归锚点

test('loadConfig：meter.userInfoId 的类型必须是 number 或 null，绝不能是 object', () => {
  // 这一条直接钉住"正在发生的故障"：真实 config.json 里填的是数字，
  // 一旦 deepMerge 回退，这里会变成 object 并立刻变红。
  const cfg = loadConfig();
  const t = typeof cfg.meter.userInfoId;
  assert.ok(t === 'number' || cfg.meter.userInfoId === null, `userInfoId 类型异常: ${t}`);
});
