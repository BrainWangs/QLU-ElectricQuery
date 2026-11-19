# 齐鲁工业大学 电费查询 / 监控 / 预警

> 纯 Node 实现的电费余额查询工具，**不需要浏览器**。
> 基于对 `qlgydx.mp.sinojy.cn`（智慧财务）接口的逆向分析，由 GitHub Actions 定时查询，
> 余额过低时通过 [ntfy](https://ntfy.sh/) 推送到手机。

## 📈 电费余额趋势（自动更新）

每次定时查询后由 GitHub Actions 自动重画。绿色圆点 = 充值；橙色/红色虚线 = 预警/告急阈值。

### 近 3 天

![近 3 天](docs/charts/chart-3d.svg)

### 近 7 天

![近 7 天](docs/charts/chart-7d.svg)

### 近 30 天

![近 30 天](docs/charts/chart-30d.svg)

### 每日消耗热力图

![每日电费消耗](docs/charts/heatmap.svg)

> **折线图每天只画一个点**（当天最后一次查询）。上游服务每天只更新一次余额，
> 同一天内多次查询值完全相同，全画出来点会重合、数值标注也互相压住。
>
> **热力图的分度是自适应的**：按当前窗口内实际用量的最大值分成 5 档，
> 并直接标出「每档约多少元」。所以用电多的周和用电少的周都能看出层次。
> 灰底斜线 = 当天没有有效数据（不是"没用过电"，两者视觉上刻意区分开）。
> 蓝色格子 = 当天净充值（充的比用得多）。

---

## 这是什么

学校宿舍的电费余额只能登录智慧财务网站手动查，而且每次都要走一遍统一身份认证。
这个项目把那条链路抽出来做成命令行工具，再交给 GitHub Actions 定时跑：

| 你会得到 | 说明 |
|---|---|
| 余额自动查询 | 每天 4 次（北京时间 8:00 / 12:00 / 16:00 / 20:00） |
| 手机预警推送 | 余额低于阈值 → ntfy 推送到锁屏 |
| 余额趋势图 | 3 / 7 / 30 天折线，自动标注充值点 |
| 完全免费 | GitHub Actions 免费额度约 2000 分钟/月，本项目约 800 分钟 |

**不做的事**：不提供用电量明细（接口没有）、不做自动充值（接口不支持）。

---

## 实现原理

学校没有开放 API。这个项目把网页版的五个请求手工重放了一遍：
登录（SM2 加密）→ 换 SESSION（两步重定向）→ 拿 sessionToken →
每个请求验签（MD5 嵌套）→ 查余额（从嵌套 JSON 里挖）。

两个绕不过去的坑：

- **登录熔断**：学校 SSO 密码连错 3 次就进验证码状态，且**按账号不按 IP**，
  换网络没用。所以程序一发现登录失败就立刻停手，绝不重试。
- **DoH 兜底**：学校 DNS 对云厂商 IP 段会返回不可达地址，
  程序在超时时改用阿里 DoH 重新解析。

> 完整的接口细节、每个参数从哪来、排障时怎么按步骤定位，见
> [docs/INTERNALS.md](docs/INTERNALS.md)。**只用不改**的话不需要读它。

---

## 手机推送（ntfy）

ntfy 是开源推送服务，**不用注册、国内可直连**，发一条 HTTP POST 就能让手机弹通知。

配好只需要三步：手机装 App → 订阅一个自己起的 topic（要够难猜，它相当于密码）
→ 把 topic 填进 `QLGYDX_NTFY_TOPIC`。

配好后跑一次 `node bin/elec.js alert-test` 验证，手机会收到一条
`🔴 预警测试`。

你会收到这几类消息：

| 标题 | 触发条件 |
|---|---|
| 🔴 电费余额严重不足 | 余额 < 5 元（持续响铃） |
| 🟠 电费余额偏低 | 余额 < 10 元（持续响铃） |
| 🟠 电费消耗异常 | 24 小时跌超 40% |
| 🟠 电费查询失败 | 连续失败 |
| 🟢 电费余额已恢复 | 充值后回到阈值以上（安静） |
| 🟢 电费日报 | 每次查询成功后（安静） |

一条日报里有：当前余额、近 24 小时用掉多少、期间充值多少、日均消耗、预计还能用几天。
充值后余额回到阈值以上会额外收到一条「电费余额已恢复」。

> 完整步骤、消息优先级、以及换用 PushPlus / Server酱 / 企业微信 / Bark / Telegram
> 的配置方法，见 [docs/ntfy.md](docs/ntfy.md)。

---

## 快速开始

这个仓库本身就是一份模板：**换成你的账号密码和宿舍号就能用**。

### 三步走

1. **复制仓库**：仓库页右上角 `Use this template`（没设成模板就点 `Fork`），
   **顺手改成私有**——你的学号、宿舍号、余额都会出现在提交记录和图表里
2. **配 Secrets**：Settings → Secrets and variables → Actions，加三条必填：

   | Name | Value |
   |---|---|
   | `QLGYDX_USER` | 你的学号 |
   | `QLGYDX_PASS` | 统一身份认证密码 |
   | `QLGYDX_METER` | 电表号，如 `示例园#1#A101` |

   > **不知道电表号？** 两种办法：
   > - 登录智慧财务 → 充值缴费页面，能看到形如 `XX园#1#A101` 的编号
   > - 或者在本地跑 `node bin/elec.js setup --user 学号 --pass 密码`，
   >   它会自动列出你名下绑定的所有宿舍

   想收手机推送再加 `QLGYDX_NTFY_TOPIC`（见 [手机推送](#手机推送ntfy)）
3. **跑一次验证**：Actions 页 → 左侧「电费查询」→ `Run workflow` →
   勾上 `force` → Run。日志里应该出现 `登录成功` 和 `余额 xx.xx 元`

之后就不用管了：每天北京时间 8/12/16/20 点前后自动查询，
同一时段不会重复查、也不会重复推送。

### 详细步骤

| 你想干什么 | 看哪里 |
|---|---|
| 一步步照着点（含截图级说明） | [docs/USAGE.md 附录 A](docs/USAGE.md#附录-a人类版详细步骤) |
| 在本地电脑上跑通再上云 | [docs/USAGE.md 附录 A.3](docs/USAGE.md#a3-方式二本地跑通再上云出问题好排查) |
| 换推送渠道 / 详细配置 | [docs/ntfy.md](docs/ntfy.md) |
| 部署分支（公开还是私有） | [docs/DEPLOY.md](docs/DEPLOY.md) |
| 让 AI agent 帮你部署 | [docs/USAGE.md](docs/USAGE.md)（写给 agent 的操作手册） |
| 想让它准点（外部定时） | [docs/USAGE.md §6](docs/USAGE.md#6-外部定时可选让查询准点) 或 [docs/external-cron.md](docs/external-cron.md) |

### 常用命令

| 命令 | 作用 |
|---|---|
| `node bin/elec.js setup` | 首次配置：登录 + 自动发现宿舍 + 写 config.json |
| `node bin/elec.js query` | 查一次余额（不落盘不推送） |
| `node bin/elec.js check` | 查询 + 判预警 + 发通知（Actions 跑的就是这个） |
| `node bin/elec.js alert-test` | 发一条测试推送 |
| `npm test` | 跑单元测试 |

> 已删除的命令：`watch` / `serve` / `snapshot` / `history` / `accounts`。

---

## 外部定时（可选：让查询准点）

如果你受够了 GitHub 自带的定时不准（原因见[已知问题](#已知问题)），可以用一个免费的
外部定时服务来当闹钟：它每天在整点调一次 GitHub 的 API，触发 workflow 立刻跑。

**你不需要云服务器，也不需要电脑开机。** 定时服务跑在别人的服务器上。

### 效果对比

| | GitHub 自带 cron | 外部定时 |
|---|---|---|
| 准点程度 | 实测五天应触发 40 次只成 9 次（22%），时间随机 | 整点触发，误差通常几十秒 |
| 实际查到余额 | 可能偏离几分钟到十几小时 | 整点后约 30 秒 ~ 2 分钟 |
| 成本 | 免费额度内 | 免费（Cloudflare Workers 免费档足够） |
| 额外风险 | 无 | 需要在一个第三方服务存一个 GitHub token |

### 方案：Cloudflare Workers（推荐）

选它而不是 cron-job.org 的原因：免费额度大（10 万次请求/天）、
Secret **加密存储**（不会在请求里明文传）、cron 精度到秒。

#### 第 1 步：准备一个 GitHub token

打开 <https://github.com/settings/tokens?type=beta>（Fine-grained token）→ Generate new token：

- **Repository access** → Only select repositories → 选你的电费仓库
- **Permissions** → 展开 Account/Repository permissions → 找到 **Actions** → 选 **Read and write**
- 其余都不用勾
- 有效期建议 90 天（到期后需要重新生成并更新）

> ⚠️ **不要**用 Classic token 并勾 `repo` 全权限——那等于把整个仓库的读写权交出去。
> Fine-grained token 只要 `Actions: write` 就够了，即使泄露也只能触发 workflow。

生成后**复制保存好**，下一步要用。

#### 第 2 步：部署 Worker

仓库里已经准备好了代码和配置：`deploy/cloudflare-worker/`。

**方式 A：网页操作（不用装任何东西）**

1. 打开 <https://dash.cloudflare.com/> → 左侧 **Workers & Pages** → **Create**
2. 选 **Start with Hello World!** → 起名（如 `elec-cron`）→ **Deploy**
3. 点 **Edit code**，把 `deploy/cloudflare-worker/worker.js` 的**全部内容**粘进去 → **Deploy**
4. **Settings** → **Variables and Secrets**，添加：
   - **Secret**：名字 `GITHUB_TOKEN`，值填第 1 步的 token（**务必勾选 Secret 复选框**）
   - 可选变量（不填则用代码里的默认值）：
     `GH_OWNER` / `GH_REPO` / `GH_WORKFLOW` / `GH_REF`
5. **Settings** → **Trigger events** → **Cron triggers** → **Add**，逐条添加
   4 条（**Cloudflare 的 cron 只认 UTC**）：

   | cron 表达式 | 对应北京时间 |
   |---|---|
   | `0 0 * * *` | 08:00 |
   | `0 4 * * *` | 12:00 |
   | `0 8 * * *` | 16:00 |
   | `0 12 * * *` | 20:00 |

   添加界面会实时显示 "Estimated upcoming events (UTC)"，可以核对时间对不对。
   加完点右下角 **Save** 保存。

**方式 B：命令行（wrangler）**

```bash
cd deploy/cloudflare-worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN    # 粘贴 token，不回显
npx wrangler deploy
```

`wrangler.toml` 里已配好 4 条 cron 与普通变量，只需设 secret。

#### 第 3 步：验证 Worker 能触发

在浏览器打开你的 Worker 地址，例如：

```
https://elec-cron.<你的子域>.workers.dev/
```

- 显示 **`OK: workflow dispatched`** → 配置正确，去 <https://github.com/> 的 Actions 页确认多了一条
  `workflow_dispatch` 运行
- 显示 `config incomplete: GITHUB_TOKEN secret is missing` → Secret 没保存成功
- 显示 `FAILED: HTTP 401` → token 无效或过期
- 显示 `FAILED: HTTP 403` → token 权限不够（需 Actions: Read and write）
- 显示 `FAILED: HTTP 404` → 仓库名 / workflow 文件名写错了

> 首次访问可能需要等几秒（冷启动），若超时刷新一次即可。
> 部分地区 `*.workers.dev` 域名可能访问不通，这不影响定时触发——
> 触发方向是 Cloudflare → GitHub，不经过你的网络。

#### 第 4 步：切到 external 模式

Worker 验证通过后，让程序知道"现在是准点触发，窗口可以收窄"。

**如果仓库是自己部署的**（用 Actions 跑），改 `.github/workflows/elec-check.yml`：

```yaml
      - name: 执行查询
        env:
          QLGYDX_USER: ${{ secrets.QLGYDX_USER }}
          # ... 其它 secrets ...
          QLGYDX_SCHEDULE_MODE: external   # ← 加这一行
```

**如果本地跑**，改 `config.json`：

```json
{ "schedule": { "mode": "external" } }
```

改完正好是整点时段内的下一次触发就会用新窗口（±10 分钟）。

### 怎么切回 GitHub 自带定时

把上面那行 `QLGYDX_SCHEDULE_MODE: external` 删掉（或改成 `github`）即可，代码不用动。

工作流里的 `cron` **保持不动**（每 30 分钟一次）——它此时是兜底：
外部服务万一挂了，GitHub 的随机触发仍有小概率落在 30 分钟窗口内补上。

> ⚠️ 只改一边会出现"查询时间偏移"：如果程序已切回 `github`（窗口 ±30 分钟）
> 而 Cloudflare 还在准点触发，那么 7:30 就会开查，比准点早 30 分钟。
> 这不是 bug，是窗口语义变了。要彻底停用请把 Cloudflare 的 cron 也删掉。

### 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 到了点但 GitHub 没有新运行 | Worker 没触发 / cron 没保存 | 看 Cloudflare Worker 的 **Metrics** 与 **Cron Events** |
| GitHub 有运行但立刻退出 | 落在窗口外，或该时段已查过 | 看日志里的 `不在查询时段` / `已经查过` |
| 只成了一次，后面没有 | cron 只加了一条 | 检查 Cron triggers 列表是不是 4 条 |
| 时间差了 8 小时 | cron 写成了北京时间 | Cloudflare 只认 UTC，北京 8 点写 `0 0 * * *` |

### 成本

| 项目 | 用量 | 免费额度 |
|---|---|---|
| Cloudflare 请求 | 4 次/天 = 120 次/月 | 10 万次/天 |
| Cloudflare CPU | 每次约 1 毫秒（只发一个 HTTP 请求） | 10 毫秒/次 |
| GitHub Actions | 4 次/天 × 约 30 秒 | 2000 分钟/月 |

远低于免费额度。

---

### GitHub Actions 的定时触发不准，会丢失

**这是本项目最需要注意的一条。**

GitHub 的 `schedule` 不保证按时执行，也不保证每次都执行。实测（2026-11-03 ~ 11-07 五天）：

| 指标 | 数值 |
|---|---|
| 应触发 | 40 次 |
| 实际创建任务 | **9 次（22%）** |
| 实际触发分钟数 | 随机分布在 :10 ~ :53（cron 定的是 :17） |
| 排队时间 | 0 秒 |
| cancelled 记录 | 0 条 |

最后两行说明关键事实：**任务是在"被创建之前"就丢掉的，不是"创建后排队失败"，也不是"延迟补跑"**。
GitHub 会对到期的定时任务做**合并 + 丢弃**，且没有任何 API 或配置能改变这个行为。

**本项目的对策：高频试探 + 时段占位**

- `cron` 写成每 30 分钟一次（`7,37 * * * *`），一天 48 次机会；
- 代码里判断"当前落在哪个时段"（8/12/16/20 点各一个，各带 30 分钟提前量）；
- 每个时段**只要成功查一次**就记下标记，同一时段后续触发直接跳过。

这样即使 75% 的触发被丢掉，每个时段仍有很大概率至少活下来一次。
已用模拟验证：丢弃 75% 后仍能精确命中 8:00 / 12:00 / 16:00 / 20:00 四次。

**代价**：Actions 用量从每天 8 次的名义值涨到最多 48 次运行，
约 800 分钟/月（单次约 25-29 秒），在私有仓库 2000 分钟免费额度内。
其中大部分触发会因为"本时段已完成"而提前退出，只跑几秒。

**你仍然可能遇到的情况**：

- 某个时段的查询晚了 10-60 分钟（不影响使用，余额不会突变）；
- 极端情况下某个时段**一次都没成**（概率低，因为每时段有 8 次机会），该时段空一次，下个时段照常；
- 如果某个时段经常漏，把 `windowMinutes` 调大（如 60）能提高覆盖率。

**不要这样做**（都会让情况更糟）：

- ❌ 把 cron 改成正好 4 条（8/12/16/20 点各一条）——22% 的成功率下，一天可能只成 1 次；
- ❌ 用"距上次不足 N 分钟就跳过"来节流——延迟会打乱节奏，
  比如 8 点那次拖到 9:40，10:10 的触发被判"太近"跳过，12 点那个时段整个落空。

**想彻底解决？** 用一个免费的外部定时服务当闹钟，见
[外部定时](#外部定时可选让查询准点)——能让查询落在整点附近，误差约 1-2 分钟。

### 学校服务 23:40 关停

接口每天 23:40 ~ 00:00 维护，这期间的查询必然失败（返回"不在服务时间范围"）。
所以最后一个时段（20 点）的窗口在 23:40 截止，之后不再尝试。

### 其他

- 密码中的 `@` 是密码本身的一部分，原样提交即可（曾怀疑有特殊编码行为，实测无）
- 接口只提供余额，无用电量/消费流水；消耗速率与预测靠本地历史推算
- 请合理设置查询时间点，避免对学校服务器造成压力

---

### 想深入了解

- **接口原理（逆向笔记）**：[docs/INTERNALS.md](docs/INTERNALS.md) —— 五道关的细节、参数从哪来、排障时怎么按步定位
- **手机推送完整配置**：[docs/ntfy.md](docs/ntfy.md) —— 三步配好、各类消息、换用其它渠道
- **踩过的坑**：[docs/EXPERIENCE.md](docs/EXPERIENCE.md) —— 按需读，别通读

### 部署与运维

- **人类版详细步骤**：[docs/USAGE.md 附录 A](docs/USAGE.md#附录-a人类版详细步骤)
- 完整部署清单：[docs/DEPLOY.md](docs/DEPLOY.md)
- 准点方案（Cloudflare）：[docs/external-cron.md](docs/external-cron.md)
- Actions 方案详解与常见问题：[docs/github-actions.md](docs/github-actions.md)
- 自带常开机器时的替代方案：[docs/ntfy-relay.md](docs/ntfy-relay.md)

### 给 AI agent

- **操作手册**：[docs/USAGE.md](docs/USAGE.md) —— 面向 agent：先摸清现状、哪些必须问用户、怎么验证做对了

---

## 许可证

[MIT](LICENSE)。可以自由使用、修改、分发，请保留版权声明。

> 用之前请知悉：这个项目通过重放学校网页版的请求来查询电费，
> **不是学校的官方接口**。学校随时可能改动加密方式或加风控，
> 届时会失效。请自行评估使用风险，并控制查询频率（默认每天 4 次）
> 以免给学校服务器造成压力。
