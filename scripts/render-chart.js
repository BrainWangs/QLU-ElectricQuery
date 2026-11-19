'use strict';
/**
 * 把 history.jsonl 画成 SVG 折线图（余额随时间变化）
 *
 * 用法：
 *   node scripts/render-chart.js data/history.jsonl --out data
 *   node scripts/render-chart.js data/history.jsonl --out data --days 1,3,7
 *
 * 输出 chart-3d.svg / chart-7d.svg / chart-30d.svg（三种时间窗，三种颜色）。
 * 纯手写 SVG，无任何依赖；GitHub README 直接 <img> 引用 raw 地址即可。
 *
 * 图表设计：
 *  - X 轴 = 时间（窗口起点 → 现在），Y 轴 = 余额（元），下限 0
 *  - 余额上涨（充值）画绿色阶梯点，下降连线为蓝色主色
 *  - 低于预警阈值画一条橙色虚线参考线，低于严重阈值红色虚线
 *  - 深色模式适配：用 currentColor 描文字，背景透明
 */
const fs = require('node:fs');
const path = require('node:path');
const daily = require('../lib/daily');
const { renderHeatmap } = require('./render-heatmap');

const W = 760;          // 画布宽
const H = 380;          // 画布高（加大提升可读性）
const PAD = { l: 58, r: 18, t: 32, b: 38 }; // 内边距（留轴标签空间）
const COLOR_MAIN = '#2563eb';   // 主折线
const COLOR_RECHARGE = '#16a34a';
const COLOR_WARN = '#f59e0b';
const COLOR_CRIT = '#dc2626';
const COLOR_GRID = '#94a3b8';
const COLOR_TEXT = '#64748b';

function parseHistory(file, hours) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const cutoff = Date.now() - hours * 3600 * 1000;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const t = Date.parse(r.queriedAt);
      if (Number.isFinite(t) && Number.isFinite(r.balance) && t >= cutoff) {
        out.push({ t, balance: r.balance, custRechNo: r.custRechNo || '' });
      }
    } catch { /* skip */ }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Y 轴刻度：给好 max，返回 {max, ticks[]}，保证 max 至少是 5 的倍数 */
function niceMax(maxVal) {
  if (!(maxVal > 0)) maxVal = 5;
  const pow = Math.pow(10, Math.floor(Math.log10(maxVal)));
  const candidates = [pow, 2 * pow, 2.5 * pow, 5 * pow, 10 * pow];
  for (const c of candidates) if (c >= maxVal) return c;
  return 10 * pow;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  // 北京时间短标签。runner 是 UTC 时区，直接 getHours() 会错 8 小时。
  return require('../lib/time').beijingLabel(new Date(ts));
}

/**
 * 生成一张折线图 SVG
 * @param {Array<{t:number,balance:number}>} rows
 * @param {object} o {title, warnAt, criticalAt, hours, color}
 */
function renderChart(rows, o) {
  const { title, warnAt, criticalAt, hours, color = COLOR_MAIN } = o;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const now = Date.now();
  // X 轴范围：优先用数据的实际时间跨度（左右各留 5% padding），
  // 否则当历史只有几小时而窗口是 7/30 天时，全部点会挤在最右边一条缝里
  const dataMin = rows.length ? Math.min(...rows.map(r => r.t)) : now - hours * 3600 * 1000;
  const dataMax = rows.length ? Math.max(...rows.map(r => r.t)) : now;
  const span = Math.max(dataMax - dataMin, 30 * 60 * 1000); // 至少半小时，防除零
  const t0 = dataMin - span * 0.05;
  const t1 = dataMax + span * 0.05;

  const maxBal = niceMax(Math.max(...rows.map(r => r.balance), 0) * 1.15);
  const x = t => PAD.l + ((t - t0) / (t1 - t0)) * iw;
  const y = v => PAD.t + ih - (v / maxBal) * ih;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`);
  // **纯白不透明背景**：GitHub 深色模式下若背景透明，浅色文字会糊在深色底上。
  // 固定白底 + 深色文字，两种主题下都可读（用户明确要求）。
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<title>${esc(title)}</title>`);
  parts.push(`<text x="${PAD.l}" y="20" font-family="sans-serif" font-size="15" fill="${COLOR_TEXT}" font-weight="600">${esc(title)}</text>`);

  // Y 轴网格 + 刻度
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxBal / yTicks) * i;
    const yy = y(v);
    parts.push(`<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" stroke="${COLOR_GRID}" stroke-opacity="0.25" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.l - 7}" y="${yy + 4}" font-family="sans-serif" font-size="12" fill="${COLOR_TEXT}" text-anchor="end">${v % 1 === 0 ? v : v.toFixed(1)}</text>`);
  }
  // X 轴时间描点：按窗口宽度取合适数量（4~6 个）的均匀刻度，
  // 每个都带竖向参考网格线，方便对齐读数
  const tickCount = Math.min(6, Math.max(3, Math.round((t1 - t0) / 3600e3 / 4)));
  const tickStep = (t1 - t0) / tickCount;
  for (let i = 0; i <= tickCount; i++) {
    const tt = t0 + tickStep * i;
    const xx = x(tt);
    parts.push(`<line x1="${xx.toFixed(1)}" y1="${PAD.t}" x2="${xx.toFixed(1)}" y2="${PAD.t + ih}" stroke="${COLOR_GRID}" stroke-opacity="0.18" stroke-width="1"/>`);
    parts.push(`<text x="${xx.toFixed(1)}" y="${H - 10}" font-family="sans-serif" font-size="12" fill="${COLOR_TEXT}" text-anchor="middle">${esc(fmtTime(tt))}</text>`);
  }

  // 阈值参考线
  if (criticalAt > 0 && criticalAt < maxBal) {
    const yy = y(criticalAt);
    parts.push(`<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" stroke="${COLOR_CRIT}" stroke-opacity="0.6" stroke-width="1" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${W - PAD.r}" y="${yy - 5}" font-family="sans-serif" font-size="12" fill="${COLOR_CRIT}" text-anchor="end">告急 ${criticalAt} 元</text>`);
  }
  if (warnAt > 0 && warnAt < maxBal) {
    const yy = y(warnAt);
    parts.push(`<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" stroke="${COLOR_WARN}" stroke-opacity="0.6" stroke-width="1" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${W - PAD.r}" y="${yy - 5}" font-family="sans-serif" font-size="12" fill="${COLOR_WARN}" text-anchor="end">预警 ${warnAt} 元</text>`);
  }

  if (rows.length === 0) {
    parts.push(`<text x="${PAD.l + iw / 2}" y="${PAD.t + ih / 2}" font-family="sans-serif" font-size="14" fill="${COLOR_TEXT}" text-anchor="middle">暂无数据（等下一次定时查询积累样本）</text>`);
    parts.push('</svg>');
    return parts.join('\n');
  }

  // 主折线
  const pts = rows.map(r => `${x(r.t).toFixed(1)},${y(r.balance).toFixed(1)}`).join(' ');
  parts.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);

  // 数据点 + 数值标注 + 检测充值
  //
  // 数据已按天去重（一天一个点），所以不需要再做"密度间隔标注 / 上下错行避让"。
  // 30 天最多 30 个点，横向空间足够每个点都标出数值。
  const n = rows.length;
  // 点数多时略缩字号，保证 30 天刻度不挤在一起
  const fontSize = n > 20 ? 10 : n > 12 ? 11 : 12;
  for (let i = 0; i < n; i += 1) {
    const r = rows[i];
    const isRecharge = i > 0 && r.balance > rows[i - 1].balance + 0.005;
    parts.push(`<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.balance).toFixed(1)}" r="${isRecharge ? 5 : 3.5}" fill="${isRecharge ? COLOR_RECHARGE : color}"/>`);

    const px = x(r.t).toFixed(1);
    const py = Number(y(r.balance).toFixed(1));

    if (isRecharge) {
      // 充值点单独标"充值 N"，比标余额更有信息量
      const amount = (r.balance - rows[i - 1].balance).toFixed(2);
      parts.push(`<text x="${px}" y="${(py - 9).toFixed(1)}" font-family="sans-serif" font-size="${fontSize}" fill="${COLOR_RECHARGE}" text-anchor="middle" font-weight="700">+${amount}</text>`);
    } else {
      // 最后一个点单独用大字号标注，这里跳过避免重复
      if (i === n - 1) continue;
      // 与最后一个点水平距离太近时也跳过：最后那个标注字号更大、向右展开，
      // 两者会撞在一起（按天去重后相邻点的 x 间距可能只有二三十像素）。
      const gapToLast = Math.abs(x(rows[n - 1].t) - x(r.t));
      if (i === n - 2 && gapToLast < 60) continue;
      parts.push(`<text x="${px}" y="${(py - 9).toFixed(1)}" font-family="sans-serif" font-size="${fontSize}" fill="${color}" text-anchor="middle" font-weight="600">${r.balance.toFixed(2)}</text>`);
    }
  }

  // 最新值标注（加粗放大，始终显示）
  //
  // 定位要点：必须**向右**展开（text-anchor=start）并上移。
  // 原来用 anchor=end 向左展开，会正好压住倒数第二个点的数值——
  // 因为按天去重后每天只有一个点，相邻两天的 x 距离很小。
  const last = rows[rows.length - 1];
  const lastX = x(last.t);
  const lastY = y(last.balance);
  // 越靠右越容易被画布右边缘截断，所以靠边时改为向左展开
  const nearRight = lastX > W - PAD.r - 70;
  parts.push(`<text x="${(nearRight ? lastX - 8 : lastX + 8).toFixed(1)}" y="${(lastY - 12).toFixed(1)}" font-family="sans-serif" font-size="14" font-weight="700" fill="${color}" text-anchor="${nearRight ? 'end' : 'start'}">${last.balance.toFixed(2)} 元</text>`);
  // 倒数第二个点的标注已经由上面的循环画过；若它与最新值挨得太近，就近裁掉
  // （在循环里做更复杂，这里简单地把最新值抬高到不会撞的位置）

  parts.push('</svg>');
  return parts.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    console.error('用法: node scripts/render-chart.js <history.jsonl> --out <dir> [--days 1,3,7] [--warn 10] [--critical 5] [--title xxx]');
    process.exit(1);
  }
  const get = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const outDir = get('out', '.');
  const days = get('days', '3,7,30').split(',').map(s => Number(s.trim())).filter(n => n > 0);
  // 统一蓝色（用户要求三张图同色）
  const PALETTE = {};
  const warnAt = Number(get('warn', 10));
  const criticalAt = Number(get('critical', 5));
  const title = get('title', '电费余额变化');

  fs.mkdirSync(outDir, { recursive: true });
  for (const d of days) {
    const hours = d * 24;
    const raw = parseHistory(file, hours);
    // **按天去重**：上游每天只更新一次余额，同一天内多次查询值完全相同。
    // 不去重的话点会在同一水平线上重合，数值标注也互相压住。
    // 只保留每天最后一次，一天一个点。
    const rows = daily.dailyLast(raw);
    const svg = renderChart(rows, {
      title: `${title}（近 ${d} 天）`, warnAt, criticalAt, hours,
      color: PALETTE[d] || COLOR_MAIN,
    });
    const fp = path.join(outDir, `chart-${d}d.svg`);
    fs.writeFileSync(fp, svg, 'utf8');
    console.log(`✅ ${fp}（${raw.length} 个样本 → ${rows.length} 天，每天取最后一次）`);
  }

  // 热力图：最近 30 天每日消耗。独立于上面的时间窗循环，只生成一张。
  // 用**全部历史**（不按 hours 截断）算日消耗，否则窗口边缘那天的
  // "前一天日末余额"会缺失，第一天永远是 null。
  const allRows = parseHistory(file, 24 * 400);
  const heatDays = daily.dailyConsumption(allRows, { days: 30 });
  const heatSvg = renderHeatmap(heatDays, { title: '每日电费消耗（近 30 天）' });
  const heatFp = path.join(outDir, 'heatmap.svg');
  fs.writeFileSync(heatFp, heatSvg, 'utf8');
  const withData = heatDays.filter(x => x.consumed !== null).length;
  console.log(`✅ ${heatFp}（${withData}/${heatDays.length} 天有数据）`);
}

module.exports = { renderChart, parseHistory, niceMax };

if (require.main === module) main();
