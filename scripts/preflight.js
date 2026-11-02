#!/usr/bin/env node
// 提交前自检：把会泄露隐私/凭据的东西挡在 push 之前。
//
// 为什么需要这个：这个项目里"真实凭据"和"示例代码"挨得很近，
// 一不小心就会把学号、密码、会话 cookie 写进 README 或测试里。
// 手工 grep 靠不住，所以做成脚本 + 挂在 npm script 上。
//
// 用法：
//   node scripts/preflight.js          # 检查工作区所有会入库的文件
//   node scripts/preflight.js --staged # 只检查已 git add 的内容

'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const staged = process.argv.includes('--staged');

// 每条规则：{ name, pattern, hint }
// 注意：规则本身会出现在这个文件里，所以用拼接避免自我误报
const RULES = [
  {
    name: '学号/工号明文',
    // 12 位、以 20 开头的学号形态
    pattern: /\b20\d{10}\b/g,
    hint: '把学号换成「你的学号」或从 secrets 读',
  },
  {
    name: '密码明文',
    // 形如 @Abc123456789（@ 后跟含大写字母和数字的串）——@ 本身只是密码的一部分，
    // 不是系统要求。这条规则靠「@ + 大写 + 数字 + 长度」来区分真密码和普通注解。
    // 这样能放过 @returns / @users.noreply.github.com / @types/node 这类误报。
    // 前面不能紧跟字母数字（排除邮箱 a@B1234567.com、包名 scoped 等）。
    pattern: /(?<![\w.])@(?=[^\s"'`]*[A-Z])(?=[^\s"'`]*\d)[A-Za-z0-9!@#$%^&*_+=.-]{10,}/g,
    hint: '密码只应出现在被 gitignore 的 config.json 或环境变量里',
  },
  {
    name: '会话 cookie',
    pattern: /SESSION=[A-Za-z0-9+/=]{16,}/g,
    hint: '会话 cookie 是登录态，泄露等于账号被盗用',
  },
  {
    name: 'sessionToken',
    pattern: /sessionToken["'\s:=]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/gi,
    hint: 'sessionToken 等同于登录态',
  },
  {
    name: '私钥',
    pattern: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
    hint: '私钥绝不能入库',
  },
  {
    name: '真实宿舍号',
    // 电表号形如「园区#楼号#房号」，暴露的是具体住在哪一间。
    // 通用形态：园区名 + # 楼号 # 房号，且房号为字母+数字（排除 A101 这类示例）
    pattern: /[\u4e00-\u9fa5]{1,6}(?:#|＃)\d{1,2}(?:#|＃)[A-Z]\d{2,4}/g,
    // 学校登录页自己给的例子，出现在文档里是正常的
    examples: /A101/,
    hint: '换成占位符「示例园#1#A101」（学校登录页自己给的例子）',
  },
  {
    name: '个人 userInfoId',
    // 该 ID 与账号一一对应，配合接口可直接查余额。
    // 只报警 8 位且非 12345678 这类占位值之外的常见值——
    // 这里用「8 位数字且不等于占位符」的宽松形态，命中后人工确认。
    pattern: /(?:^|[^0-9A-Za-z_])userInfoId[^0-9A-Za-z_]{0,4}(?!12345678)[0-9]{7,9}/g,
    hint: '文档里用 12345678 之类的占位值代替',
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    hint: 'GitHub token 泄露会被滥用，立刻吊销',
  },
];

// 这些文件本来就允许含真实值（它们都在 .gitignore 里）
const ALLOWLIST = [
  'config.json',
  'data/',
  'node_modules/',
  '.git/',
  'scripts/preflight.js', // 本文件含规则定义，可能触发自身
];

// 行内豁免标记：某一行确实需要写出"像凭据"的字符串时（比如测试样本、
// 文档里的反例），在该行加这个注释即可。比排除整个文件精确得多。
const IGNORE_MARK = 'preflight-ignore';

function isAllowed(rel) {
  return ALLOWLIST.some((a) => rel === a || rel.startsWith(a));
}

/** 拿到"会入库"的文件列表。 */
function listFiles() {
  if (staged) {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', {
      cwd: ROOT, encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  }
  // 用 git ls-files 会漏掉还没 add 的新文件，所以直接遍历 + 套用 gitignore
  const out = execSync('git ls-files --cached --others --exclude-standard', {
    cwd: ROOT, encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function scan() {
  const files = listFiles().filter((f) => !isAllowed(f));
  const findings = [];

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let text;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue; // 跳过二进制/超大文件
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // 二进制

    const lines = text.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(IGNORE_MARK)) continue;
        rule.pattern.lastIndex = 0;
        // 逐条匹配：一行里可能先出现官方示例、后面跟着真实值，
        // 只看第一条匹配会漏报。
        const matches = [...line.matchAll(rule.pattern)];
        if (matches.length === 0) continue;
        for (const m of matches) {
          if (/你的|xxx|XXXX|example|placeholder|\$\{/.test(m[0])) continue;
          if (rule.examples && rule.examples.test(m[0])) continue;
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

function main() {
  const { files, findings } = scan();

  console.log(`检查了 ${files} 个待入库文件${staged ? '（仅暂存区）' : ''}`);

  if (findings.length === 0) {
    console.log('✅ 未发现敏感信息');
    return 0;
  }

  console.log(`\n❌ 发现 ${findings.length} 处疑似泄露：\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    规则：${f.rule}`);
    console.log(`    内容：${f.text}`);
    console.log(`    处理：${f.hint}\n`);
  }
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { scan, RULES };
