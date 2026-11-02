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
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  const t0 = now - hours * 3600 * 1000;
  const t1 = now;

  const maxBal = niceMax(Math.max(...rows.map(r => r.balance), 0) * 1.15);
  const x = t => PAD.l + ((t - t0) / (t1 - t0)) * iw;
  const y = v => PAD.t + ih - (v / maxBal) * ih;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`);
  // 背景透明以适配暗色主题；文字用中性灰在两种主题下都可读
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
  // X 轴起止标签
  parts.push(`<text x="${PAD.l}" y="${H - 10}" font-family="sans-serif" font-size="12" fill="${COLOR_TEXT}">${esc(fmtTime(t0))}</text>`);
  parts.push(`<text x="${W - PAD.r}" y="${H - 10}" font-family="sans-serif" font-size="12" fill="${COLOR_TEXT}" text-anchor="end">${esc(fmtTime(t1))}</text>`);

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

  // 数据点 + 检测充值（上涨 = 充值，画亮绿并放大）
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isRecharge = i > 0 && r.balance > rows[i - 1].balance + 0.005;
    const rr = isRecharge ? 5 : 3;
    parts.push(`<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.balance).toFixed(1)}" r="${rr}" fill="${isRecharge ? COLOR_RECHARGE : color}"/>`);
    if (isRecharge) {
      parts.push(`<text x="${x(r.t).toFixed(1)}" y="${(y(r.balance) - 10).toFixed(1)}" font-family="sans-serif" font-size="12" fill="${COLOR_RECHARGE}" text-anchor="middle">充值</text>`);
    }
  }

  // 最新值标注
  const last = rows[rows.length - 1];
  parts.push(`<text x="${(x(last.t) - 5).toFixed(1)}" y="${(y(last.balance) - 12).toFixed(1)}" font-family="sans-serif" font-size="14" font-weight="700" fill="${color}" text-anchor="end">${last.balance.toFixed(2)} 元</text>`);

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
  // 三种时间窗用三种颜色区分
  const PALETTE = { 3: '#2563eb', 7: '#16a34a', 30: '#9333ea' };
  const warnAt = Number(get('warn', 10));
  const criticalAt = Number(get('critical', 5));
  const title = get('title', '电费余额变化');

  fs.mkdirSync(outDir, { recursive: true });
  for (const d of days) {
    const hours = d * 24;
    const rows = parseHistory(file, hours);
    const svg = renderChart(rows, {
      title: `${title}（近 ${d} 天）`, warnAt, criticalAt, hours,
      color: PALETTE[d] || COLOR_MAIN,
    });
    const fp = path.join(outDir, `chart-${d}d.svg`);
    fs.writeFileSync(fp, svg, 'utf8');
    console.log(`✅ ${fp}（${rows.length} 个样本）`);
  }
}

module.exports = { renderChart, parseHistory, niceMax };

if (require.main === module) main();
