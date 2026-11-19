// CLI 入口冒烟测试。
//
// 存在的理由（真实事故）：阶段 3 重构时我把 `doQuery` 和 `ensureLogin` 两个函数
// 连同旧的熔断段一起删掉了，而 213 条单元测试**全绿**——因为没有任何一条测试
// 碰 CLI 的执行路径。结果真实 CI 上 `node bin/elec.js check` 直接
// `ERROR 查询失败: doQuery is not defined`，退出码 1，整条定时任务失败。
//
// 教训：单元测试全绿 ≠ 程序能跑。`require()` 一个模块只会执行它的顶层，
// 函数体内的引用错误要等**函数真被调用**才暴露。所以必须有这一层：
// 每个命令都真正启动一次，断言它不是因为"代码缺陷"而失败。
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'elec.js');

/**
 * 跑一个命令，返回 { code, out }。
 *
 * **必须完全隔离本地环境**：只清 env 是不够的——`loadConfig()` 会回落到仓库根目录
 * 的 `config.json`，而那是真实配置。实测清空 QLGYDX_USER/PASS 之后命令依然能
 * 成功查询并打印真实房号与电表号（因为读到了本地 config.json）。
 * 所以这里必须在一个**空的临时目录**里运行，让 config.json 不存在。
 *
 * 我们要验证的是"能不能走到需要配置那一步"，而不是真的登录
 * （那会消耗真实登录次数，可能把账号锁死）。
 */
function run(args, env = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'elec-cli-'));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: workdir, // 关键：空目录，读不到任何 config.json / data/
    env: {
      ...process.env,
      // 清掉可能存在的真实凭据
      QLGYDX_USER: '',
      QLGYDX_PASS: '',
      QLGYDX_METER: '',
      QLGYDX_CONFIG: path.join(workdir, 'config.json'),
      ...env,
    },
  });
  fs.rmSync(workdir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 代码缺陷的典型特征——这些出现就一定是 bug，不是"环境没配好" */
const CODE_DEFECT = /is not defined|Cannot read propert|TypeError:|ReferenceError:|SyntaxError:|MODULE_NOT_FOUND/;

test('每个命令都不能因为代码缺陷而崩溃', () => {
  // 覆盖 COMMANDS 里的全部命令
  for (const cmd of ['query', 'check', 'login', 'setup', 'alert-test']) {
    const { out } = run([cmd]);
    assert.ok(
      !CODE_DEFECT.test(out),
      `命令 "${cmd}" 出现代码缺陷:\n${out.split('\n').filter(l => CODE_DEFECT.test(l)).join('\n')}`,
    );
  }
});

test('未知命令给出可用列表并以 2 退出', () => {
  const { code, out } = run(['不存在的命令']);
  assert.strictEqual(code, 2);
  assert.match(out, /未知命令/);
  assert.match(out, /可用命令/);
});

test('--dry-run 不会被当成未知命令', () => {
  const { out } = run(['check', '--dry-run']);
  assert.ok(!/未知命令/.test(out), `--dry-run 未被识别:\n${out}`);
});

test('缺少配置时给出可读提示并以非 0 退出', () => {
  // 非 0 退出很关键：CI 靠退出码判断成败。
  // 曾经这里返回 0，等于"配置全错也报成功"，定时任务会一直静默失败。
  const { code, out } = run(['query']);
  assert.ok(code !== 0, `配置缺失必须以非 0 退出，实际 ${code}`);
  assert.ok(!CODE_DEFECT.test(out), `提示里有代码缺陷:\n${out}`);
  // 应该逐项告诉用户缺什么，而不是只说"失败"
  assert.match(out, /配置错误/);
  assert.match(out, /username|电表号/);
});

test('所有模块都能被 require（捕获顶层引用错误）', () => {
  // 这条防止的另一种情况：某个 lib 文件的顶层 require 了不存在的东西。
  const mods = ['../lib/config', '../lib/alert', '../lib/cloud', '../lib/errors',
    '../lib/logger', '../lib/notify', '../lib/parse', '../lib/qlgydx',
    '../lib/session', '../lib/store', '../lib/time'];
  for (const m of mods) {
    assert.doesNotThrow(() => require(m), `require('${m}') 失败`);
  }
});

test('配置齐全时会真正走到查询逻辑（能捕获函数被误删）', () => {
  // 这条是阶段 3 事故的**直接回归测试**：当时我把 doQuery/ensureLogin
  // 连同旧熔断段一起删掉了。上面那条"缺少配置"的测试抓不到，因为程序在
  // 校验配置时就退出了，根本没走到 doQuery。
  //
  // 这里给一份语法合法但连不通的配置：命令必然失败，但失败的**原因**
  // 必须是网络/认证，而不是 ReferenceError。
  const { code, out } = run(['query'], {
    QLGYDX_USER: 'test_user',
    QLGYDX_PASS: 'test_pass',
    QLGYDX_METER: '示例园#1#A101',
    QLGYDX_NTFY_TOPIC: '',
  });
  assert.ok(!CODE_DEFECT.test(out),
    `配置齐全后暴露代码缺陷:\n${out.split('\n').filter(l => CODE_DEFECT.test(l)).join('\n')}`);
  // 断言它确实越过了配置校验（不是又卡在"配置错误"）
  assert.ok(!/配置错误/.test(out), `不该卡在配置校验:\n${out.slice(0, 400)}`);
  assert.ok(code !== 0, '假凭据理应登录失败');
});

test('alert-test：没有任何远程渠道时以非 0 退出（预警发不出去必须暴露）', () => {
  // 这条是阶段 5 的核心回归点。
  // 原来 alert-test 无论发送成败都退出 0，等于"渠道配错了也报成功"——
  // 而这恰恰是最该被发现的错误：预警发不出去，停电了也不知道。
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'elec-alert-'));
  const cfgFile = path.join(workdir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    account: { username: 'u', password: 'p' },
    meter: { custRechNo: '示例园#1#A101' },
    alert: { notify: { console: true, file: '' } }, // 只有本地渠道，没有远程
  }));

  const r = spawnSync(process.execPath, [BIN, 'alert-test'], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: workdir,
    env: { ...process.env, QLGYDX_CONFIG: cfgFile, QLGYDX_USER: '', QLGYDX_PASS: '', QLGYDX_METER: '' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  fs.rmSync(workdir, { recursive: true, force: true });

  assert.strictEqual(r.status, 1, `应退出 1，实际 ${r.status}\n${out}`);
  assert.match(out, /没有任何远程渠道送达成功/);
});
