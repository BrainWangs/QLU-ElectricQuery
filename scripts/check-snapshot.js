#!/usr/bin/env node
// 发布前检查：确认快照里的位置信息已经打码。
//
// 为什么需要这一步：快照会被推到仓库的 data 分支。如果仓库是公开的，
// 任何人都能看到 —— 余额曲线本身没什么，但"某人住在哪一间、余额多少"
// 就是另一回事了。
//
// 脱敏是否启用由 cloud.redact 决定（环境变量 QLGYDX_REDACT）：
//   - redact = true  → 快照里房号必须是 ***，否则 CI 失败中止发布
//   - redact = false → 允许保留真实房号，本脚本只提示、不拦截
//
// 默认 false：仓库转私有后，只有自己能看到快照，保留真实房号更方便。
// 打算公开仓库时把 QLGYDX_REDACT 设为 1。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 未打码的样子：以字母+数字结尾的房间号（A101 / 101 / B102），
// 或者园区#楼号#房号里最后一段还是具体房间。
const ROOM_SUFFIX = /[.。]([A-Za-z]?\d{2,4})$/;
const METER_ROOM = /[#＃][^#＃*]{1,8}$/;

/** 返回未打码的字段列表；已打码或字段缺失都返回空数组 */
function problems(snapshot) {
  const out = [];
  const loc = snapshot.location;
  if (loc && !/\*\*\*$/.test(loc)) {
    const m = String(loc).match(ROOM_SUFFIX);
    if (m) out.push(`location 未打码：${loc}`);
  }
  const meter = snapshot.custRechNo;
  if (meter && !/\*\*\*$/.test(meter)) {
    if (METER_ROOM.test(String(meter))) out.push(`custRechNo 未打码：${meter}`);
  }
  return out;
}

function redactEnabled() {
  const v = process.env.QLGYDX_REDACT;
  return v === '1' || v === 'true';
}

function main() {
  const file = process.argv[2] || path.join(ROOT, 'data', 'latest.json');
  if (!fs.existsSync(file)) {
    console.log(`跳过：${file} 不存在（本轮没有生成快照）`);
    return 0;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`快照不是合法 JSON：${e.message}`);
    return 1;
  }

  const found = problems(snapshot);
  const strict = redactEnabled();

  if (found.length && strict) {
    console.error('❌ 已开启脱敏（QLGYDX_REDACT=1），但快照里仍有未打码的位置信息，中止发布：');
    for (const p of found) console.error(`  - ${p}`);
    return 1;
  }

  if (found.length) {
    console.log(`ℹ️  未开启脱敏（QLGYDX_REDACT 未设置），快照保留真实位置：${snapshot.location}`);
    console.log('   如果这个仓库是公开的，请设 QLGYDX_REDACT=1，否则房号会被人看到。');
    return 0;
  }

  console.log(`✅ 快照脱敏检查通过：location=${snapshot.location} custRechNo=${snapshot.custRechNo}`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { problems };
