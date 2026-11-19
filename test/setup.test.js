// 「一键配置」相关纯函数的单测。
//
// setup 命令解决的是模板使用者的死循环：validate() 要求配置里已有电表号，
// 而电表号只能登录后从绑定列表里发现。这里测的是其中最容易被写错的部分 ——
// 半角/全角井号归一化，以及"账号绑了多间宿舍时到底选了哪间"。
//
// 学校接口实测会同时返回 `测试园#1#A101` 和 `测试园＃1＃A101`（半角与全角井号），
// 它们是同一间宿舍。不归一化就会在界面上出现两条一模一样的选项，
// 而且用户用全角写法指定时会匹配失败 —— 这正是要钉住的行为。
const test = require('node:test');
const assert = require('node:assert');

const { normalizeMeterId, pickMeter } = require('../lib/config');

// ------------------------------------------------------------ 归一化

test('normalizeMeterId 把全角井号转成半角', () => {
  assert.strictEqual(normalizeMeterId('测试园＃1＃A101'), '测试园#1#A101');
});

test('normalizeMeterId 对已是半角的值原样返回', () => {
  assert.strictEqual(normalizeMeterId('测试园#1#A101'), '测试园#1#A101');
});

test('normalizeMeterId 去掉首尾空白', () => {
  assert.strictEqual(normalizeMeterId('  测试园#1#A101 \n'), '测试园#1#A101');
});

test('normalizeMeterId 对 null/undefined 返回空串而不是崩溃', () => {
  assert.strictEqual(normalizeMeterId(null), '');
  assert.strictEqual(normalizeMeterId(undefined), '');
});

// ------------------------------------------------------------ 挑选宿舍

const ROWS = [
  { chargeNumber: '测试园#1#A101', chargeName: '示例校区学生公寓.3楼.A101', rechMerMapId: 338 },
  { chargeNumber: '测试园＃1＃A101', chargeName: '示例校区学生公寓.3楼.A101', rechMerMapId: 338 },
  { chargeNumber: '测试园#2#B102', chargeName: '示例校区学生公寓.5楼.B102', rechMerMapId: 338 }, // preflight-ignore
];

test('pickMeter 不指定时取第一间', () => {
  const { picked, candidates } = pickMeter(ROWS);
  assert.strictEqual(picked.chargeNumber, '测试园#1#A101');
  assert.strictEqual(candidates.length, 2);
});

test('pickMeter 把半角与全角井号视为同一间宿舍，只留一条候选', () => {
  const { candidates } = pickMeter(ROWS);
  const keys = candidates.map(r => normalizeMeterId(r.chargeNumber));
  assert.deepStrictEqual(keys, ['测试园#1#A101', '测试园#2#B102']); // preflight-ignore
  assert.strictEqual(keys.length, new Set(keys).size, '候选里不应有归一化后重复的项');
});

test('pickMeter 用全角写法也能匹配到半角存的那条', () => {
  const { picked } = pickMeter(ROWS, '测试园＃1＃A101');
  assert.strictEqual(normalizeMeterId(picked.chargeNumber), '测试园#1#A101');
});

test('pickMeter 用半角写法也能匹配到全角存的那条', () => {
  const { picked } = pickMeter([{ chargeNumber: '测试园＃2＃B102' }], '测试园#2#B102'); // preflight-ignore
  assert.ok(picked, '应当匹配成功');
  assert.strictEqual(picked.chargeNumber, '测试园＃2＃B102'); // preflight-ignore
});

test('pickMeter 指定了不存在的宿舍时 picked 为 null，但仍返回候选供提示', () => {
  const { picked, candidates } = pickMeter(ROWS, '测试园#9#Z999'); // preflight-ignore
  assert.strictEqual(picked, null);
  assert.strictEqual(candidates.length, 2, '失败时也要给用户可选项');
});

test('pickMeter 对空列表返回空结果', () => {
  assert.deepStrictEqual(pickMeter([]), { picked: null, candidates: [] });
  assert.deepStrictEqual(pickMeter(null), { picked: null, candidates: [] });
});

test('pickMeter 跳过没有电表号的脏数据', () => {
  const { candidates } = pickMeter([
    { chargeNumber: '' },
    { chargeNumber: null },
    { chargeNumber: '测试园#1#A101' },
  ]);
  assert.strictEqual(candidates.length, 1);
});
