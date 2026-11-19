#!/usr/bin/env node
'use strict';
/**
 * 合并 data 分支的历史到本地 data/history.jsonl。
 *
 * 从 CI 的 60 行 shell 搬到 Node，因为那段 shell 有两个**只能靠人眼发现**的 bug：
 *
 *   1. 窄 refspec 下 `origin/data` 根本不存在，于是 `if [ -f ... ]` 恒假，
 *      合并**从未生效**过——历史每轮从零开始，图表永远只有一个点。
 *   2. `git commit || echo` 把真实失败吃掉了，CI 变绿但推上去的是旧内容。
 *
 * shell 里的 `||` `if` 与退出码语义太容易写错，且完全不可测。
 * 搬进 Node 后每条逻辑都能用临时裸仓做集成测试。
 *
 * 用法：node scripts/ci-merge-history.js [--data-dir data]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 结构化去重：同一 queriedAt 后写覆盖前写。
 *
 * 原 shell 用 `sort -u -t'"' -k4,4`，依赖 JSON 字段的**字面顺序**——
 * 字段一换序就静默失效（去重变成不去重，历史出现重复行）。
 * 用 JSON.parse 取 queriedAt 才是稳的。
 *
 * @param {Array<object>} oldRows
 * @param {Array<object>} newRows
 * @returns {Array<object>} 按时间升序
 */
function mergeHistory(oldRows, newRows) {
  const byTime = new Map();
  for (const r of oldRows) {
    if (!r || typeof r !== 'object') continue;
    const t = r.queriedAt;
    if (!t) continue;
    byTime.set(t, r);
  }
  for (const r of newRows) {
    if (!r || typeof r !== 'object') continue;
    const t = r.queriedAt;
    if (!t) continue;
    byTime.set(t, r); // 后写覆盖前写
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.queriedAt) - Date.parse(b.queriedAt));
}

/** 解析 JSONL 文本；坏行跳过并计入 skipped */
function parseJsonl(text) {
  const rows = [];
  let skipped = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') rows.push(r);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

const toJsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

/** 读文件，不存在返回空串 */
function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * 从 data 分支拉取历史文件。
 *
 * **必须显式指定 refspec**：`git fetch origin data` 在窄 clone 下只会更新
 * FETCH_HEAD，不会建 `origin/data` 这个引用，后续 `git show origin/data:...` 就失败。
 *
 * @returns {{ok:boolean, text:string, reason?:string}}
 */
function fetchDataBranch({ cwd, remote = 'origin', branch = 'data', log = console.log } = {}) {
  try {
    execFileSync('git', ['fetch', '--depth', '1', remote, `${branch}:refs/remotes/${remote}/${branch}`], {
      cwd, stdio: 'pipe', timeout: 60000,
    });
  } catch (e) {
    return { ok: false, text: '', reason: `fetch 失败: ${String(e.stderr || e.message).slice(0, 200)}` };
  }
  try {
    const text = execFileSync('git', ['show', `${remote}/${branch}:history.jsonl`], {
      cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60000,
    });
    return { ok: true, text };
  } catch (e) {
    // 分支存在但没有这个文件（首次运行），不算错误
    return { ok: false, text: '', reason: 'data 分支里没有 history.jsonl' };
  }
}

function main(argv) {
  const get = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, get('--data-dir') || 'data');
  const historyFile = path.join(dataDir, 'history.jsonl');

  fs.mkdirSync(dataDir, { recursive: true });

  const local = parseJsonl(readIfExists(historyFile));
  const fetched = fetchDataBranch({ cwd });
  const remote = fetched.ok ? parseJsonl(fetched.text) : { rows: [], skipped: 0 };

  if (!fetched.ok) {
    console.log(`[ci-merge-history] 未取到 data 分支历史（${fetched.reason}），只保留本地`);
  }

  const merged = mergeHistory(remote.rows, local.rows);
  fs.writeFileSync(historyFile, toJsonl(merged), 'utf8');

  console.log(`[ci-merge-history] 本地 ${local.rows.length} 条 + 远端 ${remote.rows.length} 条 → 合并后 ${merged.length} 条`);
  if (local.skipped || remote.skipped) {
    console.log(`[ci-merge-history] 跳过坏行：本地 ${local.skipped}，远端 ${remote.skipped}`);
  }
  // 行数只增不减是硬性验收标准；这里给出可供 CI 断言的输出
  console.log(`[ci-merge-history] MERGED_ROWS=${merged.length}`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { mergeHistory, parseJsonl, toJsonl, fetchDataBranch };
