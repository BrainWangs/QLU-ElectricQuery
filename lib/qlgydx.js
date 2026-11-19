'use strict';
/**
 * 齐鲁工业大学智慧财务 —— 电费查询客户端（纯 Node，无需浏览器）
 *
 * 逆向得到的要点：
 *  1) 登录：POST https://sso.mp.sinojy.cn/oauth2.0/loginSubmit
 *     明文 = 账号|毫秒时间戳，先 Base64 再 SM2 加密（C1C3C2，mode=1），结果前加 "04"
 *  2) 登录成功后需再请求一次 /oauth2.0/authorize，从 302 Location 中取 code
 *  3) 用 code 请求 /api/user/ssoRedirect.do 换取 SESSION cookie
 *  4) 之后每个 /api/ 请求都要带 5 个头：
 *     requestSiteDomain / rand / token / sessionToken / requestid
 *     token = MD5(SALT + MD5(rand后6位 + MD5(JSON.stringify(body))))
 *  5) sessionToken 由 /api/pageService/firstInterFace 的响应下发
 */
const crypto = require('node:crypto');
const { sm2 } = require('sm-crypto');
const parse = require('./parse');
const errors = require('./errors');

const HOST = 'qlgydx.mp.sinojy.cn';
const SSO = 'sso.mp.sinojy.cn';
const SALT = 'hgf434h767s3r56f';
const SM2_PUBKEY = '0491acf8c37019924eddbeec22867476532f21e3d252e6f2fc422af681dcaffd8052bacfe58e0477d293ae78aa5f7b62bb1feaa4cf55f56408e775e7011862b274';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const ALPH = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rand13 = () => Array.from({ length: 13 }, () => ALPH[crypto.randomInt(ALPH.length)]).join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 计算验签 token */
function signToken(bodyStr, rand) {
  return md5(SALT + md5(rand.slice(-6) + md5(bodyStr)));
}

/** SM2 加密（明文先 Base64） */
function sm2Encrypt(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return '04' + sm2.doEncrypt(b64, SM2_PUBKEY, 1);
}

class CookieJar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  load(str) {
    this.map.clear();
    for (const part of String(str || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  get(name) { return this.map.get(name); }
  hasSession() { return [...this.map.keys()].some(k => /SESSION/i.test(k)); }
  toString() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  toJSON() { return Object.fromEntries(this.map); }
}

class ElecClient {
  /**
   * @param {object} opts
   * @param {string} opts.username 学号
   * @param {string} opts.password 密码（原样提交）
   * @param {string} [opts.custRechNo] 电表号，形如「园区#楼号#房号」，如 示例园#1#A101
   * @param {number} [opts.rechMerMapId] 充值商户映射 id，默认 338
   * @param {object} [opts.state] 持久化的会话状态 {cookie, sessionToken, userInfoId, merchantId, savedAt}
   */
  constructor(opts = {}) {
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.custRechNo = opts.custRechNo || '';
    this.rechMerMapId = opts.rechMerMapId || 338;
    this.merchantId = opts.merchantId || 111267;
    this.userInfoId = opts.userInfoId || null;
    this.jar = new CookieJar();
    this.sessionToken = '';
    this.loginAt = 0;
    if (opts.state) {
      if (opts.state.cookie) this.jar.load(opts.state.cookie);
      this.sessionToken = opts.state.sessionToken || '';
      this.userInfoId = opts.state.userInfoId || this.userInfoId;
      this.merchantId = opts.state.merchantId || this.merchantId;
      this.loginAt = opts.state.savedAt || 0;
    }
  }

  /** 导出可持久化的会话状态 */
  exportState() {
    return {
      cookie: this.jar.toString(),
      sessionToken: this.sessionToken,
      userInfoId: this.userInfoId,
      merchantId: this.merchantId,
      savedAt: this.loginAt,
    };
  }

  // ---------- 底层请求 ----------

  /**
   * DNS 智能解析兜底：
   * 站点 DNS 按访问方线路返回不同 CDN 节点。GitHub Actions 的解析请求会被
   * 误判为"长城宽带线路"，拿到 43.224.184.x（GWBN）这组从 Azure 机房根本
   * 连不通的 IP，导致 UND_ERR_CONNECT_TIMEOUT。国内线路则始终拿到正常 CDN。
   * 对策：connect timeout 时改用阿里 DoH 重新解析（拿公共 CDN 节点），
   * 再用 undici Agent 的自定义 lookup 固定 IP 重试一次。
   */
  async _dohResolve(hostname) {
    // 学校 DNS 权威按运营商智能解析：Azure 出口会被映射到某个 CDN 分组，
    // 而那个分组的节点可能整体不可达（2026-11-02 实测 58.30.207.x 全挂，
    // DoH 默认视角返回的 8 个地址全是这一段，兜底救不回来）。
    // 对策：用多个运营商 edns_client_subnet 各问一遍 alidns，
    // 合并全部答案进 lookup 候选池 —— undici 会挨个试，谁通用谁。
    const subnets = [
      '',                       // 不带 subnet（出口默认视角）
      '219.141.136.0/24',       // 北京电信
      '202.96.209.0/24',        // 上海联通
      '120.196.165.0/24',       // 广东移动
      '211.137.32.0/24',        // 移动通用
      '1.2.4.0/24',             // 教育网/CNNIC
    ];
    const answers = await Promise.allSettled(subnets.map((sn) => {
      const q = `https://dns.alidns.com/resolve?name=${hostname}&type=A` + (sn ? `&edns_client_subnet=${sn}` : '');
      return fetch(q, { headers: { accept: 'application/dns-json' } }).then((r) => r.json());
    }));
    const ips = [];
    for (const a of answers) {
      if (a.status !== 'fulfilled' || !a.value) continue;
      for (const rec of a.value.Answer || []) {
        // 只要 A 记录；CNAME 链的最终 A 已在 Answer 里
        if (rec.type === 1 && rec.data && /^\d+\.\d+\.\d+\.\d+$/.test(rec.data) && !ips.includes(rec.data)) {
          ips.push(rec.data);
        }
      }
    }
    if (!ips.length) throw new errors.ElecError('network-error', `DoH 解析 ${hostname} 失败：无 A 记录`, { retryable: false });
    return ips;
  }

  async _raw(url, { method = 'GET', headers = {}, body } = {}) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method, headers, body, redirect: 'manual' });
      this.jar.absorb(res);
      return res;
    } catch (e) {
      const netErr = errors.fromNetworkError(e, { elapsedMs: Date.now() - t0 });
      const code = netErr.code || '';
      // 排障日志（这条链路 2026-11 多次踩坑，必须能看见兜底到底有没有触发）
      console.error(`[net] ${new Date().toISOString()} ${method} ${url.slice(0, 90)} 耗时${Date.now() - t0}ms code=${code}`);
      // 只有"超时类"且耗时确实够长才值得走 DoH 兜底
      if (netErr.kind !== 'network-timeout' || Date.now() - t0 < 5000) throw netErr;

      // 网络超时 → DoH 兜底重试（仅对站点域名，github.com 等不动）
      // login() 对同一域名要发多次请求（authorize 预热/loginSubmit/authorize
      // 取 code），坏 IP 轮询下每一步都可能撞上，只救一次不够 —— 用缓存的
      // DoH agent（含 IP 列表）反复重试；只有「DoH IP 也全不通」才彻底放弃
      const u = new URL(url);
      if (!/(sinojy.cn)$/.test(u.hostname)) throw netErr;

      this._dohAgent = this._dohAgent || {};
      this._dohTried = this._dohTried || {};
      let ips;
      if (this._dohAgent[u.hostname]) {
        ips = this._dohAgent[u.hostname]._qluIps; // 复用已验证可通的 IP 集
      } else if (this._dohTried[u.hostname]) {
        throw netErr; // 上次 DoH 重试也失败，别再空转
      }
      this._dohTried[u.hostname] = true;
      if (!ips) {
        ips = await this._dohResolve(u.hostname);
        console.error(`[net] DoH ${u.hostname} → ${ips.join(', ')}`);
      }

      // undici 随 Node 一起分发但没有暴露成 require-able 模块，得显式装；
      // Node 18+ 全局 fetch 底层就是 undici，这里只在 DoH 兜底时才用到。
      let Agent;
      try {
        ({ Agent } = require('undici'));
      } catch {
        ({ Agent } = require('node:undici'));
      }
      if (!this._dohAgent[u.hostname]) {
        const agent = new Agent({
          connect: {
            lookup: (h, o, cb) => cb(null, ips.map(ip => ({ address: ip, family: 4 }))),
            // 多个候选 IP 时并发竞速（Happy Eyeballs）：坏分组的 IP 连不上
            // 就快速放弃，不会傻等每个 10s 超时
            autoSelectFamily: ips.length > 1,
          },
        });
        agent._qluIps = ips;
        this._dohAgent[u.hostname] = agent; // 复用，避免句柄泄漏
      }
      const res = await fetch(url, { method, headers, body, redirect: 'manual', dispatcher: this._dohAgent[u.hostname] });
      this.jar.absorb(res);
      return res;
    }
  }

  /** 调用 /api/ 接口（自动加验签头） */
  async api(pathname, bodyObj, referer) {
    const bodyStr = JSON.stringify(bodyObj);
    const rand = rand13();
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': UA,
      Cookie: this.jar.toString(),
      Origin: `https://${HOST}`,
      Referer: referer || `https://${HOST}/SL300000`,
      requestSiteDomain: HOST,
      requestid: String(Date.now()),
      rand,
      token: signToken(bodyStr, rand),
      sessionToken: this.sessionToken || '',
    };
    const res = await this._raw(`https://${HOST}${pathname}`, { method: 'POST', headers, body: bodyStr });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  }

  // ---------- 登录 ----------

  /** 完整登录：SM2 -> code -> SESSION -> sessionToken */
  async login() {
    if (!this.username || !this.password) throw new errors.ElecError('config-invalid', '缺少账号或密码');

    // 1) 预热 SSO（拿 acw_tc）
    const redirectUri = `https://${HOST}:443/api/user/ssoRedirect.do?service=` +
      encodeURIComponent(`https://${HOST}?loginByInterface=true&ssoType=true`);
    const authz = `https://${SSO}/oauth2.0/authorize?rand=${Date.now()}_${crypto.randomBytes(16).toString('hex')}` +
      `&response_type=code&client_id=111&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&redirect_uri_domain=${HOST}&loginByInterface=true&h5LoginUri=SL200000`;
    await this._raw(authz, { headers: { 'User-Agent': UA } });

    // 2) 提交加密凭据
    const ts = Date.now();
    const payload = JSON.stringify({
      userName: sm2Encrypt(this.username + '|' + ts),
      pwd: sm2Encrypt(this.password + '|' + ts),
      service: `https://${HOST}`,
    });
    const res1 = await this._raw(`https://${SSO}/oauth2.0/loginSubmit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': UA,
        Origin: `https://${HOST}`,
        Referer: `https://${HOST}/`,
        Cookie: this.jar.toString(),
      },
      body: payload,
    });
    const t1 = await res1.text();
    let j1 = null;
    try { j1 = JSON.parse(t1); } catch { /* ignore */ }
    if (!j1 || j1.code !== '00000000') {
      // 翻译逻辑集中在 lib/errors.js：这是全仓唯一知道"哪些文案算登录失败"的地方。
      // 控制流只看 kind，不再对消息做正则匹配。
      throw errors.fromLoginResponse(j1, t1);
    }
    const user = j1.data_json || j1.data || {};
    if (user.userInfoId) this.userInfoId = user.userInfoId;
    this.userName = user.userInfoName || '';

    // 3) 再请求 authorize，从 302 Location 取 code
    const authz2 = `https://${SSO}/oauth2.0/authorize?redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&redirect_uri_domain=${HOST}&h5LoginUri=SL200000`;
    const res2 = await this._raw(authz2, {
      headers: { 'User-Agent': UA, Cookie: this.jar.toString() },
    });
    const loc = res2.headers.get('location') || '';
    const m = loc.match(/[?&]code=([^&]+)/);
    if (!m) throw new errors.ElecError('auth-failed', `未拿到 SSO code，Location=${loc.slice(0, 200)}`);
    const code = m[1];

    // 4) 用 code 换 SESSION
    await this._raw(`https://${HOST}/api/user/ssoRedirect.do?service=` +
      encodeURIComponent(`https://${HOST}?loginByInterface=true&ssoType=true`) +
      `&code=${encodeURIComponent(code)}`, {
      headers: { 'User-Agent': UA, Cookie: this.jar.toString() },
    });
    if (!this.jar.hasSession()) throw new errors.ElecError('session-missing', '未获得 SESSION cookie');

    // 5) 初始化会话，拿 sessionToken
    await this.initSession();
    this.loginAt = Date.now();
    return { userName: this.userName, userInfoId: this.userInfoId, sessionToken: this.sessionToken };
  }

  /** 调用 firstInterFace 刷新 sessionToken */
  async initSession() {
    const r = await this.api('/api/pageService/firstInterFace', {
      domain: HOST,
      isPayReturn: null,
      merSwicthKeyArray: ['payment_others', 'student_loan_remind'],
      ssoType: 'true',
      url_data: 'loginByInterface=true&ssoType=true',
    });
    const j = r.json || {};
    const st = j.sessionToken || (j.siteInfo && j.siteInfo.sessionToken) || (j.data_json && j.data_json.sessionToken);
    if (!st) {
      throw new errors.fromBusinessCode(j.code, `sessionToken 获取失败: code=${j.code} is_login=${j.is_login}`);
    }
    this.sessionToken = st;
    return st;
  }

  /** 判断会话是否还可用（调一次轻量接口验证） */
  async checkSession() {
    if (!this.jar.hasSession()) return false;
    try {
      const r = await this.api('/api/pageService/firstInterFace', {
        domain: HOST,
        isPayReturn: null,
        merSwicthKeyArray: ['payment_others', 'student_loan_remind'],
        ssoType: 'true',
        url_data: 'loginByInterface=true&ssoType=true',
      });
      const j = r.json || {};
      if (j.is_login === false) return false;
      const st = j.sessionToken || (j.siteInfo && j.siteInfo.sessionToken);
      if (st) { this.sessionToken = st; return true; }
      return false;
    } catch {
      return false;
    }
  }

  /** 确保会话有效，失效则重新登录 */
  async ensureSession() {
    if (await this.checkSession()) return false;
    await this.login();
    return true;
  }

  // ---------- 业务接口 ----------

  /** 已绑定的充值账户列表 */
  async listAccounts() {
    const r = await this.api('/api/commonUserMobileService/commonUserRechargeList', {
      merchantId: this.merchantId,
      userInfoId: this.userInfoId,
    });
    return r.json;
  }

  /** 查询电费余额 */
  async queryBalance(custRechNo = this.custRechNo) {
    const r = await this.api('/api/rechargeMobileService/selectAndCheckOrder', {
      merchantId: this.merchantId,
      userInfoId: this.userInfoId,
      rechMerMapId: this.rechMerMapId,
      custRechNo,
    }, `https://${HOST}/SL321110`);

    // 解析全部交给 lib/parse.js（纯函数、可测）。这里只负责发请求。
    const b = parse.parseBalance(r.json || {}, { custRechNo });
    // 保持调用方契约不变：下游一直读 result.balance，不读 amount。
    return {
      custRechNo: b.custRechNo,
      balance: b.amount,
      meterAddress: b.meterAddress,
      location: b.location,
      unit: b.unit,
      roomName: b.roomName,
      raw: b.raw,
      queriedAt: b.queriedAt,
    };
  }
}

module.exports = { ElecClient, signToken, sleep };
