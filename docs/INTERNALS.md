# 实现原理（接口逆向笔记）

> 这份文档解释"为什么代码要这么写"。**只看用法不需要读它**——
> 部署与使用见 [USAGE.md](USAGE.md)。
>
> 读它的场合：接口报错需要判断是哪一步挂了、学校改了前端、
> 或者你要把这个项目移植到别的学校。

## 一句话概括

学校没有开放 API。这个项目把网页版的五个请求手工重放了一遍：
登录（SM2 加密）→ 换 SESSION（两步重定向）→ 拿 sessionToken →
每个请求验签（MD5 嵌套）→ 查余额（从嵌套 JSON 里挖）。

任何一步的参数错误都会表现为"登录失败"或"查询失败"，
所以排障时要按顺序核对。

整套链路要过四道关，任何一道错了都拿不到余额。

## 1. 登录：SM2 加密 + 时间戳

`POST https://sso.mp.sinojy.cn/oauth2.0/loginSubmit`

```
明文  = 账号 + "|" + 13 位毫秒时间戳
中间  = base64(明文)
密文  = "04" + SM2(中间, 学校公钥, C1C3C2)      // 266 位 hex
```

账号和密码**各自**这样加密一次，作为 `userName` / `pwd` 提交。
公钥是前端 JS 里硬编码的，逆向时直接抠出来。

## 2. 换 SESSION：两步走，第一步不能跟随跳转

1. `GET /oauth2.0/authorize` —— **必须 `followRedirects=false`**，从 302 响应的
   `Location` 头里抠出 `code` 参数
2. `GET /api/user/ssoRedirect.do?code=<code>` —— 这一步的响应才 `Set-Cookie` 下
   `SESSION`

漏了"不跟随跳转"，拿到的是最终页面而不是 `code`，后面全崩。

## 3. 拿 sessionToken：body 必须带 domain

`POST /api/pageService/firstInterFace`，body 里必须有 `domain` 字段，
返回的 `sessionToken` 是后续所有 `/api/` 请求的凭据。

## 4. 验签：每个 /api/ 请求都要带 token

```
token = MD5( salt + MD5( rand.slice(-6) + MD5(JSON.stringify(body)) ) )
```

- `salt = "hgf434h767s3r56f"`（前端硬编码）
- `rand` 是 13 位小写字母数字随机串
- 注意嵌套顺序：**最内层是 body 的 MD5**

`requestid` 服务端不校验，随便填。

## 5. 查余额：从嵌套 JSON 里挖

`POST /api/rechargeMobileService/selectAndCheckOrder`

```json
{ "merchantId": 111267, "userInfoId": <个人 id>, "rechMerMapId": 338,
  "custRechNo": "示例园#1#A101" }
```

成功码 `30300000`，余额藏在 `datajson.deviceInfo[0].infos[]` 里
`key === "JC_remoney"` 那条的 `keyValue`。

## 两个绕不过去的坑

**登录熔断**：学校 SSO 密码连错 3 次就进验证码状态（此后正确密码也登不上，
约 86 秒恢复），而且**锁定按账号不按 IP**，换网络没用。所以程序识别到登录失败
立刻停手熔断，记下"下次最早尝试时间"，绝不自作聪明重试——否则定时任务会把账号反复锁死。

**DoH 兜底**：学校 DNS 对云厂商 IP 段会返回不可达地址（实测 `43.224.184.x`、
`45.116.154.x` 两组全超时）。程序在 connect timeout 时改用阿里 DoH
（`dns.alidns.com`）重新解析，用 undici Agent 锁定 IP 重试。

## 参数是从哪来的

全部来自网页版的前端 JS 与抓包，逆向时抠出来的：

| 参数 | 来源 | 位置 |
| --- | --- | --- |
| SM2 公钥 | 登录页 JS 硬编码 | `lib/qlgydx.js` |
| `salt` | `/api/` 请求签名 JS | `lib/qlgydx.js` |
| `merchantId` / `rechMerMapId` | 充值页请求体 | `lib/config.js` 的 DEFAULTS |
| `userInfoId` | 登录响应 `data_json.userInfoId` | 首次登录自动写入 `config.json` |

> ⚠️ 学校随时可能改加密方式或加风控。改动后表现为登录/查询失败，
> 此时按上面五步顺序逐个核对请求参数即可定位。

## 相关文件

| 文件 | 职责 |
| --- | --- |
| `lib/qlgydx.js` | 登录、验签、发请求（网络层） |
| `lib/parse.js` | 把响应 JSON 翻译成领域对象（纯函数，可测） |
| `lib/errors.js` | 错误分类（8 种 kind，控制流只看 kind） |
| `lib/session.js` | 登录熔断与会话复用 |
| `lib/store.js` | 状态/历史的原子读写与版本迁移 |
