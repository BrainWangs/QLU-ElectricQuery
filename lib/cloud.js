'use strict';
/**
 * 云端快照：把每次查询结果写成一份稳定的 JSON，供手机 App 拉取。
 *
 * 设计要点：
 *  - 字段一旦定下就尽量不改（App 端要解析），新增字段只追加
 *  - 同时写一个 .js 版本，方便用 <script> 跨域读取（JSONP 式兜底，
 *    用于 raw.githubusercontent 被墙时改走 jsDelivr/其它静态托管）
 *  - 带 version 字段，App 可据此判断兼容性
 */
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_VERSION = 1;

/**
 * 快照会被推到公开位置（公开仓库的 data 分支、ntfy topic），
 * 所以里面的房间号必须打码：余额曲线公开不算大问题，
 * "某人住 A101 且余额 65 元"就不一样了。
 *
 * 只保留到楼/区一级，房号替换成 ***。
 * 例：示例校区学生公寓.示例园1号公寓A区.3楼.A101
 *  →  示例校区学生公寓.示例园1号公寓A区.3楼.***
 */
function redactLocation(location) {
  if (!location) return null;
  const parts = String(location).split('.');
  if (parts.length < 2) return String(location);
  // 最后一段通常是房间号（A101 / 101 之类），整段替换
  parts[parts.length - 1] = '***';
  return parts.join('.');
}

/**
 * 把站点的长地址压成一眼能读的短名，用于通知正文。
 *
 * 例：示例校区学生公寓.示例园1号公寓A区.3楼.A101 → 示例校区-示例园1A101
 *     示例校区学生公寓.示例园1号公寓B区.12楼.B102 → 示例校区-示例园1B102
 *
 * 规则：
 *  - 校区：首段去掉「学生公寓」后缀
 *  - 园区+楼号：「示例园1号公寓」→「示例园1」
 *  - 区域字母：「A区」→「A」（没有区就跳过）
 *  - 房号：末段原样（A101 / 101）
 * 解析不出来（段数不对）时原样返回，不猜。
 */
function shortLocation(location, custRechNo) {
  const s = location ? String(location).trim() : '';
  if (!s) return custRechNo ? String(custRechNo) : null;

  const parts = s.split('.').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return s;

  const room = parts[parts.length - 1];
  const campus = parts[0].replace(/学生公寓$/, '');

  // 在中间段里找「园区N号公寓」和「X区」。
  // 注意站点把两者塞在同一段：「示例园1号公寓A区」，所以要先整体匹配再拆。
  let park = '';
  let zone = '';
  for (const p of parts.slice(1, -1)) {
    // 同一段里既有公寓又有区
    const both = p.match(/^(.+?)(\d+)号公寓\s*([A-Za-z])区$/);
    if (both) { park = `${both[1]}${both[2]}`; zone = both[3]; continue; }
    // 只有公寓
    const mPark = p.match(/^(.+?)(\d+)号公寓$/);
    if (mPark) { park = `${mPark[1]}${mPark[2]}`; continue; }
    // 只有区
    const mZone = p.match(/^([A-Za-z])区$/);
    if (mZone) { zone = mZone[1]; continue; }
    // 兜底：既不是楼层也不是区，当成园区名
    if (!park && !/^\d+楼$/.test(p)) park = p;
  }

  // 房号本身常带区字母（A区 → A101），此时区字母重复，去掉
  const zoneOut = zone && !room.toUpperCase().startsWith(zone.toUpperCase()) ? zone : '';
  const body = `${park}${zoneOut}${room}`;
  return campus ? `${campus}-${body}` : body;
}

/**
 * 电表号（园区#楼号#房号）同样要打码，只留园区和楼号。
 * 例：示例园#1#A101 → 示例园#1#***
 */
function redactMeter(custRechNo) {
  if (!custRechNo) return null;
  const s = String(custRechNo);
  const m = s.match(/^(.*?[#＃])([^#＃]+)$/);
  if (!m) return s;
  return `${m[1]}***`;
}


/** 计算最近 N 小时的统计：消耗量、日均、样本数 */
function summarize(history, balance, hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const win = history
    .filter((r) => r && typeof r.balance === 'number' && Date.parse(r.queriedAt) >= cutoff)
    .sort((a, b) => Date.parse(a.queriedAt) - Date.parse(b.queriedAt));

  if (win.length < 2) {
    return { hours, samples: win.length, consumed: null, recharged: null, perDay: null, from: win[0]?.queriedAt || null };
  }

  // 逐个相邻样本求差：下跌=消费，上涨=充值。
  // 直接首尾相减会被中间充值抵消，算出负消耗（实测踩过：-9.51 元）。
  let consumed = 0;
  let recharged = 0;
  for (let i = 1; i < win.length; i++) {
    const d = win[i - 1].balance - win[i].balance;
    if (d > 0) consumed += d;
    else recharged += -d;
  }
  consumed = Number(consumed.toFixed(2));
  recharged = Number(recharged.toFixed(2));

  const first = win[0];
  const last = win[win.length - 1];
  const spanMs = Date.parse(last.queriedAt) - Date.parse(first.queriedAt);
  const spanDays = spanMs / 86400000;
  // 日均只按消费算，且跨度太短（<30 分钟）时不给，避免噪声放大
  const perDay = spanDays > 0.02 ? Number((consumed / spanDays).toFixed(2)) : null;

  return {
    hours,
    samples: win.length,
    consumed,
    recharged: recharged > 0 ? recharged : 0,
    perDay,
    from: first.queriedAt,
    to: last.queriedAt,
  };
}

/** 预测还能撑几天（按最近 24h 日均消耗） */
function forecast(balance, perDay) {
  if (typeof balance !== 'number' || !perDay || perDay <= 0) return null;
  return Number((balance / perDay).toFixed(1));
}

/**
 * @param {object} opts
 * @param {object} opts.result   queryBalance 返回结果
 * @param {object} opts.cfg      配置
 * @param {Array}  opts.history  历史记录（含本次）
 * @param {Array}  opts.alerts   本次触发的预警
 * @param {object} opts.state    告警状态（取 lastAlertAt/lastOkAt）
 */
function buildSnapshot({ result, cfg, history = [], alerts = [], state = {} }) {
  const last24 = summarize(history, result.balance, 24);
  const last72 = summarize(history, result.balance, 72);
  const redact = Boolean(cfg.cloud && cfg.cloud.redact);
  const location = redact ? redactLocation(result.location) : (result.location ?? null);
  const custRechNo = redact
    ? redactMeter(result.custRechNo ?? cfg.meter.custRechNo)
    : (result.custRechNo ?? cfg.meter.custRechNo ?? null);

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    ok: true,
    balance: result.balance,
    location,
    meterAddress: result.meterAddress ?? null,
    unit: result.unit ?? null,
    custRechNo,
    queriedAt: result.queriedAt ?? new Date().toISOString(),
    threshold: cfg.alert.threshold,
    criticalThreshold: cfg.alert.criticalThreshold,
    level: levelOf(result.balance, cfg),
    stats: {
      last24h: last24,
      last72h: last72,
      forecastDays: forecast(result.balance, last24.perDay ?? last72.perDay),
    },
    alerts: alerts.map((a) => ({ level: a.level, rule: a.rule, title: a.title, message: a.message })),
    recent: history
      .slice()
      .sort((a, b) => Date.parse(b.queriedAt) - Date.parse(a.queriedAt))
      .slice(0, 48)
      .map((r) => ({ at: r.queriedAt, balance: r.balance })),
    lastAlertAt: state.lastAlertAt || {},
  };
}

function levelOf(balance, cfg) {
  if (typeof balance !== 'number') return 'unknown';
  if (balance < cfg.alert.criticalThreshold) return 'critical';
  if (balance < cfg.alert.threshold) return 'warn';
  return 'ok';
}

/** 失败快照：查询挂了也要给 App 一个明确的信号，而不是让它读到旧数据 */
function buildFailureSnapshot({ cfg, error, lastOk = null }) {
  const redact = Boolean(cfg.cloud && cfg.cloud.redact);
  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    ok: false,
    error: String(error || '未知错误'),
    balance: lastOk?.balance ?? null,
    location: redact ? redactLocation(lastOk?.location) : (lastOk?.location ?? null),
    custRechNo: redact ? redactMeter(cfg.meter.custRechNo) : (cfg.meter.custRechNo ?? null),
    queriedAt: lastOk?.queriedAt ?? null,
    level: 'unknown',
  };
}

/**
 * 写快照。同时写 .json 和 .js（后者是 JSONP 兜底）
 * @returns {string[]} 实际写出的文件路径
 */
function writeSnapshot(cfg, snapshot) {
  const file = cfg.storage.latestFile || 'data/latest.json';
  const abs = path.isAbsolute(file) ? file : path.join(cfg.__root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const json = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(abs, json + '\n', 'utf8');

  const written = [abs];

  // 同目录的 .js 版本：window.ELEC_SNAPSHOT = {...}
  const jsPath = abs.replace(/\.json$/i, '') + '.js';
  if (jsPath !== abs) {
    fs.writeFileSync(jsPath, `window.ELEC_SNAPSHOT = ${json};\n`, 'utf8');
    written.push(jsPath);
  }

  return written;
}

module.exports = {
  buildSnapshot,
  buildFailureSnapshot,
  writeSnapshot,
  summarize,
  forecast,
  levelOf,
  SNAPSHOT_VERSION,
  redactLocation,
  redactMeter,
  shortLocation,
};
