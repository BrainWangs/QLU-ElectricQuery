# 使用与部署（面向 AI agent）

> **这份文档主要写给 agent 看。**
> 人要看的话，README 就够；但这份里的步骤同样是准确的，照着做也行。
>
> 它的目标是：**agent 读完能自己判断当前进度、知道下一步做什么、
> 知道哪些必须让用户做、知道怎么验证自己做对了。**

---

## 0. 先判断：现在是在部署，还是在改代码？

| 用户诉求 | 你该读的 |
| --- | --- |
| "帮我部署 / 配好 / 跑起来" | §1 起 |
| "查一下余额 / 为什么没跑 / 报错了" | §5 排障 |

| "想让它准点" / "时间太飘" | §6 外部定时（需要用户提供 Cloudflare 账号与 GitHub token） |

---

## 1. 部署前：先摸清现状，不要从头开始

**永远先做这一步。** 用户说"帮我部署"时，仓库可能已经配好了 80%。

```bash
# 1) 这个仓库是谁的、是不是模板、是不是私有
gh repo view --json nameWithOwner,isPrivate,isTemplate,parent

# 2) 关键：Secrets 配了哪几个（名字可见，值不可见）
gh secret list

# 3) workflow 是否存在、是否启用
gh workflow list --all

# 4) 最近跑过没有、结果如何
gh run list --limit 5 --json event,conclusion,createdAt,displayTitle

# 5) 本地是否有 config.json（有 = 本地也能跑）
ls -la config.json 2>/dev/null || echo "无本地配置"
```

### 用输出决定下一步

| 观察到 | 结论 | 下一步 |
| --- | --- | --- |
| Secrets 里 3 条必填齐全 | 云端配置已完成 | 直接 §5 验证 |
| 缺 `QLGYDX_USER` / `PASS` / `METER` | 需要配 Secrets | §2 |
| `gh workflow list` 显示 `disabled` | workflow 被停用 | `gh workflow enable elec-check.yml` |
| 最近一次 run 是 `success` 且日志有余额 | **已经能跑**，别改任何东西 | 告诉用户现状即可 |
| 最近一次 run 是 `failure` | 排障 | §5 |

---

### 2.1 三条必填

```bash
gh secret set QLGYDX_USER  --body "<12位学号>"
gh secret set QLGYDX_PASS  --body "<统一身份认证密码>"
gh secret set QLGYDX_METER --body "<电表号，形如 示例园#1#A101>"
```

### 2.2 一条可选（推送到手机）

```bash
gh secret set QLGYDX_NTFY_TOPIC --body "<ntfy topic>"
```

### 2.3 两个必须问用户才能拿到的值

**不要猜，不要编，不要从别处翻。**

| 值 | 为什么必须问 |
| --- | --- |
| **密码** | 只有用户知道。仓库里没有、日志里没有、任何文件里都不该有 |
| **电表号** | 用户可能有多间宿舍。`setup` 能自动发现，但那需要密码 |

**学号**有时能从仓库历史或用户 ID 推出来，但**不要这样做**——直接问最快也最安全。

### 2.4 电表号可以自动发现

如果用户不知道电表号，用这条命令列出他名下所有宿舍：

```bash
node bin/elec.js setup --user "<学号>" --pass "<密码>"
```

多间宿舍时用 `--meter` 指定：

```bash
node bin/elec.js setup --user "<学号>" --pass "<密码>" --meter "示例园#1#A101"
```

> ⚠️ 这条命令**会真实登录学校 SSO**。执行前必须读 §3。

---

## 3. 账号安全须知（做错会把用户账号锁死）

这个项目的**唯一不可逆风险**是登录熔断：

> 学校 SSO 密码连续错 **3 次** → 账号进入验证码状态，约 **86 秒**恢复。
> 锁定按**账号**不按 IP，**换网络无效**。

### 硬规则

| 场景 | 做法 |
| --- | --- |
| 不确定密码对不对 | 先跑**一次** `node bin/elec.js login` 观察，**不要重试** |
| 看到"登录失败次数过多/需要验证码" | **立刻停手**，等 ≥90 秒。不要再试 |
| 需要验证代码逻辑 | 用 `npm test`（纯本地，不联网） |
| 需要验证推送格式 | 用 `node bin/elec.js alert-test`（不发登录请求） |
| 需要验证查询流程但怕消耗登录 | 用 `--dry-run`（零副作用，不落盘不推送） |
| 反复调试 | **绝对不要**循环执行 `check` / `login` |

### 熔断被触发后怎么恢复

1. 确认密码已改对
2. 清除熔断：`node bin/elec.js check --reset-lockout`

---

## 4. 本地路径（用户想在自己电脑上跑）

```bash
git clone <repo> && cd <repo>
npm install
npm test                    # 判据是 fail 0，具体条数见 AGENTS.md §3
node bin/elec.js setup --user "<学号>" --pass "<密码>"
node bin/elec.js query      # 查一次，不落盘不推送
```

### config.json 与 git 的关系

`config.json` 在 `.gitignore` 里，**永不入库**：

- 本地跑：配置在 `config.json`
- 云端跑：配置来自 Secrets + 环境变量
- 测试隔离：用 `QLGYDX_CONFIG` 指向临时文件

---

### 5.1 判断"部署成功"的标准

**不要只看 `conclusion: success`。** 有些运行会显示绿色但实际没查成
（比如落在时段外主动跳过）。要确认这三件事：

```bash
# 1) 真的查到余额了吗（日志里要有 "余额 xx.xx 元"）
gh run view <run-id> --log | grep "余额"

# 2) data 分支有没有推进
#    ⚠️ 必须先删掉本地缓存的 ref，否则看到的是旧数据：
#    git fetch 对已有的 remote-tracking 分支不一定更新（尤其配合 --depth 1）
git update-ref -d refs/remotes/origin/data 2>/dev/null
git fetch --depth 1 origin data:refs/remotes/origin/data
git show refs/remotes/origin/data:latest.json | grep generatedAt

# 3) 历史行数只增不减
git show refs/remotes/origin/data:history.jsonl | wc -l
```

> **踩过的坑**：不删 ref 直接 `git fetch`，`latest.json` 的 `generatedAt`
> 会停在几天前，让人误判"发布坏了"。实际每次 `ci-publish` 都返回
> `committed=true`，是本地 ref 没刷新。判断真假只能看**服务端最新提交**：
> `git ls-remote origin data`。

### 5.2 日志关键字对照表

| 日志内容 | 含义 | 该做什么 |
| --- | --- | --- |
| `登录成功: <名字>` | 认证通过 | 正常 |
| `余额 xx.xx 元` | 查询成功 | 正常 |
| `没有可用会话，需要登录…` | 缓存没命中 | 正常（首次或缓存失效） |
| `复用已有会话` | 命中缓存 | 正常（省一次登录） |
| `当前 x:xx（北京）不在查询时段…` | **主动跳过，不是故障** | 什么都不用做 |
| `x 点这个时段已经查过了` | 去重生效 | 正常 |
| `登录已熔断（N 次失败后暂停）` | 熔断中 | 见 §3 |
| `查询失败: 不在服务时间范围` | 超过 23:40 | 正常，下个时段再来 |
| `is not defined` / `Cannot read` | **代码缺陷** | 这是 bug，不是配置问题 |
| `配置错误: 缺少 ...` | 缺 Secrets 或环境变量 | §2 |

> **重要**：第 5 条（不在时段）和第 6 条（已查过）都是**设计如此**。
> 别把它们当成故障去"修"——那会把正常的节流逻辑改坏。

### 5.3 按症状找原因

| 症状 | 最可能的原因 | 怎么确认 |
| --- | --- | --- |
| Actions 根本没触发 | GitHub cron 丢触发（实测丢 78%） | `gh run list` 看 `event=schedule` 的密度 |
| 触发了但没查 | 落在时段外 / 该时段已完成 | 日志搜"不在查询时段"/"已经查过" |
| 查了但没收到推送 | topic 没配 / 推送失败 | 日志搜"未送达"；先跑 `alert-test` |
| 推送收到但是 JSON | ntfy body 被包成 JSON | 看 `lib/notify/channels.js` 是否用 `postText` |
| 登录一直失败 | 密码错 / 被锁 | 只试一次 `login`，然后停下问用户 |
| data 分支没更新 | 发布脚本 / 权限 | 看 `ci-publish` 那一步的日志 |
| 图表不更新 | 图表回推失败 | 看 `推图表到 main 分支` 那一步 |

---

## 6. 外部定时（可选：让查询准点）

当用户抱怨"时间不准 / 一天只查了一两次"时，才需要这一节。
否则**不要主动引入**——它多一个依赖点，还会消耗用户的第三方账号。

### 6.1 先判断值不值得做

```bash
# 近 20 次 schedule 触发的实际时间与间隔
gh run list --limit 40 --json event,createdAt \
  -q '[.[]|select(.event=="schedule")]|.[].createdAt'
```

| 观察 | 结论 |
| --- | --- |
| 每天 3 次以上、时间大致落在 8/12/16/20 附近 | **够用了，别动** |
| 每天 1-2 次、时间飘 4 小时以上 | 值得配外部定时 |
| 已经是 `event=workflow_dispatch` 且落在整点 | **已经配好了**，不要重复配 |

### 6.2 分工：哪些必须用户做

| 步骤 | 谁做 | 为什么 |
| --- | --- | --- |
| 创建 Cloudflare 账号 | **用户** | 需要邮箱验证 |
| 创建 GitHub token | **用户** | 涉及账号权限，`gh` 无法代创 |
| 部署 Worker 代码 | 可协助 | 网页操作要用户点；本地可用 wrangler |
| 填 Secret / Cron | 可协助（用户已登录浏览器时） | 见 §6.5 的实操坑 |
| 切 `mode` 到 external | **agent 自己** | 改一个环境变量，`gh` 就能做 |
| 验证与观察 | **agent 自己** | 全部用 `gh` 完成 |

> **必须问用户才能拿到的两个值**：Cloudflare 账号（要注册）、GitHub token（要创建）。
> 不要试图用 `gh auth token` 之类的方式取现有凭据代劳——那既不合规也不安全。

### 6.3 让用户创建 token（把这段原样发给他）

> 打开 <https://github.com/settings/tokens?type=beta> → Generate new token
>
> - **Repository access** → Only select repositories → 选电费仓库
> - **Permissions** → 找 **Actions** → 选 **Read and write**
> - 其余都不勾
> - 有效期建议 90 天
>
> ⚠️ 不要用 Classic token 勾 `repo` 全权限——那等于交出整个仓库的读写权。
> 只要 `Actions: write`，即使泄露也只能触发 workflow，读不到代码和数据。
>
> 把生成的值填进 Cloudflare，**不要发给我**（我不需要也不应该拿到它）。

### 6.4 部署 Worker（两种方式）

**首推 wrangler**（agent 可代做，但要用户配合一次浏览器登录）：

```bash
cd deploy/cloudflare-worker
npx wrangler login          # ← 会打开浏览器，必须用户点授权
npx wrangler secret put GITHUB_TOKEN   # ← 交互式输入，必须用户粘贴
npx wrangler deploy         # ← 之后 agent 可代做
```

> `wrangler login` 和 `secret put` 都是交互式，**agent 无法代劳**。
> 用户点完授权、粘完 token 后，剩下的 `deploy` 与验证 agent 可以接手。

**次选网页**：完整点击路径见 [external-cron.md §方式 A](external-cron.md#方式-a网页版推荐不用装任何东西)。
只有用户已登录浏览器、且明确让 agent 操作电脑时，才走这条路。

### 6.5 网页操作时的三个坑（实测踩过）

如果确实要用浏览器代做，先知道这三件事：

| 现象 | 真因 | 对策 |
| --- | --- | --- |
| 点了输入框，文字却进了别的字段 | React 受控组件不吃剪贴板粘贴 | 用 `sendinput` 逐字符键入，不用 paste |
| 粘完 token 后 Secret 复选框看不见了 | 93 字符把对话框撑宽，复选框被挤出视野 | **先填短占位值 `x` → 勾 Secret → 再替换成真值** |
| 点 Save 后界面毫无变化 | `printwindow` 截图漏掉弹层 | 改用 desktop 截图或读 accessibility tree 再判断 |

> 最危险的是第二条：没勾 Secret 就把 token 存成**明文变量**。
> 保存后**务必核对**列表里显示 `Type: Secret` + `Value encrypted`。

### 6.6 切到 external 模式（agent 自己做）

Worker 验证通过后，改 workflow 里的环境变量：

```yaml
# .github/workflows/elec-check.yml 的「执行查询」步骤
      env:
        QLGYDX_SCHEDULE_MODE: external   # ← 加这一行
```

推上去即生效。CI 里没有 `config.json`，**只能靠这个环境变量切模式**。

> 本地跑的话改 `config.json`：`{"schedule":{"mode":"external"}}`。

效果：窗口从 ±30 分钟收窄到 ±10 分钟，只有准点附近才查。

### 6.7 验证做对了

```bash
# 触发一次 Worker（会立刻 dispatch 一个 run）
# 用户提供 Worker 地址时：
curl -s https://<worker>.workers.dev/      # 期望 "OK: workflow dispatched"

# 然后确认 GitHub 收到了
gh run list --limit 3 --json event,createdAt -q '.[]|.createdAt+" "+.event'
```

期望看到 `workflow_dispatch` 类型的新运行。

**真正的验收要等第二天**：

```bash
gh run list --limit 20 --json event,createdAt \
  -q '[.[]|select(.event=="workflow_dispatch")]|.[].createdAt'
```

把 UTC 时间 +8 换算成北京时间，确认是否落在 8/12/16/20 附近。
误差 1-2 分钟属于正常（GitHub 启动虚拟机要时间）。

**配置正确时，输出长这样**（2026-11-10 实测）：

```
2026-11-10T00:00:43Z   -> 北京 08:00   ✅ 误差 43 秒
2026-11-10T04:00:22Z   -> 北京 12:00   ✅ 误差 22 秒
2026-11-10T08:00:10Z   -> 北京 16:00   ✅ 误差 10 秒
```

如果看到的时间是 `01:00Z / 05:00Z` 这类**整点偏移 1 小时**的，
说明 cron 换算错了（比如把北京 8 点写成 `0 8 * * *`，实际对应北京 16 点）。

### 6.8 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| Worker 返回 `config incomplete` | Secret 没保存成功 | 重做 §6.5，核对 Type 是 Secret |
| Worker 返回 `FAILED: HTTP 401` | token 无效/过期 | 让用户重新生成 |
| Worker 返回 `FAILED: HTTP 403` | 权限不够 | 需 `Actions: Read and write` |
| Worker 返回 `FAILED: HTTP 404` | 仓库名或 workflow 文件名错 | 核对 `GH_REPO` / `GH_WORKFLOW` |
| Worker 正常但 GitHub 没跑 | cron 没保存 | 检查 Cron triggers 是否 4 条 |
| 到了点但落在时段外 | cron 写成了北京时间 | Cloudflare 只认 UTC，北京 8 点写 `0 0 * * *` |
| 只有一条 cron 生效 | 加完没点 Save | 底部 "Unsaved changes" 必须点 Save |
| 某天完全没跑 | Worker 被 Cloudflare 停用 | 看 Worker 的 Metrics/Logs |

### 6.9 回退

删掉 workflow 里的 `QLGYDX_SCHEDULE_MODE: external` 即回到 github 模式，代码不用动。

> ⚠️ **要彻底停用必须两边都做**：如果程序回到 github 模式（窗口 ±30 分钟）
> 而 Cloudflare 还在准点触发，7:30 就会开查——比准点早 30 分钟。
> 这不是 bug，是窗口语义变了。

### 6.10 成本

| 项目 | 用量 | 免费额度 |
| --- | --- | --- |
| Cloudflare 请求 | 4 次/天 = 120 次/月 | 10 万次/天 |
| Cloudflare CPU | 每次约 1ms | 10ms/次 |
| GitHub Actions | 4 次/天 × 约 30 秒 | 2000 分钟/月 |

---

### 可以自主做（不需要问用户）

- 读任何文件、跑 `npm test`、跑 `--dry-run`
- 改代码、加测试、改文档
- 用 `gh` 查状态（`gh run list` / `gh secret list` / `gh run view --log`）
- 修 preflight 报出的敏感信息泄漏
- 重新触发一次 workflow 做验证（`gh workflow run`）

### 必须先问用户

| 操作 | 为什么 |
| --- | --- |
| 改 Secrets 的值 | 那是用户的凭据，改了会覆盖 |
| 创建/撤销 GitHub token | 涉及账号权限，只能用户本人操作 |
| 把仓库改成 public | 会让房号/余额/电表号永久公开，**不可逆** |
| 反复执行真实登录 | 会锁账号（见 §3） |
| 删除 `data` 分支 | 历史清零，不可恢复 |

### 绝对不要做

- 把 `config.json` / `data/` / `cookies.txt` 提交进仓库
- 在日志、文档、commit message 里贴真实学号/密码/房号/电表号/userInfoId
- 为了让测试变绿而删掉测试
- 在密码可能失效的情况下循环重试登录

---

## 8. 交接给用户时，说这四件事

部署完成后用这四句话收尾（不要罗列技术细节）：

1. **现在能做什么**：每天几点会查（默认北京 8/12/16/20 点）
2. **怎么确认它在工作**：去 Actions 页看有没有新的绿色运行；或看 README 顶部的图有没有新点
3. **出问题看哪里**：Actions 日志；或直接问 agent
4. **还有什么可选**：想要准点可以配外部定时（见 §6，或 [external-cron.md](external-cron.md)）

---

## 附录 A：人类版详细步骤

> 面向"不想理解原理、只想照着点"的用户。agent 一般走 §1-§5 就够，
> 但如果用户明确说"一步步教我怎么点"，把这一节贴给他更快。

### A.1 前置条件

- 一个 GitHub 账号
- Node.js **22 或以上**（本地跑需要；只走 Actions 的话不用装）
- 手机装好 ntfy（想收推送的话）

### A.2 方式一：从模板生成仓库 + 配 Secrets（推荐，零代码）

**1. 复制成你自己的仓库**

| 情况 | 怎么做 |
| --- | --- |
| 仓库是 **Template repository** | 仓库页右上角绿色 **`Use this template`** → `Create a new repository` |
| 没设成模板（普通仓库） | 点右上角 **Fork** |

两条路都建议把新仓库改成私有：`Settings` → `General` → 最下面
`Danger Zone` → `Change repository visibility` → **Private**。
你的学号、宿舍号、余额都会出现在提交记录和图表里，别公开。

> 私有仓库照样能跑 `schedule`，只是消耗 Actions 免费额度（2000 分钟/月）。
> 本项目每天 4 次查询，但 cron 每 30 分钟试探一次（原因见
> README 的[已知问题](../README.md#已知问题)），约 800 分钟/月，仍在额度内。

> 模板和 Fork 的区别：模板生成的新仓库**历史是干净的**；
> Fork 会保留作者的提交历史和数据分支。要干净就选模板。

**2. 找到你的电表号**

- 网页上查：登录智慧财务 → 充值缴费页面，能看到形如 `示例园#1#A101` 的编号
- 让程序自己找：本地跑 A.3 第 2 步，会自动列出来

**3. 配 Secrets**

仓库页 → Settings → Secrets and variables → Actions → `New repository secret`：

| Name | Value |
|---|---|
| `QLGYDX_USER` | 你的学号（12 位数字） |
| `QLGYDX_PASS` | 统一身份认证密码（原样抄） |
| `QLGYDX_METER` | 电表号，如 `示例园#1#A101` |
| `QLGYDX_NTFY_TOPIC` | （可选）ntfy topic |

**4. 手动跑一次验证**

Actions 页 → 左侧「电费查询」→ 右侧 `Run workflow` → 勾上 `force` → Run。

点进这次 run 看「执行查询」步骤的日志，应该看到：

```
INFO  没有可用会话，需要登录…
INFO  登录成功（张三）
INFO  余额 68.30 元  (示例校区-示例园1A101)
INFO  🟢 电费日报
```

同时手机收到一条日报推送。

**5. 之后就不用管了**

查询会在北京时间 8:00 / 12:00 / 16:00 / 20:00 前后自动进行
（默认 github 模式下每个时段有 30 分钟提前量）。README 顶部的三张折线图
也会随每次查询自动更新。同一时段内不会重复查询、也不会重复推送。

> 💡 觉得时间太飘？GitHub 自带的定时会丢触发（实测丢 78%），
> 实际可能一天只查成 1-3 次。想让查询稳定落在整点附近，可以加一个免费的
> 外部定时服务，约 5 分钟配好：见 [external-cron.md](external-cron.md)。

### A.3 方式二：本地跑通再上云（出问题好排查）

**1. 克隆并装依赖**

```bash
git clone https://github.com/<你的用户名>/<仓库名>.git
cd <仓库名>
npm install
npm test
```

**2. 一条命令完成配置**

```bash
node bin/elec.js setup --user 你的学号 --pass "你的密码"
```

这条命令会登录一次、自动发现你名下绑定的宿舍，把账号密码和电表号写进
`config.json`。多间宿舍时用 `--meter` 指定：

```bash
node bin/elec.js setup --user 你的学号 --pass "你的密码" --meter "示例园#1#A101"
```

> 密码里有 `$`、`!`、`@` 这类字符时，**一定要用引号包起来**，
> 否则 shell 会先解释掉。

**3. 查一次试试**

```bash
node bin/elec.js query
```

```
余额：68.30 元
位置：示例校区学生公寓.示例园1号公寓A区.3楼.A101
```

**4. 测一下推送**

```bash
QLGYDX_NTFY_TOPIC=你的topic node bin/elec.js alert-test
```

**5. 定时运行**

本项目**不提供常驻 `watch` 模式**（原实现的 `intervalMinutes` 非数字会让
`while (Date.now() < NaN)` 变成零延时死循环，每轮都真实打一次学校接口）。
定时需求由 GitHub Actions 承担，见
[.github/workflows/elec-check.yml](../.github/workflows/elec-check.yml)。

### A.4 常用命令

| 命令 | 作用 |
|---|---|
| `node bin/elec.js setup` | 首次配置：登录 + 自动发现宿舍 + 写 config.json |
| `node bin/elec.js query` | 查一次余额 |
| `node bin/elec.js check` | 查询 + 判预警 + 发通知（Actions 跑的就是这个） |
| `node bin/elec.js login` | 单独验证密码是否还有效（排查熔断用） |
| `node bin/elec.js alert-test` | 发一条测试推送 |
| `npm test` | 跑单元测试 |

> 已删除的命令：`watch` / `serve` / `snapshot` / `history` / `accounts`。
> 快照直接看 `data/latest.json`；历史看 `data` 分支的 `history.jsonl`；

### A.5 改默认行为

`config.json` 里最常改的几个：

```json
{
  "schedule": {
    "mode": "github",           // github（自带 cron）/ external（外部准点）
    "slots": [8, 12, 16, 20],   // 每天在几点查（北京小时）
    "windowMinutes": null,      // null = 按 mode 自动定宽；写数字则强制
    "closeMinutes": 1420,       // 学校服务关闭时刻（1420 = 23:40）
    "pushHours": [8, 22]        // 只在这时段内推「余额概览」，预警不受限
  },
  "alert": {
    "threshold": 10,            // 余额低于这个值 → 预警
    "criticalThreshold": 5,     // 低于这个值 → 严重预警
    "dailyChangePercent": 40    // 24 小时跌超这个百分比 → 消耗异常
  }
}
```

想改查询次数/时间点，改 `slots` 就行，例如 `[8, 20]` 是早晚各一次。

`mode` 决定窗口有多宽：

| mode | 谁在计时 | 窗口 |
|---|---|---|
| `"github"` | GitHub 自带 cron | 准点前后各 **30 分钟** |
| `"external"` | 外部服务（如 Cloudflare Worker） | 准点前后各 **10 分钟** |

两种模式**共用同一套时段去重**，切换只改这一个字段，不用动代码。

> ⚠️ 旧配置里的 `intervalMinutes` **已删除**。它属于早已移除的 `watch` 模式，
> 在 Actions 方案下从未被任何代码读取——改它没有任何效果。

### A.6 把仓库公开成模板给别人用

如果想把它当模板分享：

1. 清空数据：`rm -rf data data/latest.json`（`data/` 已在 gitignore 里）
2. 勾上 Template：`Settings` → `General` → **Template repository**
3. **别把私有的那份也公开**：`data` 分支存着真实余额曲线与历史，
   `docs/charts/*.svg` 里也有宿舍编号

公开前**务必**打开脱敏，否则宿舍号会出现在快照和历史里：

```
QLGYDX_REDACT = 1
```

设了之后：房号打码成 `***`、不再发布历史数据与图表。同时记得删掉
`data` 分支和 `docs/charts/` 下的旧图——历史文件不会被自动打码。

---

## 9. 相关文档

| 文档 | 什么时候读 |
| --- | --- |
| [README](../README.md) | 给用户看的完整说明（含图） |
| [DEPLOY.md](DEPLOY.md) | 更细的部署分支：公开/私有怎么选、常见失败 |
| [external-cron.md](external-cron.md) | 准点方案（Cloudflare Worker） |
| [INTERNALS.md](INTERNALS.md) | 接口逆向细节，排障时判断哪一步挂了 |
| [ntfy.md](ntfy.md) | 推送渠道完整配置 |
| [github-actions.md](github-actions.md) | workflow 每一步在干什么 |

