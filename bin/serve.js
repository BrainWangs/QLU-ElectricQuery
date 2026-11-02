#!/usr/bin/env node
'use strict';
/**
 * 电费余额 HTTP 小服务（可选，默认不用）
 *   node bin/serve.js            启动 HTTP 服务（默认 127.0.0.1:7788）
 *   GET /balance                 返回当前余额 JSON
 *   GET /history?hours=24        返回历史记录
 *   POST /check                  立即查询并执行预警判断
 *   GET /health                  健康检查
 *
 * 可用 --port / --host 覆盖，也可用环境变量 ELEC_PORT / ELEC_HOST
 */
const http = require('node:http');
const { loadConfig, resolvePath, validate } = require('../lib/config');
const { ElecClient } = require('../lib/qlgydx');
const store = require('../lib/alert');
const { notify } = require('../lib/notify');
const log = require('../lib/logger');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(opt('port', process.env.ELEC_PORT || 7788));
const HOSTNAME = opt('host', process.env.ELEC_HOST || '127.0.0.1');

const cfg = loadConfig();
const errs = validate(cfg);
if (errs.length) { for (const e of errs) log.error('配置错误:', e); process.exit(2); }
cfg.paths = {
  state: resolvePath(cfg, cfg.storage.stateFile),
  history: resolvePath(cfg, cfg.storage.historyFile),
  logFile: resolvePath(cfg, cfg.storage.logFile),
};
log.init({ file: cfg.paths.logFile, level: 'info' });

// 简单的串行队列，避免并发重复登录
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function doQuery() {
  const state = store.loadState(cfg.paths.state);
  const client = new ElecClient({
    username: cfg.account.username,
    password: cfg.account.password,
    custRechNo: cfg.meter.custRechNo,
    rechMerMapId: cfg.meter.rechMerMapId,
    merchantId: cfg.meter.merchantId,
    userInfoId: cfg.meter.userInfoId,
    state: state.session || null,
  });
  if (!(await client.checkSession())) await client.login();
  state.session = client.exportState();
  store.saveState(cfg.paths.state, state);
  return client.queryBalance();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj, null, 2));
  };
  try {
    if (url.pathname === '/balance' && req.method === 'GET') {
      const r = await enqueue(doQuery);
      return send(200, {
        balance: r.balance, custRechNo: r.custRechNo, location: r.location,
        meterAddress: r.meterAddress, queriedAt: r.queriedAt,
      });
    }
    if (url.pathname === '/history' && req.method === 'GET') {
      const hours = Number(url.searchParams.get('hours') || 24);
      return send(200, store.readHistory(cfg.paths.history, hours));
    }
    if (url.pathname === '/check' && req.method === 'POST') {
      const r = await enqueue(doQuery);
      store.appendHistory(cfg.paths.history, {
        queriedAt: r.queriedAt, balance: r.balance, custRechNo: r.custRechNo, location: r.location,
      });
      const state = store.loadState(cfg.paths.state);
      state.lastBalance = r.balance;
      state.lastOkAt = r.queriedAt;
      state.consecutiveErrors = 0;
      const alerts = store.evaluate(r, cfg, state, store.readHistory(cfg.paths.history, 24));
      store.saveState(cfg.paths.state, state);
      for (const a of alerts) await notify(a, cfg, r);
      return send(200, { balance: r.balance, alerts, queriedAt: r.queriedAt });
    }
    if (url.pathname === '/health') return send(200, { ok: true, ts: Date.now() });
    send(404, { error: 'not found', paths: ['/balance', '/history', '/check', '/health'] });
  } catch (e) {
    log.error('请求失败:', e.message);
    send(500, { error: e.message });
  }
});

server.listen(PORT, HOSTNAME, () => {
  log.info(`电费查询服务已启动: http://${HOSTNAME}:${PORT}`);
  log.info('  GET  /balance        当前余额');
  log.info('  GET  /history?hours= 历史记录');
  log.info('  POST /check          查询 + 预警');
});
