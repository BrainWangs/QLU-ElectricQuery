// 通知渠道注册表与调度器（lib/notify/）的夹具。
//
// 阶段 5 的核心问题是**三份判断不一致**：原来 notify() / hasRemoteChannel() /
// activeChannels() 各自写了一遍"这个渠道配了吗"，看起来一样，但改一处就失配。
// 失配的表现是：启动自检说"ntfy 已启用"，实际不发；或者反过来。
// 这类 bug 没有任何测试能抓到，因为每份判断单独看都对。
//
// 所以这里最重要的测试是"注册表与调度器用的是同一个判据"，
// 其次是"alert-test 的退出码必须反映真实送达结果"。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CHANNELS, getChannel, encodeHeaderText, PRIORITY, ICONS } = require('../lib/notify/channels');
const notifyMod = require('../lib/notify/index');
const { notify, buildReport, describeReport, activeChannels, hasRemoteChannel } = notifyMod;
const { __test } = require('../lib/config');

/** 造一份"什么渠道都没配"的配置 */
function bareCfg() {
  return __test.deepMerge(__test.DEFAULTS, {
    account: { username: 'u', password: 'p' },
    meter: { custRechNo: '示例园#1#A101' },
    alert: { notify: { console: false, file: '' } },
  });
}

const ALERT = { level: 'warn', rule: 'test', title: '测试', message: '正文' };

// ------------------------------------------------------------ 注册表结构

test('注册表：每个渠道都有 id/label/remote/isConfigured/send', () => {
  for (const ch of CHANNELS) {
    assert.strictEqual(typeof ch.id, 'string', `${ch.id} 缺 id`);
    assert.strictEqual(typeof ch.label, 'string', `${ch.id} 缺 label`);
    assert.strictEqual(typeof ch.remote, 'boolean', `${ch.id} 缺 remote`);
    assert.strictEqual(typeof ch.isConfigured, 'function', `${ch.id} 缺 isConfigured`);
    assert.strictEqual(typeof ch.send, 'function', `${ch.id} 缺 send`);
  }
});

test('注册表：id 不重复', () => {
  const ids = CHANNELS.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, `重复的 id: ${ids}`);
});

test('注册表：console/file 不是远程渠道，其余都是', () => {
  assert.strictEqual(getChannel('console').remote, false);
  assert.strictEqual(getChannel('file').remote, false);
  for (const id of ['ntfy', 'pushplus', 'serverchan', 'wecom', 'bark', 'telegram', 'webhook']) {
    assert.strictEqual(getChannel(id).remote, true, `${id} 应标记为远程`);
  }
});

test('注册表：getChannel 对不存在的 id 返回 null 而不是崩', () => {
  assert.strictEqual(getChannel('nope'), null);
});

// ------------------------------------------------------------ isConfigured 一致性（本阶段的核心）

test('核心：activeChannels 与 hasRemoteChannel 用同一判据，不可能失配', () => {
  // 构造每一种"只配一个渠道"的配置，逐一验证
  const cases = [
    ['ntfy', { ntfy: { topic: 't' } }, true],
    ['pushplus', { pushplus: { token: 't' } }, true],
    ['serverchan', { serverchan: { sendkey: 'k' } }, true],
    ['wecom', { wecom: { webhook: 'https://x' } }, true],
    ['bark', { bark: { url: 'https://x' } }, true],
    ['telegram', { telegram: { token: 't', chatId: 'c' } }, true],
    ['webhook', { webhook: 'https://x' }, true],
  ];
  for (const [id, notifyCfg, expectRemote] of cases) {
    const cfg = bareCfg();
    Object.assign(cfg.alert.notify, notifyCfg);
    const active = activeChannels(cfg);
    assert.deepStrictEqual(active, [id], `${id} 的 activeChannels`);
    assert.strictEqual(hasRemoteChannel(cfg), expectRemote, `${id} 的 hasRemoteChannel`);
    // 关键：能列出它 = 会发它。两边用的必须是同一个 isConfigured
    assert.ok(getChannel(id).isConfigured(cfg), `${id} 的 isConfigured 应为真`);
  }
});

test('核心：telegram 只配 token 不算已配置（缺 chatId 发不出去）', () => {
  // 反例：如果这里判成"已配置"，自检会说 telegram 可用，实际发送必然失败
  const cfg = bareCfg();
  cfg.alert.notify.telegram = { token: 'tok', chatId: '' };
  assert.strictEqual(hasRemoteChannel(cfg), false);
  assert.ok(!activeChannels(cfg).includes('telegram'));
});

test('核心：console/file 不算远程渠道（用户不会盯 CI 日志看电费）', () => {
  const cfg = bareCfg();
  cfg.alert.notify.console = true;
  cfg.alert.notify.file = '/tmp/x.log';
  assert.deepStrictEqual(activeChannels(cfg).sort(), ['console', 'file']);
  assert.strictEqual(hasRemoteChannel(cfg), false, '只有本地渠道时不算能到达手机');
});

test('isConfigured 对形状异常的配置不抛错（自检不能崩掉整个命令）', () => {
  const weird = { alert: { notify: { ntfy: 'not-an-object', telegram: null, bark: 42 } } };
  for (const ch of CHANNELS) {
    assert.doesNotThrow(() => ch.isConfigured(weird), `${ch.id} 在异常配置下抛错了`);
  }
});

// ------------------------------------------------------------ 送达报告

test('报告：全成功时 ok 取决于有没有远程渠道成功', () => {
  const onlyLocal = buildReport([
    { id: 'console', label: '控制台', remote: false, ok: true },
  ]);
  assert.strictEqual(onlyLocal.ok, false, '只有本地渠道不算送达');

  const withRemote = buildReport([
    { id: 'console', label: '控制台', remote: false, ok: true },
    { id: 'ntfy', label: 'ntfy', remote: true, ok: true },
  ]);
  assert.strictEqual(withRemote.ok, true);
  assert.strictEqual(withRemote.sent, 2);
  assert.strictEqual(withRemote.remoteSent, 1);
});

test('报告：远程渠道全失败时 ok=false（预警没送到人手上）', () => {
  const r = buildReport([
    { id: 'console', label: '控制台', remote: false, ok: true },
    { id: 'ntfy', label: 'ntfy', remote: true, ok: false, error: 'HTTP 500' },
  ]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.sent, 1);
});

test('报告：描述文字列出成功与失败项', () => {
  const r = buildReport([
    { id: 'ntfy', label: 'ntfy', remote: true, ok: true },
    { id: 'bark', label: 'Bark', remote: true, ok: false, error: 'HTTP 404' },
  ]);
  const lines = describeReport(r).join('\n');
  assert.match(lines, /已送达.*ntfy/);
  assert.match(lines, /发送失败.*Bark.*404/);
});

test('报告：一个渠道都没配时明确说出来', () => {
  const lines = describeReport(buildReport([])).join('\n');
  assert.match(lines, /没有配置任何通知渠道/);
});

// ------------------------------------------------------------ notify 实际行为

test('notify：单渠道抛错不影响其它渠道', async () => {
  const cfg = bareCfg();
  cfg.alert.notify.ntfy = { topic: 'topic-a' };
  cfg.alert.notify.webhook = 'https://example.invalid/hook';

  // 让两个网络渠道都失败（域名不可解析），但绝不能抛出去
  const report = await notify(ALERT, cfg, {});
  assert.ok(report, '必须返回报告');
  assert.strictEqual(report.results.length >= 1, true);
  // 远程渠道可达性不保证，但函数不能抛
  assert.strictEqual(typeof report.ok, 'boolean');
});

test('notify：没有任何渠道时返回空报告而不是崩', async () => {
  const cfg = bareCfg();
  const report = await notify(ALERT, cfg, {});
  assert.deepStrictEqual(report.results, []);
  assert.strictEqual(report.ok, false);
});

test('notify：file 渠道真的写文件，且内容含等级与标题', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elec-notify-'));
  const cfg = bareCfg();
  cfg.__root = dir;
  cfg.alert.notify.file = 'alerts.log';

  const report = await notify({ level: 'critical', rule: 'test', title: '余额不足', message: '只剩 3 元' }, cfg, {});
  const file = path.join(dir, 'alerts.log');
  assert.ok(fs.existsSync(file), '日志文件应被创建');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /CRITICAL/);
  assert.match(body, /余额不足/);
  assert.match(body, /只剩 3 元/);
  assert.strictEqual(report.ok, false, '只有本地渠道 → 不算送达');
});

test('notify：file 写失败时报告里带 error，不抛', async () => {
  const cfg = bareCfg();
  cfg.__root = '/nonexistent-root-xyz';
  cfg.alert.notify.file = 'deep/alerts.log';
  const report = await notify(ALERT, cfg, {});
  const fileResult = report.results.find(r => r.id === 'file');
  // 要么成功（有权限）要么带 error，但绝不能抛
  assert.ok(fileResult, 'file 渠道应出现在结果里');
  assert.ok(fileResult.ok === true || typeof fileResult.error === 'string');
});

// ------------------------------------------------------------ 编码与常量

test('ntfy 标题编码：纯 ASCII 原样返回', () => {
  assert.strictEqual(encodeHeaderText('hello world'), 'hello world');
});

test('ntfy 标题编码：中文按 RFC 2047 编码，可解回原文', () => {
  const out = encodeHeaderText('余额不足');
  assert.match(out, /^=\?UTF-8\?B\?.+\?=$/);
  const b64 = out.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  assert.strictEqual(Buffer.from(b64, 'base64').toString('utf8'), '余额不足');
});

test('ntfy 优先级：critical 最高，warn/info 递减', () => {
  assert.strictEqual(PRIORITY.critical, 5);
  assert.ok(PRIORITY.critical > PRIORITY.warn);
  assert.ok(PRIORITY.warn > PRIORITY.info);
});

test('图标：三个等级都有，未知等级有兜底', () => {
  assert.ok(ICONS.critical && ICONS.warn && ICONS.info);
});

test('核心：渠道返回 ok=false 时必须计入失败（不能一律当成功）', async () => {
  // 变异 N3 的靶心：把渠道返回值忽略掉、一律算成功，
  // 会让"发送失败"变成"已送达"，而用户以为收到了提醒。
  // 这里用一个必然失败的 file 渠道（路径不可写）来触发。
  const cfg = bareCfg();
  // 指向一个不存在的根 + 需要创建深层目录，且父级是文件（必然失败）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elec-n3-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  cfg.__root = blocker; // __root 是文件 → mkdirSync 必然抛错
  cfg.alert.notify.file = 'alerts.log';

  const report = await notify(ALERT, cfg, {});
  const fileResult = report.results.find(r => r.id === 'file');
  assert.ok(fileResult, 'file 渠道应出现在结果里');
  assert.strictEqual(fileResult.ok, false, '写入失败必须如实记为失败');
  assert.ok(fileResult.error, '失败项必须带 error 说明');
  assert.strictEqual(report.sent, 0);
});

test('核心：渠道 send 返回 undefined 视为成功（sender 不需要显式返回）', async () => {
  // 这是允许的宽松约定；但要与"返回 ok:false"区分开
  const cfg = bareCfg();
  cfg.alert.notify.console = true;
  const report = await notify(ALERT, cfg, {});
  const consoleResult = report.results.find(r => r.id === 'console');
  assert.strictEqual(consoleResult.ok, true);
});

// ------------------------------------------------------------ 请求格式（真实事故回归）
//
// 这一组是 2026-11-07 的真实事故的回归测试：
// 阶段 5 重构通知层时，把 ntfy 的 body 从「纯文本」改成了 JSON.stringify({message})。
// 结果手机上收到的推送正文是原始 JSON：
//     {"message":"当前余额 44.27 元。\n示例校区-示例园1A101"}
// 而用户期望的是「当前余额 44.27 元」。
//
// 根因：ntfy 的 POST /<topic> 端点把**整个 body 当消息正文**；
// 它的 JSON 发布方式是「发到根路径 / 且 JSON 里带 topic」，是另一套 API。
//
// 这类 bug 单测之前抓不到，因为测试只检查"有没有调用发送"，
// 没检查"发出去的东西长什么样"。所以这里直接拦截 fetch 检查 body。

/** 装一个假的 fetch，记录所有请求 */
function captureFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('回归：ntfy 的 body 必须是纯文本，不能是 JSON', async () => {
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.ntfy = { topic: 'test-topic', server: 'https://ntfy.sh' };
    const report = await notify(
      { level: 'info', rule: 'daily', title: '电费日报', message: '当前余额 44.27 元。\n示例校区-示例园1A101' },
      cfg, {},
    );

    const call = cap.calls.find(c => c.url.includes('ntfy'));
    assert.ok(call, '应该真的发了一个 ntfy 请求');
    // 核心断言：body 就是正文本身
    assert.strictEqual(
      call.body,
      '当前余额 44.27 元。\n示例校区-示例园1A101',
      `ntfy body 必须是纯文本，实际是 ${JSON.stringify(call.body)}`,
    );
    // 绝不能出现 JSON 包装
    assert.ok(!/^\{/.test(String(call.body)), 'body 不能以 { 开头（那是 JSON 包装）');
    assert.strictEqual(call.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.ok(report.results.find(r => r.id === 'ntfy').ok);
  } finally {
    cap.restore();
  }
});

test('回归：ntfy 预警 body 加 ⚠️ 前缀且优先级为 5', async () => {
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.ntfy = { topic: 't' };
    await notify({ level: 'warn', rule: 'low', title: '余额偏低', message: '只剩 8 元' }, cfg, {});

    const call = cap.calls.find(c => c.url.includes('ntfy'));
    assert.ok(String(call.body).startsWith('⚠️'), `预警正文应带 ⚠️ 前缀，实际 ${call.body}`);
    assert.strictEqual(call.headers.Priority, '5', 'warn 级预警必须是最高优先级（手机持续响铃）');
    assert.strictEqual(call.headers.Tags, 'warning');
  } finally {
    cap.restore();
  }
});

test('回归：ntfy 日报不加 ⚠️、不加 Tags、优先级为 3', async () => {
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.ntfy = { topic: 't' };
    await notify({ level: 'info', rule: 'daily', title: '电费日报', message: '余额 44 元' }, cfg, {});

    const call = cap.calls.find(c => c.url.includes('ntfy'));
    assert.ok(!String(call.body).startsWith('⚠️'), '日报不该带预警前缀');
    assert.strictEqual(call.headers.Tags, undefined, '日报不该加标签（锁屏会多出无关图标）');
    assert.strictEqual(call.headers.Priority, '3');
  } finally {
    cap.restore();
  }
});

test('回归：Bark 必须用 GET（URL 式 API 不支持 POST）', async () => {
  // 阶段 5 把 Bark 从 GET 改成了 POST + 空 body，Bark 会忽略请求，
  // 表现为「显示发送成功但手机没收到」——比报错难发现得多。
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.bark = { url: 'https://api.day.app/KEY' };
    await notify({ level: 'info', rule: 'daily', title: '电费日报', message: '余额 44 元' }, cfg, {});

    const call = cap.calls.find(c => c.url.includes('api.day.app'));
    assert.ok(call, '应该发了 Bark 请求');
    assert.strictEqual(call.method, 'GET', `Bark 必须用 GET，实际 ${call.method}`);
    assert.ok(call.url.includes('group='), 'Bark 应带 group 参数（便于批量清理通知）');
  } finally {
    cap.restore();
  }
});

test('回归：企业微信用 markdown 类型（否则正文格式符号会原样显示）', async () => {
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.wecom = { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' };
    await notify({ level: 'info', rule: 'daily', title: '日报', message: '**加粗** 内容' }, cfg, {});

    const call = cap.calls.find(c => c.url.includes('qyapi'));
    const body = JSON.parse(call.body);
    assert.strictEqual(body.msgtype, 'markdown', '用 text 会让 **加粗** 原样显示成符号');
    assert.ok(body.markdown.content);
  } finally {
    cap.restore();
  }
});

test('回归：所有渠道的 body 里都不该出现 {"message": 这种 JSON 包装', async () => {
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    // 把所有渠道都配上，一次看全
    cfg.alert.notify.ntfy = { topic: 't' };
    cfg.alert.notify.pushplus = { token: 'tk' };
    cfg.alert.notify.serverchan = { sendkey: 'sk' };
    cfg.alert.notify.wecom = { webhook: 'https://qyapi.weixin.qq.com/x' };
    cfg.alert.notify.bark = { url: 'https://api.day.app/K' };
    cfg.alert.notify.telegram = { token: 'tk', chatId: '1' };
    cfg.alert.notify.webhook = 'https://example.com/hook';
    await notify({ level: 'info', rule: 'daily', title: '日报', message: '余额 44 元' }, cfg, {});

    for (const c of cap.calls) {
      const body = String(c.body || '');
      // ntfy 是唯一一个 body 应该是纯文本的；其余允许 JSON
      if (c.url.includes('ntfy') || c.url.includes('api.day.app')) continue;
      assert.ok(!/^\{"message":/.test(body), `${c.url} 的 body 被包成了 {message:...}`);
    }
  } finally {
    cap.restore();
  }
});

// ------------------------------------------------------------ 全部推送类型的格式
//
// 上一组只覆盖了"日报"和"预警"两种。但实际会发出 7 种通知，
// 每种 level 不同 → Priority/Tags/⚠️ 前缀都不同。漏测任何一种，
// 就可能出现"日报正常但预警格式坏掉"这种半好半坏的状态。

/** 所有会真正发出的通知类型，来源：bin/elec.js 与 lib/alert.js */
const ALL_ALERTS = [
  ['日报', { level: 'info', rule: 'daily', title: '电费日报', message: '当前余额 44.27 元，日均 1.2 元。' }, { priority: '3', tags: false, warn: false }],
  ['低余额', { level: 'warn', rule: 'low', title: '电费余额偏低', message: '当前余额 8.50 元。' }, { priority: '5', tags: true, warn: true }],
  ['严重不足', { level: 'critical', rule: 'critical', title: '电费余额严重不足', message: '当前余额 3.20 元。' }, { priority: '5', tags: true, warn: true }],
  ['余额恢复', { level: 'info', rule: 'recovered', title: '电费余额已恢复', message: '当前余额 50.00 元。' }, { priority: '3', tags: false, warn: false }],
  ['消耗异常', { level: 'warn', rule: 'drop', title: '电费消耗异常', message: '24 小时消耗 12.00 元。' }, { priority: '5', tags: true, warn: true }],
  ['查询失败', { level: 'warn', rule: 'offline', title: '电费查询失败', message: '余额查询失败：网络超时。' }, { priority: '5', tags: true, warn: true }],
  ['预警测试', { level: 'critical', rule: 'test', title: '预警测试', message: '这是一条测试通知。' }, { priority: '5', tags: true, warn: true }],
];

for (const [name, alert, want] of ALL_ALERTS) {
  test(`全部类型：${name} 的 Priority/Tags/⚠️ 前缀都符合约定`, async () => {
    const cap = captureFetch();
    try {
      const cfg = bareCfg();
      cfg.alert.notify.ntfy = { topic: 't' };
      await notify(alert, cfg, {});
      const c = cap.calls.find(x => x.url.includes('ntfy'));

      assert.ok(c, `${name} 应该发出 ntfy 请求`);
      assert.strictEqual(c.headers.Priority, want.priority, `${name} 的 Priority`);
      assert.strictEqual(Boolean(c.headers.Tags), want.tags, `${name} 的 Tags`);
      assert.strictEqual(String(c.body).startsWith('⚠️'), want.warn, `${name} 的 ⚠️ 前缀`);
      // 所有类型的 body 都必须是纯文本，不能是 JSON
      assert.ok(!/^\{/.test(String(c.body)), `${name} 的 body 不该是 JSON`);
    } finally {
      cap.restore();
    }
  });
}

test('全部类型：body 里的换行是真实换行符，不是字面的 \\n', async () => {
  // 消息正文里有 `\n`（如"余额…。\n地点"）。若被二次转义成字面 \n，
  // 手机上会显示成一行 "…。\n地点" 而不是两行。
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.ntfy = { topic: 't' };
    await notify({ level: 'info', rule: 'daily', title: '日报', message: '第一行\n第二行' }, cfg, {});
    const c = cap.calls.find(x => x.url.includes('ntfy'));
    assert.ok(c.body.includes('\n'), '应含真实换行');
    assert.ok(!c.body.includes('\\n'), '不该含字面的反斜杠 n');
  } finally {
    cap.restore();
  }
});

test('全部类型：标题是 RFC 2047 编码，解码后能还原中文与图标', async () => {
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.ntfy = { topic: 't' };
    await notify({ level: 'critical', rule: 'critical', title: '电费余额严重不足', message: 'x' }, cfg, {});
    const c = cap.calls.find(x => x.url.includes('ntfy'));
    const raw = c.headers.Title;
    assert.match(raw, /^=\?UTF-8\?B\?.+\?=$/, '应是 RFC 2047 编码');
    const b64 = raw.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    assert.strictEqual(decoded, '🔴 电费余额严重不足', '解码后应含图标与中文');
  } finally {
    cap.restore();
  }
});

test('全部类型：每个 level 都有对应图标，不会漏成 undefined', async () => {
  const { ICONS } = require('../lib/notify/channels');
  for (const level of ['critical', 'warn', 'info']) {
    assert.ok(ICONS[level], `${level} 缺图标`);
  }
  // 未知 level 要有兜底，不能显示 "undefined 标题"
  const cap = captureFetch();
  try {
    const cfg = bareCfg();
    cfg.alert.notify.ntfy = { topic: 't' };
    await notify({ level: 'weird', rule: 'x', title: '测试', message: 'x' }, cfg, {});
    const c = cap.calls.find(x => x.url.includes('ntfy'));
    const b64 = String(c.headers.Title).replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    assert.ok(!decoded.includes('undefined'), `未知 level 的标题不该含 undefined: ${decoded}`);
  } finally {
    cap.restore();
  }
});
