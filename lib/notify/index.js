'use strict';
/**
 * 通知调度器。
 *
 * 职责：按注册表决定"发给谁"，并发发送，并给出**结构化送达报告**。
 *
 * 关键设计：
 *  1. 自检（activeChannels / hasRemoteChannel）与发送共用同一份 `isConfigured`，
 *     结构上不可能出现"自检说已配、实际不发"的失配。
 *  2. 报告是数据（`DeliveryReport`），不只是日志。`alert-test` 靠它决定退出码——
 *     原来 alert-test 无论发送成败都以 0 退出，等于"渠道配错了也报成功"，
 *     而这是最需要被发现的错误（预警发不出去 = 停电了也不知道）。
 *  3. 任一渠道失败不影响其它渠道，也不让查询整体失败（预警是尽力而为）。
 */
const log = require('../logger');
const { CHANNELS, ICONS } = require('./channels');

/**
 * @typedef {Object} DeliveryResult
 * @property {string} id      渠道 id
 * @property {string} label   渠道中文名
 * @property {boolean} remote 是否能到达手机
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * @typedef {Object} DeliveryReport
 * @property {DeliveryResult[]} results
 * @property {number} sent     成功数
 * @property {number} failed   失败数
 * @property {number} remoteSent 成功的远程渠道数
 * @property {boolean} ok      只要有一个远程渠道成功就算 OK；
 *                             没有配远程渠道时为 false（预警等于没发出去）
 */

/** 已启用的渠道（自检与发送的唯一判据） */
function activeChannelObjects(cfg) {
  return CHANNELS.filter(ch => {
    try {
      return Boolean(ch.isConfigured(cfg));
    } catch {
      // 配置形状异常时不要让自检崩掉整个命令
      return false;
    }
  });
}

/** 已启用渠道的 id 列表，用于启动自检打印 */
function activeChannels(cfg) {
  return activeChannelObjects(cfg).map(ch => ch.id);
}

/** 是否至少配置了一个「能到达手机」的远程渠道（console/file 不算） */
function hasRemoteChannel(cfg) {
  return activeChannelObjects(cfg).some(ch => ch.remote);
}

/**
 * 发送一条通知到所有已配置渠道。
 *
 * @param {object} alert {level, title, message, rule}
 * @param {object} cfg
 * @param {object} [ctx] {balance, location, custRechNo}
 * @returns {Promise<DeliveryReport>}
 */
async function notify(alert, cfg, ctx = {}) {
  const icon = ICONS[alert.level] || 'ℹ️';
  const title = `${icon} ${alert.title}`;
  // 正文不带标题行：ntfy 把 Title 渲染成通知标题，正文第一行再重复一遍是冗余
  const text = alert.message;

  const targets = activeChannelObjects(cfg);
  const results = await Promise.all(targets.map(async (ch) => {
    const base = { id: ch.id, label: ch.label, remote: Boolean(ch.remote) };
    try {
      const r = await ch.send({ alert, cfg, ctx, title, text });
      // 渠道可以不返回任何东西（视为成功），也可以返回 {ok, error}
      const ok = r === undefined ? true : Boolean(r && r.ok);
      return { ...base, ok, error: ok ? undefined : (r && r.error) || '未知错误' };
    } catch (e) {
      // 单个渠道抛错不能拖垮其它渠道
      return { ...base, ok: false, error: e.message };
    }
  }));

  return buildReport(results);
}

/** 由结果数组汇总成报告 */
function buildReport(results) {
  const sent = results.filter(r => r.ok).length;
  const failed = results.length - sent;
  const remoteSent = results.filter(r => r.ok && r.remote).length;
  return {
    results,
    sent,
    failed,
    remoteSent,
    // 一条远程渠道都没成功 = 预警实际上没送到人手上。
    // 本地 console/file 成功不算数——用户不会盯着 CI 日志看电费。
    ok: remoteSent > 0,
  };
}

/**
 * 把报告打成人类可读的几行。失败项明确列出来，不静默。
 * @param {DeliveryReport} report
 */
function describeReport(report) {
  const lines = [];
  const okList = report.results.filter(r => r.ok);
  const badList = report.results.filter(r => !r.ok);
  if (okList.length) {
    lines.push(`已送达: ${okList.map(r => r.label).join('、')}`);
  }
  if (badList.length) {
    lines.push(`发送失败: ${badList.map(r => `${r.label}(${r.error || '未知'})`).join('、')}`);
  }
  if (!report.results.length) {
    lines.push('没有配置任何通知渠道');
  } else if (!report.ok) {
    lines.push('⚠ 没有任何远程渠道送达成功——预警实际上没有到达你手上');
  }
  return lines;
}

module.exports = {
  notify,
  buildReport,
  describeReport,
  activeChannels,
  activeChannelObjects,
  hasRemoteChannel,
};
