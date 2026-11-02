'use strict';
/** 简单的分级日志，同时写控制台和文件 */
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let filePath = null;
let minLevel = LEVELS.info;

function init({ file, level } = {}) {
  if (file) {
    filePath = file;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  if (level && LEVELS[level]) minLevel = LEVELS[level];
}

function write(level, args) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
  if (filePath) {
    try { fs.appendFileSync(filePath, line + '\n'); } catch { /* ignore */ }
  }
}

module.exports = {
  init,
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};
