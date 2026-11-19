#!/usr/bin/env node
'use strict';
/**
 * 镜像构建器：从主仓生成一份**可公开**的目录树。
 *
 * 为什么需要它：主仓是私有的，里面到处是真实学号、电表号、房号、会话 cookie；
 * 公开镜像只应该让人看到代码结构。手抄一份副本必然漂移，所以镜像改成**构建产物**：
 * 白名单复制 → 文本脱敏 → 生成后对整棵输出树自检。
 *
 * 设计取舍（维护者已确认，见 docs/REFACTOR-PLAN.md §5）：
 *
 *  1. **白名单只列顶层项**。`config.json` / `data/` / `cookies.txt` 这些不是
 *     "被排除"，而是**根本没有入口**——将来仓库里新增一个敏感文件，默认行为是
 *     "不复制"，而不是"复制后再想办法排除"。
 *
 *  2. **脱敏只在构建时做**，主仓运行路径不脱敏（私有仓库保留真实房号才能确认
 *     是哪一间，见 lib/redact.js 顶部注释）。
 *
 *  3. **含真实形态串的测试文件整份跳过**（记进 skipped）。测试夹具里的值是被
 *     断言直接引用的：把 `A316` 改写成 `A101` 之后，`assert.strictEqual(x, 'A316')`
 *     要么失去意义、要么变成自证同义反复。镜像的目的是让人读到代码结构，不是
 *     在镜像里跑测试，所以"跳过并告知"比"改坏再假装通过"更安全。
 *
 *  4. **自检复用 scripts/preflight.js 的 RULES**（pattern + examples + 行内豁免），
 *     但扫描对象是任意输出树，而不是主仓的 git 文件列表。命中即 CLI 非 0 退出。
 *
 * 用法：
 *   node scripts/build-mirror.js --src . --out ../mirror-out
 *
 * 说明：`--push`（git commit + push 到公开仓库）在方案里是可选项，本文件**不做**
 * 任何 git 操作——推送需要一个明确的、可审阅的出口，不适合藏在构建器里。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RULES } = require('./preflight');

// ---------------------------------------------------------------- 名单

/**
 * 自检豁免：这些文件**按设计**必须包含真实形态的串。
 *
 * `scripts/preflight.js` 与 `scripts/build-mirror.js` 是检测器本身——
 * 它们要把园区名、电表号模式写进正则才能做检测。若把它们"脱敏"掉，
 * 镜像里的检测器就变成摆设，而读者会以为它还在工作。
 * 所以这里不脱敏、也不参与自检，但**在报告里明确列出**，让看到镜像的人知道
 * 这两个文件含真实形态串且原因是什么。
 */
const SELF_EXEMPT = Object.freeze(new Set([
  'scripts/preflight.js',
  'scripts/build-mirror.js',
]));

/** 只复制这些顶层项（不存在就跳过）。 */
const WHITELIST = Object.freeze([
  'lib',
  'bin',
  'scripts',
  'test',
  'docs',
  '.github',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'config.example.json',
  '.gitignore',
  '.gitattributes',
]);

/**
 * 永不复制的目录名（任意层级命中都跳过）。
 * 这些是运行时数据/依赖/逆向残留，一旦进公开镜像就是事故。
 */
const FORBIDDEN_DIRS = Object.freeze([
  'node_modules',
  '.git',
  'probe',
  'chunks',
  'data',
  /**
   * 内部开发记录，不进公开镜像。
   *
   * docs/review 是四个角度的代码审查（含修复前的缺陷细节、真实房号示例），
   * docs/REFACTOR-PLAN 是重构进度表（提到私有主仓与镜像的关系）。
   * 这两份对"想用这个模板部署自己电费"的读者没有价值，
   * 反而会暴露内部工作过程与历史缺陷。
   */
  'review',
  // 单独按文件排除 REFACTOR-PLAN，见 FORBIDDEN_FILES
]);

/** 永不复制的文件名（精确匹配）。 */
const FORBIDDEN_FILES = Object.freeze([
  'REFACTOR-PLAN.md',   // 重构进度表：含私有主仓/镜像的内部约定
  'AGENTS.md',          // 开发规则（测试基线/凭据边界），对模板使用者无意义
  'config.json', // 真实学号 + 密码
  'cookies.txt', // 抓包登录态
  'headers.txt',
  'vendor.js', // 逆向残留
  'vendor-seg.js',
  'login.html',
]);

/** 永不复制的文件名（形态匹配）。 */
const FORBIDDEN_FILE_RES = Object.freeze([
  /^main(?:\..*)?\.js$/i, // 逆向出来的主 bundle
  /\.log$/i, // 日志里全是真实房号与余额
  /^\.env(?:\.|$)/i, // 环境变量文件可能含密码
]);

// ---------------------------------------------------------------- 占位值

/**
 * 镜像里唯一允许出现的"真实值替身"。
 * 与 AGENTS.md / preflight 推荐的占位约定保持一致。
 */
const PLACEHOLDER = Object.freeze({
  studentId: 'your_student_id',
  campus: '示例校区',
  park: '示例园',
  meter: '示例园#1#A101',
  room: 'A101',
  userInfoId: '12345678',
  meterSerial: '123456789012',
  password: 'your_password',
  ntfyTopic: 'your-ntfy-topic',
});

/** 已经是占位/示例形态的值：脱敏时原样保留（否则会把示例也改掉，越改越乱）。 */
const EXAMPLE_MARK_RE = /(?:示例|测试|某|占位|your_)/;

/** 与 preflight 的 scan() 完全一致：匹配到这些片段的疑似值算"已经是占位"。 */
const PLACEHOLDER_SAFE_RE = /你的|xxx|XXXX|example|placeholder|\$\{/;

/** preflight 的行内豁免标记（文档里确实需要写出反例时用）。 */
const IGNORE_MARK = 'preflight-ignore';

/**
 * 扫描时豁免的文件：它就是规则定义本身。
 *
 * 规则文本必须写出"要抓什么"（园区名、密码形态），所以它必然命中自己——
 * preflight 的 ALLOWLIST 也是这么处理的。除此之外不设任何文件级豁免。
 */
// 自检豁免：检测器本体必须含真实形态串（见 SELF_EXEMPT 的说明）。
// 这里刻意复用同一个集合，避免两处名单漂移——漂移的后果是"复制时脱敏了、
// 自检却豁免了"，两边都以为自己是对的。
const SCAN_SELF_EXEMPT = SELF_EXEMPT;

// ---------------------------------------------------------------- 脱敏规则

/** 电表号「园区#楼号#房号」；全角井号一并处理。 */
const METER_RE = /[\u4e00-\u9fa5]{1,6}(?:#|＃)\d{1,2}(?:#|＃)[A-Z]\d{2,4}/g;

/** 房号：区字母 + 2~3 位数字（A316 / B102 之类）。占位值 A101 单独放行。 */
// 前面允许是数字（园区楼号与房号常粘连，如「示例园1A316」），
// 但不允许字母/下划线——否则会误伤 METER_A316、varA316 这类标识符。
const ROOM_RE = /(?<![A-Za-z_])A\d{2,3}(?![0-9A-Za-z_])/g;

/** userInfoId 的值（8 位上下，12345678 是约定占位）。只认紧跟在键名后的数字。 */
const UID_RE = /(userInfoId["'`\s:=,]{0,6})(\d{7,9})/g;

/**
 * 会话凭据所在的整行。
 * 只认"值本身就是凭据"的形态：`this.sessionToken = opts.state.sessionToken || ''`
 * 这类代码行必须保留，否则镜像里的代码会缺胳膊少腿。
 */
const SESSION_LINE_RES = Object.freeze([
  /SESSION=[A-Za-z0-9+/=]{16,}/, // cookie 头
  /["'`]?sessionToken["'`]?\s*[:=]\s*["'][^"']{8,}["']/, // 字面量 token
  /(?:[?&]|\b)session=[A-Za-z0-9+/=_.-]{16,}/i, // query / 环境变量里的会话
]);

// ---------------------------------------------------------------- 其它常量

/** 超过这个大小的文件按二进制处理（不脱敏，也就不会被误伤）。 */
const TEXT_MAX_BYTES = 4 * 1024 * 1024;

/** 自检时的读取上限；与脱敏上限解耦，保证大文件也会被扫到。 */
const SCAN_MAX_BYTES = 8 * 1024 * 1024;

/** docs/charts 下的图一律换成占位图，不复制真实余额曲线。 */
const CHART_SVG_RE = /^docs\/charts\/[^/]+\.svg$/i;

/**
 * docs/images 下的截图不进镜像。
 *
 * 两个原因：
 *  1. 截图是**二进制**，redactText 只处理文本，二进制走"原样复制"分支，
 *     截图里的真实园区名、房号、ntfy topic 会一字不落地进公开镜像，
 *     而自检扫的也是文本，发现不了。
 *  2. 用户明确要求：公开仓库里**直接不显示这张图**，不要换成占位图——
 *     占位图没有信息量，反而占版面。
 *
 * 所以：文件不复制，README 里的引用连同它所在的整段一起删掉。
 */
const README_IMAGE_RE = /^docs\/images\/[^/]+\.(?:jpe?g|png|gif|webp)$/i;

/** README 里引用这些图片的行（HTML <img> 与 Markdown ![]() 两种写法）。 */
const README_IMAGE_LINE_RE = new RegExp(
  '^.*(?:<img\\b[^>]*docs/images/[^>]*>|!\\[[^\\]]*\\]\\(docs/images/[^)]*\\)).*$',
  'gim',
);

const CHART_PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320" role="img" aria-label="示例图">
  <rect width="640" height="320" fill="#e5e7eb"/>
  <text x="320" y="150" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#6b7280">示例图</text>
  <text x="320" y="190" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#9ca3af">部署后自动生成</text>
</svg>
`;

/** config.example.json 里必须换成占位值的键（无论源文件是否已有）。 */
const CONFIG_FORCED_PLACEHOLDERS = Object.freeze([
  ['account.username', PLACEHOLDER.studentId],
  ['account.password', PLACEHOLDER.password],
  ['meter.custRechNo', PLACEHOLDER.meter],
  ['meter.userInfoId', Number(PLACEHOLDER.userInfoId)],
  ['alert.notify.ntfy.topic', PLACEHOLDER.ntfyTopic],
]);

/** 通知渠道凭据：源文件里非空才替换，保留"这个渠道留空"的示例形状。 */
const CONFIG_SECRET_PLACEHOLDERS = Object.freeze([
  ['alert.notify.webhook', 'your-webhook'],
  ['alert.notify.pushplus.token', 'your-pushplus-token'],
  ['alert.notify.pushplus.topic', 'your-pushplus-topic'],
  ['alert.notify.serverchan.sendkey', 'your-serverchan-sendkey'],
  ['alert.notify.wecom.webhook', 'your-wecom-webhook'],
  ['alert.notify.bark.url', 'your-bark-url'],
  ['alert.notify.telegram.token', 'your-telegram-token'],
  ['alert.notify.telegram.chatId', 'your-telegram-chat-id'],
]);

// ---------------------------------------------------------------- 小工具

const toPosix = (p) => p.split(path.sep).join('/');

const ruleCache = new Map();

/**
 * 按名字取 preflight 的规则。
 * 名字对不上就抛错——静默降级会让"脱敏少了一条"变成没人知道的事故。
 */
function pickRule(name) {
  if (!ruleCache.has(name)) {
    const rule = RULES.find((r) => r.name === name);
    if (!rule) throw new Error(`preflight 里找不到规则「${name}」，build-mirror 的脱敏依赖它`);
    ruleCache.set(name, rule);
  }
  return ruleCache.get(name);
}

function isForbiddenDir(name) {
  return FORBIDDEN_DIRS.includes(name);
}

function isForbiddenFile(name) {
  if (FORBIDDEN_FILES.includes(name)) return true;
  return FORBIDDEN_FILE_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(name);
  });
}

function isBinary(buf) {
  return buf.includes(0);
}

/** 严格 UTF-8 解码；解不开（含非法字节序列）返回 null，调用方按二进制处理。 */
function decodeUtf8Strict(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** 把匹配到的前缀原样留下，只替换 12 位数字本体。 */
function keepPrefix(match, bodyLength) {
  return match.length > bodyLength ? match.slice(0, match.length - bodyLength) : '';
}

// ---------------------------------------------------------------- 脱敏

/**
 * 对一段文本做全部脱敏替换。
 *
 * 顺序有意义：先把 12 位学号换成占位（否则它会被"12 位序列号"规则再抓一次），
 * 再处理园区名（它可能出现在电表号里），最后才是房号——
 * 房号规则最宽，必须放在最后，避免把占位符里的 A101 又拆开。
 *
 * @param {string} text
 * @returns {string}
 */
function redactText(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;

  // 1) 学号：12 位、20 开头（复用 preflight 的规则本体）
  out = out.replace(pickRule('学号/工号明文').pattern, PLACEHOLDER.studentId);

  // 2) 12 位电表序列号（preflight 的同名规则）。方案的表里没单列这一条，
  //    但它是自检规则的一部分：不处理就会让每次构建都自检失败。
  out = out.replace(pickRule('真实电表序列号').pattern, (m) =>
    keepPrefix(m, 12) + PLACEHOLDER.meterSerial);

  // 3) 真实园区名：…校区 → 示例校区，…园 → 示例园
  out = out.replace(pickRule('真实园区名').pattern, (m) =>
    (m.endsWith('校区') ? PLACEHOLDER.campus : PLACEHOLDER.park));

  // 4) 电表号「园区#楼号#房号」
  out = out.replace(METER_RE, (m) =>
    (m.includes(PLACEHOLDER.room) || EXAMPLE_MARK_RE.test(m) ? m : PLACEHOLDER.meter));

  // 5) 房号（A + 2~3 位数字）
  out = out.replace(ROOM_RE, (m) => (m === PLACEHOLDER.room ? m : PLACEHOLDER.room));

  // 6) userInfoId 的值
  out = out.replace(UID_RE, (m, prefix, digits) =>
    (digits === PLACEHOLDER.userInfoId ? m : prefix + PLACEHOLDER.userInfoId));

  // 7) 会话凭据：整行删除
  // 8) 被排除的内部文档：镜像里不存在这些文件，指向它们的链接必须处理掉，
  //    否则公开仓库里是死链（比没有链接更糟）。
  //
  //    处理策略：整行删除（这些行几乎都是"详见内部文档"性质的指引，
  //    删掉不影响读者理解正文）。
  out = out.replace(/^.*\]\((?:[^)]*\/)?(?:REFACTOR-PLAN\.md|AGENTS\.md|review\/[^)]*)\).*$/gm, '');
  //    注意：**不要**在这里替换行内的裸路径。
  //    测试文件里有形如"验收判据见 docs/REFACTOR-PLAN.md"的注释，
  //    替换会让该文件被判定为"已改写"从而整份跳过（见下面 test/ 分支），
  //    而它本来是可以安全进入镜像的。
  //    清掉因删行产生的连续空行
  out = out.replace(/\n{3,}/g, '\n\n');

  // 9) 文档截图：镜像里不放这些文件（见 README_IMAGE_RE），
  //    所以 README 里的引用要整段删掉，否则公开仓库里是坏链接。
  //
  //    注意顺序：先删引用行，再清理因此变空的标题。
  //    形如：
  //        ### 手机上长这样
  //        <img src="docs/images/xxx.jpg" ...>
  //    标题下有内容时保留标题；若标题下只剩空白，标题也一起删。
  out = out.replace(README_IMAGE_LINE_RE, '');
  // 清理由删除产生的"空标题 + 连续空行"（标题后紧跟空行/另一个标题）
  out = out.replace(/^#{2,6}[^\n]*\n(?:[ \t]*\n)+(?=#{2,6}|$)/gm, '');
  // 连续 3 个以上空行压成 2 个
  out = out.replace(/\n{3,}/g, '\n\n');

  return redactSessionLines(out);
}

/** 删掉"值本身就是会话凭据"的整行。 */
function redactSessionLines(text) {
  const kept = [];
  for (const line of text.split('\n')) {
    const hit = SESSION_LINE_RES.some((re) => {
      re.lastIndex = 0;
      return re.test(line);
    });
    if (!hit) kept.push(line);
  }
  return kept.join('\n');
}

// ---------------------------------------------------------------- config.example.json

function setPath(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, keyPath) {
  return keyPath.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/** 递归把所有字符串值过一遍红act。 */
function redactStringsDeep(node) {
  if (typeof node === 'string') return redactText(node);
  if (Array.isArray(node)) return node.map(redactStringsDeep);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = redactStringsDeep(v);
    return out;
  }
  return node;
}

/**
 * config.example.json 全部换成占位值。
 *
 * 用 JSON 解析而不是纯正则：示例文件的键是有语义的，按路径写占位值比
 * "把看起来像数字的都换掉"可控得多。解析失败时退化为纯文本脱敏（不炸构建）。
 */
function buildConfigExample(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return redactText(text);

  for (const [keyPath, value] of CONFIG_FORCED_PLACEHOLDERS) setPath(obj, keyPath, value);
  for (const [keyPath, value] of CONFIG_SECRET_PLACEHOLDERS) {
    const cur = getPath(obj, keyPath);
    if (typeof cur === 'string' && cur.trim() !== '') setPath(obj, keyPath, value);
  }

  // 兜底：示例文件里任何漏网的字符串也过一遍脱敏
  return `${JSON.stringify(redactStringsDeep(obj), null, 2)}\n`;
}

// ---------------------------------------------------------------- 输出目录安全

/**
 * 清空 out 之前必须做的检查。
 *
 * 这个函数存在的唯一理由是"误敲一个 --out 就删库"：构建器第一件事是
 * `rm -rf out`，所以任何和主仓/磁盘根/当前目录重叠的目标都要直接拒绝。
 */
function assertSafeOut(src, out) {
  const srcAbs = path.resolve(src);
  const outAbs = path.resolve(out);
  const root = path.parse(outAbs).root;

  if (outAbs === root) throw new Error(`拒绝清空磁盘根目录：${outAbs}`);
  if (outAbs === srcAbs) throw new Error(`拒绝把主仓本身当作输出目录：${outAbs}`);
  if (srcAbs.startsWith(outAbs + path.sep)) {
    throw new Error(`输出目录不能是主仓的祖先（会连同主仓一起删掉）：${outAbs}`);
  }
  if (outAbs === path.resolve(os.homedir())) throw new Error(`拒绝清空用户主目录：${outAbs}`);
  if (outAbs === path.resolve(process.cwd())) throw new Error(`拒绝清空当前工作目录：${outAbs}`);
  if (fs.existsSync(outAbs) && !fs.statSync(outAbs).isDirectory()) {
    throw new Error(`输出路径已存在且不是目录：${outAbs}`);
  }
}

// ---------------------------------------------------------------- 目录树工具

/** 递归列出目录下的普通文件（相对路径，posix 分隔，已排序）。 */
function listTree(root) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/**
 * 对**任意目录树**跑 preflight 的规则。
 *
 * 与 preflight.scan() 的判据逐条对齐（行内豁免、占位放行、examples 放行），
 * 区别只有两处，都是因为扫描对象变了：
 *   - 文件列表来自目录遍历，而不是 git；
 *   - 只豁免 scripts/preflight.js（规则本体，见 SCAN_SELF_EXEMPT）。
 *
 * @param {string} root 待扫描目录
 * @returns {{files:number, findings:Array<{file:string,line:number,rule:string,text:string,hint:string}>}}
 */
function scanTree(root) {
  const absRoot = path.resolve(root);
  const files = listTree(absRoot);
  const findings = [];

  for (const rel of files) {
    if (SCAN_SELF_EXEMPT.has(rel)) continue;
    const abs = path.join(absRoot, ...rel.split('/'));
    let text;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > SCAN_MAX_BYTES) continue;
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) continue;
      text = decodeUtf8Strict(buf);
    } catch {
      continue;
    }
    if (text === null) continue;

    const lines = text.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.includes(IGNORE_MARK)) continue;
        rule.pattern.lastIndex = 0;
        for (const m of line.matchAll(rule.pattern)) {
          if (PLACEHOLDER_SAFE_RE.test(m[0])) continue;
          if (rule.examples) {
            rule.examples.lastIndex = 0;
            if (rule.examples.test(m[0])) continue;
          }
          findings.push({
            file: rel,
            line: i + 1,
            rule: rule.name,
            text: m[0],
            hint: rule.hint,
          });
        }
      }
    }
  }

  return { files: files.length, findings };
}

// ---------------------------------------------------------------- 构建

/**
 * 从主仓生成一份可公开的镜像目录树。
 *
 * @param {object} opts
 * @param {string} opts.src   主仓根目录
 * @param {string} opts.out   输出目录（先清空）
 * @returns {{copied:string[], skipped:string[], findings:Array, scanned:number}}
 */
function buildMirror(opts = {}) {
  const srcAbs = path.resolve(opts.src || path.join(__dirname, '..'));
  if (!opts.out) throw new Error('缺少输出目录 out');
  const outAbs = path.resolve(opts.out);

  assertSafeOut(srcAbs, outAbs);
  if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) {
    throw new Error(`源目录不存在或不是目录：${srcAbs}`);
  }

  fs.rmSync(outAbs, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(outAbs, { recursive: true });

  const copied = [];
  const skipped = [];

  const writeFile = (rel, data) => {
    const dest = path.join(outAbs, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  };

  const handleFile = (rel, abs) => {
    const buf = fs.readFileSync(abs);

    // 趋势图：不复制真实版本，写中性占位图（文件名保持一致，README 引用不会断）
    if (CHART_SVG_RE.test(rel)) {
      writeFile(rel, Buffer.from(CHART_PLACEHOLDER, 'utf8'));
      copied.push(rel);
      return;
    }

    // 文档截图：二进制无法脱敏，且用户要求公开仓库直接不显示，
    // 所以整个文件都不进镜像（不写占位图）。
    if (README_IMAGE_RE.test(rel)) {
      skipped.push(rel);
      return;
    }

    // 示例配置：按语义换占位值（比纯正则可靠）
    if (rel === 'config.example.json') {
      writeFile(rel, Buffer.from(buildConfigExample(buf.toString('utf8')), 'utf8'));
      copied.push(rel);
      return;
    }

    if (buf.length > TEXT_MAX_BYTES || isBinary(buf)) {
      writeFile(rel, buf); // 二进制原样复制
      copied.push(rel);
      return;
    }

    const text = decodeUtf8Strict(buf);
    if (text === null) {
      writeFile(rel, buf); // 非法 UTF-8：当作二进制，别冒写坏的风险
      copied.push(rel);
      return;
    }

    const redacted = redactText(text);
    if (redacted === text) {
      writeFile(rel, buf); // 没有命中：逐字节保留，镜像里的换行/编码与主仓一致
      copied.push(rel);
      return;
    }

    // **检测器本身例外**：scripts/preflight.js 与 build-mirror.js 里必须写出
    // 真实形态的串（园区名、电表号模式）才能做检测。把它们的模式改掉，
    // 镜像里的检测器就失效了——那比"镜像里出现园区名"严重得多，
    // 因为读者会以为那套检测还在工作。
    // 处理方式：原样复制，但在自检阶段**豁免**这两个文件（见 SELF_EXEMPT）。
    if (SELF_EXEMPT.has(rel)) {
      writeFile(rel, buf);
      copied.push(rel);
      return;
    }

    // 测试夹具被改写会破坏断言语义：整份跳过，交给 skipped 报告
    if (rel.startsWith('test/')) {
      skipped.push(rel);
      return;
    }

    writeFile(rel, Buffer.from(redacted, 'utf8'));
    copied.push(rel);
  };

  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);

      // 输出目录落在主仓里时（--out ./scripts/mirror-out）必须跳过自身，
      // 否则第二次构建会把上一次的产物当源码复制进来。
      if (abs === outAbs || abs.startsWith(outAbs + path.sep)) continue;
      if (ent.isSymbolicLink()) {
        skipped.push(rel);
        continue;
      }

      if (ent.isDirectory()) {
        if (isForbiddenDir(ent.name)) {
          skipped.push(`${rel}/`);
          continue;
        }
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (isForbiddenFile(ent.name)) {
          skipped.push(rel);
          continue;
        }
        handleFile(rel, abs);
      }
    }
  };

  for (const entry of WHITELIST) {
    const abs = path.join(srcAbs, entry);
    if (!fs.existsSync(abs) || isForbiddenFile(entry)) continue;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      skipped.push(`${entry}/`);
      continue;
    }
    if (st.isDirectory()) walk(abs, toPosix(entry));
    else if (st.isFile()) handleFile(toPosix(entry), abs);
  }

  const { files, findings } = scanTree(outAbs);
  return { copied, skipped, findings, scanned: files };
}

// ---------------------------------------------------------------- CLI

const USAGE = `用法：node scripts/build-mirror.js --src <主仓> --out <输出目录>

  --src   主仓根目录（缺省：本仓库根目录）
  --out   输出目录（必填；会被先清空）
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const m = /^--(src|out)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`不认识的参数：${arg}`);
    if (m[2] !== undefined) {
      opts[m[1]] = m[2];
    } else {
      i += 1;
      if (i >= argv.length) throw new Error(`参数 --${m[1]} 缺少值`);
      opts[m[1]] = argv[i];
    }
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}\n`);
    console.error(USAGE);
    return 1;
  }
  if (!opts.out) {
    console.error('❌ 缺少必填参数 --out\n');
    console.error(USAGE);
    return 1;
  }

  let result;
  try {
    result = buildMirror(opts);
  } catch (err) {
    console.error(`❌ 构建失败：${err.message}`);
    return 1;
  }

  const outAbs = path.resolve(opts.out);
  console.log(`镜像已生成：${outAbs}`);
  console.log(`  复制 ${result.copied.length} 个文件，跳过 ${result.skipped.length} 个`);
  if (result.skipped.length > 0) {
    console.log(`  跳过：${result.skipped.join(', ')}`);
  }

  if (result.findings.length === 0) {
    console.log(`自检：扫描 ${result.scanned} 个文件，0 命中 ✅`);
    return 0;
  }

  console.log(`自检：扫描 ${result.scanned} 个文件，${result.findings.length} 处命中 ❌\n`);
  for (const f of result.findings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    规则：${f.rule}`);
    console.log(`    内容：${f.text}`);
    console.log(`    处理：${f.hint}\n`);
  }
  return 1;
}

module.exports = {
  buildMirror,
  scanTree,
  redactText,
  buildConfigExample,
  assertSafeOut,
  PLACEHOLDER,
  WHITELIST,
  CHART_PLACEHOLDER,
  README_IMAGE_LINE_RE,
  README_IMAGE_RE,
};

if (require.main === module) {
  process.exit(main());
}
