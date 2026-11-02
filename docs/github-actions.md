# 用 GitHub Actions 跑定时电费查询

手机上那个 App 的定时是 WorkManager，被国产 ROM 杀掉后台就跑了不动。
把查询搬到 GitHub Actions 上，就是让一台大机器替你按时干活，
手机只负责**看数据**和**收通知**——即使你几天不开 App，数据也是新的。

---

## 先看清楚这套方案的边界

| 能力 | 能到吗 | 说明 |
|---|---|---|
| 定时查询 | ✅ | 每 5 分钟起步，建议 2 小时一次（本项目默认） |
| **准时** 查询 | ❌ | 高峰期会延迟 5–30 分钟，官方无 SLA |
| App 不打开也更新数据 | ✅ | App 启动/下拉时从云端拉快照 |
| 低余额推送手机 | ✅ | ntfy / PushPlus / Server酱 / 企业微信 / Bark / TG |
| 私有仓库跑定时 | ✅ | 可用，但消耗 Free 额度（2000 分钟/月） |
| 长期无人维护 | ⚠️ | 公开仓库 60 天无提交会被自动禁用（私有仓库不受影响） |

> **两条要注意的**：私有仓库能跑 `schedule`，只是要算额度 ——
> 本项目每 2 小时一次、8–24 点，约 160 分钟/月，离上限很远。
> 公开仓库则相反：不消耗额度，但 60 天没提交会被自动停掉定时。

---

## 一、先本地跑通

别一上来就 push，先在本地确认账号密码和推送渠道都对。

```bash
cd D:/Projects/elec
npm install
cp config.example.json config.json    # 然后填账号密码
node bin/elec.js check --force --dry-run
```

`--dry-run` 只打印不真发通知。看到类似这样的输出就成了：

```
余额 68.30 元  (示例校区学生公寓.示例园1号公寓A区.3楼.<房号>)
[dry-run] 将发送: 电费日报 — 当前余额 68.30 元，近 24 小时用掉 1.20 元…
```

然后配一个推送渠道，用真发模式验证一次：

```bash
QLGYDX_NTFY_TOPIC=my-secret-topic node bin/elec.js alert-test
```

手机装 [ntfy](https://ntfy.sh) App、订阅同一个 topic，应该立刻收到。
（ntfy 免费、不用注册、国内可直连，是最省事的一个。）

看到这一行说明渠道生效了：

```
测试通知已发送（渠道: console, file, ntfy），请检查手机/控制台是否收到。
```

如果显示 `（渠道: console, file）`，说明环境变量没传进去 ——
注意别写成 `node -e "..." TOPIC=xxx`，那样 `TOPIC=xxx` 是命令行参数不是环境变量。

---

## 二、建仓库

这里有个岔路口，选一个：

### 方案 A：公开仓库（最简单）

能用 `schedule`，免费。代价是**电表号、学号、仓库内容都公开**。

如果你不介意舍友看到你的余额，选这个。至少把密码放 secret：

```bash
cd D:/Projects/elec
git init
git add .
git commit -m "电费定时查询"
git branch -M main
git remote add origin https://github.com/BrainWangs/QLUhelper.git
git push -u origin main
```

⚠️ push 前务必确认 `.gitignore` 生效了，这两个文件**绝不能**进仓库：

```bash
git status --short | grep -E "config.json|data/" && echo "危险：有敏感文件要提交" || echo "干净"
```

### 方案 B：私有仓库 + 外部 cron（不推荐，仅在额度不够时考虑）

> **注意**：私有仓库**能**跑 `schedule`（见上面能力表），本项目默认就是私有仓库 + `schedule`。
> 只有当月额度快用完、又不想升付费时，才需要改用本方案走外部 cron。

外部 cron 走的是 `workflow_dispatch` 接口：

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/elec-check.yml/dispatches
Authorization: Bearer <有 repo 权限的 PAT>
{"ref":"main"}
```

免费的外部 cron 不少，`cron-job.org` 支持 1 分钟粒度且免费。
（需要先建一个 Personal Access Token，勾 `repo` 权限。）

这样数据全在私有仓库里，只有你自己看得到。

---

## 三、配置 Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 必填 | 说明 |
|---|---|---|
| `QLGYDX_USER` | ✅ | 学号/工号 |
| `QLGYDX_PASS` | ✅ | 统一身份认证密码，原样抄（`@` 是密码的一部分时别漏） |
| `QLGYDX_METER` | ✅ | 电表号，如 `示例园#1#A101` |
| `QLGYDX_NTFY_TOPIC` | 推送 | ntfy topic，随便起个别人猜不到的 |
| `QLGYDX_PUSHPLUS` | 推送 | PushPlus token |
| `QLGYDX_SCT_KEY` | 推送 | Server酱 SendKey |
| `QLGYDX_WECOM` | 推送 | 企业微信群机器人 webhook |
| `QLGYDX_BARK` | 推送 | Bark 推送地址 |
| `QLGYDX_TG_TOKEN` / `QLGYDX_TG_CHAT` | 推送 | Telegram bot token + chat id |
| `QLGYDX_REDACT` | 可选 | 设 `1` 时快照里的房号打码。私有仓库不用配；仓库要公开时必须配 |

推送渠道**至少配一个**，否则预警只写在 Actions 日志里——没人会去看。

> 早前的 `QLGYDX_PUBLISH_KIND` / `QLGYDX_PUBLISH_TOPIC`（把快照塞进 ntfy topic）
> 已废弃：快照现在由 workflow 直接推到仓库的 `data` 分支，不需要额外 secret。

---

## 四、手机上收数据

App 目前是**本机直连**模式：设置页填学号、密码 → 点「自动发现我的宿舍号」→ 之后
每次打开或下拉直接查学校接口，不依赖云端快照。

快照仍在 `data` 分支（`latest.json` / `history.jsonl` / 图表），主要供 README 折线图
和你自己查看。私有仓库的 raw 地址需要 token，所以 App 没走这条路。

如果你将来想让 App 读云端快照，可用的加速域名（2026-11 实测，国内宽带 + 手机 Clash）：

| 顺序 | 源 | 实测 |
|---|---|---|
| 1 | `fastly.jsdelivr.net` | ✅ 通 |
| 2 | `testingcf.jsdelivr.net` | ✅ 通 |
| 3 | `gcore.jsdelivr.net` | ✅ 通 |
| 4 | `cdn.jsdelivr.net` | ❌ **直接超时（被墙）** |
| 5 | `raw.githubusercontent.com` | ❌ **直接超时（被墙）** |

> ⚠️ 很多人默认以为 `cdn.jsdelivr.net` 是主站、`fastly.` 是备胎，其实是反的：
> 被墙的恰恰是不带前缀的 `cdn.jsdelivr.net` 和 `raw.githubusercontent.com`。
>
> 这张表是实测换来的，不是抄文档——如果你的网络环境不同（比如在校内网），
> 顺序可能又不一样，填「自定义地址」最保险。

如果你有自己的服务器或对象存储，填「自定义地址」最稳。

---

## 五、Workflow 干了什么

`.github/workflows/elec-check.yml` 每 2 小时（8–24 点）：

1. checkout 代码、装 Node、`npm ci`
2. 从 `actions/cache` 恢复上一轮的 `data/state.json`（会话）和 `history.jsonl`
3. `node bin/elec.js check` —— 查询、判预警、发通知、写快照
4. 把 `latest.json` 推到一个 **`data` 分支**（orphan 分支，不污染主分支历史）
5. 同时上传 artifact 留档 7 天

### 为什么要 cache 而不是直接提交 state

`data/state.json` 里有真实 SESSION cookie。
每轮都重新登录会：① 慢 1.8 秒 ② 每次都撞一次密码校验，白白增加风控风险。
用 cache 让大多数 run 直接复用餐会话，登录频率降到很低。

> cache 是 best-effort，GitHub 会在 7 天不访问后清理。
> 缓存丢了也不影响正确性——只是那一轮会重新登录一次。

---

## 六、常见问题

**Q: Actions 跑成功了，但手机拉不到数据？**

先看仓库有没有 `data` 分支：`https://github.com/<owner>/<repo>/tree/data`。
没有的话说明 workflow 里的 git push 失败了，去 Actions 日志找 `发布快照到 data 分支` 那一步。

**Q: 显示 `jsDelivr 返回 404`？**

jsDelivr 对新建分支有缓存，可能要等几分钟。也可以先用「自定义地址」填 raw 地址验证逻辑通不通。

**Q: 余额一直是旧的？**

App 里那张卡片会显示「数据已过期」，说明快照的 `queriedAt` 超过 3 小时。
去仓库 Actions 页面看 workflow 是不是被禁用了（公开仓库 60 天无提交会自动禁）。

**Q: 会不会因为频繁登录被锁号？**

不会——正常情况每轮都复用 cache 里的会话，不登录。
只有缓存丢了或会话过期才登一次。而且代码里**登录失败绝不重试**
（连续 3 次错密码会触发验证码锁定，而且锁定期正确密码也登不上）。

**Q: 能不能不公开电表号？**

用户名和电表号只放在 Secrets 里，不写进代码。
但方案 A 的快照会带 `custRechNo` 和 `location`（含房间号）——
介意就用方案 B（私有仓库）。

---

## 七、这套方案和手机 App 的分工

```
GitHub Actions ──定时查询──> 学校接口
     │
     ├──推送──> 手机通知（ntfy 等）
     └──写快照──> data 分支 ──拉取──> App 显示
```

App 仍然保留本地直连查询（点「查询」按钮、下拉刷新），
只是后台定时那一环**优先走云端**：云端有新鲜数据就不碰学校接口，
省一次登录、少一分风控风险。云端拿不到才回退到本地直连。

两边都判预警、都发通知，但各自有 cooldown（后端 180 分钟），
不会重复轰炸你。
