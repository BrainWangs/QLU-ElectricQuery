// 配置迁移脚本（scripts/migrate-config.js）的夹具。
//
// 这一层的核心不是"能把 v1 改成 v2"，而是**改错了能不能退回去**：
// config.json 里有真实凭据，是不能丢的文件。
// 所以重点测三件事：dry-run 零写入、写盘前必留备份、凭据值不被打印。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { migrateData, detectVersion, diffPaths } = require('../scripts/migrate-config');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-config.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elec-mig-'));
}

/** 一份典型的 v1 配置：无 pushHours、有 redact、userInfoId 被破坏成 {} */
function v1Config() {
  return {
    account: { username: 'your_student_id', password: 'placeholder' },
    meter: { custRechNo: '示例园#1#A101', userInfoId: {} },
    schedule: { intervalMinutes: 120, activeHours: [8, 24] },
    alert: { threshold: 10, criticalThreshold: 5 },
    cloud: { redact: false, stateless: false, publishSnapshot: true },
  };
}

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ------------------------------------------------------------ 版本检测

test('版本检测：有 pushHours 且无 redact 判为 v2', () => {
  const v2 = v1Config();
  v2.schedule.pushHours = [8, 22];
  delete v2.cloud.redact;
  assert.strictEqual(detectVersion(v2), 2);
});

test('版本检测：缺 pushHours 或有 redact 都判为 v1', () => {
  assert.strictEqual(detectVersion(v1Config()), 1);

  const half = v1Config();
  half.schedule.pushHours = [8, 22];
  // 还留着 redact → 仍是 v1
  assert.strictEqual(detectVersion(half), 1);
});

test('版本检测：空对象不崩', () => {
  assert.strictEqual(detectVersion({}), 1);
});

// ------------------------------------------------------------ 迁移内容

test('迁移：新增 pushHours，默认 [8,22]', () => {
  const { data } = migrateData(v1Config());
  assert.deepStrictEqual(data.schedule.pushHours, [8, 22]);
});

test('迁移：删除 cloud.redact', () => {
  const { data } = migrateData(v1Config());
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data.cloud, 'redact'), false);
});

test('迁移：userInfoId 是空对象时重置为 null（**不猜具体值**）', () => {
  // 猜错 userInfoId 会查到别人的电表，所以只能置 null 等下次 login 重新发现
  const { data } = migrateData(v1Config());
  assert.strictEqual(data.meter.userInfoId, null);
});

test('迁移：userInfoId 已是合法数字时不动它', () => {
  const c = v1Config();
  c.meter.userInfoId = 12345678;
  const { data, log } = migrateData(c);
  assert.strictEqual(data.meter.userInfoId, 12345678);
  assert.ok(log.find(r => r.id === 'userInfoId-repair').note.includes('正常'));
});

test('迁移：userInfoId 为 null 时视为正常（尚未发现），不报异常', () => {
  const c = v1Config();
  c.meter.userInfoId = null;
  const { data } = migrateData(c);
  assert.strictEqual(data.meter.userInfoId, null);
});

test('迁移是纯函数：不修改传入的对象', () => {
  const orig = v1Config();
  const snapshot = JSON.stringify(orig);
  migrateData(orig);
  assert.strictEqual(JSON.stringify(orig), snapshot, 'migrateData 不该改入参');
});

test('迁移：幂等 —— 跑第二次不再产生改动', () => {
  const once = migrateData(v1Config()).data;
  const twice = migrateData(once).data;
  assert.deepStrictEqual(twice, once);
  assert.strictEqual(detectVersion(twice), 2);
});

test('迁移：已有 pushHours 时不覆盖用户的自定义值', () => {
  const c = v1Config();
  c.schedule.pushHours = [0, 24]; // 用户明确要"每次都推"
  const { data } = migrateData(c);
  assert.deepStrictEqual(data.schedule.pushHours, [0, 24], '用户设置必须保留');
});

// ------------------------------------------------------------ diff

test('diff：能列出新增与删除的键', () => {
  const a = { x: 1, y: 2 };
  const b = { x: 1, z: 3 };
  const d = diffPaths(a, b);
  const keys = d.map(x => x.key).sort();
  assert.deepStrictEqual(keys, ['y', 'z']);
});

test('diff：无改动时返回空数组', () => {
  assert.deepStrictEqual(diffPaths({ a: 1 }, { a: 1 }), []);
});

// ------------------------------------------------------------ CLI 行为（真实进程）

test('CLI：不带 --write 时零写入（dry-run 是默认）', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'config.json');
  const body = JSON.stringify(v1Config(), null, 2);
  fs.writeFileSync(f, body);

  const { code, out } = runCli(['--in', f]);
  assert.strictEqual(code, 0);
  assert.match(out, /dry-run/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), body, 'dry-run 绝不能改文件');
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json'], '不该产生 .bak 或其它文件');
});

test('CLI：--write 会写盘并留下 .bak 备份', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'config.json');
  const orig = JSON.stringify(v1Config(), null, 2);
  fs.writeFileSync(f, orig);

  const { code } = runCli(['--in', f, '--write']);
  assert.strictEqual(code, 0);
  assert.ok(fs.existsSync(`${f}.bak`), '必须留备份，否则迁错了退不回去');
  assert.strictEqual(fs.readFileSync(`${f}.bak`, 'utf8'), orig, '备份必须是原始内容');

  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(after.schedule.pushHours, [8, 22]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(after.cloud, 'redact'), false);
});

test('CLI：已是 v2 时直接退出，不改文件', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'config.json');
  const v2 = v1Config();
  v2.schedule.pushHours = [8, 22];
  delete v2.cloud.redact;
  const body = JSON.stringify(v2, null, 2);
  fs.writeFileSync(f, body);

  const { code, out } = runCli(['--in', f, '--write']);
  assert.strictEqual(code, 0);
  assert.match(out, /已是 v2/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), body);
  assert.ok(!fs.existsSync(`${f}.bak`), '无需迁移时不该产生备份');
});

test('CLI：文件不存在时以 2 退出并说明原因', () => {
  const { code, out } = runCli(['--in', path.join(tmpDir(), 'nope.json')]);
  assert.strictEqual(code, 2);
  assert.match(out, /找不到配置文件/);
});

test('CLI：JSON 损坏时以 2 退出，不覆盖原文件', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, '{ 坏掉的 json');
  const { code, out } = runCli(['--in', f, '--write']);
  assert.strictEqual(code, 2);
  assert.match(out, /不是合法 JSON/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ 坏掉的 json', '解析失败时绝不能写盘');
});

test('CLI：输出里绝不打印凭据值', () => {
  // 迁移日志会展示 diff。password/token 这类键的值必须打码，
  // 否则一次复制粘贴就把密码贴进了 issue。
  const dir = tmpDir();
  const f = path.join(dir, 'config.json');
  const c = v1Config();
  c.account.password = 'SuperSecret_DoNotPrint_123';
  c.alert.notify = { ntfy: { server: 'https://ntfy.sh', topic: 'my-secret-topic' } };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));

  const { out } = runCli(['--in', f]);
  assert.ok(!out.includes('SuperSecret_DoNotPrint_123'), '输出里出现了密码明文');
  assert.ok(!out.includes('my-secret-topic'), '输出里出现了 topic 明文');
  // 并且要明确告诉用户"这些键我看到了但没打印"，而不是假装不存在
  assert.match(out, /敏感字段/);
  assert.match(out, /account\.password/);
  assert.match(out, /ntfy\.topic/);
});
