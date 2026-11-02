// 隐私自检脚本本身的测试。
//
// 检测器比被测代码更需要测试：一个漏报的密钥扫描器比没有扫描器更危险，
// 因为它会让人误以为"已经检查过了"。这里对每条规则的判据都做正反用例。
const test = require('node:test');
const assert = require('node:assert');

const { RULES } = require('../scripts/preflight.js');

function hits(ruleName, sample) {
  const rule = RULES.find((r) => r.name === ruleName);
  assert.ok(rule, `找不到规则 ${ruleName}`);
  rule.pattern.lastIndex = 0;
  // 与 scan() 保持一致：逐条匹配（一行里可能先有官方示例、后面才是真值），
  // 且占位符与官方示例都算放过。
  for (const m of sample.matchAll(rule.pattern)) {
    if (/你的|xxx|XXXX|example|placeholder|\$\{/.test(m[0])) continue;
    if (rule.examples && rule.examples.test(m[0])) continue;
    return true;
  }
  return false;
}

// ------------------------------------------------------------ 密码规则

test('密码规则：能抓到本校格式的密码', () => {
  assert.strictEqual(hits('密码明文', 'export QLGYDX_PASS="@Abc123456789"'), true); // preflight-ignore
  assert.strictEqual(hits('密码明文', "password: '@Abc12345678'"), true); // preflight-ignore
});

test('密码规则：放过 JSDoc 标签（否则每个源文件都报错）', () => {
  for (const s of ['@returns {string}', '@param x 说明', '@type {number}', '@example', '@throws Error']) {
    assert.strictEqual(hits('密码明文', s), false, `不该命中 ${s}`);
  }
});

test('密码规则：放过邮箱、npm scope、.github 后缀', () => {
  for (const s of [
    'email a@B1234567.com',
    'npm i @babel/core',
    'elec-bot@users.noreply.github.com',
    '@types/node',
  ]) {
    assert.strictEqual(hits('密码明文', s), false, `不该命中 ${s}`);
  }
});

test('密码规则：纯小写或纯字母的 @ 串不误报（靠大小写+数字双条件）', () => {
  assert.strictEqual(hits('密码明文', '@returns'), false);
  assert.strictEqual(hits('密码明文', '@abcdefghijkl'), false);
  assert.strictEqual(hits('密码明文', '@1234567890123'), false);
});

// ------------------------------------------------------------ 学号规则

test('学号规则：能抓到 12 位、20 开头的学号', () => {
  assert.strictEqual(hits('学号/工号明文', 'user=202300000000'), true); // preflight-ignore
  assert.strictEqual(hits('学号/工号明文', 'QLGYDX_USER=202312345678'), true); // preflight-ignore
});

test('学号规则：放过明显不是学号的数字', () => {
  assert.strictEqual(hits('学号/工号明文', 'port: 8899'), false);
  assert.strictEqual(hits('学号/工号明文', 'merchantId: 111267'), false);
  assert.strictEqual(hits('学号/工号明文', 'id=12345678901'), false); // 11 位
  assert.strictEqual(hits('学号/工号明文', 'id=2023000000005'), false); // 13 位 // preflight-ignore
});

// ------------------------------------------------------------ 其他规则

test('会话 cookie 规则', () => {
  assert.strictEqual(hits('会话 cookie', 'Cookie: SESSION=abcdef1234567890abcdef'), true); // preflight-ignore
  assert.strictEqual(hits('会话 cookie', 'SESSION=short'), false);
});

test('sessionToken 规则', () => {
  assert.strictEqual(
    hits('sessionToken', '"sessionToken":"ddfc9ac9-3218-4239-a9e4-6b1249299a59"'), // preflight-ignore
    true,
  );
  assert.strictEqual(hits('sessionToken', 'sessionToken: 随便写的'), false);
});

test('私钥规则', () => {
  assert.strictEqual(hits('私钥', '-----BEGIN RSA PRIVATE KEY-----'), true); // preflight-ignore
  assert.strictEqual(hits('私钥', '-----BEGIN PRIVATE KEY-----'), true); // preflight-ignore
  assert.strictEqual(hits('私钥', '-----BEGIN CERTIFICATE-----'), false);
});

test('GitHub token 规则', () => {
  assert.strictEqual(hits('GitHub token', 'ghp_' + 'a'.repeat(36)), true); // preflight-ignore
  assert.strictEqual(hits('GitHub token', 'ghp_short'), false); // preflight-ignore
});

// ------------------------------------------------------------ 宿舍号 / userInfoId
//
// 这两条规则不加的话，"住在哪一间、账号是哪个 ID"就会跟着文档一起进公开仓库。
// 注意 A101 是学校登录页自己给的示例，必须放过 —— 否则每条文档都会误报。

test('宿舍号规则：抓真实房间号，放过官方示例', () => {
  assert.strictEqual(hits('真实宿舍号', 'custRechNo": "示例园#1#C305"'), true); // preflight-ignore
  assert.strictEqual(hits('真实宿舍号', '示例园＃1＃C305'), true); // 全角井号 // preflight-ignore
  assert.strictEqual(hits('真实宿舍号', '如 示例园#1#A101'), false); // 官方示例
  assert.strictEqual(hits('真实宿舍号', '示例园#1#A101 和 示例园#2#D407'), true); // 其他房间也要抓 // preflight-ignore
});

test('userInfoId 规则：抓真实 ID，放过占位值', () => {
  assert.strictEqual(hits('个人 userInfoId', '"userInfoId": 87654321'), true); // preflight-ignore
  assert.strictEqual(hits('个人 userInfoId', 'userInfoId = 98765432'), true); // preflight-ignore
  assert.strictEqual(hits('个人 userInfoId', '"userInfoId": 12345678'), false); // 占位值
  assert.strictEqual(hits('个人 userInfoId', 'merchantId: 111267'), false); // 不是这个字段
});

// ------------------------------------------------------------ 整体

test('扫描当前工作区应通过（仓库本身不含敏感信息）', () => {
  const { scan } = require('../scripts/preflight.js');
  const { findings } = scan();
  assert.deepStrictEqual(
    findings.map((f) => `${f.file}:${f.line} ${f.rule}`),
    [],
    '仓库文件里有疑似敏感信息，先处理再提交',
  );
});
