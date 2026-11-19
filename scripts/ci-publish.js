#!/usr/bin/env node
'use strict';
/**
 * 把快照与历史发布到 data 分支。
 *
 * 从 CI 的 shell 搬进 Node，同时修掉「切开关删历史」这个真实缺陷：
 *
 *   原实现每次都把 /tmp/snapshot 整个重建再 orphan 覆盖 data 分支。
 *   只要某一轮没有 history.jsonl（比如公开模式下跳过了历史发布），
 *   那一轮就会把**整个历史从分支上删掉**——一次开关切换，历史清零。
 *
 * 现在的策略：**增量覆盖**。
 *   先 fetch 出 data 分支现有内容，把本轮要发布的东西叠上去，
 *   本轮没有的保持原样。这样"不发布某个文件"不等于"删除那个文件"。
 *
 * 用法：
 *   node scripts/ci-publish.js --snapshot data/latest.json --history data/history.jsonl \
 *        [--publish-history 0|1] [--dry-run]
 *
 * 退出码：0 成功；1 失败（**不吞错**，这是 `git commit || echo` 的反面）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 允许发布到 data 分支的文件白名单（防止误把 config.json 之类推上去） */
const ALLOWED = new Set(['latest.json', 'history.jsonl', 'chart-3d.svg', 'chart-7d.svg', 'chart-30d.svg', 'heatmap.svg']);

/**
 * 规划要发布到 data 分支的文件集合。
 *
 * @param {object} opts
 * @param {object} opts.files { latest.json: '<内容>', 'history.jsonl': '<内容>', ... }
 * @param {boolean} opts.publishHistory 是否发布 history.jsonl
 * @param {Array<string>} opts.existing 分支上已有的文件名
 * @returns {{publish: object, removed: string[], kept: string[]}}
 */
function planPublish({ files = {}, publishHistory = true, existing = [] } = {}) {
  const publish = {};
  const removed = [];
  const kept = [];

  for (const [name, content] of Object.entries(files)) {
    if (content === undefined || content === null) continue;
    if (!ALLOWED.has(name)) {
      // 白名单外的东西一律拒绝，并明确报错——静默跳过会让人以为发布成功了
      throw new Error(`拒绝发布白名单外的文件: ${name}`);
    }
    if (name === 'history.jsonl' && !publishHistory) continue; // 本轮不发布，但不删除
    publish[name] = content;
  }

  for (const name of existing) {
    if (ALLOWED.has(name) || name === '.gitignore') {
      if (!(name in publish)) {
        if (name === '.gitignore') kept.push(name);
        else kept.push(name);
      }
    } else {
      removed.push(name);
    }
  }

  return { publish, removed, kept };
}

/** 在裸仓/普通仓里执行 git，失败就抛（绝不吞） */
function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', timeout: 120000, ...opts });
}

/**
 * 发布到 data 分支。
 *
 * @param {object} opts
 * @param {string} opts.cwd 工作区
 * @param {object} opts.files 文件名 → 内容
 * @param {boolean} [opts.publishHistory]
 * @param {boolean} [opts.dryRun]
 * @returns {{committed: boolean, files: string[], kept: string[]}}
 */
function publishToDataBranch({ cwd, files, publishHistory = true, dryRun = false } = {}) {
  // ------------------------------------------------------------------
  // 为什么在**原仓库**里操作，而不是 `git init` 一个临时目录：
  //
  // actions/checkout 把认证放在原仓库的 `.git/config` 里，
  // 形如 `http.https://github.com/.extraheader = AUTHORIZATION: basic ...`。
  // 新建的临时仓库没有这段配置，push 时会报：
  //   fatal: could not read Username for 'https://github.com'
  // 这不是理论问题——真实 CI 上连撞两次（先没 origin，再没凭据）。
  //
  // 所以改成：在原仓库里用 git worktree 建一个游离分支的工作区。
  // worktree 共享同一个 `.git`，凭据配置天然可用，也不污染工作区。
  // ------------------------------------------------------------------
  let existing = [];
  try {
    git(['fetch', '--depth', '1', 'origin', 'data:refs/remotes/origin/data'], { cwd });
    const listing = git(['ls-tree', '--name-only', 'refs/remotes/origin/data'], { cwd });
    existing = listing.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    // 分支还不存在（首次发布），existing 为空即可
  }

  const plan = planPublish({ files, publishHistory, existing });

  if (dryRun) {
    return { committed: false, files: Object.keys(plan.publish), kept: plan.kept };
  }

  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'elec-pub-'));
  const worktree = path.join(tmp, 'wt');
  const branch = `pub-${Date.now()}`;

  try {
    // --orphan 让新分支没有父提交，data 分支要求只有内容、没有代码历史
    git(['-C', cwd, 'worktree', 'add', '-q', '--detach', worktree], { cwd });
    git(['-C', worktree, 'checkout', '-q', '--orphan', branch], { cwd });
    // 清空继承来的工作区内容
    for (const name of fs.readdirSync(worktree)) {
      if (name === '.git') continue;
      fs.rmSync(path.join(worktree, name), { recursive: true, force: true });
    }
    for (const [name, content] of Object.entries(plan.publish)) {
      fs.writeFileSync(path.join(worktree, name), content, 'utf8');
    }

    git(['-C', worktree, 'add', '-A'], { cwd });

    // **不能用 `git commit || echo`**：那会把钩子拒绝、索引损坏、身份未配置
    // 等真实失败一并吞掉，CI 变绿但推上去的是旧内容。
    // 只有本来就没有改动才允许跳过，且必须用 git 自己的判据。
    let committed = false;
    try {
      git(['-C', worktree, '-c', 'user.name=elec-ci', '-c', 'user.email=elec-ci@users.noreply.github.com',
        'commit', '-q', '-m', `snapshot ${new Date().toISOString()}`], { cwd });
      committed = true;
    } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '');
      if (!/nothing to commit|no changes added/i.test(msg)) {
        throw new Error(`git commit 失败（不是无改动）：${msg.slice(0, 300)}`);
      }
    }

    if (committed) {
      git(['-C', worktree, 'push', '--force', 'origin', `HEAD:data`], { cwd });
    }

    return { committed, files: Object.keys(plan.publish), kept: plan.kept };
  } finally {
    try { git(['-C', cwd, 'worktree', 'remove', '--force', worktree], { cwd }); } catch { /* ignore */ }
    try { git(['-C', cwd, 'branch', '-D', branch], { cwd }); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  const get = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwd = process.cwd();
  const dryRun = argv.includes('--dry-run');
  const publishHistory = (get('--publish-history') ?? '1') === '1';

  const files = {};
  const snap = get('--snapshot');
  if (snap && fs.existsSync(snap)) files['latest.json'] = fs.readFileSync(snap, 'utf8');

  const hist = get('--history');
  if (hist && fs.existsSync(hist)) files['history.jsonl'] = fs.readFileSync(hist, 'utf8');

  // 图表也一起发（如果存在）
  const chartDir = path.resolve(cwd, get('--charts') || 'docs/charts');
  for (const name of ['chart-3d.svg', 'chart-7d.svg', 'chart-30d.svg', 'heatmap.svg']) {
    const f = path.join(chartDir, name);
    if (fs.existsSync(f)) files[name] = fs.readFileSync(f, 'utf8');
  }

  try {
    const r = publishToDataBranch({ cwd, files, publishHistory, dryRun });
    console.log(`[ci-publish] ${dryRun ? '[dry-run] ' : ''}发布文件: ${r.files.join(', ') || '（无）'}`);
    if (r.kept.length) console.log(`[ci-publish] 保留未动: ${r.kept.join(', ')}`);
    console.log(`[ci-publish] committed=${r.committed}`);
    return 0;
  } catch (e) {
    console.error(`[ci-publish] 失败: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { planPublish, publishToDataBranch, ALLOWED };
