// 快照脱敏与发布前检查的测试。
//
// 公开仓库的 data 分支和 GitHub Actions 的运行日志谁都看得到。
// 余额曲线被看到不算大事，"某人住在哪一间、余额多少"就是隐私泄露。
// 所以脱敏一旦失效必须被测出来，而不是等推送之后才发现。
const test = require('node:test');
const assert = require('node:assert');

const { redactLocation, redactMeter } = require('../lib/cloud.js');
const { problems } = require('../scripts/check-snapshot.js');

// ------------------------------------------------------------ location 打码

test('位置打码：房间号被替换，楼栋与园区保留', () => {
  assert.strictEqual(
    redactLocation('示例校区学生公寓.示例园1号公寓A区.3楼.A101'),
    '示例校区学生公寓.示例园1号公寓A区.3楼.***',
  );
});

test('位置打码：纯数字房号也要打码', () => {
  assert.strictEqual(redactLocation('某公寓.1楼.101'), '某公寓.1楼.***');
});

test('位置打码：只有一段时不硬拆，原样返回', () => {
  // 拆不动就原样返回 —— 总比抛异常把查询流程搞挂好
  assert.strictEqual(redactLocation('某个地方'), '某个地方');
});

test('位置打码：空值返回 null，不产生 "null" 字符串', () => {
  assert.strictEqual(redactLocation(null), null);
  assert.strictEqual(redactLocation(undefined), null);
  assert.strictEqual(redactLocation(''), null);
});

// ------------------------------------------------------------ 电表号打码

test('电表号打码：只留园区与楼号', () => {
  assert.strictEqual(redactMeter('示例园#1#A101'), '示例园#1#***'); // preflight-ignore
});

test('电表号打码：全角井号同样处理', () => {
  assert.strictEqual(redactMeter('示例园＃1＃A101'), '示例园＃1＃***'); // preflight-ignore
});

test('电表号打码：没有井号分隔时原样返回（不瞎猜）', () => {
  assert.strictEqual(redactMeter('A101'), 'A101');
  assert.strictEqual(redactMeter(null), null);
});

// ------------------------------------------------------------ 发布前检查

test('检查脚本：已打码的快照应通过', () => {
  const snap = {
    location: '示例校区学生公寓.示例园1号公寓A区.3楼.***',
    custRechNo: '示例园#1#***',
  };
  assert.deepStrictEqual(problems(snap), []);
});

test('检查脚本：未打码的快照必须被判为有问题', () => {
  const snap = {
    location: '示例校区学生公寓.示例园1号公寓A区.3楼.A101',
    custRechNo: '示例园#1#A101', // preflight-ignore
  };
  const found = problems(snap);
  assert.strictEqual(found.length, 2, `应报 2 项，实际：${JSON.stringify(found)}`);
  assert.ok(found.some((p) => p.includes('location')));
  assert.ok(found.some((p) => p.includes('custRechNo')));
});

test('检查脚本：只漏一处的也要抓到', () => {
  const snap = {
    location: '示例校区学生公寓.示例园1号公寓A区.3楼.***',
    custRechNo: '示例园#1#A101', // preflight-ignore
  };
  const found = problems(snap);
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].includes('custRechNo'));
});

test('检查脚本：字段缺失时不误报（失败快照可能没有位置）', () => {
  assert.deepStrictEqual(problems({ balance: null }), []);
  assert.deepStrictEqual(problems({ location: null, custRechNo: null }), []);
});

test('检查脚本：开启脱敏时 buildSnapshot 的输出可直接发布', () => {
  const cloud = require('../lib/cloud.js');
  // redact 是可选开关：只有显式打开才会打码。仓库公开时才需要。
  const cfg = {
    alert: { threshold: 10, criticalThreshold: 5 },
    meter: { custRechNo: '测试园#2#B102' }, // preflight-ignore
    cloud: { redact: true },
  };
  const result = {
    balance: 42.5,
    location: '示例校区学生公寓.测试园2号公寓B区.5楼.B102',
    custRechNo: '测试园#2#B102', // preflight-ignore
    meterAddress: '152000000000',
    unit: '开户',
    queriedAt: new Date().toISOString(),
  };
  const snap = cloud.buildSnapshot({ result, cfg, history: [], alerts: [], state: {} });
  // buildSnapshot 内部必须已经打过码
  assert.deepStrictEqual(problems(snap), [], 'buildSnapshot 的输出必须是可直接发布的');
  assert.ok(!snap.location.includes('B102'), `location 仍含房号：${snap.location}`);
  assert.ok(!snap.custRechNo.includes('B102'), `custRechNo 仍含房号：${snap.custRechNo}`);
});

test('检查脚本：关闭脱敏时保留真实房号（私有仓库默认行为）', () => {
  const cloud = require('../lib/cloud.js');
  const cfg = {
    alert: { threshold: 10, criticalThreshold: 5 },
    meter: { custRechNo: '测试园#2#B102' }, // preflight-ignore
    cloud: { redact: false },
  };
  const result = {
    balance: 42.5,
    location: '示例校区学生公寓.测试园2号公寓B区.5楼.B102',
    custRechNo: '测试园#2#B102', // preflight-ignore
    queriedAt: new Date().toISOString(),
  };
  const snap = cloud.buildSnapshot({ result, cfg, history: [], alerts: [], state: {} });
  // 私有仓库里保留真实房号是刻意的：手机上能直接确认是哪间宿舍
  assert.equal(snap.location, result.location);
  assert.equal(snap.custRechNo, result.custRechNo);
});
