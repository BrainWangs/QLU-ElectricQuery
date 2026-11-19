'use strict';
/**
 * 兼容层：`require('../lib/notify')` 仍然可用。
 *
 * 实现已拆到 `lib/notify/`（channels.js 渠道注册表 + index.js 调度器）。
 * 保留这个文件是为了不用一次性改掉所有调用点——但**它只是一层转发**，
 * 不持有任何判断逻辑。两份实现必然漂移，那是这个仓库反复踩过的坑。
 */
const notify = require('./notify/index');

module.exports = notify;
