# 部署清单

> 仓库已经初始化并完成首次提交，**只差 push**。
> 这份清单是给"拿到仓库地址之后"用的，按顺序做即可。
> 全部步骤约 10 分钟。

---

## 第 0 步：先想清楚仓库公开还是私有

两者的限制不同，但**都不是"不能跑"**：

| | 公开仓库 | 私有仓库 |
|---|---|---|
| `schedule` 定时触发 | ✅ 可用 | ✅ 可用 |
| runner 计费 | ✅ 不消耗额度 | 消耗 Free 额度（2000 分钟/月） |
| 学号/电表号暴露风险 | ⚠️ 高（谁都能看代码和数据分支） | ✅ 低 |
| 60 天无 commit | ⚠️ schedule 会被自动禁用 | ✅ 不受影响 |

> 关键区别只有两条：**私有仓库要算额度**（本项目每 2 小时跑一次，约 160 分钟/月，
> 离 2000 分钟上限很远）；**公开仓库 60 天没提交会被自动停掉定时**。
>
> 所以如果这个仓库只有你自己用，**直接建私有仓库**，最省心也最安全 ——
> 不需要任何绕法，也不需要脱敏。

### 三个可选方案

**方案 A：私有仓库 + Secrets（推荐，本项目默认走这条）**

代码和数据都只有你自己能看到，`schedule` 正常工作，额度也够用。
凭据全放在 Secrets 里，不写进任何文件。

本项目已经做好隔离：`config.json` 和 `data/` 都在 `.gitignore` 里，
`preflight.js` 会在提交前拦住泄露，workflow 也只从 `secrets.*` 读凭据。

**方案 B：私有仓库 + 外部 cron**

如果你不想消耗 Actions 额度，或者想要更准时的触发，
可以关掉 workflow 里的 `schedule`，改用外部定时服务
（cron-job.org、UptimeRobot、自己的服务器）调 GitHub API：

```bash
curl -X POST \
  -H "Authorization: Bearer <你的 GitHub PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<用户名>/<仓库名>/actions/workflows/elec-check.yml/dispatches \
  -d '{"ref":"main"}'
```

PAT 需要 `repo` + `workflow` 权限。cron-job.org 免费、支持自定义 header。

**方案 C：完全不碰 GitHub**

用 `watch` 跑在常开机上，预警走 ntfy，见 [ntfy-relay.md](ntfy-relay.md)。

跑完第 0 步请确定选哪个，下面的步骤按 **方案 A** 写，方案 B 只是额外多一步外部 cron。

---

## 第 1 步：建仓库并 push

在 GitHub 网页上建一个**空仓库**（不要勾选 README / .gitignore / license，否则会和本地历史冲突）。

然后在本地：

```bash
cd /d/Projects/elec

git remote add origin https://github.com/<用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

> 如果 push 时要求输密码：GitHub 早已不支持密码认证，要用 **Personal Access Token**
> 当密码填（Settings → Developer settings → Personal access tokens → Fine-grained tokens，
> 勾 `Contents: Read and write`）。
> 或者用 SSH：`git remote set-url origin git@github.com:<用户名>/<仓库名>.git`

push 之前可以先跑一次自检确认没有敏感信息：

```bash
npm test                    # 88 个用例，含隐私自检
npm run preflight           # 单独跑泄露扫描（只看暂存区）
```

---

## 第 2 步：配 Secrets

仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

### 必填（3 个）

| Name | Value |
|---|---|
| `QLGYDX_USER` | 你的学号 |
| `QLGYDX_PASS` | 密码，原样抄 |
| `QLGYDX_METER` | 电表号，形如 `示例园#1#A101`（园+楼号+宿舍号） |

> 填密码时逐字对照，**不要凭印象**：密码错了 SSO 返回
> `用户名或密码不正确`，连续 3 次会触发验证码锁定（约 90 秒）。

### 推送渠道（至少配一个，否则预警没人看得见）

| Name | 说明 |
|---|---|
| `QLGYDX_NTFY_TOPIC` | ntfy topic（**最省事**：手机装 ntfy App 订阅同名 topic，不用注册） |
| `QLGYDX_PUSHPLUS` | PushPlus token（微信接收） |
| `QLGYDX_SCT_KEY` | Server酱 SendKey（微信接收） |
| `QLGYDX_WECOM` | 企业微信群机器人 webhook URL |
| `QLGYDX_BARK` | Bark 地址（iOS） |
| `QLGYDX_TG_TOKEN` + `QLGYDX_TG_CHAT` | Telegram |

### 可选开关

| Name | 说明 |
|---|---|
| `QLGYDX_REDACT` | 设 `1`/`true` 时快照与日志里的房号打码成 `***`。**私有仓库不用配**；仓库要公开时务必配上，否则 `check-snapshot.js` 会在发布前拦下并让任务失败 |
| `QLGYDX_THRESHOLD` / `QLGYDX_CRITICAL` | 覆盖 `config.json` 里的预警阈值（元） |
| `QLGYDX_STATELESS` | 设 `1` 时不落会话状态（每次全新登录，仅排障用） |

> `QLGYDX_REDACT` 同时决定 `PUBLISH_HISTORY`：未设（私有仓库）→ 发布历史与图表；
> 设了（公开仓库）→ 只发 `latest.json`，防止历史里的房号外泄。

### 手机 App 读数据（可选）

快照由 workflow 直接推到仓库的 **`data` 分支**（`latest.json` + `history.jsonl` + 图表），
**不需要额外配任何 secret**。App 里填 data 分支的 raw 地址即可：

```
https://raw.githubusercontent.com/<owner>/<repo>/data/latest.json
```

私有仓库的 raw 地址需要 token 才能读，所以本项目 App 走的是**本机直连**（见第 5 步），
data 分支主要是给你自己和 README 图表用的。

> 历史配置 `QLGYDX_PUBLISH_KIND` / `QLGYDX_PUBLISH_TOPIC`（把快照塞进 ntfy topic）
> 是早期方案，**已废弃**，现在不需要配，配了也不生效。

---

## 第 3 步：验证跑通

> **先本地跑一次 setup**（不用在 CI 里跑，它只写一次配置）：
>
> ```bash
> node bin/elec.js setup --user 你的学号 --pass "你的密码"
> ```
>
> 它会登录后自动发现你绑定的宿舍号并写回 `config.json`，省得手动去查电表号。
> 跑完 `node bin/elec.js query` 应能看到余额。CI 那边不需要 setup，
> 它只依赖 Secrets 里的三个环境变量。

仓库 → **Actions** → 左侧「电费查询」→ 右侧 **Run workflow**

第一次建议填：
- `force`: ✅ true（忽略生效时段，立刻查）
- `dry_run`: ✅ true（只打印，不真发通知）

点绿色按钮，等约 1 分钟。展开运行记录，应该看到：

```
✔ 检出代码
✔ 安装 Node
✔ 安装依赖
✔ 单元测试          → tests 88 / pass 88
✔ 隐私自检          → ✅ 未发现敏感信息
✔ 恢复状态缓存
✔ 执行查询          → INFO 余额 68.30 元 (示例校区...)
✔ 打印快照          → 一段 JSON
✔ 上传快照为构建产物
✔ 发布快照到 data 分支
```

**看到「余额 xx 元」就算成功。** 如果 `dry_run` 跑通了，再跑一次把 `dry_run` 去掉，
这次应该能在手机上收到通知（如果你配了推送渠道）。

### 常见失败

| 现象 | 原因 |
|---|---|
| `用户名或密码不正确` | 密码抄错，逐字对照 |
| `登录失败次数过多，需要输入验证码` | 密码错了 3 次被锁，**等 90 秒**，别连续重试 |
| `未登录或登录超时` | Actions 的 cache 没捞到会话，正常，会自动重登 |
| 「隐私自检」失败 | 仓库里有敏感文件，按输出的行号处理 |
| workflow 一直不自动触发 | 私有仓库（见第 0 步），改用方案 B |
| 60 天后突然不跑了 | 公开仓库无 commit 被禁用，push 一次或手动 enable |

---

## 第 4 步：让它长期跑

### 定时策略

workflow 里默认是 `0 8-23/2 * * *`（每 2 小时一次，只在 8–24 点跑，
实际触发点 08,10,12,14,16,18,20,22）。这个频率下：

- 每天 8 次、每月约 240 次，每次约 40 秒 → **约 160 分钟/月**，
  免费额度（2000 分钟）绰绰有余
- GitHub 的定时**没有 SLA**，高峰期会延迟 5–30 分钟，整点尤其堵
- 凌晨 0–8 点完全不跑：没人看，也省额度

想换频率直接改 `.github/workflows/elec-check.yml` 第 12 行的 cron：

| 需求 | cron | 每月消耗（约） |
|---|---|---|
| 只想每天知道个大概 | `0 8-23/6 * * *` | 60 分钟 |
| 默认：每 2 小时 | `0 8-23/2 * * *` | 160 分钟 |
| 想及时发现没电 | `0 * * * *`（每小时，全天） | 1200 分钟 |
| 宿舍用电很快 | `*/15 * * * *` | 2000 分钟（**接近上限**） |

> 公开仓库的 runner 不计费，可以放心用更密的频率。
> 私有仓库要算额度。

### 生效时段

程序内还有一层 `activeHours`（默认 8–24 点），不在时段内会直接跳过、不查、
不消耗登录次数。所以就算 cron 设成全天，凌晨那几次也只是空跑退出。

---

## 第 5 步：手机端

### 收预警（ntfy）

1. 手机装 [ntfy](https://ntfy.sh/)（Play Store / F-Droid / App Store 都有）
2. 订阅你在 `QLGYDX_NTFY_TOPIC` 里填的 topic
3. 等 Actions 跑一轮，或手动 Run workflow（记得 `force=true`）

> ntfy 免费版消息保留 12 小时，够用。

### 看余额（App）

App 目前是**本机直连**模式：在设置页填学号、密码，点「自动发现我的宿舍号」，
之后每次打开 App 或下拉都直接向学校接口查询（不走云端快照）。

> 早前版本支持「云端同步」读 ntfy 快照，该方案已废弃（快照改走 git data 分支）。
> 如果将来要恢复，地址形如 `https://raw.githubusercontent.com/<owner>/<repo>/data/latest.json`。

---

## 仓库里都有什么

```
elec/
├── .github/workflows/elec-check.yml   # Actions 定时任务（仓库里唯一的 workflow）
├── .gitattributes                     # 强制 LF
├── .gitignore                         # 挡住 config.json / data / 逆向残留
├── bin/
│   ├── elec.js                        # CLI：setup/query/accounts/login/check/watch/snapshot/history/alert-test
│   └── serve.js                       # 本地 HTTP 服务（可选，默认不用）
├── lib/
│   ├── qlgydx.js                      # 接口客户端（SM2 登录 + 验签 + DoH 兜底）
│   ├── alert.js                       # 预警规则
│   ├── notify.js                      # 多通道推送
│   ├── cloud.js                       # 快照生成 + 短地址格式化
│   ├── config.js                      # 配置 + 环境变量
│   └── logger.js
├── scripts/
│   ├── preflight.js                   # 提交前隐私扫描
│   ├── check-snapshot.js              # 发布前的快照脱敏校验
│   └── render-chart.js                # 余额折线图 SVG 生成
├── test/                              # 88 个用例
│   ├── core.test.js                   # 验签向量 / 快照统计 / 短地址
│   ├── lockout.test.js                # 登录熔断（防把账号锁死）
│   ├── setup.test.js                  # 电表号归一化 / 多宿舍挑选
│   ├── redact.test.js                 # 快照脱敏
│   ├── workflow.test.js               # workflow 结构校验
│   └── preflight.test.js              # 扫描器自身的正反用例
├── docs/
│   ├── DEPLOY.md                      # 本文件：部署清单
│   ├── github-actions.md              # Actions 方案详解
│   ├── ntfy-relay.md                  # 不用 GitHub 的方案（自带常开机器）
│   └── charts/                        # 余额折线图（每次查询自动更新）
├── config.example.json                # 配置模板（真实 config.json 被 ignore）
└── README.md
```

### 不会进仓库的（都在 .gitignore）

- `config.json` — 含真实账号密码电表号
- `data/` — 会话 cookie、历史、快照
- `probe/` — 逆向分析用的一次性探测脚本
- `vendor.js` / `main.js` / `slJs.js` 等 — 站点混淆代码，逆向时下载的
- `node_modules/`

---

## 什么时候可以来找我

- 拿到仓库地址了，想让我帮你 push 或检查配置
- Actions 跑失败了，把日志贴给我
- 想改预警阈值 / 查询频率 / 推送渠道
- 想加别的功能（比如用电量趋势图、多电表并存、导出报表）
