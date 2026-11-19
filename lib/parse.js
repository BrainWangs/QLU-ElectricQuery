'use strict';
/**
 * 响应解析层：把学校接口返回的裸 JSON 翻译成领域对象。
 *
 * 为什么单独成文件：
 * 这 26 行原本在 `lib/qlgydx.js` 的 `queryBalance()` 里，是**唯一不能测**的一段
 * （实测函数覆盖 8.70%），却同时是三个 P1 级缺陷的共同根因：
 *
 *   - `Number('')` → 0        → 余额 0 → 触发"严重不足"假告警
 *   - `Number('65.42元')` → NaN → 显示"正常"（静默错误），JSON 里变 null
 *   - `null.toFixed(2)` 崩溃    → 整条 check 以 1 退出，快照/状态都不写
 *
 * 抽成纯函数后，这些全都能用夹具钉死。**本文件不得依赖网络、文件系统、时钟**
 * ——时间由调用方通过 ctx 传入，这样测试才可能稳定。
 */

/** 判断是否为可逐键访问的普通对象 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 金额解析：**本仓库唯一允许出现 Number() 的地方**。
 *
 * 规则（每条都有对应夹具）：
 *   数字           → 保留，四舍五入到分
 *   '65.42'        → 65.42
 *   ' 65.42 '      → 65.42（去空白）
 *   '65.42元'      → 65.42（去单位）
 *   '1,234.56'     → 1234.56（去千分位）
 *   '0'            → 0（合法：真的没电了，会触发预警）
 *   ''  / '--' / null / undefined / 'abc' → **抛错**
 *   负数           → 抛错（电费余额不可能为负）
 *
 * 关键取舍：**区分"解析失败"和"余额为 0"**。
 * 旧实现把 `''` 变成 0，那是最糟的一种错——它让"接口给了垃圾"伪装成
 * "余额刚好是 0"，于是发出一条假告警，而真正的故障被掩盖。
 *
 * @param {*} raw 接口原值
 * @returns {number} 元，两位小数的数值
 * @throws {Error} kind='bad-amount'
 */
function parseAmount(raw) {
  const bad = why => {
    const e = new Error(`余额字段无法解析：${why}（原值 ${JSON.stringify(raw)?.slice(0, 40)}）`);
    e.kind = 'bad-amount';
    e.rawValue = raw;
    return e;
  };

  // 已经是数字：直接校验
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw bad('不是有限数字');
    if (raw < 0) throw bad('余额不可能为负');
    return Math.round(raw * 100) / 100;
  }

  if (typeof raw !== 'string') throw bad(`类型 ${raw === null ? 'null' : typeof raw} 不支持`);

  // 去空白、去货币单位与千分位。注意只容忍这些"装饰"，不容忍别的东西。
  const cleaned = raw
    .trim()
    .replace(/[¥￥元圆]/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '');

  if (cleaned === '') throw bad('空字符串');
  // 只接受可选负号的十进制数，拒绝 '--'、'abc'、'1e5'、'NaN'、'Infinity' 等
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) throw bad('不是合法十进制数字符串');

  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw bad('转换后不是有限数字');
  if (n < 0) throw bad('余额不可能为负');
  return Math.round(n * 100) / 100;
}

/**
 * 从 `deviceInfo[0].infos[]` 里按 key 取值。
 *
 * 注意：这里的 `: null` 不是随手写的 —— 变异 M1 就是把它改成 `: undefined`。
 * 两者在下游差别巨大：`undefined` 会让 `balanceRaw === null ? null : Number(...)`
 * 走进 Number(undefined) → NaN，而 NaN 在告警逻辑里表现为"一切正常"。
 *
 * @returns {*} 找不到时返回 null（**不是 undefined**）
 */
function pickInfo(infos, key) {
  if (!Array.isArray(infos)) return null;
  const it = infos.find(x => x && x.key === key);
  if (!it) return null;
  return it.keyValue === undefined ? null : it.keyValue;
}

/**
 * 解析余额查询响应。
 *
 * 契约（见 docs/REFACTOR-PLAN.md §3.2）：
 * @typedef {Object} Balance
 * @property {number}   amount       元，两位小数，**永远不是 null/NaN**
 * @property {string}   custRechNo   请求时用的电表号（归一化后）
 * @property {string|null} meterAddress 表具地址（Amid）
 * @property {string|null} location  长地址（未脱敏）
 * @property {string|null} unit      单位（开户/…）
 * @property {string|null} roomName  房间名
 * @property {string}   queriedAt    ISO 8601
 * @property {Object}   raw          原始 datajson（排障用）
 *
 * @param {Object} json     接口返回的完整 JSON
 * @param {Object} [ctx]    { custRechNo, now }
 * @returns {Balance}
 * @throws {Error} kind='bad-response' | 'bad-amount'
 */
function parseBalance(json, ctx = {}) {
  const fail = why => {
    const e = new Error(`余额响应无法解析：${why}`);
    e.kind = 'bad-response';
    return e;
  };

  if (!isObj(json)) throw fail('响应不是对象');

  // 业务错误码：30300000 是成功。这里只负责翻译成异常，控制流由调用方看 kind。
  if (json.code !== undefined && json.code !== '30300000') {
    const msg = typeof json.message === 'string' && json.message
      ? json.message
      : (typeof json.msg === 'string' ? json.msg : '未知业务错误');
    const e = new Error(`查询失败: ${msg}`);
    e.kind = 'bad-response';
    e.code = json.code;
    throw e;
  }

  const dj = isObj(json.datajson) ? json.datajson : {};
  const deviceInfo = dj.deviceInfo;
  const dev = Array.isArray(deviceInfo) && isObj(deviceInfo[0]) ? deviceInfo[0] : {};

  // 多表具时明确报错，而不是"静默选第一个"——选错了就是查了别人的电表。
  if (Array.isArray(deviceInfo) && deviceInfo.length > 1) {
    const e = new Error(`响应里有 ${deviceInfo.length} 个表具，无法确定查的是哪一个`);
    e.kind = 'multi-meter';
    e.count = deviceInfo.length;
    throw e;
  }

  const infos = Array.isArray(dev.infos) ? dev.infos : [];
  const balanceRaw = pickInfo(infos, 'JC_remoney');
  // 注意 M2：绝对不能让 balance 有机会变成 NaN。
  // 解析失败时抛错（让上层当成查询失败），比返回 NaN（伪装成功）好得多。
  const amount = parseAmount(balanceRaw);

  // 时钟由调用方注入：三种形态都支持，测试才能完全确定化
  //   ctx.now 是函数 → 调用它
  //   ctx.now 是 Date → 直接用
  //   都没给          → 取当前时间
  const rawNow = typeof ctx.now === 'function' ? ctx.now() : (ctx.now ?? new Date());
  const now = rawNow instanceof Date ? rawNow : new Date(rawNow);
  return {
    amount,
    custRechNo: ctx.custRechNo ?? null,
    meterAddress: pickInfo(infos, 'Amid'),
    location: dev.nameValue || null,
    unit: dev.unitValue || null,
    roomName: dj.roomName || dev.roomName || null,
    queriedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    raw: dj,
  };
}

/**
 * 把 `listUser` 拉平成一维账户数组。
 *
 * 实际结构有两种形态（都实测见过）：
 *   { listUser: { "充值缴费": [ { merUserBillInfo: {...} }, ... ] } }
 *   { datajson: { listUser: { ... } } }
 *
 * @param {Object} json
 * @returns {Array<{group:string, chargeNumber:string, chargeName:string,
 *                  rechMerMapId:*, merchantId:*, rechChargeTypeId:*, rechargeTypeName:string}>}
 */
function parseAccounts(json) {
  if (!isObj(json)) return [];
  const listUser = isObj(json.listUser) ? json.listUser
    : (isObj(json.datajson) && isObj(json.datajson.listUser) ? json.datajson.listUser : null);
  if (!listUser) return [];

  const rows = [];
  for (const [group, arr] of Object.entries(listUser)) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!isObj(item)) continue;
      const b = isObj(item.merUserBillInfo) ? item.merUserBillInfo : item;
      if (!b || !b.chargeNumber) continue; // 没有电表号的行没有意义
      rows.push({
        group,
        chargeNumber: b.chargeNumber,
        chargeName: b.chargeName || '',
        rechMerMapId: b.rechMerMapId,
        merchantId: b.merchantId,
        rechChargeTypeId: b.rechChargeTypeId,
        rechargeTypeName: b.rechargeTypeName || '',
      });
    }
  }
  return rows;
}

module.exports = { parseAmount, parseBalance, parseAccounts, pickInfo };
