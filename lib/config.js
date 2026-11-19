'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  account: { username: '', password: '' },
  meter: { custRechNo: '', rechMerMapId: 338, merchantId: 111267, userInfoId: null },
  schedule: {
    /**
     * 触发方式：谁在计时。
     *
     *  "github"   —— 用 GitHub Actions 自带的 cron。
     *                缺点实测过：应触发 40 次只成 9 次（22%），且时间随机。
     *                所以窗口要留宽（30 分钟），靠"多试几次"碰运气。
     *
     *  "external" —— 用外部服务（Cloudflare Workers）的 cron 调 workflow_dispatch。
     *                它的 cron 是准的（秒级），所以窗口可以收窄（10 分钟），
     *                既保证准点，又不会在错误的时间段里查。
     *
     * 两种模式**共用同一套时段去重逻辑**，切换只需改这一个字段。
     * 切回 "github" 立刻恢复原行为，不需要改 workflow 文件。
     */
    mode: 'github',
    // 一天查几次、在几点查（北京小时）。
    // 为什么是时段而不是间隔：GitHub 的 cron 会合并+丢弃（实测丢弃率 78%），
    // 按间隔节流会被延迟打乱节奏，按时段占位则只要每次时段内有一下活着就够。
    slots: [8, 12, 16, 20],
    // 时段提前量：从基准点前 N 分钟就开始接受触发。
    //
    // **null = 按 mode 自动决定**（github → 30 分钟，external → 10 分钟）。
    // 显式写数字则强制使用该值，忽略 mode 的推导。
    // 默认给 null 而不是 30，否则会盖掉 mode 的作用——那样改 mode 就失效了。
    windowMinutes: null,
    // 学校服务关闭时刻（分钟数）：23:40 → 1420。
    // 最后一个时段到此为止，之后去查必然失败。
    closeMinutes: 1420,
    // activeHours：**查不查**（保留给 --force 之外的粗粒度兜底，左闭右开）
    activeHours: [8, 24],
    // pushHours：**推不推**（只约束余额概览；预警不受此限）
    pushHours: [8, 22],
  },
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
    /**
     * 每日/每次报告开关。
     *
     * 注意：「什么时候推」已由 `schedule.pushHours` 决定，这个布尔只剩总开关语义。
     * 想恢复到"每次都推"，设 `pushHours: [0, 24]` 即可，不必关掉它。
     */
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

  },
};

/** 是否可逐键合并的普通对象（数组、null、Date 等都不算） */
function isPlainObject(v) {
  return v !== null
    && typeof v === 'object'
    && !Array.isArray(v)
    && !(v instanceof Date)
    && !(v instanceof RegExp);
}

/** 深拷贝：用于绝不把 DEFAULTS 的引用交给调用方 */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = deepClone(val);
  return out;
}

/**
 * 以 base 为默认值、over 为覆盖，返回一棵**全新的**树。
 *
 * 三条不变量（每条都由 test/config.test.js 守着）：
 * 1. base 为 null 表示"无默认值"，不是"空对象"，必须直接让位给 over。
 *    否则 `{...null}` 得 `{}`，会把 meter.userInfoId 这类 null 默认值吞成 `{}`。
 * 2. over 是原始值（数字/字符串/布尔）时直接返回它。不能对它做 Object.entries，
 *    否则 `k in base` 在 base 为 null 时会抛 TypeError。
 * 3. 任何情况下都不返回 base 的引用，缺子树也要深拷贝，
 *    否则调用方写配置会就地污染 DEFAULTS，env 覆盖在同进程内"粘住"。
 */
function deepMerge(base, over) {
  if (!isPlainObject(over)) {
    // 不变量 2：原始值/数组/undefined 覆盖
    return deepClone(over === undefined ? base : over);
  }
  // 不变量 1：base 不是普通对象（含 null）就整体让位给 over
  if (!isPlainObject(base)) return deepClone(over);

  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = deepClone(v);
  for (const [k, v] of Object.entries(over)) {
    // 键值为 undefined 视为"这一项没提供"，保留默认值。
    // 与顶层 `over === undefined` 同义，也避免 JSON 之外的调用方
    // 误把某个配置项抹成 undefined。
    if (v === undefined) continue;
    // 不变量 3：只有两边都是普通对象才递归，其余一律取 over
    out[k] = k in base && isPlainObject(base[k]) && isPlainObject(v)
      ? deepMerge(base[k], v)
      : deepClone(v);
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
  // 触发方式：github（默认）/ external（外部 cron 准点）
  // CI 里没有 config.json，只能靠环境变量切换。
  ['QLGYDX_SCHEDULE_MODE', (c, v) => { c.schedule.mode = v === 'external' ? 'external' : 'github'; }],
];

function loadConfig(file = path.join(ROOT, 'config.json')) {
  // QLGYDX_CONFIG 允许把配置文件指到别处。
  // 主要用途是**测试隔离**：CLI 冒烟测试必须在空目录里跑，否则会读到仓库根目录
  // 的真实 config.json（实测过一次：清空 USER/PASS 后命令照样成功查询，
  // 并打印出真实房号与电表号）。部署时也能用它把配置放到任意挂载点。
  if (process.env.QLGYDX_CONFIG) file = path.resolve(process.env.QLGYDX_CONFIG);
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

/**
 * 配置 schema：**每个键都声明类型与范围**。
 *
 * 为什么需要它：原来 `validate()` 只检查 4 个必填项，其余键完全不校验。
 * 于是 `QLGYDX_THRESHOLD=abc` 会得到 `Number('abc')` = `NaN`，
 * 而 `NaN > 0` 为 false —— 这一条侥幸被挡住，但 `userInfoId` 没有任何校验，
 * `QLGYDX_USERINFOID=abc` 会把 `NaN` 原样发给学校接口。
 *
 * 这里把"什么算合法"变成数据而不是散落的 if。新增配置项必须同时在此登记，
 * 否则 `validate()` 会报"未声明的键"——这是一道防止配置悄悄长出野字段的闸门。
 *
 * 类型记号：
 *   'string' | 'number' | 'boolean' | 'object' | 'array'
 *   'number|null'  —— 允许 null（表示"尚未发现"，如 userInfoId）
 */
const SCHEMA = {
  'account.username': { type: 'string', required: true, hint: '学号（或 QLGYDX_USER）' },
  'account.password': { type: 'string', required: true, hint: '密码（或 QLGYDX_PASS）' },

  'meter.custRechNo': { type: 'string', required: true, hint: '电表号，形如 示例园#1#A101' },
  'meter.rechMerMapId': { type: 'number', min: 1 },
  'meter.merchantId': { type: 'number', min: 1 },
  // null 是合法值：表示"还没发现"，不能当成错误
  'meter.userInfoId': { type: 'number|null', positiveInt: true },

  // 一天查几次、在几点（北京小时）。空数组 = 不按时间表跑（只手动/--force）
  // 触发方式：github = 自带 cron（容错宽）；external = 外部准点（窗口窄）
  'schedule.mode': { type: 'string', enum: ['github', 'external'] },
  'schedule.slots': { type: 'array', hours: true },
  // 时段提前量（分钟）：容忍 cron 的提前/滞后
  // null = 按 schedule.mode 自动推导（见 lib/schedule.js 的 WINDOW_BY_MODE）
  'schedule.windowMinutes': { type: 'number|null', min: 0, max: 720 },
  // 服务关闭时刻（分钟数，1420 = 23:40）
  'schedule.closeMinutes': { type: 'number', min: 0, max: 1440 },
  // activeHours 决定**查不查**，pushHours 决定**推不推**
  'schedule.activeHours': { type: 'array', length: 2, hours: true },
  'schedule.pushHours': { type: 'array', length: 2, hours: true },
  'schedule.retryOnErrorMinutes': { type: 'number', min: 1, max: 1440 },

  'alert.threshold': { type: 'number', min: 0 },
  'alert.criticalThreshold': { type: 'number', min: 0 },
  'alert.dailyChangePercent': { type: 'number', min: 0, max: 1000 },
  'alert.cooldownMinutes': { type: 'number', min: 1, max: 10080 },
  'alert.repeatWhileCriticalMinutes': { type: 'number', min: 1, max: 10080 },
  'alert.notify': { type: 'object' },

  'storage.stateFile': { type: 'string' },
  'storage.historyFile': { type: 'string' },
  'storage.logFile': { type: 'string' },
  'storage.latestFile': { type: 'string' },
  'storage.dailyReport': { type: 'boolean' },

  'cloud.stateless': { type: 'boolean' },
  'cloud.publishSnapshot': { type: 'boolean' },
};

/** 允许出现在配置里的顶层键（防止手写配置长出拼错的野字段） */
const KNOWN_TOP_LEVEL = Object.keys(SCHEMA).map(k => k.split('.')[0]);

/** 取嵌套值，键不存在时返回 undefined */
function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 按 schema 校验单个值，返回错误描述数组 */
function checkField(key, spec, value) {
  const errs = [];
  const allowNull = spec.type.endsWith('|null');
  const baseType = spec.type.replace('|null', '');

  if (value === undefined) {
    if (spec.required) errs.push(`缺少 ${key}${spec.hint ? `（${spec.hint}）` : ''}`);
    return errs;
  }
  if (value === null) {
    if (allowNull) return errs;
    errs.push(`${key} 不能为 null`);
    return errs;
  }

  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== baseType) {
    errs.push(`${key} 应为 ${baseType}，实际是 ${actual}`);
    return errs;
  }

  if (baseType === 'number') {
    // **这条是重点**：NaN 的 typeof 也是 'number'，光靠类型检查放它过去。
    // 而 NaN 会一路传到 API 请求与阈值比较里，表现为"永远不告警"。
    if (!Number.isFinite(value)) {
      errs.push(`${key} 不是有效数字（可能是环境变量填了非数字）`);
      return errs;
    }
    if (spec.positiveInt && (!Number.isInteger(value) || value <= 0)) {
      errs.push(`${key} 必须是正整数`);
    }
    if (spec.min !== undefined && value < spec.min) errs.push(`${key} 不能小于 ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) errs.push(`${key} 不能大于 ${spec.max}`);
  }

  if (baseType === 'string' && spec.required && value === '') {
    errs.push(`缺少 ${key}${spec.hint ? `（${spec.hint}）` : ''}`);
  }

  if (spec.enum && !spec.enum.includes(value)) {
    errs.push(`${key} 只能是 ${spec.enum.map(v => JSON.stringify(v)).join(' / ')}，实际是 ${JSON.stringify(value)}`);
    return errs;
  }

  if (baseType === 'array') {
    if (spec.length !== undefined && value.length !== spec.length) {
      errs.push(`${key} 应为 ${spec.length} 个元素，实际 ${value.length} 个`);
    }
    if (spec.hours) {
      for (const v of value) {
        if (!Number.isInteger(v) || v < 0 || v > 24) {
          errs.push(`${key} 的元素应为 0-24 的整数，遇到 ${JSON.stringify(v)}`);
        }
      }
    }
  }

  return errs;
}

/**
 * 按 SCHEMA 全量校验。
 *
 * **不 throw，返回错误数组**——配置错误是"用户可修复"的，应该逐条打印出来，
 * 而不是抛一个异常让调用方只能看到第一条。
 *
 * @param {Object} cfg
 * @returns {string[]}
 */
function validateSchema(cfg) {
  const errs = [];
  for (const [key, spec] of Object.entries(SCHEMA)) {
    errs.push(...checkField(key, spec, getPath(cfg, key)));
  }
  // 反向检查：配置里出现了 schema 未声明的顶层键（多半是拼写错误）
  for (const k of Object.keys(cfg || {})) {
    if (k.startsWith('__')) continue; // 内部字段
    if (!KNOWN_TOP_LEVEL.includes(k)) errs.push(`未知配置项 ${k}（拼写错误？）`);
  }
  // 跨字段一致性：criticalThreshold 高于 threshold 会让"严重"永远不触发
  if (typeof cfg?.alert?.threshold === 'number' && typeof cfg?.alert?.criticalThreshold === 'number'
    && cfg.alert.criticalThreshold > cfg.alert.threshold) {
    errs.push(`alert.criticalThreshold(${cfg.alert.criticalThreshold}) 不应大于 alert.threshold(${cfg.alert.threshold})，否则严重预警永不触发`);
  }
  return errs;
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

/**
 * 校验配置。保留这个入口是为了兼容既有调用点，内部走 schema。
 * @returns {string[]} 错误列表（不 throw）
 */
function validate(cfg) {
  return validateSchema(cfg);
}

/**
 * 判断某个整点是否落在 [from, to) 区间内，支持跨夜。
 *
 * 语义统一为**左闭右开**：`[8, 24)` = 08:00 到 23:59，不含次日 0 点。
 * 跨夜写法 `[22, 6)` = 22:00 到次日 05:59。
 *
 * @param {number} hour 0-23
 * @param {number[]} range [from, to]
 */
function inHourRange(hour, range) {
  const [a, b] = Array.isArray(range) ? range : [0, 24];
  // [0,24) 或 [n,n] 视为全天：后者是历史写法，用来表示"不限制"
  if (a === b) return true;
  if (a === 0 && b === 24) return true;
  return a <= b ? (hour >= a && hour < b) : (hour >= a || hour < b);
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
  validate, validateSchema, inHourRange, SCHEMA,
  // 仅供测试：这几条的不变量正是历史 bug 的根因，必须能被直接断言
  __test: { deepMerge, deepClone, isPlainObject, DEFAULTS, checkField, getPath },
};
