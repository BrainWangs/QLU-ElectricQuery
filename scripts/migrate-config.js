#!/usr/bin/env node
'use strict';
/**
 * 配置迁移：v1 → v2。
 *
 * 为什么要一个脚本而不是"读的时候顺手改"：
 * `config.json` 里有真实凭据（学号、密码），是**不能丢**的文件。
 * 读时静默改写会有两个风险：
 *   1. 用户看不出发生了什么，想回退也没得退；
 *   2. 万一迁移逻辑有 bug，原始内容已经被覆盖掉，找不回来。
 * 所以迁移是**显式的一次性动作**：默认只打印差异不写盘，写之前自动留 .bak。
 *
 * 用法：
 *   node scripts/migrate-config.js --in config.json            # 只看会改什么（零写入）
 *   node scripts/migrate-config.js --in config.json --write    # 真的写（自动备份 .bak）
 *   node scripts/migrate-config.js --in config.json --out x.json --write
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config');

/** 迁移规则：每条都是 {描述, 应用(data) -> {changed, note}} */
const STEPS = [
  {
    id: 'pushHours',
    desc: '新增 schedule.pushHours（决定"推不推"，与 activeHours"查不查"分离）',
    apply(data) {
      if (!data.schedule) data.schedule = {};
      if (data.schedule.pushHours === undefined) {
        data.schedule.pushHours = [8, 22];
        return { changed: true, note: '新增 [8, 22]' };
      }
      return { changed: false, note: `已有 ${JSON.stringify(data.schedule.pushHours)}` };
    },
  },
  {
    id: 'drop-redact',
    desc: '删除 cloud.redact（主仓不再脱敏，改由 scripts/build-mirror.js 统一处理）',
    apply(data) {
      if (data.cloud && Object.prototype.hasOwnProperty.call(data.cloud, 'redact')) {
        const was = data.cloud.redact;
        delete data.cloud.redact;
        return { changed: true, note: `删除（原值 ${JSON.stringify(was)}）` };
      }
      return { changed: false, note: '不存在' };
    },
  },
  {
    id: 'dailyReport-note',
    desc: 'storage.dailyReport 语义收窄：只管"要不要日报"，"什么时候推"交给 pushHours',
    apply(data) {
      // 语义变了但值不用改；这里只做检查，避免用户以为还需要它来控制时段
      if (data.storage && data.storage.dailyReport === false) {
        return { changed: false, note: '为 false（日报已关闭）；若只是想控制时段，改 schedule.pushHours' };
      }
      return { changed: false, note: '保持默认（开启）' };
    },
  },
  {
    id: 'userInfoId-repair',
    desc: '修 meter.userInfoId 被 deepMerge 破坏成 {} 的历史故障',
    apply(data) {
      if (!data.meter) return { changed: false, note: '无 meter 段' };
      const v = data.meter.userInfoId;
      if (v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0)) {
        return { changed: false, note: v === null ? '为 null（尚未发现，属正常）' : `为 ${v}（正常）` };
      }
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        // 空对象 = 被吞掉的 null。**不能猜具体数值**，只能给出动作指引：
        // userInfoId 与账号一一对应，猜错会查到别人的电表。
        data.meter.userInfoId = null;
        return { changed: true, note: '曾被破坏为空对象，已重置为 null（下次 login 会自动重新发现）' };
      }
      return { changed: false, note: `值异常（${JSON.stringify(v)}），需人工确认` };
    },
  },
];

/** 递归收集"敏感键"的完整路径（只取键名，永不取值） */
function collectSensitiveKeys(obj, prefix = '', out = []) {
  const SENSITIVE = /password|username|token|sendkey|webhook|topic|chatId|url/i;
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (SENSITIVE.test(k)) { out.push(key); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) collectSensitiveKeys(v, key, out);
  }
  return out;
}

/** 检测配置当前版本：有 pushHours 且无 redact 视为 v2 */
function detectVersion(data) {
  const hasPush = Boolean(data.schedule && Array.isArray(data.schedule.pushHours));
  const hasRedact = Boolean(data.cloud && Object.prototype.hasOwnProperty.call(data.cloud, 'redact'));
  return hasPush && !hasRedact ? 2 : 1;
}

function migrateData(data) {
  const out = JSON.parse(JSON.stringify(data));
  const log = [];
  for (const step of STEPS) {
    const r = step.apply(out);
    log.push({ id: step.id, desc: step.desc, ...r });
  }
  return { data: out, log };
}

/** 递归比较，列出改动路径（用于 dry-run 展示） */
function diffPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const key = prefix ? `${prefix}.${k}` : k;
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    const oa = va !== null && typeof va === 'object' && !Array.isArray(va);
    const ob = vb !== null && typeof vb === 'object' && !Array.isArray(vb);
    if (oa && ob) { diffPaths(va, vb, key, out); continue; }
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ key, from: va, to: vb });
  }
  return out;
}

function main(argv) {
  const get = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inFile = get('--in') || path.join(config.__test ? path.resolve(__dirname, '..') : '.', 'config.json');
  const outFile = get('--out') || inFile;
  const write = argv.includes('--write');

  if (!fs.existsSync(inFile)) {
    console.error(`找不到配置文件: ${inFile}`);
    return 2;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  } catch (e) {
    console.error(`配置文件不是合法 JSON: ${e.message}`);
    return 2;
  }

  const from = detectVersion(raw);
  console.log(`输入: ${inFile}`);
  console.log(`检测到版本: v${from}`);

  if (from >= 2) {
    console.log('已是 v2，无需迁移。');
    return 0;
  }

  const { data, log } = migrateData(raw);
  console.log('\n迁移步骤:');
  for (const r of log) {
    console.log(`  ${r.changed ? '✔' : '·'} ${r.id}：${r.note}`);
    console.log(`      ${r.desc}`);
  }

  const diffs = diffPaths(raw, data);
  console.log('\n实际改动:');
  if (!diffs.length) {
    console.log('  （无）');
  } else {
    for (const d of diffs) {
      // 只打印键名与"是否敏感"，**绝不打印凭据相关的值**
      const sensitive = /password|username|token|sendkey|webhook|topic|chatId|url/i.test(d.key);
      const show = v => (sensitive ? '<已隐藏>' : JSON.stringify(v));
      console.log(`  ${d.key}: ${show(d.from)} → ${show(d.to)}`);
    }
  }

  // 敏感键即使没改动也要报一句"已确认未打印"，让用户能亲眼确认
  // 迁移过程没有把他的密码/推送凭据打到终端或 CI 日志里。
  const sensitiveKeys = collectSensitiveKeys(raw);
  if (sensitiveKeys.length) {
    console.log(`\n敏感字段（${sensitiveKeys.length} 个，值一律不打印）: ${sensitiveKeys.join(', ')}`);
  }

  // 用 schema 校验迁移结果，保证迁完是合法的
  const merged = config.__test.deepMerge(config.__test.DEFAULTS, data);
  const errs = config.validateSchema(merged);
  if (errs.length) {
    console.log('\n⚠ 迁移结果未通过 schema 校验（可能需要人工补配置）:');
    for (const e of errs) console.log(`  - ${e}`);
  }

  if (!write) {
    console.log('\n[dry-run] 未写入任何文件。确认无误后加 --write 执行。');
    return 0;
  }

  // 写之前备份：迁移是不可逆的，必须留退路
  if (fs.existsSync(outFile)) {
    const bak = `${outFile}.bak`;
    fs.copyFileSync(outFile, bak);
    console.log(`\n已备份原文件 → ${bak}`);
  }
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${outFile}`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { migrateData, detectVersion, diffPaths, STEPS };
