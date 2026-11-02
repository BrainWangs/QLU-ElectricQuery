# 不用 GitHub 的定时方案（本地 watch + ntfy）

如果你只是想要「定时查询 + 低余额提醒」，
**不需要 GitHub Actions**。这条路更短，而且不受下面这些限制：

| 限制 | GitHub Actions 方案 | 本方案 |
|---|---|---|
| 免费私有仓库要算额度 | ⚠️ 消耗 2000 分钟/月额度 | ✅ 无关 |
| 公开仓库 60 天无提交被禁用 | ⚠️ 受制（私有仓库不受影响） | ✅ 无关 |
| `github.com` 国内可达性 | ❌ 实测被墙 | ✅ 无关 |
| 需要 GitHub 账号 | ✅ 需要 | ✅ 不需要 |
| 要有一台常开的机器 | ✅ Actions 代劳 | ⚠️ **需要**（见下） |

> **唯一代价**：得有个地方跑 `node bin/elec.js watch`。
> 家里旧笔记本、树莓派、Nas、公司的常开台式机都行。
> 如果你没有常开机器，那还是用 GitHub Actions（见 `github-actions.md`）。

---

## 它怎么工作

```
常开机器: node bin/elec.js watch
   │
   ├── 每 N 分钟查一次余额
   ├── 判预警 ──> ntfy 推送 ──> 手机通知
   └── 落本地 history.jsonl（图表用）
```

预警直接由本机的 `watch` 进程发到 ntfy topic，手机装 ntfy App 订阅同名 topic 即可。

> **关于快照**：早前版本支持把快照 POST 到 ntfy topic 当「寄存柜」供 App 轮询，
> 该方案已废弃（`cloud.publish.*` 相关配置不再生效）。App 现在走本机直连查询。

---

## 配置

只需要配预警的 ntfy topic：

```json
{
  "alert": {
    "notify": {
      "ntfy": {
        "server": "https://ntfy.sh",
        "topic": "换成别人猜不到的字符串"
      }
    }
  }
}
```

也可以全走环境变量，适合 Docker / systemd：

```bash
QLGYDX_NTFY_TOPIC=<预警 topic>
```

---

## 跑起来

先验证一次（不常驻）：

```bash
node bin/elec.js check --force
```

看到这两行就成了：

```
INFO  余额 68.30 元  (示例校区-示例园1A101)
INFO  🟢 电费日报
```

然后常驻：

```bash
node bin/elec.js watch
```

### 开机自启（Windows）

用任务计划程序建一个「计算机启动时」触发的任务，操作填：

```
程序:   node.exe 的完整路径
参数:   bin\elec.js watch
起始于: D:\Projects\elec
```

（`起始于` 必须填，否则相对路径的 `data/` 会跑到系统目录去。）

### 开机自启（Linux / 树莓派）

`/etc/systemd/system/elec.service`：

```ini
[Unit]
Description=QLU 电费监控
After=network-online.target

[Service]
WorkingDirectory=/opt/elec
ExecStart=/usr/bin/node bin/elec.js watch
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now elec
```

---

## 手机端怎么收

装 [ntfy](https://ntfy.sh/)（Play Store / F-Droid / App Store 都有），
订阅上面配的 topic 即可收到预警和日报推送。

- 预警类消息：优先级 5（持续响铃震动），锁屏显示 `🟠 电费余额偏低` 这类中文标题
- 日报/恢复类：优先级 3，安静推送

ntfy 免费版消息保留 12 小时，够用。

---

## 两个方案怎么选

- **有常开机器** → 用这个，更简单、更可控、不受 GitHub 可达性影响
- **没有常开机器** → 用 `github-actions.md`，私有仓库照样能跑定时（只是算额度）

两个方案可以**同时开**：Actions 兜底，本地 watch 主用。
只是要注意预警通知会从两边各发一次——把其中一边的 `alert.notify` 关掉即可。
