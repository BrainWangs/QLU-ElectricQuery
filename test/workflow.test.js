// Workflow 文件校验。
//
// 为什么值得单独测：workflow YAML 写错时 GitHub 不会报错给你看，只会
// 静默地不触发（或者在 UI 里显示一个红色叉但没人注意）。等到"为什么
// 三天没收到预警"才发现，损失已经造成了。这里把结构性错误挡在提交前。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WF = path.join(__dirname, '..', '.github', 'workflows', 'elec-check.yml');

function loadWorkflow() {
  const text = fs.readFileSync(WF, 'utf8');
  return { text, doc: yaml.load(text) };
}

test('workflow：YAML 能被解析', () => {
  const { doc } = loadWorkflow();
  assert.ok(doc, '解析结果为空');
  assert.strictEqual(typeof doc, 'object');
});

test('workflow：必须由 schedule 和 workflow_dispatch 触发', () => {
  const { doc } = loadWorkflow();
  // YAML 1.1 里裸 on 会被解析成布尔 true，js-yaml 默认按 YAML 1.2 处理成字符串
  const on = doc.on ?? doc[true];
  assert.ok(on, '缺少 on 触发器');
  assert.ok(Array.isArray(on.schedule), 'schedule 必须是数组');
  assert.ok(on.schedule.length > 0, 'schedule 不能为空');
  assert.ok(on.workflow_dispatch, '缺少 workflow_dispatch（私有仓库方案靠它）');
});

test('workflow：cron 表达式合法且间隔 >= 5 分钟', () => {
  const { doc } = loadWorkflow();
  const on = doc.on ?? doc[true];
  for (const entry of on.schedule) {
    assert.ok(entry.cron, 'schedule 条目缺少 cron');
    const parts = entry.cron.trim().split(/\s+/);
    assert.strictEqual(parts.length, 5, `cron 应为 5 段，实际 "${entry.cron}"`);

    const [min] = parts;
    // GitHub 的 schedule 最小间隔是 5 分钟；比这更密不会更快，只会白烧额度
    if (min.startsWith('*/')) {
      const step = Number(min.slice(2));
      assert.ok(step >= 5, `间隔 ${step} 分钟小于 GitHub 最小允许值 5`);
    }
  }
});

test('workflow：有 concurrency，避免两次查询互相覆盖状态', () => {
  const { doc } = loadWorkflow();
  assert.ok(doc.concurrency, '缺少 concurrency');
  assert.ok(doc.concurrency.group, 'concurrency 缺少 group');
});

test('workflow：permissions 够写快照分支', () => {
  const { doc } = loadWorkflow();
  assert.strictEqual(doc.permissions?.contents, 'write', '推 data 分支需要 contents: write');
});

test('workflow：node 版本满足 package.json engines', () => {
  const { doc } = loadWorkflow();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const minor = Number(String(pkg.engines.node).replace(/[^0-9.]/g, '').split('.')[0]);

  const setup = doc.jobs.check.steps.find((s) => String(s.uses || '').startsWith('actions/setup-node'));
  assert.ok(setup, '缺少 setup-node 步骤');
  const ver = Number(String(setup.with['node-version']));
  assert.ok(ver >= minor, `workflow 用 node ${ver}，但 package.json 要求 >= ${minor}`);
});

test('workflow：执行查询的步骤注入了账号密码', () => {
  const { doc } = loadWorkflow();
  const runStep = doc.jobs.check.steps.find(
    (s) => typeof s.run === 'string' && s.run.includes('bin/elec.js check'),
  );
  assert.ok(runStep, '找不到执行 check 的步骤');
  const env = runStep.env || {};
  for (const key of ['QLGYDX_USER', 'QLGYDX_PASS', 'QLGYDX_METER']) {
    assert.ok(env[key], `缺少环境变量 ${key}`);
    assert.match(env[key], /secrets\./, `${key} 应引用 secrets 而不是硬编码`);
  }
});

test('workflow：不含任何硬编码的密码/学号明文', () => {
  const { doc } = loadWorkflow();
  // 逐字段检查 env 值是否都走 secrets，而不是把真实凭据写在 workflow 里
  // （workflow 是仓库里的明文文件，公开仓库会直接暴露）
  for (const step of doc.jobs.check.steps) {
    for (const [key, value] of Object.entries(step.env || {})) {
      if (!/^QLGYDX_(USER|PASS|METER|USERINFOID)$/.test(key)) continue;
      assert.match(
        String(value),
        /^\$\{\{\s*secrets\./,
        `${key} 必须引用 secrets，实际是 "${value}"`,
      );
    }
  }

  // 整体文本不应出现裸的密码形态（@ 开头的长串）或长数字学号
  const { text } = loadWorkflow();
  assert.ok(!/@[A-Za-z][A-Za-z0-9]{6,}/.test(text), 'workflow 里出现了疑似密码明文');
  assert.ok(!/\b20\d{10}\b/.test(text), 'workflow 里出现了疑似学号明文');
  assert.ok(!/SESSION=[0-9a-f]{16,}/i.test(text), 'workflow 里出现了会话 cookie');
});

test('workflow：发布快照前必须做脱敏检查', () => {
  const { doc } = loadWorkflow();
  const pub = doc.jobs.check.steps.find(
    (s) => typeof s.run === 'string' && s.run.includes('push origin HEAD:data'),
  );
  assert.ok(pub, '找不到发布快照到 data 分支的步骤');
  // 顺序很重要：先检查后推送。写在 push 之后就毫无意义了。
  const iCheck = pub.run.indexOf('check-snapshot.js');
  const iPush = pub.run.indexOf('push origin HEAD:data');
  assert.ok(iCheck >= 0, '发布步骤缺少 check-snapshot.js 脱敏检查');
  assert.ok(iCheck < iPush, '脱敏检查必须在 push 之前执行');
});

test('workflow：history.jsonl 的发布必须受脱敏开关控制', () => {
  const { doc } = loadWorkflow();
  const pub = doc.jobs.check.steps.find(
    (s) => typeof s.run === 'string' && s.run.includes('push origin HEAD:data'),
  );
  assert.ok(pub, '找不到发布步骤');
  // history.jsonl 每行都含 location/custRechNo。策略：
  //  - 仓库私有（QLGYDX_REDACT 未设）→ 发布，README 折线图才能更新
  //  - 仓库公开（QLGYDX_REDACT=1）→ 跳过发布历史文件，只发 latest.json（它有兜底检查）
  assert.ok(
    /PUBLISH_HISTORY/.test(pub.run),
    '发布 history.jsonl 前必须判断 PUBLISH_HISTORY（= ! QLGYDX_REDACT）',
  );
});

test('workflow：日志里不能 cat 完整快照', () => {
  const { doc } = loadWorkflow();
  for (const step of doc.jobs.check.steps) {
    if (typeof step.run !== 'string') continue;
    // Actions 日志对公开仓库所有人可见；cat 整个 latest.json 会把位置细节写进日志
    assert.ok(
      !/^\s*cat\s+data\/latest\.json\s*$/m.test(step.run),
      `步骤「${step.name}」直接 cat 了完整快照`,
    );
  }
});

test('workflow：npm ci 之前先有 checkout', () => {
  const { doc } = loadWorkflow();
  const steps = doc.jobs.check.steps;
  const iCheckout = steps.findIndex((s) => String(s.uses || '').startsWith('actions/checkout'));
  const iCi = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('npm ci'));
  assert.ok(iCheckout >= 0 && iCi >= 0, '缺少 checkout 或 npm ci');
  assert.ok(iCheckout < iCi, 'checkout 必须在 npm ci 之前');
});
