# 手机推送（ntfy）

> 本文是 [README](../README.md) 里"手机预警推送"的完整展开。
> 只想快速配好？看 README 的[快速开始](../README.md#快速开始)。
>
> **给 agent 的提示**：配置 ntfy 只涉及一个 secret `QLGYDX_NTFY_TOPIC`，
> 不需要登录请求。验证方式是 `node bin/elec.js alert-test`，
> 它只发推送、不碰学校接口，可以放心多跑几次。

ntfy 是一个开源的推送服务，**不用注册、不用装 SDK、国内可直连**，
发一条 HTTP POST 就能让手机弹通知。

## 工作原理

```
程序  --POST-->  https://ntfy.sh/<topic>  --推送-->  手机 ntfy App
```

`<topic>` 就是你随便起的一个字符串，相当于频道名。谁订阅了同名 topic
谁就能收到——所以**起个别人猜不到的**，别用 `test` / `elec` 这种。

## 三步配好

**第 1 步：手机装 App**

- Android：[Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/)
- iOS：App Store 搜 ntfy

**第 2 步：订阅 topic**

打开 App → 右下角 `+` → 输入你选的 topic（比如 `qlu-elec-a316-x7k2m`）→ Subscribe。

**第 3 步：告诉程序这个 topic**

在仓库 Settings → Secrets and variables → Actions 里加一条：

```
QLGYDX_NTFY_TOPIC = qlu-elec-a316-x7k2m
```

本地跑的话就写进 `config.json`：

```json
{ "alert": { "notify": { "ntfy": {
  "server": "https://ntfy.sh",
  "topic": "qlu-elec-a316-x7k2m"
} } } }
```

配好后可以立刻验证一次：

```bash
node bin/elec.js alert-test
```

手机会收到一条 `🔴 预警测试`——收到了就说明链路通了。

## 你会收到哪些消息

| 标题 | 优先级 | 触发条件 |
|---|---|---|
| 🔴 电费余额严重不足 | 5（持续响铃） | 余额 < 5 元 |
| 🟠 电费余额偏低 | 5（持续响铃） | 余额 < 10 元 |
| 🟠 电费消耗异常 | 5 | 24 小时内余额下降 ≥ 40% |
| 🟠 电费查询失败 | 5 | 连续查询失败 |
| 🟢 电费余额已恢复 | 3（安静） | 充值后回到阈值以上 |
| 🟢 电费日报 | 3（安静） | 每次查询成功后 |

同一类预警有冷却时间（默认 180 分钟），不会一直轰炸；
但严重不足状态下每 12 小时会重复提醒一次，避免你忽略。

> **为什么标题是中文还能正常显示**：HTTP header 不能直接放中文，
> 程序用 RFC 2047（`=?UTF-8?B?base64?=`）编码后再发，手机端会自动解码。

## 换别的推送渠道

ntfy 最省事，但不是唯一选择。`config.json` 的 `alert.notify` 里还支持
PushPlus、Server酱、企业微信机器人、Bark、Telegram——配哪个用哪个，
也可以同时配多个（会同时发）。

