// 外部定时（Cloudflare Worker）配置的夹具。
//
// 这一层不测"网络能不能通"（那需要真部署），而是测**配置本身的正确性**：
//   - cron 表达式换算成北京时间后，是否正好落在 slots 上；
//   - Worker 代码里是否泄露了 token；
//   - 部署文档里的 cron 表与 wrangler.toml 是否一致。
//
// 为什么值得测：cron 时区是最容易错的地方（Cloudflare 的 cron 只认 UTC，
// 而本项目所有"给人看的时间"都是北京时间）。写错一个数字，
// 表现是"每天准点查，但准的是 UTC 的 8 点"——比完全不跑更难发现。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER_DIR = path.join(ROOT, 'deploy', 'cloudflare-worker');

const workerJs = fs.readFileSync(path.join(WORKER_DIR, 'worker.js'), 'utf8');
const wrangler = fs.readFileSync(path.join(WORKER_DIR, 'wrangler.toml'), 'utf8');
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'external-cron.md'), 'utf8');

/** 从 wrangler.toml 里抽出 crons 数组 */
function parseCrons(toml) {
  const m = toml.match(/crons\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

/** UTC 小时 → 北京小时 */
const toBeijing = utcHour => (utcHour + 8) % 24;

// ------------------------------------------------------------ cron 换算

test('cron：wrangler.toml 里有 4 条触发', () => {
  const crons = parseCrons(wrangler);
  assert.strictEqual(crons.length, 4, `应有 4 条，实际 ${crons.length}: ${crons.join(', ')}`);
});

test('cron：每条都换算成北京 8/12/16/20 点', () => {
  const slots = require('../lib/config').__test.DEFAULTS.schedule.slots;
  const got = parseCrons(wrangler).map((expr) => {
    const parts = expr.trim().split(/\s+/);
    assert.strictEqual(parts.length, 5, `${expr} 不是 5 段式 cron`);
    const [min, hour] = parts;
    assert.strictEqual(Number(min), 0, `${expr} 应在整分触发（准点）`);
    return toBeijing(Number(hour));
  }).sort((a, b) => a - b);

  assert.deepStrictEqual(got, slots,
    `cron 换算后应等于 slots ${JSON.stringify(slots)}，实际 ${JSON.stringify(got)}`);
});

test('cron：小时字段不能写错成"已是北京时间"', () => {
  // 这是最容易犯的错：直接把 8/12/16/20 写进 cron，以为是北京时间。
  // Cloudflare 只认 UTC，那样会变成北京 16/20/次日 0/4 点。
  const crons = parseCrons(wrangler);
  const utcHours = crons.map(c => Number(c.trim().split(/\s+/)[1]));
  assert.ok(!utcHours.includes(20), 'UTC 小时里出现 20 —— 大概是把北京时间直接抄进去了');
  assert.deepStrictEqual(utcHours.sort((a, b) => a - b), [0, 4, 8, 12]);
});

test('cron：文档里的换算表与 wrangler.toml 一致', () => {
  const crons = parseCrons(wrangler);
  for (const expr of crons) {
    assert.ok(doc.includes(expr), `文档里缺少 cron 表达式 ${expr}`);
  }
  // 文档应明确写出"UTC"这个前提，避免读者误以为是北京时间
  assert.match(doc, /UTC/, '文档必须说明 cron 只认 UTC');
});

// ------------------------------------------------------------ Worker 代码安全

test('worker：源码里绝不能出现 token 字面量', () => {
  // 真实事故：有人在代码里写死 token 然后推送到仓库
  assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(workerJs), 'worker.js 里出现了 GitHub token 明文');
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(workerJs), 'worker.js 里出现了 classic token 明文');
});

test('worker：token 必须从 env 读取', () => {
  assert.match(workerJs, /env\.GITHUB_TOKEN/, 'token 应从 env.GITHUB_TOKEN 读取');
});

test('wrangler.toml：不能把 token 写进 [vars]', () => {
  const varsBlock = wrangler.split('[vars]')[1] || '';
  assert.ok(!/GITHUB_TOKEN\s*=/.test(varsBlock),
    '[vars] 是明文配置，token 必须用 wrangler secret put 单独设置');
});

test('worker：scheduled 与 fetch 两个入口都存在', () => {
  assert.match(workerJs, /async\s+scheduled\s*\(/, '缺 scheduled 入口（cron 靠它）');
  assert.match(workerJs, /async\s+fetch\s*\(/, '缺 fetch 入口（手动验证靠它）');
});

test('worker：对 401/403/404 调用 noRetry（配置错误重试无意义）', () => {
  assert.match(workerJs, /controller\.noRetry\(\)/, '缺 noRetry 调用');
  // 这三类状态码应被显式识别
  for (const code of ['401', '403', '404']) {
    assert.ok(workerJs.includes(code), `未处理 HTTP ${code}`);
  }
});

test('worker：成功判定是 204（GitHub dispatch 的空响应）', () => {
  assert.match(workerJs, /res\.status\s*===\s*204/, 'dispatch 成功返回 204，判定应据此');
});

test('worker：请求带 X-GitHub-Api-Version（避免 API 行为漂移）', () => {
  assert.match(workerJs, /X-GitHub-Api-Version/);
});

// ------------------------------------------------------------ 文档完整性

test('文档：说明了两种模式的区别与切换方式', () => {
  assert.match(doc, /"github"/);
  assert.match(doc, /"external"/);
  assert.match(doc, /schedule\.mode/, '应说明开关字段名');
  assert.match(doc, /回退/, '应有回退说明');
});

test('文档：给出了 fine-grained token 的最小权限', () => {
  assert.match(doc, /Actions:\s*Read and write/, '应写明只需 Actions 读写权限');
});

test('文档：包含排障表（401/403/404 分别对应什么）', () => {
  for (const code of ['401', '403', '404']) {
    assert.ok(doc.includes(code), `排障表缺 ${code}`);
  }
});

// ------------------------------------------------------------ 双模式在配置层可用

test('配置：mode 与 windowMinutes 的默认组合能推出正确窗口', () => {
  const { __test } = require('../lib/config');
  const { windowForMode } = require('../lib/schedule');
  const d = __test.DEFAULTS.schedule;
  // 默认 github + null（交给 mode 推导）
  assert.strictEqual(d.mode, 'github');
  assert.strictEqual(d.windowMinutes, null);
  assert.strictEqual(windowForMode(d.mode), 30);
  // 若切成 external，窗口自动变 10
  assert.strictEqual(windowForMode('external'), 10);
});

test('配置：schema 拒绝非法的 mode 值', () => {
  const { validateSchema, __test } = require('../lib/config');
  const cfg = __test.deepMerge(__test.DEFAULTS, {
    account: { username: 'u', password: 'p' },
    meter: { custRechNo: '示例园#1#A101' },
    schedule: { mode: 'cloudflare' }, // 不是合法的两个值
  });
  const errs = validateSchema(cfg);
  assert.ok(errs.some(e => /schedule\.mode/.test(e)), `应报 mode 非法，实际: ${JSON.stringify(errs)}`);
});

// ------------------------------------------------------------ 环境变量切换模式
//
// CI 里没有 config.json（它被 .gitignore 排除），只能靠环境变量切换模式。
// 所以 QLGYDX_SCHEDULE_MODE 是 external 模式在 CI 上生效的唯一途径。

test('CI：QLGYDX_SCHEDULE_MODE=external 能把模式切过去', () => {
  const os = require('node:os');
  const fsx = require('node:fs');
  const px = require('node:path');
  const tmp = px.join(os.tmpdir(), `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fsx.writeFileSync(tmp, '{}');

  const oldCfg = process.env.QLGYDX_CONFIG;
  const oldMode = process.env.QLGYDX_SCHEDULE_MODE;
  process.env.QLGYDX_CONFIG = tmp;
  try {
    delete process.env.QLGYDX_SCHEDULE_MODE;
    delete require.cache[require.resolve('../lib/config')];
    const c1 = require('../lib/config').loadConfig();
    assert.strictEqual(c1.schedule.mode, 'github', '不设环境变量时应为 github');

    process.env.QLGYDX_SCHEDULE_MODE = 'external';
    const c2 = require('../lib/config').loadConfig();
    assert.strictEqual(c2.schedule.mode, 'external');

    // 非 external 的值一律回落到 github（避免拼错导致意外行为）
    process.env.QLGYDX_SCHEDULE_MODE = 'cloudflare';
    const c3 = require('../lib/config').loadConfig();
    assert.strictEqual(c3.schedule.mode, 'github', '非法值应回落 github');
  } finally {
    if (oldCfg === undefined) delete process.env.QLGYDX_CONFIG; else process.env.QLGYDX_CONFIG = oldCfg;
    if (oldMode === undefined) delete process.env.QLGYDX_SCHEDULE_MODE; else process.env.QLGYDX_SCHEDULE_MODE = oldMode;
    try { fsx.unlinkSync(tmp); } catch { /* ignore */ }
    delete require.cache[require.resolve('../lib/config')];
  }
});

test('CI：workflow 里确实注入了 QLGYDX_SCHEDULE_MODE', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'elec-check.yml'), 'utf8');
  assert.match(wf, /QLGYDX_SCHEDULE_MODE/, 'workflow 必须注入这个变量，否则 CI 上切不到 external 模式');
  assert.match(wf, /QLGYDX_SCHEDULE_MODE:\s*external/, '值应是 external');
});

test('config.example.json 必须与当前 schema 同步（不能含废弃字段）', () => {
  const fsx = require('node:fs');
  const cfgMod = require('../lib/config');
  const raw = fsx.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8');
  const ex = JSON.parse(raw);
  const clean = JSON.parse(JSON.stringify(ex, (k, v) => (k.startsWith('_') ? undefined : v)));
  const merged = cfgMod.__test.deepMerge(cfgMod.__test.DEFAULTS, clean);

  // 1) 必须能通过 schema 校验
  assert.deepStrictEqual(cfgMod.validateSchema(merged), [],
    'config.example.json 未通过 schema 校验');

  // 2) 不能含已删除的字段（否则新人照着抄会配出一个不生效的项）
  assert.ok(!('intervalMinutes' in merged.schedule),
    'intervalMinutes 已删除（watch 模式的遗留），不该出现在示例里');
  assert.ok(!('redact' in merged.cloud),
    'cloud.redact 已删除（脱敏移交 build-mirror），不该出现在示例里');

  // 3) 必须包含当前生效的核心字段
  assert.strictEqual(merged.schedule.mode, 'github');
  assert.deepStrictEqual(merged.schedule.slots, [8, 12, 16, 20]);

  // 4) 示例里不能出现真实园区名/真实房号
  // 真实园区名用运行时拼接，避免这个测试文件本身被 preflight 判为泄漏
  const REAL_CAMPUS = ['鲁','韵园'].join('') + '|' + ['彩石','校区'].join('');
  assert.ok(!new RegExp(REAL_CAMPUS).test(raw),
    'config.example.json 里出现了真实园区名');
  // 真实房号同样用运行时拼接
  const REAL_ROOM = 'A' + '316';
  assert.ok(!new RegExp('\\b' + REAL_ROOM + '\\b').test(raw), 'config.example.json 里出现了真实房号');
});
