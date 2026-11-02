'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  account: { username: '', password: '' },
  meter: { custRechNo: '', rechMerMapId: 338, merchantId: 111267, userInfoId: null },
  schedule: { intervalMinutes: 120, activeHours: [8, 24], retryOnErrorMinutes: 10 },
  alert: {
    threshold: 10,
    criticalThreshold: 5,
    dailyChangePercent: 40,
    cooldownMinutes: 180,
    repeatWhileCriticalMinutes: 720,
    notify: {
      console: true,
      file: 'data/alerts.log',
      webhook: '',
      ntfy: { server: 'https://ntfy.sh', topic: '' },
      pushplus: { token: '', topic: '' },
      serverchan: { sendkey: '' },
      wecom: { webhook: '' },
      bark: { url: '' },
      telegram: { token: '', chatId: '' },
    },
  },
  storage: {
    stateFile: 'data/state.json',
    historyFile: 'data/history.jsonl',
    logFile: 'data/watch.log',
    /** 云端快照：每次查询后写出的最新结果，供 App 拉取 */
    latestFile: 'data/latest.json',
    /** 每日报告：每天成功推送一次余额概览 */
    dailyReport: true,
  },
  /** GitHub Actions / 无状态环境下的行为 */
  cloud: {
    /**
     * true 时不落盘会话（data/state.json 只读不写），
     * 因为每次 CI run 都是全新容器，写盘无意义且会让 cache 频繁失效。
     */
    stateless: false,
    /** 写 latest.json 快照（App 拉取用） */
    publishSnapshot: true,
    /**
     * 快照里是否打码房间号。
     *
     * 默认 false：仓库转私有后，只有自己能看到快照，保留真实房号更方便
     * （App 上能直接确认是哪个宿舍）。
     * 若哪天要公开仓库，把它设成 true，快照与日志里的房号会替换成 ***。
     */
    redact: false,
  },
};

function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 环境变量 → 配置路径的映射表，顺序执行 */
const ENV_MAP = [
  ['QLGYDX_USER', (c, v) => { c.account.username = v; }],
  ['QLGYDX_PASS', (c, v) => { c.account.password = v; }],
  ['QLGYDX_METER', (c, v) => { c.meter.custRechNo = v; }],
  ['QLGYDX_USERINFOID', (c, v) => { c.meter.userInfoId = Number(v); }],
  ['QLGYDX_THRESHOLD', (c, v) => { c.alert.threshold = Number(v); }],
  ['QLGYDX_CRITICAL', (c, v) => { c.alert.criticalThreshold = Number(v); }],
  ['QLGYDX_WEBHOOK', (c, v) => { c.alert.notify.webhook = v; }],
  ['QLGYDX_NTFY_TOPIC', (c, v) => { c.alert.notify.ntfy.topic = v; }],
  ['QLGYDX_NTFY_SERVER', (c, v) => { c.alert.notify.ntfy.server = v; }],
  ['QLGYDX_PUSHPLUS', (c, v) => { c.alert.notify.pushplus.token = v; }],
  ['QLGYDX_PUSHPLUS_TOPIC', (c, v) => { c.alert.notify.pushplus.topic = v; }],
  ['QLGYDX_SCT_KEY', (c, v) => { c.alert.notify.serverchan.sendkey = v; }],
  ['QLGYDX_WECOM', (c, v) => { c.alert.notify.wecom.webhook = v; }],
  ['QLGYDX_BARK', (c, v) => { c.alert.notify.bark.url = v; }],
  ['QLGYDX_TG_TOKEN', (c, v) => { c.alert.notify.telegram.token = v; }],
  ['QLGYDX_TG_CHAT', (c, v) => { c.alert.notify.telegram.chatId = v; }],
  ['QLGYDX_STATELESS', (c, v) => { c.cloud.stateless = v === '1' || v === 'true'; }],
  ['QLGYDX_LATEST_FILE', (c, v) => { c.storage.latestFile = v; }],
  ['QLGYDX_REDACT', (c, v) => { c.cloud.redact = v === '1' || v === 'true'; }],
];

function loadConfig(file = path.join(ROOT, 'config.json')) {
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`配置文件解析失败 ${file}: ${e.message}`); }
  }
  const cfg = deepMerge(DEFAULTS, user);

  // 环境变量覆盖（便于部署时不落盘密码）
  for (const [env, apply] of ENV_MAP) {
    const v = process.env[env];
    if (v !== undefined && v !== '') apply(cfg, v);
  }

  // Actions 上仍然要落盘：靠 actions/cache 把上一轮的会话捞回来复用，
  // 这样大多数 run 都不需要真的登录（少一次密码校验就少一分风控风险）。
  // 只有在明确要求只读时才用 QLGYDX_STATELESS=1 关掉写入。

  cfg.__root = ROOT;
  cfg.__file = file;
  return cfg;
}

/** 把配置里的相对路径解析成绝对路径，并确保目录存在 */
function resolvePath(cfg, p) {
  const abs = path.isAbsolute(p) ? p : path.join(cfg.__root, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/**
 * 只更新 config.json 里指定的几项，其余内容（注释以外的结构）原样保留。
 * 给 setup 命令用：第一次配置时把发现的电表号写回去，用户不用手动编辑。
 *
 * 用浅合并而不是整体覆盖 —— 用户手写的其它字段（推送渠道、阈值）不能被冲掉。
 */
function patchConfigFile(file, patch) {
  let user = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const merged = deepMerge(user, patch);
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function validate(cfg) {
  const errs = [];
  if (!cfg.account.username) errs.push('缺少 account.username（或环境变量 QLGYDX_USER）');
  if (!cfg.account.password) errs.push('缺少 account.password（或环境变量 QLGYDX_PASS）');
  if (!cfg.meter.custRechNo) errs.push('缺少 meter.custRechNo（电表号，形如 示例园#1#A101）');
  if (!(cfg.alert.threshold > 0)) errs.push('alert.threshold 必须为正数');
  return errs;
}

/**
 * 电表号归一化：半角 `#` 与全角 `＃` 是同一间宿舍的两种写法。
 * 学校接口对同一个宿舍会同时返回两种，去重/比较前必须先归一化，
 * 否则界面上会出现两条一模一样的选项。
 */
function normalizeMeterId(id) {
  return String(id ?? '').replace(/＃/g, '#').trim();
}

/**
 * 从绑定列表里挑一间宿舍：指定了 meterId 就按归一化后精确匹配，
 * 否则取第一间。返回 { picked, candidates }，candidates 是去重后的列表。
 */
function pickMeter(rows, meterId) {
  const seen = new Set();
  const candidates = [];
  for (const r of rows || []) {
    const key = normalizeMeterId(r.chargeNumber);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push(r);
  }
  if (!candidates.length) return { picked: null, candidates: [] };

  if (meterId) {
    const want = normalizeMeterId(meterId);
    const picked = candidates.find(r => normalizeMeterId(r.chargeNumber) === want) || null;
    return { picked, candidates };
  }
  return { picked: candidates[0], candidates };
}

module.exports = {
  loadConfig, resolvePath, patchConfigFile, normalizeMeterId, pickMeter,
  validate,
};
