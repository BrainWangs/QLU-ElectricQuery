# 外部定时（Cloudflare Workers）—— 让查询真正准点

## 这是干什么的

> **给 agent**：本文是**人类视角**的完整点击步骤。
> agent 视角的操作手册（含分工、验证、排障、实测基准）见
> [USAGE.md §6](USAGE.md#6-外部定时可选让查询准点)。
> 两边内容一致，只是组织方式不同——改一处记得同步另一处。

GitHub 自带的定时（`schedule: cron`）**不准，而且会丢**。实测数据（2026-11-03 ~ 11-07）：

| 指标 | 数值 |
|---|---|
| 应触发 | 40 次 |
| 实际创建任务 | **9 次（22%）** |
| 实际触发分钟数 | 随机分布在 :10 ~ :53（配置的是 :17） |
| 排队时间 | 0 秒 |
| cancelled 记录 | 0 条 |

最后三行说明：任务是在**创建之前**就被合并丢弃了，不是"延迟补跑"。

结果是"每天 4 次"变成"每天碰运气 1-3 次"。

**解决办法**：改用 Cloudflare Workers 的 Cron Trigger 当闹钟——它是准点的（秒级），
由它每天在 8/12/16/20 点各发一个 HTTP 请求给 GitHub，触发 `workflow_dispatch`。

用 Cloudflare 而不是 cron-job.org 的原因：

| | Cloudflare Workers | cron-job.org |
|---|---|---|
| 费用 | 免费额度：10 万次请求/天 | 免费 |
| Secret 存储 | **加密存储**，不会在请求里明文传 | 明文存在请求头里 |
| cron 精度 | 秒级 | 分钟级，官方声明不保证准点 |
| 你已注册 | ✅ | ❌ |

---

## 两种模式并存，可随时切换

代码里加了 `schedule.mode`，默认 `"github"`（维持现状）。

| mode | 谁在计时 | 时段窗口 | 适用 |
|---|---|---|---|
| `"github"` | GitHub 自带 cron | 准点前后各 **30 分钟** | 现状，容错优先 |
| `"external"` | Cloudflare Workers | 准点前后各 **10 分钟** | 准点优先 |

**共同点**：两种模式共用同一套「时段去重」——同一时段只查一次、只推一次。
**切换方式**：改 `config.json` 里一个字段，改完立即生效，不用改 workflow。
**回退**：改回 `"github"` 即可，Cloudflare 那边停不停都不影响正确性
（它的触发会被 10 分钟窗口挡掉，但 `github` 模式下窗口变 30 分钟……详见下方"回退注意事项"）。

---

### 方式 A：网页版（推荐，不用装任何东西）

1. 打开 <https://dash.cloudflare.com/> → 左侧 **Workers & Pages** → **Create**
2. 选 **Start with Hello World!** → 随便起个名字，比如 `elec-cron` → **Deploy**
3. 点 **Edit code**，把本仓库 `deploy/cloudflare-worker/worker.js` 的**全部内容**粘贴进去 → **Deploy**
4. 回到 Worker 页面 → **Settings** → 找到 **Runtime variables and secrets** → **+ Add variable**：
   - **Key** 填 `GITHUB_TOKEN`，**Value** 填你的 fine-grained PAT
     （GitHub → Settings → Developer settings → Fine-grained tokens →
      只选 `QLUhelper` 仓库 → Permissions: **Actions: Read and write**）
   - **务必勾选右侧的 `Secret` 复选框**（勾上后 Value 会变成圆点，加密存储）
   - 点 **Add variable and deploy** 保存
   - 同样方式再加 4 个**普通变量**（不勾 Secret；不填也可，代码里有默认值）：
     - `GH_OWNER` = `BrainWangs`
     - `GH_REPO` = `QLUhelper`
     - `GH_WORKFLOW` = `elec-check.yml`
     - `GH_REF` = `main`

   > **实际操作提示**：添加 Token 时先填一个短占位值（如 `x`）→ 勾选 Secret → 再把真值
   > 粘进 Value。因为超长的 token 会把对话框撑宽，导致 Secret 复选框被挤出可视区域。
   > 保存后可在列表里看到类型是 **Secret**、值是 **Value encrypted**。
5. **Settings** → 往下滚到 **Trigger events** → **Cron triggers** → **+ Add**：
   添加以下 4 条（**UTC 时间**，Cloudflare 的 cron 只认 UTC）：

   | cron 表达式 | 对应北京时间 |
   |---|---|
   | `0 0 * * *` | 08:00 |
   | `0 4 * * *` | 12:00 |
   | `0 8 * * *` | 16:00 |
   | `0 12 * * *` | 20:00 |

6. 添加时切到 **Cron expression** 标签页（另一个 Schedule 标签页是图形化的，也能用）。
   每加一条都会弹出对话框，输入表达式后下方会实时显示 **Estimated upcoming events (UTC)**，
   **核对这里的时间对不对**，然后点 **Add**。
   加完 4 条后，页面底部会出现 "Unsaved changes" 提示条，**必须点 Save** 才真正生效。

7. **验证**：在浏览器打开你的 Worker 地址（如 `https://elec-cron.你的子域.workers.dev`），
   看到 `✅ 已触发 ...` 就说明 token 和仓库名都对了。
   然后去 <https://github.com/你的用户名/你的仓库名/actions> 确认多了一条 `workflow_dispatch` 运行。

### 方式 B：命令行（wrangler）

```bash
cd deploy/cloudflare-worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # 粘贴 PAT，不回显
npx wrangler deploy
```

`wrangler.toml` 里已经配好了 4 条 cron 与 4 个普通变量，只需设 secret。

---

## 部署后：切到 external 模式

验证 Worker 能成功触发之后，改 `config.json`：

```json
{
  "schedule": {
    "mode": "external",
    "slots": [8, 12, 16, 20]
  }
}
```

改完提交推送，下一轮生效。

此时 GitHub 自带的 cron **仍然保留**（不删除），但它的触发大多落在 10 分钟窗口外，
会被自动跳过——这就是兜底：万一 Cloudflare 那边出问题，GitHub 的随机触发仍有小概率补上。

---

## 回退注意事项

把 `mode` 改回 `"github"` 后，窗口变回 ±30 分钟。此时 Cloudflare 若还在按点触发，
它会在 7:30 就落进窗口、立刻查询——**比准点早 30 分钟**。

如果你要彻底回退，建议**两边都做**：

1. `config.json` 改回 `"mode": "github"`
2. Cloudflare 那边删掉 4 条 Cron Trigger（或直接删掉 Worker）

只改一边会出现"查询时间偏移"的现象，不是 bug，是窗口语义变了。

---

## 成本

| 项目 | 用量 | 免费额度 |
|---|---|---|
| Cloudflare 请求 | 4 次/天 = 120 次/月 | 10 万次/天 |
| Cloudflare CPU | 每次约 1ms（只发一个 fetch） | 10ms/次 |
| GitHub Actions | 4 次/天 × 约 30 秒 | 2000 分钟/月 |

两边都远低于免费额度。

---

## 排障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| Worker 返回 401 | token 无效或过期 | 重新生成 PAT，更新 secret |
| Worker 返回 403 | token 权限不足 | 确认勾了 `Actions: Read and write` |
| Worker 返回 404 | 仓库名/workflow 名写错 | 检查 `GH_REPO`、`GH_WORKFLOW` |
| Worker 正常但 GitHub 没跑 | workflow 文件里没有 `workflow_dispatch` | 本仓库已有，检查是否被改掉 |
| 到了点但没查 | 落在窗口外，或该时段已完成 | 看 Actions 日志里的 `不在查询时段` / `已经查过` |

Cloudflare 侧的日志：Worker 页面 → **Logs** → **Begin log stream**（实时）
或 **Metrics** 看调用次数与错误率。
