// 余额解析层（lib/parse.js）的夹具。
//
// 这组测试解决的是一个**真实发生过**的问题：原解析代码在 `lib/qlgydx.js` 里
// 零覆盖（函数覆盖 8.70%），却同时埋着三个 P1 级缺陷：
//
//   1. `Number('')` 得 0      → 余额显示 0 元 → 触发"严重不足"**假告警**
//   2. `Number('65.42元')` 得 NaN → 界面显示"正常"（静默错误），JSON 里变 null
//   3. `null.toFixed(2)` 抛错  → 整条 check 以 1 退出，快照/状态都不写
//
// 后两条的共同点：**不报错**。所以这组夹具的重点不是"正常值能解出来"，
// 而是"垃圾输入必须显式失败，且失败的形态是可判别的"。
//
// 验收判据（docs/REFACTOR-PLAN.md §阶段1）：变异 M1、M2 必须由存活变杀死。
const test = require('node:test');
const assert = require('node:assert');

const { parseAmount, parseBalance, parseAccounts, pickInfo } = require('../lib/parse');

const NOW = new Date('2026-11-07T08:00:00.000Z');
const ctx = { custRechNo: '示例园#1#A101', now: () => NOW };

/** 构造一份最小可用响应 */
function resp(infos, extra = {}) {
  return {
    code: '30300000',
    datajson: {
      deviceInfo: [{ nameValue: '示例校区学生公寓.示例园1号公寓A区.3楼.A101', unitValue: '开户', infos }],
      roomName: 'A101',
      ...extra,
    },
  };
}
const info = (key, val) => ({ key, keyValue: val });

// ------------------------------------------------------------ parseAmount

test('金额：纯数字字符串', () => {
  assert.strictEqual(parseAmount('65.42'), 65.42);
});

test('金额：前后空白被忽略', () => {
  assert.strictEqual(parseAmount(' 65.42 '), 65.42);
  assert.strictEqual(parseAmount('\t65.42\n'), 65.42);
});

test('金额：带货币单位也能解', () => {
  assert.strictEqual(parseAmount('65.42元'), 65.42);
  assert.strictEqual(parseAmount('¥65.42'), 65.42);
  assert.strictEqual(parseAmount('￥65.42圆'), 65.42);
});

test('金额：千分位', () => {
  assert.strictEqual(parseAmount('1,234.56'), 1234.56);
  assert.strictEqual(parseAmount('12,345'), 12345);
});

test('金额：0 是合法值（会触发预警，不是解析失败）', () => {
  assert.strictEqual(parseAmount('0'), 0);
  assert.strictEqual(parseAmount(0), 0);
});

test('金额：四舍五入到分', () => {
  assert.strictEqual(parseAmount(12345.678), 12345.68);
  assert.strictEqual(parseAmount('0.005'), 0.01);
  assert.strictEqual(parseAmount('65.424'), 65.42);
});

test('金额：空串必须抛错，绝不能变成 0', () => {
  // 这是 P1-5 的正中心：`Number('')` 是 0，假告警就是这么来的
  assert.throws(() => parseAmount(''), /无法解析/);
  assert.throws(() => parseAmount('   '), /无法解析/);
});

test('金额：占位符/垃圾串必须抛错', () => {
  for (const bad of ['--', 'abc', 'NaN', 'Infinity', '1e5', '65.42.1', '元', '¥']) {
    assert.throws(() => parseAmount(bad), /无法解析/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('金额：null / undefined 必须抛错', () => {
  assert.throws(() => parseAmount(null), /无法解析/);
  assert.throws(() => parseAmount(undefined), /无法解析/);
});

test('金额：负数必须抛错（余额不可能为负）', () => {
  assert.throws(() => parseAmount(-5), /不可能为负/);
  assert.throws(() => parseAmount('-5'), /不可能为负/);
  assert.throws(() => parseAmount(-0.01), /不可能为负/);
});

test('金额：非有限数字必须抛错', () => {
  assert.throws(() => parseAmount(NaN), /无法解析/);
  assert.throws(() => parseAmount(Infinity), /无法解析/);
});

test('金额：抛出的错误带 kind 与原始值，便于上层分类', () => {
  try {
    parseAmount('--');
    assert.fail('应当抛出');
  } catch (e) {
    assert.strictEqual(e.kind, 'bad-amount');
    assert.strictEqual(e.rawValue, '--');
  }
});

// ------------------------------------------------------------ pickInfo

test('pickInfo：找不到返回 null，且绝不能是 undefined', () => {
  // 变异 M1 就是把这里的 null 改成 undefined。两者下游差别巨大：
  // undefined 会让 Number(undefined) → NaN，而 NaN 表现为"一切正常"。
  assert.strictEqual(pickInfo([], 'X'), null);
  assert.strictEqual(pickInfo([info('Y', 1)], 'X'), null);
  assert.notStrictEqual(pickInfo([], 'X'), undefined);
});

test('pickInfo：keyValue 是 undefined 时归一化成 null', () => {
  assert.strictEqual(pickInfo([{ key: 'X', keyValue: undefined }], 'X'), null);
});

test('pickInfo：值本身是 0 时要原样返回（不能当成缺失）', () => {
  assert.strictEqual(pickInfo([info('X', 0)], 'X'), 0);
  assert.strictEqual(pickInfo([info('X', '')], 'X'), '');
});

test('pickInfo：infos 不是数组时安全返回 null', () => {
  assert.strictEqual(pickInfo(null, 'X'), null);
  assert.strictEqual(pickInfo({}, 'X'), null);
});

// ------------------------------------------------------------ parseBalance 正常路径

test('余额：完整响应解析成领域对象', () => {
  const b = parseBalance(resp([info('JC_remoney', '65.42'), info('Amid', 'METER-0001')]), ctx);
  assert.strictEqual(b.amount, 65.42);
  assert.strictEqual(b.meterAddress, 'METER-0001');
  assert.strictEqual(b.location, '示例校区学生公寓.示例园1号公寓A区.3楼.A101');
  assert.strictEqual(b.unit, '开户');
  assert.strictEqual(b.roomName, 'A101');
  assert.strictEqual(b.custRechNo, '示例园#1#A101');
  assert.strictEqual(b.queriedAt, NOW.toISOString());
});

test('余额：amount 永远是 number，永远不是 NaN', () => {
  // 变异 M2 的靶心：直接 Number(balanceRaw) 会让 NaN 漏出去
  const b = parseBalance(resp([info('JC_remoney', '12.5')]), ctx);
  assert.strictEqual(typeof b.amount, 'number');
  assert.ok(!Number.isNaN(b.amount));
});

test('余额：缺 Amid 时 meterAddress 为 null，但金额仍能解析', () => {
  const b = parseBalance(resp([info('JC_remoney', '30')]), ctx);
  assert.strictEqual(b.meterAddress, null);
  assert.strictEqual(b.amount, 30);
});

// ------------------------------------------------------------ parseBalance deviceInfo 三态

test('余额：deviceInfo 是空数组 → 报错（没有表具就没有余额）', () => {
  const j = { code: '30300000', datajson: { deviceInfo: [] } };
  assert.throws(() => parseBalance(j, ctx), /无法解析/);
});

test('余额：deviceInfo 缺失 → 报错', () => {
  const j = { code: '30300000', datajson: {} };
  assert.throws(() => parseBalance(j, ctx), /无法解析/);
});

test('余额：deviceInfo 多元素 → kind=multi-meter，绝不静默取第一个', () => {
  // 静默取第一个 = 可能查了别人的电表，这是最坏的一种"看起来成功"
  const j = {
    code: '30300000',
    datajson: { deviceInfo: [{ infos: [info('JC_remoney', '10')] }, { infos: [info('JC_remoney', '99')] }] },
  };
  try {
    parseBalance(j, ctx);
    assert.fail('应当抛出 multi-meter');
  } catch (e) {
    assert.strictEqual(e.kind, 'multi-meter');
    assert.strictEqual(e.count, 2);
  }
});

test('余额：infos 缺失/非数组 → 报错而不是返回 0', () => {
  assert.throws(() => parseBalance(resp(null), ctx), /无法解析/);
  assert.throws(() => parseBalance(resp('oops'), ctx), /无法解析/);
});

// ------------------------------------------------------------ parseBalance 错误路径

test('余额：业务码不是 30300000 → 抛错并带上 code 与文案', () => {
  try {
    parseBalance({ code: '40001', message: '参数错误' }, ctx);
    assert.fail('应当抛出');
  } catch (e) {
    assert.strictEqual(e.code, '40001');
    assert.match(e.message, /参数错误/);
  }
});

test('余额：业务码失败但没有 message 时不崩', () => {
  assert.throws(() => parseBalance({ code: '40001' }, ctx), /查询失败/);
});

test('余额：响应不是对象 → 抛错', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.throws(() => parseBalance(bad, ctx), /无法解析/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('余额：余额字段是垃圾时抛错（不伪装成 0 或 NaN）', () => {
  assert.throws(() => parseBalance(resp([info('JC_remoney', '--')]), ctx), /无法解析/);
  assert.throws(() => parseBalance(resp([info('JC_remoney', '')]), ctx), /无法解析/);
});

test('余额：不传 ctx 也能工作（queriedAt 用当前时间）', () => {
  const b = parseBalance(resp([info('JC_remoney', '1')]));
  assert.ok(!Number.isNaN(Date.parse(b.queriedAt)), 'queriedAt 必须是合法 ISO 时间');
});

test('余额：ctx.now 传 Date 或函数都支持', () => {
  const b1 = parseBalance(resp([info('JC_remoney', '1')]), { now: NOW });
  assert.strictEqual(b1.queriedAt, NOW.toISOString());
});

// ------------------------------------------------------------ parseAccounts

test('账户：标准 listUser 结构', () => {
  const j = {
    listUser: {
      充值缴费: [
        { merUserBillInfo: { chargeNumber: '示例园#1#A101', chargeName: 'A101', rechMerMapId: 338, merchantId: 111267 } },
        { merUserBillInfo: { chargeNumber: '示例园#2#B102', chargeName: 'B102', rechMerMapId: 338, merchantId: 111267 } },
      ],
    },
  };
  const rows = parseAccounts(j);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].chargeNumber, '示例园#1#A101');
  assert.strictEqual(rows[0].group, '充值缴费');
});

test('账户：listUser 套在 datajson 里也能解', () => {
  const j = { datajson: { listUser: { 充值缴费: [{ chargeNumber: '示例园#1#A101' }] } } };
  const rows = parseAccounts(j);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].chargeNumber, '示例园#1#A101');
});

test('账户：没有 chargeNumber 的行被跳过（空行没有意义）', () => {
  const j = { listUser: { 组: [{ merUserBillInfo: {} }, { chargeNumber: '示例园#1#A101' }] } };
  assert.strictEqual(parseAccounts(j).length, 1);
});

test('账户：结构异常时返回空数组而不是崩', () => {
  for (const bad of [null, undefined, {}, { listUser: null }, { listUser: { 组: 'notarray' } }]) {
    assert.deepStrictEqual(parseAccounts(bad), []);
  }
});

test('账户：item 可能是 {merUserBillInfo} 也可能是裸对象，两种都支持', () => {
  const j = {
    listUser: {
      组: [
        { merUserBillInfo: { chargeNumber: '示例园#1#A101' } },
        { chargeNumber: '示例园#2#B102' },
      ],
    },
  };
  assert.strictEqual(parseAccounts(j).length, 2);
});
