'use strict';
/**
 * 预警判断逻辑
 *
 * 规则：
 *  - low:      余额 < alert.threshold           → 一般预警
 *  - critical: 余额 < alert.criticalThreshold   → 严重预警
 *  - drop:     相比 24h 前下降超过 dailyChangePercent% → 用量异常
 *  - recovered:上次是 low/critical，这次回到阈值以上 → 恢复通知
 *  - offline:  连续失败 N 次                          → 查询异常通知
 *
 * 去重：同一规则在 cooldownMinutes 内只通知一次；
 *       critical 状态若持续，每 repeatWhileCriticalMinutes 再提醒一次。
 */
const fs = require('node:fs');
const path = require('node:path');
const { shortLocation } = require('./cloud');

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, lastAlertAt: {}, lastBalance: null, lastOkAt: null, consecutiveErrors: 0 };
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...emptyState(), ...s, lastAlertAt: s.lastAlertAt || {} };
  } catch {
    return emptyState();
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function appendHistory(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

/** 读取最近 N 小时的历史，用于计算趋势 */
function readHistory(file, hours = 24) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const cutoff = Date.now() - hours * 3600 * 1000;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const t = Date.parse(r.queriedAt);
      if (Number.isFinite(t) && t >= cutoff) out.push(r);
    } catch { /* skip bad line */ }
  }
  return out;
}

/**
 * 评估是否需要预警
 * @returns {{level: string, title: string, message: string, rule: string}[]}
 */
function evaluate(result, cfg, state, history) {
  const { threshold, criticalThreshold, dailyChangePercent, cooldownMinutes, repeatWhileCriticalMinutes } = cfg.alert;
  const now = Date.now();
  const alerts = [];
  const bal = result.balance;

  const canNotify = (rule, extraMs = 0) => {
    const last = state.lastAlertAt[rule] || 0;
    return now - last >= (cooldownMinutes * 60000) + extraMs;
  };
  const mark = rule => { state.lastAlertAt[rule] = now; };

  if (bal === null || bal === undefined) return alerts;

  // 通知正文统一用短地址（示例校区-示例园1A101），比站点的长路径好读
  const where = shortLocation(result.location, result.custRechNo);

  // 1) 余额不足
  if (bal < criticalThreshold) {
    const repeatMs = Math.max(0, repeatWhileCriticalMinutes - cooldownMinutes) * 60000;
    if (canNotify('critical', repeatMs)) {
      alerts.push({
        level: 'critical', rule: 'critical',
        title: '电费余额严重不足',
        message: `${where} 当前余额 ${bal.toFixed(2)} 元，低于严重阈值 ${criticalThreshold} 元，请立即充值。`,
      });
      mark('critical');
      mark('low'); // 同时抑制 low，避免重复
    }
  } else if (bal < threshold) {
    if (canNotify('low')) {
      alerts.push({
        level: 'warn', rule: 'low',
        title: '电费余额偏低',
        message: `${where} 当前余额 ${bal.toFixed(2)} 元，低于预警阈值 ${threshold} 元。`,
      });
      mark('low');
    }
  } else if (state.lastAlertAt.critical || state.lastAlertAt.low) {
    // 2) 恢复通知
    const lastWasAlert = Math.max(state.lastAlertAt.critical || 0, state.lastAlertAt.low || 0);
    if (now - lastWasAlert < 24 * 3600 * 1000 && canNotify('recovered')) {
      alerts.push({
        level: 'info', rule: 'recovered',
        title: '电费余额已恢复',
        message: `${where} 当前余额 ${bal.toFixed(2)} 元，已回到预警阈值以上。`,
      });
      mark('recovered');
      delete state.lastAlertAt.low;
      delete state.lastAlertAt.critical;
    }
  }

  // 3) 异常掉电检测：对比 24 小时前的余额。
  //    注意 history 由调用方传入 7 天窗口，这里必须自己再筛 24h，
  //    否则会拿 7 天前的高余额当基准，误报「24 小时内下降 N%」。
  if (dailyChangePercent > 0 && Array.isArray(history) && history.length) {
    const cutoff = now - 24 * 3600 * 1000;
    const win = history
      .filter((h) => h && typeof h.balance === 'number' && Date.parse(h.queriedAt) >= cutoff)
      .sort((a, b) => Date.parse(a.queriedAt) - Date.parse(b.queriedAt));
    if (win.length) {
      const base = win[0]; // 24h 窗口内最早的一条
      if (typeof base.balance === 'number' && base.balance > 0) {
        const dropPct = ((base.balance - bal) / base.balance) * 100;
        if (dropPct >= dailyChangePercent && canNotify('drop')) {
          alerts.push({
            level: 'warn', rule: 'drop',
            title: '电费消耗异常',
            message: `24 小时内余额从 ${base.balance.toFixed(2)} 元降至 ${bal.toFixed(2)} 元（下降 ${dropPct.toFixed(1)}%），请留意是否有大功率电器。`,
          });
          mark('drop');
        }
      }
    }
  }

  return alerts;
}

module.exports = { loadState, saveState, appendHistory, readHistory, evaluate, emptyState };
