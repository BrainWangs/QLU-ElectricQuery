'use strict';
/**
 * 生成"最近 N 天每日消耗"热力图 SVG。
 *
 * 设计要点（每条都有原因）：
 *
 *  1. **纯白不透明背景**。GitHub 深色模式下若背景透明，浅色文字会糊在深色底上。
 *     同折线图，用户明确要求。
 *
 *  2. **分度值自适应**。每天消耗从 0.5 元到 10 元都可能出现，
 *     写死「<2 浅绿 / <5 中绿 / >5 深绿」在用电少的一周会全是最浅色，
 *     用电多的那周会全是深色——都看不出差异。
 *     改为按**当窗口内的实际分位数**分档（见 buildScale）。
 *
 *  3. **null 与 0 视觉上必须可区分**。
 *     上游每天只更新一次，某些天可能一条样本都没有 → 那天消耗算不出来。
 *     如果和"消耗 0 元"画成同一种颜色，用户会以为那天没用电。
 *     所以 null 用灰色底 + 斜线纹理，0 用最浅的实色。
 *
 *  4. **表格布局而非日历对齐**。30 天排成 5 行 × 6 列（或 6×5），
 *     比"按周对齐的日历"更省空间，也更适合嵌在 README 里。
 */

const CELL = 51;          // 单元格边长（1.5 倍：34→51）
const GAP = 6;            // 格子间距（1.5 倍：4→6）
const COLS = 6;           // 每行几个（30 天 = 5 行）
const PAD = 21;           // 画布内边距（1.5 倍：14→21）
const TITLE_H = 39;       // 标题占高（1.5 倍：26→39）
const LEGEND_H = 78;      // 图例 + 刻度说明占高（1.5 倍：52→78）

// 分档配色：从"几乎没用"到"用得多"。用同一色相的深浅，避免认知负担。
const SCALE_COLORS = ['#f0fdf4', '#bbf7d0', '#4ade80', '#16a34a', '#15803d'];
const COLOR_NULL = '#e5e7eb';       // 无数据：灰
const COLOR_RECHARGE = '#93c5fd';   // 当天净充值：浅蓝（与消耗的绿区分）
const COLOR_TEXT = '#334155';
const COLOR_SUB = '#64748b';
const COLOR_BORDER = '#ffffff';

/**
 * 把每天消耗量化成 0..levels-1 的档位。
 *
 * ## 为什么用分位数而不是线性等分
 *
 * 线性等分（max/levels）在真实数据上区分度很差：
 * 实测某窗口最大值 6.4 元，而绝大多数日子在 3.4~4.6 元之间，
 * 于是它们**全部落进同一档**，热力图看起来一片同色，看不出哪天用得多。
 *
 * 分位数让每档装同样多的天，无论分布集中还是分散，颜色都能拉开差异。
 *
 * ## 实现上的两个坑（都实测踩过）
 *
 * 1. **最小值会被挤掉**。若把分位点当第 0 档下界、再覆盖成 0，
 *    最小的两三个值会一起落进第 0 档。所以第 0 档下界直接取 0，
 *    其余档从第 1 档开始取分位点。
 *
 * 2. **最大值会和次大值同档**。当正消耗天数恰好等于档数时，
 *    最后一个分位点等于最大值，于是最大值落不进"最高档"。
 *    这里用"最高档下界 = 次高分位点"的方式绕开：只要边界严格小于最大值，
 *    最大值自然落进最高档。
 *
 * 分位数在样本太少时没有意义（3 个点分 5 档），此时退化为线性等分。
 *
 * @param {Array<{day:string, consumed:number|null}>} days
 * @param {number} [levels] 档位数，默认 5
 * @returns {{levels:number, max:number, min:number, thresholds:number[],
 *            method:'quantile'|'linear', levelOf:(v:number|null)=>number}}
 */
function buildScale(days, levels = 5) {
  const vals = days
    .map(d => d.consumed)
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
    .sort((x, y) => x - y);

  const max = vals.length ? vals[vals.length - 1] : 0;
  const min = vals.length ? vals[0] : 0;

  /**
   * 统一的档位判定：
   *   null / 非有限数 → -1（无数据，画灰色斜线）
   *   负值           → -2（当天净充值，画蓝色）
   *   0              →  0（真的没用电，最浅色）
   *   正值           →  按 thresholds 落档
   */
  const makeLevelOf = (thresholds) => (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return -1;
    if (v < 0) return -2;
    if (v === 0) return 0;
    for (let i = levels - 1; i >= 1; i -= 1) {
      if (v >= thresholds[i]) return i;
    }
    return 0;
  };

  // ---- 退化情形：样本太少、或所有值相同 ----
  // 分位数在"3 个点分 5 档"时会产生空档，颜色反而聚在一起，不如线性等分。
  if (vals.length < levels || max === min) {
    // 所有正消耗都相同时，不该硬塞进最高档（那样看起来"每天都用很多"）。
    // 此时无法区分高低，统一放进最低档，语义是"有消耗但无差异"。
    if (max === min && max > 0) {
      const thresholds = [];
      for (let i = 0; i < levels; i += 1) {
        thresholds.push(Number((max * (i / levels)).toFixed(2)));
      }
      thresholds[0] = 0;
      return { levels, max, min, thresholds, method: 'linear', levelOf: (v) => {
        if (v === null || v === undefined || !Number.isFinite(v)) return -1;
        if (v < 0) return -2;
        return 0;   // 值全相同 → 全部同一档
      } };
    }
    const upper = max > 0 ? max : 1;
    const thresholds = [];
    for (let i = 0; i < levels; i += 1) {
      thresholds.push(Number(((upper / levels) * i).toFixed(2)));
    }
    return { levels, max: upper, min, thresholds, method: 'linear', levelOf: makeLevelOf(thresholds) };
  }

  // ---- 分位数分档 ----
  // thresholds[0] = 0（含 0 与所有小于第 1 分位点的正值）
  // thresholds[i] = 第 (i/levels) 分位的值，i >= 1
  //
  // 关键：最高档的下界取 **倒数第二个分位点**，
  // 这样最大值严格大于它，必然落进最高档。
  const thresholds = [0];
  for (let i = 1; i < levels; i += 1) {
    // 第 i 档的下界：取 (i/levels) 分位
    const idx = Math.min(vals.length - 1, Math.floor((vals.length * i) / levels));
    thresholds.push(Number(vals[idx].toFixed(2)));
  }

  // 保证严格递增（分位点可能因取整而相等）
  for (let i = 1; i < levels; i += 1) {
    if (thresholds[i] <= thresholds[i - 1]) {
      thresholds[i] = Number((thresholds[i - 1] + 0.01).toFixed(2));
    }
  }

  // 最高档的下界：取"严格小于最大值的那个值"，保证最大值独占最高档。
  // 直接用分位点会踩到"最大值与次大值同档"（6 个点分 5 档时 5 和 6 同档）。
  const secondMax = vals.length >= 2 ? vals[vals.length - 2] : max;
  thresholds[levels - 1] = Number(
    Math.max(
      Math.min(secondMax, max - 0.01),
      thresholds[levels - 2] + 0.01,
    ).toFixed(2),
  );

  return { levels, max, min, thresholds, method: 'quantile', levelOf: makeLevelOf(thresholds) };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 渲染热力图。
 *
 * @param {Array<{day:string, consumed:number|null, samples:number}>} days 按日期升序
 * @param {{title?:string}} [opts]
 * @returns {string} SVG
 */
function renderHeatmap(days, opts = {}) {
  const title = opts.title || '每日电费消耗（近 30 天）';
  const list = Array.isArray(days) ? days : [];
  const scale = buildScale(list);

  const rows = Math.max(1, Math.ceil(list.length / COLS));
  const gridW = COLS * CELL + (COLS - 1) * GAP;
  const gridH = rows * CELL + (rows - 1) * GAP;

  // 画布宽度取"网格宽度"与"图例所需宽度"的较大者。
  // 只按网格算的话，图例（少 + 5档 + 充值 + 无数据）会被右边缘裁掉。
  // 图例共 4 项：少+5档+多 / 充值 / 无数据。
  // 按最长组合预留：16+5*(SW+2)+16 + 12 + (SW+4+24) + 12 + (SW+4+36) + PAD
  const SWW = Math.round(CELL * 0.6);
  const legendMinW = PAD + 24 + scale.levels * (SWW + 3) + 24 + 18 + (SWW + 6 + 36) + 18 + (SWW + 6 + 54) + PAD;
  const W = Math.max(gridW + PAD * 2, legendMinW);
  const H = TITLE_H + gridH + LEGEND_H + PAD * 2;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`);
  parts.push(`<title>${esc(title)}</title>`);
  // 纯白不透明背景
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="${PAD}" y="${PAD + 22}" font-family="sans-serif" font-size="21" font-weight="600" fill="${COLOR_TEXT}">${esc(title)}</text>`);

  const top = TITLE_H + PAD;

  for (let i = 0; i < list.length; i += 1) {
    const d = list[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cx = PAD + col * (CELL + GAP);
    const cy = top + row * (CELL + GAP);
    const lv = scale.levelOf(d.consumed);

    const fill = lv === -2 ? COLOR_RECHARGE : (lv < 0 ? COLOR_NULL : SCALE_COLORS[lv]);
    parts.push(`<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="6" fill="${fill}" stroke="${COLOR_BORDER}" stroke-width="1"/>`);

    // 无数据的格子加一道斜线，与"消耗 0"明确区分
    if (lv === -1) {
      parts.push(`<line x1="${cx + 6}" y1="${cy + CELL - 6}" x2="${cx + CELL - 6}" y2="${cy + 6}" stroke="#9ca3af" stroke-width="1" stroke-opacity="0.5"/>`);
    }

    // 日期（月/日）放在格子上方，消耗数值放在下方
    const [, mm, dd] = d.day.split('-');
    const label = `${Number(mm)}/${Number(dd)}`;
    // 深色格子上的文字要用白色才看得清
    const onDark = lv >= 3;
    const textColor = onDark ? '#ffffff' : COLOR_TEXT;
    parts.push(`<text x="${cx + CELL / 2}" y="${cy + 19}" font-family="sans-serif" font-size="13.5" fill="${textColor}" text-anchor="middle" opacity="0.85">${label}</text>`);
    const valText = d.consumed === null ? '—'
      : d.consumed > 0 ? d.consumed.toFixed(1)
        : d.consumed < 0 ? `+${Math.abs(d.consumed).toFixed(1)}`
          : '0';
    parts.push(`<text x="${cx + CELL / 2}" y="${cy + 39}" font-family="sans-serif" font-size="15" font-weight="600" fill="${textColor}" text-anchor="middle">${valText}</text>`);
  }

  // 图例：少 ▢▢▢▢▢ 多 | ▢充值 | ▢无数据
  //
  // 用**游标推进**而不是手工偏移：每画完一项就 lx += 该项宽度。
  // 之前是手工写"lx += 16 / +42"这种魔法数，一旦某项文字变长就压住下一项。
  const legendY = top + gridH + 21;
  const SW = Math.round(CELL * 0.6);   // 色块宽
  const ITEM_GAP = 18;                  // 项目之间的间距
  const TEXT_SIZE = 15;
  let lx = PAD;

  parts.push(`<text x="${lx}" y="${legendY + 17}" font-family="sans-serif" font-size="${TEXT_SIZE}" fill="${COLOR_SUB}">少</text>`);
  lx += 18;                             // "少"字宽度（15px 汉字）

  // 5 档色块，紧挨着排
  for (let i = 0; i < scale.levels; i += 1) {
    parts.push(`<rect x="${lx}" y="${legendY}" width="${SW}" height="21" rx="3" fill="${SCALE_COLORS[i]}" stroke="${COLOR_BORDER}" stroke-width="1"/>`);
    lx += SW + 3;
  }

  parts.push(`<text x="${lx}" y="${legendY + 17}" font-family="sans-serif" font-size="${TEXT_SIZE}" fill="${COLOR_SUB}">多</text>`);
  lx += 18;                             // "多"字宽度
  lx += ITEM_GAP;

  // 净充值
  parts.push(`<rect x="${lx}" y="${legendY}" width="${SW}" height="21" rx="3" fill="${COLOR_RECHARGE}" stroke="${COLOR_BORDER}" stroke-width="1"/>`);
  lx += SW + 6;
  parts.push(`<text x="${lx}" y="${legendY + 17}" font-family="sans-serif" font-size="${TEXT_SIZE}" fill="${COLOR_SUB}">充值</text>`);
  lx += 32;                             // "充值"两个汉字
  lx += ITEM_GAP;

  // 无数据
  parts.push(`<rect x="${lx}" y="${legendY}" width="${SW}" height="21" rx="3" fill="${COLOR_NULL}" stroke="${COLOR_BORDER}" stroke-width="1"/>`);
  parts.push(`<line x1="${lx + 5}" y1="${legendY + 16}" x2="${lx + SW - 5}" y2="${legendY + 5}" stroke="#9ca3af" stroke-width="1" stroke-opacity="0.5"/>`);
  lx += SW + 6;
  parts.push(`<text x="${lx}" y="${legendY + 17}" font-family="sans-serif" font-size="${TEXT_SIZE}" fill="${COLOR_SUB}">无数据</text>`);
  lx += 48;

  // 画布宽度必须容得下图例的最后位置
  const legendNeeded = lx + PAD;

  // 刻度说明：让用户知道每档对应多少元（自适应分档必须标出来，否则颜色无意义）
  const unitY = legendY + 33;
  // 图例下方说明：分位数分档必须给出**实际区间**，不然颜色没有可读含义
  let rangeText;
  if (!(scale.max > 0)) {
    rangeText = '本窗口暂无消耗数据';
  } else if (scale.method === 'quantile') {
    const parts2 = [];
    for (let i = 0; i < scale.levels; i += 1) {
      const lo = scale.thresholds[i];
      const hi = i + 1 < scale.levels ? scale.thresholds[i + 1] : null;
      const seg = hi === null ? `≥${lo}` : `${lo}~${hi}`;
      parts2.push(seg);
    }
    rangeText = `单位：元/天　分档：${parts2.join(' / ')}`;
  } else {
    rangeText = `每档约 ${(scale.max / scale.levels).toFixed(1)} 元（本窗口最大 ${scale.max.toFixed(1)} 元/天）`;
  }
  parts.push(`<text x="${PAD}" y="${unitY + 15}" font-family="sans-serif" font-size="12.75" fill="${COLOR_SUB}">${esc(rangeText)}</text>`);

  parts.push('</svg>');
  return parts.join('\n');
}

module.exports = { renderHeatmap, buildScale, SCALE_COLORS, COLOR_NULL };

if (require.main === module) {
  // 命令行入口由 render-chart 统一调用，这里只做独立调试
  const daily = require('./daily');
  const fs = require('node:fs');
  const file = process.argv[2];
  const out = process.argv[3] || 'heatmap.svg';
  const rows = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  fs.writeFileSync(out, renderHeatmap(daily.dailyConsumption(rows, { days: 30 })), 'utf8');
  console.log('已写入', out);
}
