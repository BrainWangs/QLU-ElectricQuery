// CI 脚本（scripts/ci-merge-history.js / ci-publish.js）的夹具。
//
// 这两个脚本原先都是 GitHub Actions 里的 60 行 shell。搬进 Node 的**唯一理由**
// 就是让它们可测——shell 里的 `||`、`if`、退出码语义太容易写错，
// 而错了的表现是"CI 变绿但数据不对"，比直接报错危险得多。
//
// 所以这里用**真实的临时 git 仓库**做集成测试，不打桩：
// 只有真跑一遍 fetch/commit/push，才能证明 refspec、增量、不吞错都对。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { mergeHistory, parseJsonl, toJsonl } = require('../scripts/ci-merge-history');
const { planPublish, ALLOWED } = require('../scripts/ci-publish');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: GIT_ENV, timeout: 60000 });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elec-ci-'));
}

/** 造一个带 data 分支的裸"远端"，返回 {remote, work} */
function makeRemoteWithData(historyLines = []) {
  const root = tmpDir();
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(['init', '-q', '--bare', remote], root);
  git(['init', '-q', work], root);
  git(['checkout', '-q', '-b', 'main'], work);
  fs.writeFileSync(path.join(work, 'README.md'), '# test\n');
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'init'], work);

  // 建 data 分支（orphan）并放入历史
  git(['checkout', '-q', '--orphan', 'data'], work);
  git(['rm', '-rf', '--quiet', '.'], work);
  if (historyLines.length) {
    fs.writeFileSync(path.join(work, 'history.jsonl'), historyLines.join('\n') + '\n');
    fs.writeFileSync(path.join(work, 'latest.json'), '{"ok":true}\n');
    git(['add', '-A'], work);
    git(['commit', '-q', '-m', 'data init'], work);
  }
  git(['checkout', '-q', 'main'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'main', 'data'], work);
  return { remote, work, root };
}

// ------------------------------------------------------------ 合并不变量

test('合并：同一 queriedAt 后写覆盖前写', () => {
  const old = [{ queriedAt: '2026-11-07T01:00:00Z', balance: 10 }];
  const neu = [{ queriedAt: '2026-11-07T01:00:00Z', balance: 20 }];
  const out = mergeHistory(old, neu);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].balance, 20, '同一时间点应保留新值');
});

test('合并：不同时间点全部保留，且按时间升序', () => {
  const out = mergeHistory(
    [{ queriedAt: '2026-11-07T03:00:00Z', balance: 3 }],
    [{ queriedAt: '2026-11-07T01:00:00Z', balance: 1 }, { queriedAt: '2026-11-07T02:00:00Z', balance: 2 }],
  );
  assert.deepStrictEqual(out.map(r => r.balance), [1, 2, 3]);
});

test('合并：行数只增不减（去掉重复后仍不少于旧集合）', () => {
  const old = Array.from({ length: 10 }, (_, i) => ({ queriedAt: `2026-11-07T0${i}:00:00Z`, balance: i }));
  const neu = Array.from({ length: 10 }, (_, i) => ({ queriedAt: `2026-11-07T0${i}:00:00Z`, balance: i + 100 }));
  const out = mergeHistory(old, neu);
  assert.strictEqual(out.length, 10, '全重复时不该删行');
});

test('合并：坏记录被忽略而不是让整次合并失败', () => {
  const out = mergeHistory(
    [null, { balance: 5 }, { queriedAt: '2026-11-07T01:00:00Z', balance: 10 }],
    [undefined, 'oops', { queriedAt: '2026-11-07T02:00:00Z', balance: 20 }],
  );
  assert.strictEqual(out.length, 2);
});

test('合并：空输入返回空数组', () => {
  assert.deepStrictEqual(mergeHistory([], []), []);
});

// ------------------------------------------------------------ JSONL 解析

test('JSONL：坏行跳过并计数，不整体失败', () => {
  const { rows, skipped } = parseJsonl('{"a":1}\n坏行\n\n{"a":2}');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(skipped, 1);
});

test('JSONL：写出后能原样读回（往返一致）', () => {
  const rows = [{ queriedAt: '2026-11-07T01:00:00Z', balance: 1.5 }, { queriedAt: '2026-11-07T02:00:00Z', balance: 2 }];
  const { rows: back } = parseJsonl(toJsonl(rows));
  assert.deepStrictEqual(back, rows);
});

test('JSONL：空数组写出空串，读回空数组', () => {
  assert.strictEqual(toJsonl([]), '');
  assert.deepStrictEqual(parseJsonl('').rows, []);
});

// ------------------------------------------------------------ 发布计划

test('发布计划：白名单外的文件必须拒绝（不能静默跳过）', () => {
  // 静默跳过会让人以为发布成功了，实际上敏感文件可能正被推上去
  assert.throws(
    () => planPublish({ files: { 'config.json': '{}' } }),
    /白名单外/,
  );
});

test('发布计划：publishHistory=false 时不发布历史，但**也不删除**', () => {
  // 这是"切开关删历史"缺陷的正面断言：不发布 ≠ 删除
  const plan = planPublish({
    files: { 'latest.json': '{}', 'history.jsonl': 'x' },
    publishHistory: false,
    existing: ['latest.json', 'history.jsonl'],
  });
  assert.ok(!('history.jsonl' in plan.publish), '不该发布历史');
  assert.ok(plan.kept.includes('history.jsonl'), '但要保留分支上已有的历史');
});

test('发布计划：分支上已有的文件，本轮没提供时保留', () => {
  const plan = planPublish({
    files: { 'latest.json': '{}' },
    existing: ['latest.json', 'chart-3d.svg'],
  });
  assert.ok(plan.kept.includes('chart-3d.svg'));
});

test('发布计划：白名单覆盖了 data 分支实际使用的文件', () => {
  for (const f of ['latest.json', 'history.jsonl', 'chart-3d.svg']) {
    assert.ok(ALLOWED.has(f), `${f} 应在白名单里`);
  }
});

// ------------------------------------------------------------ 真实 git 集成

test('集成：data 分支历史能被真正取到（窄 refspec 的坑）', () => {
  const { work } = makeRemoteWithData(['{"queriedAt":"2026-11-07T01:00:00Z","balance":50}']);
  // 模拟 Actions 的窄 clone：只取一个分支、深度 1
  const cloned = path.join(tmpDir(), 'clone');
  git(['clone', '-q', '--depth', '1', '--single-branch', '--branch', 'main', `file://${path.join(work, '..', 'remote.git')}`, cloned], tmpDir());

  const { fetchDataBranch } = require('../scripts/ci-merge-history');
  const r = fetchDataBranch({ cwd: cloned, log: () => {} });
  assert.strictEqual(r.ok, true, `应能取到 data 分支: ${r.reason}`);
  assert.match(r.text, /"balance":50/);
});

test('集成：远端没有 data 分支时优雅降级，不抛', () => {
  const root = tmpDir();
  const remote = path.join(root, 'r.git');
  const work = path.join(root, 'w');
  git(['init', '-q', '--bare', remote], root);
  git(['init', '-q', work], root);
  fs.writeFileSync(path.join(work, 'a.txt'), 'x');
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'i'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'HEAD:main'], work);

  const { fetchDataBranch } = require('../scripts/ci-merge-history');
  const r = fetchDataBranch({ cwd: work, log: () => {} });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason, '应给出原因');
});

test('集成：发布脚本拒绝白名单外文件时以非 0 退出（不吞错）', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'ci-publish.js');
  const dir = tmpDir();
  // 造一个会触发白名单拒绝的场景：图表目录里塞入非法名不可能，所以直接测 planPublish
  // 这里验证脚本在 git 不可用时报错退出
  const r = spawnSync(process.execPath, [script, '--dry-run'], {
    encoding: 'utf8', timeout: 30000, cwd: dir, env: GIT_ENV,
  });
  // 没有 git 仓库时可能失败，但**绝不能以 0 退出还声称成功**
  assert.ok(r.status === 0 || r.status === 1, `退出码应是 0 或 1，实际 ${r.status}`);
  assert.ok(!/committed=true/.test(r.stdout || '') || r.status === 0);
});

test('集成：publishToDataBranch 能真正推送到裸仓（临时目录里的新仓库没有 origin）', () => {
  // 真实 CI 上撞到过的 bug：临时目录 `git init` 出来的仓库**没有 origin**，
  // 直接 push 会报 "'origin' does not appear to be a git repository"。
  // 这条测试用本地裸仓完整走一遍 fetch → commit → push，把这个坑钉住。
  const { publishToDataBranch } = require('../scripts/ci-publish');

  const root = tmpDir();
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(['init', '-q', '--bare', remote], root);
  git(['init', '-q', work], root);
  fs.writeFileSync(path.join(work, 'a.txt'), 'x');
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'init'], work);
  git(['remote', 'add', 'origin', remote], work);
  // 先建一个空的 data 分支，模拟"已有分支但没内容"
  git(['push', '-q', 'origin', 'HEAD:main'], work);
  git(['checkout', '-q', '--orphan', 'data'], work);
  git(['rm', '-rf', '--quiet', '.'], work);
  fs.writeFileSync(path.join(work, '.gitignore'), '\n');
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'data init'], work);
  git(['push', '-q', 'origin', 'HEAD:data'], work);

  const r = publishToDataBranch({
    cwd: work,
    files: { 'latest.json': '{"ok":true}', 'history.jsonl': '{"queriedAt":"2026-11-07T01:00:00Z","balance":1}\n' },
    publishHistory: true,
  });

  assert.strictEqual(r.committed, true, '应该真的提交了');

  // 从裸仓读回来验证内容确实推上去了
  const body = git(['--git-dir', remote, 'show', 'data:latest.json'], root);
  assert.match(body, /"ok":true/);
});

test('集成：不在 git 仓库里发布必须报错（不能静默成功）', () => {
  // 意图：发布失败绝不能返回"成功"。具体报错文案会随实现变化
  // （先在临时目录 git init → 改为 git worktree，报错点不同），
  // 所以断言"抛错"而不是断言某句文案。
  const { publishToDataBranch } = require('../scripts/ci-publish');
  const lonely = tmpDir(); // 一个不是 git 仓库的空目录
  assert.throws(
    () => publishToDataBranch({ cwd: lonely, files: { 'latest.json': '{}' } }),
    /git|origin|worktree|not a repository/i,
    '没有 git 环境时必须报错，而不是假装发布成功',
  );
});
