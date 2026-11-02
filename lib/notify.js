'use strict';
/**
 * 通知渠道
 *
 *   console     控制台
 *   file        追加到本地文件
 *   webhook     通用 JSON webhook
 *   ntfy        ntfy.sh（手机装 ntfy App 订阅 topic，免费、免注册）
 *   pushplus    PushPlus（微信推送，国内可达性最好）
 *   serverchan  Server酱³（微信推送）
 *   wecom       企业微信群机器人
 *   bark        Bark（iOS）
 *   telegram    Telegram Bot
 *
 * 所有渠道都是「配置了才发」，没配的直接跳过，互不影响；
 * 任一渠道失败只记 warning，不阻断其它渠道，也不让整个查询失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');

const ICONS = { critical: '🔴', warn: '🟠', info: '🟢' };
/** 各等级对应的 ntfy priority */
const PRIORITY = { critical: 5, warn: 4, info: 3 };

const TIMEOUT_MS = 15000;

/** 所有网络请求统一走这里：超时、吞异常、只记日志 */
async function request(url, init = {}, label = '') {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`${label || url} 返回 ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`${label || url} 发送失败: ${e.message}`);
    return false;
  }
}

const postJson = (url, body, label, headers = {}) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
}, label);

const postForm = (url, form, label) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(form).toString(),
}, label);

// ---------------- 各渠道实现 ----------------

function sendConsole(text) { log.info(text); return true; }

function sendFile(alert, cfg, text) {
  const n = cfg.alert.notify || {};
  if (!n.file) return false;
  const file = path.isAbsolute(n.file) ? n.file : path.join(cfg.__root, n.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  fs.appendFileSync(file, `[${ts}] ${alert.level.toUpperCase()} ${alert.title} | ${alert.message}\n`);
  return true;
}

/** ntfy 的 Title 走 HTTP header，只能放 latin1，中文必须按 RFC 2047 编码 */
function encodeHeaderText(s) {
  // 纯 ASCII 直接返回，避免无谓编码
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

async function sendNtfy(alert, cfg, text) {
  const c = (cfg.alert.notify || {}).ntfy || {};
  const topic = c.topic;
  if (!topic) return false;
  const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const isAlert = alert.level === 'critical' || alert.level === 'warn';
  // 标题带等级图标，锁屏横幅一眼能分清是预警还是日报（RFC 2047 编码中文）
  const icon = ICONS[alert.level] || 'ℹ️';
  const headerTitle = encodeHeaderText(`${icon} ${alert.title}`);
  return request(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: headerTitle,
      // 额度预警（warn/critical）一律最高优先级 5（手机持续响铃/震动）；
      // 普通通知（日报/恢复）默认优先级 3。Tags 只在预警时加，
      // 普通通知不加标签，避免锁屏上多出一个无关的小图标。
      Priority: isAlert ? '5' : String(PRIORITY[alert.level] || 3),
      ...(isAlert ? { Tags: 'warning' } : {}),
    },
    body: isAlert ? `⚠️ ${text}` : text,
  }, 'ntfy');
}

async function sendPushPlus(alert, cfg, title, message) {
  const c = (cfg.alert.notify || {}).pushplus || {};
  if (!c.token) return false;
  const body = { token: c.token, title, content: message, template: 'txt' };
  if (c.topic) body.topic = c.topic;
  return postJson('https://www.pushplus.plus/send', body, 'pushplus');
}

async function sendServerChan(alert, cfg, title, message) {
  const c = (cfg.alert.notify || {}).serverchan || {};
  if (!c.sendkey) return false;
  return postForm(`https://sctapi.ftqq.com/${c.sendkey}.send`, { title, desp: message }, 'serverchan');
}

async function sendWecom(alert, cfg, text) {
  const c = (cfg.alert.notify || {}).wecom || {};
  if (!c.webhook) return false;
  return postJson(c.webhook, { msgtype: 'markdown', markdown: { content: text } }, 'wecom');
}

async function sendBark(alert, cfg, title, message) {
  const c = (cfg.alert.notify || {}).bark || {};
  if (!c.url) return false;
  const base = c.url.replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?group=${encodeURIComponent('电费助手')}`;
  return request(url, { method: 'GET' }, 'bark');
}

async function sendTelegram(alert, cfg, title, message) {
  const c = (cfg.alert.notify || {}).telegram || {};
  if (!c.token || !c.chatId) return false;
  return postJson(`https://api.telegram.org/bot${c.token}/sendMessage`, {
    chat_id: c.chatId,
    text: `${title}\n${message}`,
    disable_web_page_preview: true,
  }, 'telegram');
}

/**
 * 发一条通知，扇出到所有已配置渠道
 * @param {object} alert {level, title, message, rule}
 * @param {object} cfg   完整配置
 * @param {object} ctx   {balance, location, custRechNo}
 */
async function notify(alert, cfg, ctx = {}) {
  const n = cfg.alert.notify || {};
  const icon = ICONS[alert.level] || 'ℹ️';
  const title = `${icon} ${alert.title}`;
  const text = `${title}\n${alert.message}`;

  const tasks = [];

  if (n.console !== false) tasks.push(sendConsole(text));
  tasks.push(sendFile(alert, cfg, text));

  if (n.ntfy && n.ntfy.topic) tasks.push(sendNtfy(alert, cfg, text));
  if (n.pushplus && n.pushplus.token) tasks.push(sendPushPlus(alert, cfg, title, alert.message));
  if (n.serverchan && n.serverchan.sendkey) tasks.push(sendServerChan(alert, cfg, title, alert.message));
  if (n.wecom && n.wecom.webhook) tasks.push(sendWecom(alert, cfg, text));
  if (n.bark && n.bark.url) tasks.push(sendBark(alert, cfg, title, alert.message));
  if (n.telegram && n.telegram.token && n.telegram.chatId) tasks.push(sendTelegram(alert, cfg, title, alert.message));

  if (n.webhook) {
    tasks.push(postJson(n.webhook, {
      level: alert.level,
      rule: alert.rule,
      title: alert.title,
      message: alert.message,
      balance: ctx.balance ?? null,
      location: ctx.location ?? null,
      custRechNo: ctx.custRechNo ?? null,
      at: new Date().toISOString(),
    }, 'webhook'));
  }

  await Promise.all(tasks);
}

/** 是否至少配置了一个「能到达手机」的远程渠道（console/file 不算） */
function hasRemoteChannel(cfg) {
  const n = (cfg.alert && cfg.alert.notify) || {};
  return Boolean(
    (n.ntfy && n.ntfy.topic) ||
    (n.pushplus && n.pushplus.token) ||
    (n.serverchan && n.serverchan.sendkey) ||
    (n.wecom && n.wecom.webhook) ||
    (n.bark && n.bark.url) ||
    (n.telegram && n.telegram.token) ||
    n.webhook,
  );
}

/** 列出已启用的渠道名，用于启动时自检打印 */
function activeChannels(cfg) {
  const n = (cfg.alert && cfg.alert.notify) || {};
  const out = [];
  if (n.console !== false) out.push('console');
  if (n.file) out.push('file');
  if (n.ntfy && n.ntfy.topic) out.push('ntfy');
  if (n.pushplus && n.pushplus.token) out.push('pushplus');
  if (n.serverchan && n.serverchan.sendkey) out.push('serverchan');
  if (n.wecom && n.wecom.webhook) out.push('wecom');
  if (n.bark && n.bark.url) out.push('bark');
  if (n.telegram && n.telegram.token) out.push('telegram');
  if (n.webhook) out.push('webhook');
  return out;
}

module.exports = { notify, hasRemoteChannel, activeChannels };
