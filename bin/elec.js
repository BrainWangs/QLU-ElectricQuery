#!/usr/bin/env node
'use strict';
/**
 * 电费查询 CLI
 *
 *   node bin/elec.js query            查询余额（人读）
 *   node bin/elec.js query --json     查询余额（JSON，便于脚本消费）
 *   node bin/elec.js accounts         列出已绑定的充值账户
 *   node bin/elec.js login            仅登录并缓存会话（测试账号密码）
 *   node bin/elec.js watch            启动定时查询 + 预警（前台常驻）
 *   node bin/elec.js check            单次查询 + 预警判断（配合 cron / GitHub Actions）
 *   node bin/elec.js snapshot         打印最新云端快照
 *   node bin/elec.js history [--hours 24] [--limit 20]   查看历史记录
 *   node bin/elec.js alert-test       模拟一次预警，验证通知渠道
 *
 * check 的额外开关：
 *   --force       忽略生效时段，强制查询
 *   --dry-run     不真正发送通知，只打印将要发送的内容
 *   --json        机器可读输出
 */
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig, resolvePath, patchConfigFile, pickMeter, validate } = require('../lib/config');
const { ElecClient, sleep } = require('../lib/qlgydx');
const store = require('../lib/alert');
const { notify, activeChannels, hasRemoteChannel } = require('../lib/notify');
const cloud = require('../lib/cloud');
const log = require('../lib/logger');

const args = process.argv.slice(2);
const cmd = args[0] || 'query';
const flag = name => args.includes('--' + name);
const opt = (name, def = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

function setup() {
  const cfg = loadConfig();
  const errs = validate(cfg);
  if (errs.length) {
    for (const e of errs) log.error('配置错误:', e);
    process.exit(2);
  }
  cfg.paths = {
    state: resolvePath(cfg, cfg.storage.stateFile),
    history: resolvePath(cfg, cfg.storage.historyFile),
    logFile: resolvePath(cfg, cfg.storage.logFile),
    latest: resolvePath(cfg, cfg.storage.latestFile),
  };
  log.init({ file: cfg.paths.logFile, level: process.env.QLGYDX_DEBUG ? 'debug' : 'info' });
  return cfg;
}

/** 启动自检：告诉用户哪些渠道生效了（配错渠道时最容易发现的地方） */
function announceChannels(cfg) {
  const ch = activeChannels(cfg);
  log.debug(`通知渠道: ${ch.join(', ') || '（无）'}`);
  if (!hasRemoteChannel(cfg)) {
    log.warn('没有配置任何远程推送渠道，预警只会写进控制台和本地文件。');
    log.warn('想让手机收到提醒，可配置 ntfy / PushPlus / Server酱 / 企业微信 之一，见 README。');
  }
}

function makeClient(cfg) {
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
  return { client, state };
}

/** 是否允许把会话/状态写回磁盘 */
function canPersist(cfg) {
  return !(cfg.cloud && cfg.cloud.stateless);
}

function persistState(cfg, state) {
  if (!canPersist(cfg)) {
    log.debug('stateless 模式，跳过状态落盘');
    return;
  }
  store.saveState(cfg.paths.state, state);
}

// ---------------- 登录熔断 ----------------
//
// 学校 SSO 有账号级风控：密码连续错 3 次就会锁进"需要输入验证码"状态，
// 而此时**你自己手动登录也进不去**，大约 90 秒后才自动恢复（锁是按账号
// 不是按 IP，换个网络也没用）。
//
// 定时任务每 2 小时跑一次，一旦密码被改而程序还在跑，就会自动把账号
// 反复锁死。所以这里做熔断：登录失败立刻停手，并记下"下次最早尝试时间"。

/** 登录类失败（凭据错、被锁定）——这类错误重试只会让事情更糟 */
const AUTH_FAIL_RE = /用户名或密码不正确|登录失败次数过多|需要输入验证码|20119999|30610010/;

/** 熔断时长：首次 6 小时，每多失败一次翻倍，最多 24 小时 */
function lockoutHours(fails) {
  return Math.min(24, 6 * Math.pow(2, Math.max(0, fails - 1)));
}

/**
 * 检查是否处于登录熔断期。
 * @returns {{locked: boolean, until?: Date, remainingMs?: number}}
 */
function checkLoginLockout(state) {
  const until = state.loginLockedUntil ? Date.parse(state.loginLockedUntil) : 0;
  if (!until || Number.isNaN(until)) return { locked: false };
  const remainingMs = until - Date.now();
  if (remainingMs <= 0) return { locked: false };
  return { locked: true, until: new Date(until), remainingMs };
}

/** 登录失败：累加计数并顺延熔断时间 */
function recordLoginFailure(state, message) {
  state.loginFailures = (state.loginFailures || 0) + 1;
  const hours = lockoutHours(state.loginFailures);
  state.loginLockedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  state.lastLoginError = String(message).slice(0, 300);
  return { hours, until: state.loginLockedUntil };
}

/** 登录成功后清空熔断状态 */
function clearLoginFailure(state) {
  state.loginFailures = 0;
  delete state.loginLockedUntil;
  delete state.lastLoginError;
}

/** 包一层：带熔断的登录 */
async function safeLogin(cfg, client, state, statePath) {
  const lock = checkLoginLockout(state);
  if (lock.locked) {
    const mins = Math.ceil(lock.remainingMs / 60000);
    throw new Error(
      `登录已熔断（${state.loginFailures} 次失败后暂停），还剩约 ${mins} 分钟。`
      + `上次错误：${state.lastLoginError || '未知'}。`
      + `若是密码改了就更新配置，然后删除 state 里的 loginLockedUntil 或运行 check --reset-lockout`,
    );
  }
  try {
    await client.login();
    clearLoginFailure(state);
    persistState(cfg, state);
    log.info(`登录成功: ${client.userName || cfg.account.username}`);
  } catch (e) {
    if (AUTH_FAIL_RE.test(String(e.message))) {
      const { hours } = recordLoginFailure(state, e.message);
      // 熔断状态必须落盘，即使 stateless 也要写，否则下次又从零开始试
      try { store.saveState(statePath, state); } catch { /* ignore */ }
      log.error(`登录失败，已熔断 ${hours} 小时，期间不再尝试登录（避免把账号锁死）`);
      log.error('如果是改了密码，请更新 QLGYDX_PASS 后清除熔断：node bin/elec.js check --reset-lockout');
    }
    throw e;
  }
}

async function ensureLogin(cfg, client, state) {
  const ok = await client.checkSession();
  if (ok) {
    log.debug('复用已有会话');
    state.session = client.exportState();
    persistState(cfg, state);
    return;
  }
  if (!client.jar.hasSession()) {
    log.info('没有可用会话，需要登录…');
  } else {
    log.info('会话已失效，需要重新登录…');
  }
  await safeLogin(cfg, client, state, cfg.paths.state);
  state.session = client.exportState();
  persistState(cfg, state);
}

async function doQuery(cfg, client, state) {
  await ensureLogin(cfg, client, state);
  try {
    return await client.queryBalance();
  } catch (e) {
    // 会话可能刚好过期，重试一次
    if (/未登录|登录超时|40320001/.test(String(e.message) + String(e.code))) {
      log.warn('会话过期，重新登录后重试');
      await safeLogin(cfg, client, state, cfg.paths.state);
      state.session = client.exportState();
      persistState(cfg, state);
      return await client.queryBalance();
    }
    throw e;
  }
}

/** 生效时段判断，支持跨夜（如 22 点–次日 6 点） */
function inActiveHours(cfg) {
  const h = new Date().getHours();
  const [a, b] = cfg.schedule.activeHours;
  if (a === b) return true;          // 0-0 之类视为全天
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

/** 今天的日期键（本地时区），用于「每天只发一次报告」 */
const dayKey = () => new Date().toLocaleDateString('zh-CN');

// ---------------- 命令实现 ----------------

async function cmdQuery() {
  const cfg = setup();
  const { client, state } = makeClient(cfg);
  const r = await doQuery(cfg, client, state);

  if (flag('json')) {
    process.stdout.write(JSON.stringify({
      balance: r.balance,
      custRechNo: r.custRechNo,
      location: r.location,
      meterAddress: r.meterAddress,
      queriedAt: r.queriedAt,
    }, null, 2) + '\n');
    return;
  }
  log.info('────────────────────────────');
  log.info(`  地点：${r.location || r.custRechNo}`);
  log.info(`  余额：${r.balance === null ? '未知' : r.balance.toFixed(2) + ' 元'}`);
  if (r.meterAddress) log.info(`  表号：${r.meterAddress}`);
  log.info(`  时间：${new Date(r.queriedAt).toLocaleString('zh-CN', { hour12: false })}`);
  log.info('────────────────────────────');
}

async function cmdAccounts() {
  const cfg = setup();
  const { client, state } = makeClient(cfg);
  await ensureLogin(cfg, client, state);
  const rows = await discoverAccounts(client);
  if (flag('json')) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return; }

  if (!rows.length) {
    log.info('没有找到已绑定的账户，请确认这个账号在网站上绑过电表。');
    return;
  }
  for (const a of rows) {
    const mark = a.chargeNumber === cfg.meter.custRechNo ? ' ← 当前使用' : '';
    log.info(`${a.chargeNumber}  ${a.chargeName}`);
    log.info(`    ${a.rechargeTypeName || ''}  rechMerMapId=${a.rechMerMapId} merchantId=${a.merchantId}${mark}`);
  }
}

/**
 * 把接口返回的绑定账户列表拉平成一维数组。
 * 实际结构：{ code, listUser: { "充值缴费": [{ merUserBillInfo: {...} }] } }
 */
async function discoverAccounts(client) {
  const j = await client.listAccounts();
  const listUser = (j && (j.listUser || (j.datajson && j.datajson.listUser))) || {};
  const rows = [];
  for (const [group, arr] of Object.entries(listUser)) {
    for (const item of (Array.isArray(arr) ? arr : [])) {
      const b = item.merUserBillInfo || item;
      if (!b) continue;
      rows.push({
        group,
        chargeNumber: b.chargeNumber,
        chargeName: b.chargeName,
        rechMerMapId: b.rechMerMapId,
        merchantId: b.merchantId,
        rechChargeTypeId: b.rechChargeTypeId,
        rechargeTypeName: b.rechargeTypeName,
      });
    }
  }
  return rows;
}

/**
 * 首次配置：只要账号密码，自动登录、发现宿舍号并写回 config.json。
 *
 * 为什么必须绕过 setup()：setup() 里 validate() 要求 meter.custRechNo 已存在，
 * 而这个值恰恰要靠本命令才能发现 —— 用 setup() 会让新用户卡在死循环里。
 */
async function cmdSetup() {
  const cfg = loadConfig();
  const file = cfg.__file;
  const user = (opt('user') || cfg.account.username || '').trim();
  const pass = opt('pass') || cfg.account.password || '';

  if (!user || !pass) {
    log.error('需要账号密码。两种给法：');
    log.error('  1) node bin/elec.js setup --user 你的学号 --pass 你的密码');
    log.error('  2) 先填好 config.json 的 account.username / account.password');
    log.error('密码若以 @ 开头，记得用引号包住，例如 --pass "@Abc123456"');
    process.exit(2);
  }

  cfg.paths = {
    state: resolvePath(cfg, cfg.storage.stateFile),
    history: resolvePath(cfg, cfg.storage.historyFile),
    logFile: resolvePath(cfg, cfg.storage.logFile),
    latest: resolvePath(cfg, cfg.storage.latestFile),
  };
  log.init({ file: cfg.paths.logFile, level: process.env.QLGYDX_DEBUG ? 'debug' : 'info' });

  // 必须先写进 cfg 再建 client：ElecClient 在构造时就把账号密码抓走了，
  // 事后给 safeLogin 传一份改过的 cfg 是不生效的（踩过一次）。
  cfg.account.username = user;
  cfg.account.password = pass;

  const { client, state } = makeClient(cfg);
  log.info(`用 ${user} 登录中…`);
  await safeLogin(cfg, client, state, cfg.paths.state);

  const rows = await discoverAccounts(client);
  if (!rows.length) {
    log.error('登录成功，但这个账号没有查到已绑定的电表。');
    log.error('请先在网站「校园充值」里绑定宿舍，再回来跑 setup。');
    process.exit(1);
  }

  // 半角/全角井号是同一间宿舍的两种写法，按「归一化后」去重，避免让用户面对两条一样的选项
  const { picked: autoPicked, candidates } = pickMeter(rows, opt('meter'));
  if (!autoPicked) {
    if (opt('meter')) {
      log.error(`指定的电表号不在绑定列表里：${opt('meter')}`);
      log.error('可用的有：' + candidates.map(r => r.chargeNumber).join('、'));
    } else {
      log.error('没能从接口返回里解析出电表号。');
    }
    process.exit(2);
  }
  const picked = autoPicked;
  if (!opt('meter') && candidates.length > 1) {
    log.warn(`这个账号绑了 ${candidates.length} 间宿舍，默认用第一个；想换用 --meter 指定：`);
    for (const r of candidates) log.warn(`  ${r.chargeNumber}  ${r.chargeName}`);
  }

  patchConfigFile(file, {
    account: { username: user, password: pass },
    meter: {
      custRechNo: picked.chargeNumber,
      merchantId: picked.merchantId || cfg.meter.merchantId,
      rechMerMapId: picked.rechMerMapId || cfg.meter.rechMerMapId,
    },
  });

  log.info(`✅ 已写入 ${path.relative(process.cwd(), file) || file}`);
  log.info(`   账号   ${user}`);
  log.info(`   宿舍   ${picked.chargeNumber}  ${picked.chargeName || ''}`);
  log.info('');
  log.info('下一步：');
  log.info('  node bin/elec.js query            查一次余额');
  log.info('  node bin/elec.js check --force    查一次并跑预警规则');
  log.info('要定时跑就配 .github/workflows 或 watch，见 docs/DEPLOY.md');

  if (flag('json')) {
    process.stdout.write(JSON.stringify({
      ok: true,
      username: user,
      custRechNo: picked.chargeNumber,
      chargeName: picked.chargeName,
      rechMerMapId: picked.rechMerMapId,
      merchantId: picked.merchantId,
      candidates: candidates.map(r => r.chargeNumber),
    }, null, 2) + '\n');
  }
}

async function cmdLogin() {
  const cfg = setup();
  announceChannels(cfg);
  const { client, state } = makeClient(cfg);
  const info = await client.login();
  state.session = client.exportState();
  persistState(cfg, state);
  log.info(`登录成功: ${info.userName} (userInfoId=${info.userInfoId})`);
  log.info(`会话已缓存到 ${cfg.paths.state}`);
}

/**
 * 无人值守入口：单次查询 → 落历史 → 判预警 → 发通知 → 写云端快照
 * 专为 cron / GitHub Actions 设计：不常驻、不交互、失败要退出码非 0。
 */
async function cmdCheck() {
  const cfg = setup();
  announceChannels(cfg);

  const dryRun = flag('dry-run');
  const force = flag('force');

  // 改了密码 / 确认账号已解锁后，用这个清掉登录熔断
  if (flag('reset-lockout')) {
    const st = store.loadState(cfg.paths.state);
    const had = st.loginLockedUntil || st.loginFailures;
    clearLoginFailure(st);
    store.saveState(cfg.paths.state, st);
    log.info(had ? '已清除登录熔断状态' : '当前没有登录熔断状态');
  }

  if (!force && !inActiveHours(cfg)) {
    log.info(`当前不在生效时段 ${cfg.schedule.activeHours.join('–')} 点，跳过（用 --force 强制执行）`);
    if (flag('json')) {
      process.stdout.write(JSON.stringify({ skipped: true, reason: 'outside-active-hours' }) + '\n');
    }
    return { skipped: true };
  }

  const { client, state } = makeClient(cfg);

  // 熔断期内直接安静退出：既不发远程告警，也不让 CI 标红。
  // 熔断是"我们自己主动不打学校接口"的状态，不是查询出了故障，
  // 每 2 小时报一次失败只会刷屏；等用户改完密码手动恢复即可。
  const gate = checkLoginLockout(state);
  if (gate.locked) {
    const mins = Math.ceil(gate.remainingMs / 60000);
    log.warn(`登录处于熔断期，还剩约 ${mins} 分钟，本次跳过（不发告警）`);
    log.warn('改完密码后运行 node bin/elec.js check --reset-lockout 立即恢复');
    if (flag('json')) {
      process.stdout.write(JSON.stringify({
        skipped: true, reason: 'login-lockout', remainingMinutes: mins,
      }) + '\n');
    }
    return { skipped: true, reason: 'login-lockout' };
  }

  // 查询失败：写失败快照 + 连续失败告警 + 非 0 退出码
  let r;
  try {
    r = await doQuery(cfg, client, state);
  } catch (e) {
    // 注意：必须用内存里的 state，不能用 loadState 重新读盘。
    // 因为登录熔断的计数是在 safeLogin 里写进 state 的，重新读盘会把它冲掉，
    // 于是下一轮又从零开始尝试登录 —— 熔断等于失效。
    const st = state;
    st.consecutiveErrors = (st.consecutiveErrors || 0) + 1;
    persistState(cfg, st);

    if (cfg.cloud.publishSnapshot) {
      const prev = store.readHistory(cfg.paths.history, 24 * 365).filter(x => x && typeof x.balance === 'number').pop();
      const snap = cloud.buildFailureSnapshot({ cfg, error: e.message, lastOk: prev ? { balance: prev.balance, location: prev.location, queriedAt: prev.queriedAt } : null });
      cloud.writeSnapshot(cfg, snap);
    }

    // fetch failed 时真正的网络错误藏在 e.cause 里，必须打出来才能排障
    log.error('查询失败:', e.message);
    if (e.cause) {
      const c = e.cause;
      log.error(`  cause: ${c.code || ''} ${c.message || c}`.trimEnd());
      if (c.errors) for (const sub of c.errors) log.error(`    - ${sub.code || ''} ${sub.message || sub}`);
    }
    const offlineAlert = {
      level: 'warn', rule: 'offline', title: '电费查询失败',
      message: `余额查询失败：${e.message}（已连续 ${st.consecutiveErrors} 次）`,
    };
    if (dryRun) log.info(`[dry-run] 将发送: ${offlineAlert.title} — ${offlineAlert.message}`);
    else if (st.consecutiveErrors === 1 || st.consecutiveErrors % 6 === 0) {
      await notify(offlineAlert, cfg, { custRechNo: cfg.meter.custRechNo }).catch(err => log.warn('通知发送失败:', err.message));
    }
    throw e;
  }

  // ---- 成功：落历史
  store.appendHistory(cfg.paths.history, {
    queriedAt: r.queriedAt, balance: r.balance, custRechNo: r.custRechNo, location: r.location,
  });
  state.lastBalance = r.balance;
  state.lastOkAt = r.queriedAt;
  state.consecutiveErrors = 0;

  const history = store.readHistory(cfg.paths.history, 24 * 7);
  const alerts = store.evaluate(r, cfg, state, history);

  log.info(`余额 ${r.balance === null ? '未知' : r.balance.toFixed(2)} 元  (${r.location || r.custRechNo})`);

  // ---- 发预警
  for (const a of alerts) {
    if (dryRun) log.info(`[dry-run] 将发送: ${a.title} — ${a.message}`);
    else await notify(a, cfg, r).catch(err => log.warn('通知发送失败:', err.message));
  }

  // ---- 每日报告（每天第一次成功查询时发一次概览）
  let dailySent = false;
  if (cfg.storage.dailyReport) {
    const today = dayKey();
    if (state.lastDailyReportDay !== today) {
      const s24 = cloud.summarize(history, r.balance, 24);
      const s72 = cloud.summarize(history, r.balance, 72);
      const days = cloud.forecast(r.balance, s24.perDay ?? s72.perDay);
      const parts = [
        `当前余额 ${r.balance.toFixed(2)} 元`,
        s24.consumed ? `近 24 小时用掉 ${s24.consumed.toFixed(2)} 元` : null,
        s24.recharged ? `期间充值 ${s24.recharged.toFixed(2)} 元` : null,
        s24.perDay ? `日均 ${s24.perDay.toFixed(2)} 元` : null,
        days !== null ? `预计还能用 ${days} 天` : null,
      ].filter(Boolean);
      const daily = {
        level: 'info', rule: 'daily', title: '电费日报',
        message: parts.join('，') + `。\n${cloud.shortLocation(r.location, r.custRechNo)}`,
      };
      if (dryRun) log.info(`[dry-run] 将发送: ${daily.title} — ${daily.message}`);
      else {
        await notify(daily, cfg, r).catch(err => log.warn('日报发送失败:', err.message));
        dailySent = true;
      }
      state.lastDailyReportDay = today;
    }
  }

  persistState(cfg, state);

  // ---- 写云端快照（只写 data/latest.json，不再发 ntfy：
  //      ntfy 只用于「定时查询结果」和「额度预警」两种消息）
  let snapshotPaths = [];
  let snapshot = null;
  if (cfg.cloud.publishSnapshot) {
    snapshot = cloud.buildSnapshot({ result: r, cfg, history, alerts, state });
    snapshotPaths = cloud.writeSnapshot(cfg, snapshot);
    log.debug(`快照已写入 ${snapshotPaths.join(', ')}`);
  }

  if (flag('json')) {
    process.stdout.write(JSON.stringify({
      balance: r.balance,
      alerts,
      dailyReportSent: dailySent,
      queriedAt: r.queriedAt,
      snapshot: snapshotPaths,
    }, null, 2) + '\n');
  }
  return { balance: r.balance, alerts };
}

async function cmdSnapshot() {
  const cfg = setup();
  const file = cfg.paths.latest;
  if (!fs.existsSync(file)) {
    log.error(`快照不存在: ${file}（先运行一次 check）`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

async function cmdWatch() {
  const cfg = setup();
  announceChannels(cfg);
  const { schedule } = cfg;
  const intervalMs = Math.max(1, schedule.intervalMinutes) * 60000;
  log.info(`定时监控已启动：每 ${schedule.intervalMinutes} 分钟查询一次` +
    `（活跃时段 ${schedule.activeHours[0]}:00–${schedule.activeHours[1]}:00），阈值 ${cfg.alert.threshold} 元`);

  let stopping = false;
  const stop = sig => { log.info(`收到 ${sig}，正在退出…`); stopping = true; };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    const t0 = Date.now();
    let nextDelay = intervalMs;
    try {
      if (!inActiveHours(cfg)) {
        log.debug('不在活跃时段，跳过本次查询');
      } else {
        const { client, state } = makeClient(cfg);
        const r = await doQuery(cfg, client, state);
        store.appendHistory(cfg.paths.history, {
          queriedAt: r.queriedAt, balance: r.balance, custRechNo: r.custRechNo, location: r.location,
        });
        state.lastBalance = r.balance;
        state.lastOkAt = r.queriedAt;
        state.consecutiveErrors = 0;
        const history = store.readHistory(cfg.paths.history, 24 * 7);
        const alerts = store.evaluate(r, cfg, state, history);
        persistState(cfg, state);
        log.info(`余额 ${r.balance === null ? '未知' : r.balance.toFixed(2)} 元  (${r.location || r.custRechNo})`);
        for (const a of alerts) await notify(a, cfg, r);
        if (cfg.cloud.publishSnapshot) {
          cloud.writeSnapshot(cfg, cloud.buildSnapshot({ result: r, cfg, history, alerts, state }));
        }
      }
    } catch (e) {
      log.error('查询失败:', e.message);
      if (e.cause) {
        const c = e.cause;
        log.error(`  cause: ${c.code || ''} ${c.message || c}`.trimEnd());
        if (c.errors) for (const sub of c.errors) log.error(`    - ${sub.code || ''} ${sub.message || sub}`);
      }
      const st = store.loadState(cfg.paths.state);
      st.consecutiveErrors = (st.consecutiveErrors || 0) + 1;
      persistState(cfg, st);
      if (st.consecutiveErrors >= 3) {
        await notify({
          level: 'warn', rule: 'offline', title: '电费查询连续失败',
          message: `已连续 ${st.consecutiveErrors} 次查询失败，最后一次错误：${e.message}`,
        }, cfg, {});
      }
      nextDelay = Math.max(60000, (schedule.retryOnErrorMinutes || 10) * 60000);
    }

    // 可中断等待
    const waitMs = Math.max(1000, nextDelay - (Date.now() - t0));
    const deadline = Date.now() + waitMs;
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(1000, deadline - Date.now()));
    }
  }
  log.info('已停止');
}

async function cmdHistory() {
  const cfg = setup();
  const hours = Number(opt('hours', 24));
  const limit = Number(opt('limit', 20));
  const rows = store.readHistory(cfg.paths.history, hours);
  if (!rows.length) { log.info(`最近 ${hours} 小时没有记录`); return; }
  const tail = rows.slice(-limit);
  if (flag('json')) { process.stdout.write(JSON.stringify(tail, null, 2) + '\n'); return; }
  for (const r of tail) {
    const t = new Date(r.queriedAt).toLocaleString('zh-CN', { hour12: false });
    log.info(`${t}  ${Number(r.balance).toFixed(2)} 元`);
  }
  const first = tail[0], last = tail[tail.length - 1];
  if (tail.length > 1) {
    const diff = first.balance - last.balance;
    const hoursSpan = (Date.parse(last.queriedAt) - Date.parse(first.queriedAt)) / 3600000;
    log.info(`—— 区间消耗 ${diff.toFixed(2)} 元 / ${hoursSpan.toFixed(1)} 小时` +
      (hoursSpan > 0 ? `（约 ${(diff / hoursSpan * 24).toFixed(2)} 元/天）` : ''));
  }
}

async function cmdAlertTest() {
  const cfg = setup();
  announceChannels(cfg);
  const fake = {
    level: 'critical', rule: 'test', title: '预警测试',
    message: `这是一条测试通知：当前余额低于阈值 ${cfg.alert.threshold} 元时的提醒效果。`,
  };
  await notify(fake, cfg, { balance: 1.23, location: '测试地点', custRechNo: cfg.meter.custRechNo });
  log.info(`测试通知已发送（渠道: ${activeChannels(cfg).join(', ') || '无'}），请检查手机/控制台是否收到。`);
}

const COMMANDS = {
  setup: cmdSetup,
  query: cmdQuery, accounts: cmdAccounts, login: cmdLogin,
  check: cmdCheck, watch: cmdWatch, snapshot: cmdSnapshot,
  history: cmdHistory, 'alert-test': cmdAlertTest,
};

// 供单测 require：require('bin/elec.js') 时不执行命令。
// 熔断相关的纯函数放在这里导出，避免为了测它们而启动整个 CLI。
if (require.main !== module) {
  module.exports = {
    lockoutHours, checkLoginLockout, recordLoginFailure, clearLoginFailure,
    AUTH_FAIL_RE,
  };
}

if (require.main === module) {
  (async () => {
    const fn = COMMANDS[cmd];
    if (!fn) {
      console.error(`未知命令: ${cmd}\n可用命令: ${Object.keys(COMMANDS).join(', ')}`);
      process.exit(2);
    }
    try {
      await fn();
      if (cmd !== 'watch') process.exit(0);
    } catch (e) {
      log.error(e.message);
      if (process.env.QLGYDX_DEBUG) console.error(e.stack);
      process.exit(1);
    }
  })();
}
