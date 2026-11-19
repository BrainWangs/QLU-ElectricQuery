'use strict';
/**
 * 通知渠道注册表。
 *
 * 每个渠道是一个对象：
 *   { id, label, remote, isConfigured(cfg), send({alert, cfg, ctx, title, text}) }
 *
 * **为什么必须做成注册表**：原来有三份各自独立的判断——
 *   - `notify()`        里一串 `if (n.ntfy && n.ntfy.topic) tasks.push(...)`
 *   - `hasRemoteChannel()` 里一串 `(n.ntfy && n.ntfy.topic) || ...`
 *   - `activeChannels()`  里又串 `if (n.ntfy && n.ntfy.topic) out.push('ntfy')`
 * 三份写法看起来一样，但只要改动一处（比如给 bark 加个必要条件），
 * 另外两份就悄悄失配：启动自检说"bark 已启用"，实际 notify 不发，
 * 或者反过来——自检说没配渠道，其实在发。这类不一致**没有任何测试能抓到**，
 * 因为每份判断各自"看起来对"。
 *
 * 现在只有一个 `isConfigured`，自检与发送都用它，结构上不可能失配。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('../logger');
const time = require('../time');

const TIMEOUT_MS = 15000;
const ICONS = { critical: '🔴', warn: '🟠', info: '🟢' };
/** 各等级对应的 ntfy priority */
const PRIORITY = { critical: 5, warn: 4, info: 3 };

/** 所有网络请求统一走这里：超时、吞异常、只记日志、返回布尔 */
async function request(url, init = {}, label = '') {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`${label || url} 返回 ${res.status} ${body.slice(0, 200)}`);
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn(`${label || url} 发送失败: ${e.message}`);
    return { ok: false, status: 0, error: e.message };
  }
}

const postJson = (url, body, label, headers = {}) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
}, label);

/**
 * 发纯文本 body。**ntfy 必须用这个，不能用 postJson。**
 *
 * 原因（真实事故）：ntfy 的 `POST /<topic>` 端点把**整个 body 当成消息正文**。
 * 阶段 5 重构时把 ntfy 的 body 写成了 `JSON.stringify({message: text})`，
 * 于是手机上收到的推送正文是原始 JSON：
 *     {"message":"当前余额 44.27 元。\n示例校区-示例园1A101"}
 * 而不是「当前余额 44.27 元」。
 *
 * ntfy 也支持 JSON 发布，但那种用法要把 JSON 发到**根路径 `/`**，
 * 且必须在 JSON 里带 `topic` 字段——和"发到 /topic 端点"是两套 API，不能混。
 * 这里沿用原来的纯文本方式，改动最小、行为最稳。
 */
const postText = (url, text, label, headers = {}) => request(url, {
  method: 'POST',
  // ntfy 默认 text/plain；显式写出来避免任何中间层猜测
  headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  body: text,
}, label);

const postForm = (url, form, label) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(form).toString(),
}, label);

/** ntfy 的 Title 走 HTTP header，只能放 latin1，中文必须按 RFC 2047 编码 */
function encodeHeaderText(s) {
  // 纯 ASCII 直接返回，避免无谓编码
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** 取路径下的一层配置，缺失时返回空对象（避免满屏 && 判空） */
const sect = (cfg, ...keys) => {
  let cur = (cfg && cfg.alert && cfg.alert.notify) || {};
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return {};
    cur = cur[k];
  }
  return cur && typeof cur === 'object' ? cur : {};
};

// ---------------- 渠道定义 ----------------

const consoleChannel = {
  id: 'console',
  label: '控制台',
  remote: false,
  isConfigured: cfg => sect(cfg).console !== false,
  // eslint-disable-next-line no-unused-vars
  send: async ({ text }) => { log.info(text); return { ok: true }; },
};

const fileChannel = {
  id: 'file',
  label: '本地文件',
  remote: false,
  isConfigured: cfg => Boolean(sect(cfg).file),
  send: async ({ alert, cfg }) => {
    const n = sect(cfg);
    if (!n.file) return { ok: false, error: '未配置文件路径' };
    const file = path.isAbsolute(n.file) ? n.file : path.join(cfg.__root, n.file);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const ts = time.beijingNowText();
      fs.appendFileSync(file, `[${ts}] ${alert.level.toUpperCase()} ${alert.title} | ${alert.message}\n`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

const ntfyChannel = {
  id: 'ntfy',
  label: 'ntfy',
  remote: true,
  // 唯一判据：有没有 topic。server 有默认值，不需要判断。
  isConfigured: cfg => Boolean(sect(cfg, 'ntfy').topic),
  send: async ({ alert, cfg, text, title }) => {
    const c = sect(cfg, 'ntfy');
    if (!c.topic) return { ok: false, error: '未配置 topic' };
    const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const isAlert = alert.level === 'critical' || alert.level === 'warn';

    const headers = {
      // Title 走 HTTP header，只能放 latin1，中文必须 RFC 2047 编码
      Title: encodeHeaderText(title),
      // 额度预警（warn/critical）一律最高优先级 5（手机持续响铃/震动）；
      // 普通通知（日报/恢复）用等级默认值。这条在阶段 5 被我改坏了：
      // 当时一律用 PRIORITY[level]（critical=5, warn=4），
      // 导致 warn 级预警从「持续响铃」降级为「长振动」。
      Priority: isAlert ? '5' : String(PRIORITY[alert.level] || 3),
    };
    // Tags 只在预警时加，普通通知不加，避免锁屏多出无关小图标
    if (isAlert) headers.Tags = 'warning';

    // **必须发纯文本**：发到 /<topic> 端点时，body 就是消息正文。
    // 用 JSON.stringify 会让手机上显示整段 JSON（真实踩过，见 postText 注释）。
    // 预警正文前加 ⚠️ 让锁屏一眼看出严重性；日报不加。
    return postText(
      `${server}/${encodeURIComponent(c.topic)}`,
      isAlert ? `⚠️ ${text}` : text,
      'ntfy',
      headers,
    );
  },
};

const pushplusChannel = {
  id: 'pushplus',
  label: 'PushPlus',
  remote: true,
  isConfigured: cfg => Boolean(sect(cfg, 'pushplus').token),
  send: async ({ cfg, title, text }) => {
    const c = sect(cfg, 'pushplus');
    const body = { token: c.token, title, content: text, template: 'txt' };
    if (c.topic) body.topic = c.topic;
    return postJson('https://www.pushplus.plus/send', body, 'pushplus');
  },
};

const serverchanChannel = {
  id: 'serverchan',
  label: 'Server酱',
  remote: true,
  isConfigured: cfg => Boolean(sect(cfg, 'serverchan').sendkey),
  send: async ({ cfg, title, text }) => {
    const c = sect(cfg, 'serverchan');
    const key = String(c.sendkey || '');
    // Server酱³ 是 sctp{token} 形式，走不同域名
    const url = key.startsWith('sctp')
      ? `https://${key}.push.ft07.com/send`
      : `https://sctapi.ftqq.com/${key}.send`;
    return postForm(url, { title, desp: text }, 'serverchan');
  },
};

const wecomChannel = {
  id: 'wecom',
  label: '企业微信',
  remote: true,
  isConfigured: cfg => Boolean(sect(cfg, 'wecom').webhook),
  send: async ({ cfg, text }) => postJson(
    sect(cfg, 'wecom').webhook,
    // 用 markdown 而不是 text：阶段 5 我把它改成了 text，
    // 效果是正文里的 **加粗** 与链接会原样显示成符号，手机上看很难看。
    { msgtype: 'markdown', markdown: { content: text } },
    'wecom',
  ),
};

const barkChannel = {
  id: 'bark',
  label: 'Bark',
  remote: true,
  isConfigured: cfg => Boolean(sect(cfg, 'bark').url),
  send: async ({ cfg, title, text }) => {
    const base = String(sect(cfg, 'bark').url || '').replace(/\/+$/, '');
    // Bark 的 URL 式 API 只支持 **GET**：内容全部走路径段。
    // 阶段 5 我把它改成了 POST + 空 body，Bark 服务器会忽略整个请求
    // （表现为「显示发送成功但手机没收到」——比报错更难发现）。
    // group 参数让通知在 Bark 里归到同一组，便于批量清理。
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(text)}`
      + `?group=${encodeURIComponent('电费助手')}`;
    return request(url, { method: 'GET' }, 'bark');
  },
};

const telegramChannel = {
  id: 'telegram',
  label: 'Telegram',
  remote: true,
  // token 与 chatId 缺一不可：只配 token 发不出去，自检不该说"已启用"
  isConfigured: cfg => Boolean(sect(cfg, 'telegram').token && sect(cfg, 'telegram').chatId),
  send: async ({ cfg, title, text }) => {
    const c = sect(cfg, 'telegram');
    return postJson(
      `https://api.telegram.org/bot${c.token}/sendMessage`,
      { chat_id: c.chatId, text: `${title}\n${text}`, disable_web_page_preview: true },
      'telegram',
    );
  },
};

const webhookChannel = {
  id: 'webhook',
  label: '通用 webhook',
  remote: true,
  isConfigured: cfg => Boolean(sect(cfg).webhook),
  send: async ({ alert, cfg, ctx }) => postJson(sect(cfg).webhook, {
    level: alert.level,
    rule: alert.rule,
    title: alert.title,
    message: alert.message,
    balance: ctx.balance ?? null,
    location: ctx.location ?? null,
    custRechNo: ctx.custRechNo ?? null,
    at: new Date().toISOString(),
  }, 'webhook'),
};

/** 注册表顺序即发送顺序（console 在前，便于本地调试时先看到） */
const CHANNELS = [
  consoleChannel,
  fileChannel,
  ntfyChannel,
  pushplusChannel,
  serverchanChannel,
  wecomChannel,
  barkChannel,
  telegramChannel,
  webhookChannel,
];

module.exports = {
  CHANNELS,
  ICONS,
  PRIORITY,
  TIMEOUT_MS,
  request,
  encodeHeaderText,
  getChannel: id => CHANNELS.find(c => c.id === id) || null,
};
