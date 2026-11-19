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
const { loadConfig, resolvePath, patchConfigFile, pickMeter, validate, inHourRange } = require('../lib/config');
const { ElecClient, sleep } = require('../lib/qlgydx');
const store = require('../lib/alert');
const session = require('../lib/session');
const { notify, activeChannels, hasRemoteChannel, describeReport } = require('../lib/notify');
const cloud = require('../lib/cloud');
const parse = require('../lib/parse');
const errors = require('../lib/errors');
const log = require('../lib/logger');
const time = require('../lib/time');
const schedule = require('../lib/schedule');

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

/**
 * 发一条通知并检查送达结果。
 *
 * notify() 不再抛错（单渠道失败不影响别的渠道），所以 .catch() 已经没意义了。
 * 但**预警送不出去这件事必须被看见**：静默失败正是这个仓库最怕的形态。
 * 这里统一打警告，调用点不再各写各的。
 *
 * @param {object} alert
 * @param {object} cfg
 * @param {object} ctx
 * @param {string} [label] 日志前缀，如 '日报'
 */
async function deliver(alert, cfg, ctx, label = '通知') {
  const report = await notify(alert, cfg, ctx);
  if (!report.ok && report.results.length) {
    const bad = report.results.filter(r => !r.ok).map(r => `${r.label}(${r.error || '未知'})`);
    log.warn(`${label}未送达任何远程渠道${bad.length ? `，失败项: ${bad.join('、')}` : ''}`);
  }
  return report;
}

function makeClient(cfg) {
  // state.json 损坏时不能静默恢复成空状态（那会把登录熔断一并清零，
  // 等于鼓励程序拿可能已失效的密码继续打 SSO）。loadState 会返回
  // 带 stateCorrupt 标记的安全状态，这里必须让它被看见。
  const state = store.loadState(cfg.paths.state, {
    onCorrupt: err => {
      log.warn(`状态文件损坏（${err.message}），已进入安全模式：本轮的登录熔断不会被清零。`);
      log.warn(`  ${cfg.paths.state} —— 修好后可运行 node bin/elec.js check --reset-lockout 恢复`);
    },
  });
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
// 学校 SSO 有账号级风控：密码连续错 3 次就会锁进需要输入验证码状态，
// 而此时**你自己手动登录也进不去**，大约 90 秒后才自动恢复（锁是按账号
// 不是按 IP，换个网络也没用）。
//
// 定时任务每 2 小时跑一次，一旦密码被改而程序还在跑，就会自动把账号
// 反复锁死。所以这里做熔断：登录失败立刻停手，并记下下次最早尝试时间。
//
// 实现已搬到 lib/session.js（纯函数 + 可注入时钟，能全量测试）。
// 这里只做绑定与再导出。

const lockoutHours = session.lockoutHours;
const checkLoginLockout = state => session.lockoutStatus(state);
const recordLoginFailure = (state, message) => session.recordLoginFailure(state, message);
const clearLoginFailure = state => session.clearLoginFailure(state);

/**
 * 登录类失败（凭据错、被锁定）——这类错误重试只会让事情更糟。
 *
 * 这里不再用正则判断。isAuthFailure() 只看 ElecError.kind，
 * 而哪些文案/业务码算登录失败集中在 lib/errors.js 的映射表里。
 *
 * 仍然导出一个 .test() 兼容层（老测试与少量调用点按这个形态用），
 * 但它内部走的是映射表，不是自己的一份正则——两份正则会漂移，那是旧问题。
 */
const AUTH_FAIL_RE = {
  test: s => errors.isAuthFailure(errors.fromLoginResponse(null, String(s))),
};

/** 包一层：带熔断的登录（真正实现见 lib/session.js） */
async function safeLogin(cfg, client, state, statePath) {
  return session.ensure(cfg, {
    client,
    store,
    state,
    log,
  });
}

/**
 * 确保有可用会话：能复用就复用，不行才登录。
 *
 * 注意这里的顺序不是随意的：先 checkSession() 再决定要不要登录。
 * 直接登录会每次都消耗一次真实认证请求，而学校 SSO 有频率风控。
 */
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

/**
 * 查询余额，会话过期时自动重登一次。
 *
 * 判据是 errors.isSessionGone(kind)，不再匹配消息文案——
 * 服务端改一句提示，靠正则判断的重登就静默失效了。
 */
async function doQuery(cfg, client, state) {
  await ensureLogin(cfg, client, state);
  try {
    return await client.queryBalance();
  } catch (e) {
    const err = errors.normalize(e);
    if (errors.isSessionGone(err)) {
      log.warn('会话过期，重新登录后重试');
      await safeLogin(cfg, client, state, cfg.paths.state);
      state.session = client.exportState();
      persistState(cfg, state);
      return await client.queryBalance();
    }
    throw err;
  }
}

/** 生效时段判断，支持跨夜（如 22 点–次日 6 点）。
 *  注意用北京时间：GitHub Actions 的 runner 是 UTC 时区，
 *  直接 new Date().getHours() 会把 activeHours [8,24] 过滤成 UTC 8–24 点
 *  （= 北京 16:00–次日 08:00），导致北京早上的定时查询被误跳过。 */
function inActiveHours(cfg) {
  // 区间语义统一走 config.inHourRange（左闭右开，支持跨夜），
  // 不再在这里维护第二份实现——两份判断逻辑必然漂移。
  return inHourRange(time.beijingHour(), cfg.schedule.activeHours);
}

/** 今天的日期键（北京时间），用于「每天只发一次报告」 */
const dayKey = () => time.dayKey();

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
  log.info(`  时间：${time.fmtBeijing(new Date(r.queriedAt))}`);
  log.info('────────────────────────────');
}

/**
 * 把接口返回的绑定账户列表拉平成一维数组。
 * 实际结构：{ code, listUser: { "充值缴费": [{ merUserBillInfo: {...} }] } }
 *
 * 供 setup 使用（重构时删掉了 accounts 命令，但这个拉平逻辑是 setup 的依赖）。
 */
async function discoverAccounts(client) {
  // 拉平逻辑已搬到 lib/parse.js（纯函数、可测），这里只发请求。
  // 原来这段 20 行内联在 bin 里，是"零覆盖"的一块。
  return parse.parseAccounts(await client.listAccounts());
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
    log.error('密码含空格或特殊字符时记得用引号包住');
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

  const { client, state } = makeClient(cfg);

  // ---- 时段判定：这是"该不该查"的唯一入口
  //
  // 用**时段占位**而不是"距上次多久"：GitHub 的 cron 会合并+丢弃
  // （实测 5 天应 40 次只成 9 次），按间隔节流会被延迟打乱节奏。
  // 时段占位的语义是"每个时段内只要有一次查成功就算完成"，
  // 因此 cron 可以每 30 分钟猛试，多余的触发会被 already-done 挡掉。
  const parts = time.beijingParts();
  const lastSlotKey = state.lastSlotKey;
  const plan = schedule.decide({
    parts,
    slots: cfg.schedule.slots,
    // 窗口宽度由 mode 决定（github=30 分钟容错 / external=10 分钟准点）。
    // 但 config 里显式写了 windowMinutes 就尊重它——那是用户/运维的最终决定。
    mode: cfg.schedule.mode,
    windowMinutes: cfg.schedule.windowMinutes,
    closeMinutes: cfg.schedule.closeMinutes,
    lastSlotKey,
    force,
  });

  if (!plan.run) {
    const why = {
      'outside-window': `当前 ${parts.hour}:${String(parts.minute).padStart(2, '0')}（北京）不在查询时段 `
        + `${cfg.schedule.slots.map(h => `${h}点`).join('/')} 内（用 --force 强制执行）`,
      'already-done': `${parts.hour} 点这个时段已经查过了（${plan.key}），跳过`,
    }[plan.reason] || plan.reason;
    log.info(why);
    if (flag('json')) {
      process.stdout.write(JSON.stringify({ skipped: true, reason: plan.reason }) + '\n');
    }
    return { skipped: true, reason: plan.reason };
  }

  if (!force && !inActiveHours(cfg)) {
    log.info(`当前不在生效时段 ${cfg.schedule.activeHours.join('–')} 点，跳过（用 --force 强制执行）`);
    if (flag('json')) {
      process.stdout.write(JSON.stringify({ skipped: true, reason: 'outside-active-hours' }) + '\n');
    }
    return { skipped: true };
  }

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
      if (c.code === 'UND_ERR_CONNECT_TIMEOUT' && e.stack) {
        // 打出请求 URL：分不清是站点域名还是 DoH 查询本身挂了
        const m = String(e.stack).match(/at\s+.*?_raw.*|https?:\/\/\S+/);
        if (m) log.error(`  at: ${m[0].slice(0, 160)}`);
      }
    }
    const offlineAlert = {
      level: 'warn', rule: 'offline', title: '电费查询失败',
      message: `余额查询失败：${e.message}（已连续 ${st.consecutiveErrors} 次）`,
    };
    if (dryRun) log.info(`[dry-run] 将发送: ${offlineAlert.title} — ${offlineAlert.message}`);
    else if (st.consecutiveErrors === 1 || st.consecutiveErrors % 6 === 0) {
      await deliver(offlineAlert, cfg, { custRechNo: cfg.meter.custRechNo }, '失败通知');
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
  // 记下"本时段已完成"：后续同一时段内的触发会直接跳过，不重复查也不重复推。
  // dry-run 不写（干跑不该占用真实时段名额，否则真跑就漏了）。
  if (!dryRun && plan.key) state.lastSlotKey = plan.key;

  const history = store.readHistory(cfg.paths.history, 24 * 7);
  // dry-run 必须零副作用：evaluate 内部会 mark() 写 lastAlertAt，
  // 如果直接传 state，干跑就会吃掉随后 3 小时的冷却窗口 ——
  // 之后真跑时该发的预警一条都不发，而且完全没有报错。
  // 这里把 state 深拷贝一份给它，mark() 只污染副本。
  const evalState = dryRun ? structuredClone(state) : state;
  const alerts = store.evaluate(r, cfg, evalState, history);

  log.info(`余额 ${r.balance === null ? '未知' : r.balance.toFixed(2)} 元  (${r.location || r.custRechNo})`);

  // ---- 发预警
  for (const a of alerts) {
    if (dryRun) log.info(`[dry-run] 将发送: ${a.title} — ${a.message}`);
    else await deliver(a, cfg, r, '预警');
  }

  // ---- 每次查询报告（余额概览）
  //
  // 这里受 `schedule.pushHours` 约束，而**上面的预警不受约束**：
  // activeHours 决定查不查，pushHours 决定推不推。
  // 半夜没电了必须叫醒你（预警），但"每次查询都推一条余额概览"
  // 没必要在凌晨 3 点发。想恢复"每次都推"，把 pushHours 设成 [0, 24]。
  let dailySent = false;
  const pushHourNow = time.beijingHour();
  const inPushWindow = inHourRange(pushHourNow, cfg.schedule.pushHours);
  if (cfg.storage.dailyReport && !inPushWindow) {
    log.info(`当前 ${pushHourNow} 点不在推送时段 ${JSON.stringify(cfg.schedule.pushHours)} 内，跳过日报（预警不受此限）`);
  }
  if (cfg.storage.dailyReport && inPushWindow) {
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
      await deliver(daily, cfg, r, '日报');
      dailySent = true;
    }
  }

  // dry-run 完全不落盘：不写 state，也不写快照。
  // 干跑的意义就是"先看看会发生什么"，它不该留下任何痕迹。
  if (!dryRun) persistState(cfg, state);

  // ---- 写云端快照（只写 data/latest.json，不再发 ntfy：
  //      ntfy 只用于「定时查询结果」和「额度预警」两种消息）
  let snapshotPaths = [];
  let snapshot = null;
  if (cfg.cloud.publishSnapshot && !dryRun) {
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

async function cmdAlertTest() {
  const cfg = setup();
  announceChannels(cfg);
  const fake = {
    level: 'critical', rule: 'test', title: '预警测试',
    message: `这是一条测试通知：当前余额低于阈值 ${cfg.alert.threshold} 元时的提醒效果。`,
  };
  const report = await notify(fake, cfg, { balance: 1.23, location: '测试地点', custRechNo: cfg.meter.custRechNo });

  // 按结果打印，不再笼统说"已发送"
  for (const line of describeReport(report)) log.info(line);
  for (const r of report.results) {
    log.info(`  ${r.ok ? '✔' : '✖'} ${r.label}${r.remote ? '（远程）' : ''}${r.ok ? '' : ` — ${r.error}`}`);
  }

  // **退出码必须反映真实结果**。
  // 原来无论成败都退出 0，等于"渠道配错了也报成功"——而这恰恰是最该被
  // 发现的错误：预警发不出去，停电了也不知道。CI 与人工排查都靠这个码。
  if (!report.ok) {
    log.error('没有任何远程渠道送达成功。请检查配置，否则预警到达不了你手上。');
    process.exitCode = 1;
  } else {
    log.info('测试通知已送达远程渠道，请检查手机是否收到。');
  }
}

const COMMANDS = {
  setup: cmdSetup,
  query: cmdQuery, login: cmdLogin,
  check: cmdCheck, 'alert-test': cmdAlertTest,
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
      // 不能无条件 process.exit(0)：那会把命令自己设置的 process.exitCode 覆盖掉。
      // 例：alert-test 发现"没有任何远程渠道送达"时设 exitCode=1，
      // 旧写法会把这条信号吃掉，于是"预警发不出去"在 CI 里表现为成功。
      process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
    } catch (e) {
      log.error(e.message);
      if (process.env.QLGYDX_DEBUG) console.error(e.stack);
      process.exit(1);
    }
  })();
}
