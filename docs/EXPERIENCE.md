# EXPERIENCE.md

踩过的坑。**按需读取**——只在你要改相关模块时才看。

每条满足三个条件才收进来：可复现、下次还会踩、看报错看不出来。

---

## `queryBalance` 是 bug 高发区，改它必须让变异测试变红

- **现象**：余额显示"正常"但实际接口给了垃圾值；或者整条 `check` 抛 `TypeError: Cannot read properties of null` 退出。
- **真因**：`lib/qlgydx.js:360-385` 的响应解析从未被测试覆盖（函数覆盖 **8.70%**）。`pick('JC_remoney')` 的原值直接过 `Number()`：`''` → `0`（触发假的 critical 告警）、`'65.42元'` → `NaN`（静默"一切正常"，JSON 序列化成 `null`）。
- **处置**：改这一段时，验收标准不是"补了测试"，而是**让 D 报告里的变异 M1 / M2 由存活变杀死**。
  M1 = `pick()` 的 `: null` 改 `: undefined`；M2 = `balanceRaw === null ? null : Number(...)` 改成直接 `Number(...)`。
  两个变异现在都能存活，说明测试完全没保护这里。变异表见 `docs/review/D-tests-architecture.md` §1.4。
- **发现**：2026-11-07，commit `4799cc0`

---

## 判断 CI 是否真跑了某段逻辑，要看 Actions 日志，不能只读 YAML

- **现象**：`elec-check.yml` 里有一段"从 data 分支补齐历史"的代码，注释写着"data 分支才是历史的真正权威"，读起来完全正确——但它**自始至终没有生效过**。
- **真因**：`actions/checkout@v4` 默认是单分支克隆，refspec 为 `+refs/heads/main:refs/remotes/origin/main`（窄）。这种配置下 `git fetch origin data` 只写 `FETCH_HEAD`，**不创建 `refs/remotes/origin/data`**。于是 `git cat-file -e origin/data:history.jsonl` 恒失败，`if` 分支永不进入，每次打日志"data 分支尚无 history.jsonl，跳过"。
- **处置**：显式指定 refspec —— `git fetch --depth 1 origin data:refs/remotes/origin/data`（已实测可建立引用），并加 `mkdir -p data`（全新 runner 上 `data/` 不存在，`>>` 会因目录缺失而中止整步）。
  判据：翻最近几次 Actions 日志，若每次都打"跳过"，即为线上证据。
- **发现**：2026-11-07，commit `4799cc0`

---

## `deepMerge` 会把数字吃掉变成 `{}`，且污染全局默认值

- **现象**：`meter.userInfoId` 在 `config.json` 里明明填的是数字，但发给学校接口时变成 `{"userInfoId":{}}`。
- **真因**：`lib/config.js:58-66` 的 `deepMerge` 用 `typeof base !== 'object'` 判分支，而 `typeof null === 'object'`。默认值是 `null` 时走进对象分支，`{...null}` 得 `{}`，`Object.entries(数字)` 得空数组，最终返回 `{}`。
  第二个坑：配置里缺子树时 `deepMerge` 直接 `return base`，**返回的是 `DEFAULTS` 的引用**。于是环境变量覆盖会就地改写 `DEFAULTS`，同一进程内第二次 `loadConfig()` 会"粘住"上次的 env 值。
- **处置**：`deepMerge` 必须在 `over` 为原始值/`null` 时直接返回 `over`，且不返回 base 的引用（要深拷贝）。
  改之前先确认当前破坏程度：`node -e "console.log(typeof require('./lib/config').loadConfig().meter.userInfoId)"` —— 现在输出 `object`，正确应为 `number`。
- **发现**：2026-11-07，commit `4799cc0`

---

## 不能只看函数覆盖率，模块顶层被执行会虚高分支覆盖

- **现象**：`node --test --experimental-test-coverage` 显示 `lib/notify.js` 分支覆盖 **100%**，看起来测得很充分。
- **真因**：`lockout.test.js` require 了 `bin/elec.js`，后者又 require 了 `notify.js`，模块顶层跑过一遍而已。它的**函数覆盖率是 0.00%**——7 个渠道一个都没被调用过。
- **处置**：看覆盖率一律以"函数覆盖"为准，不看分支覆盖。另：`bin/serve.js` 和 `scripts/render-chart.js` 根本不在覆盖率报告里（没有任何 require 边指向它们），等于完全隐形。
- **发现**：2026-11-07，commit `4799cc0`

---

## 测试全绿之后，必须再验证"测试是否真的能变红"

- **现象**：给 `deepMerge` 写完 13 条回归测试，全部通过，看起来已经锁死了。随后做变异测试，把实现**整体回退成旧版有 bug 的代码**，13 条**依然全绿**。
- **真因**：第一版"变异"根本没注入成功——我用 `python` 写文件，但这个环境里 `python` 不存在，脚本静默失败，文件原封不动，于是"测试抓住了变异"变成了"测试跑在没变异的代码上"。**绿灯是假的。**
  改用 `node` 重做后才暴露真问题：13 条里确实有 2 个变异（M2 去掉深拷贝、M3 只判 `undefined`）**仍然存活**——因为我的用例只覆盖了"配置里有值"的路径，没覆盖"整个 over 为 undefined"和"base 为 null 但 over 是对象"。
  补上两条后 3/3 全杀。
- **处置**：改完核心函数后，至少做一次变异验证，且**先确认变异真的注入了**（注入脚本要能自证：改前 ≠ 改后，否则 exit 2）。
  判据不是"测试通过"，是"注入变异后测试必须变红"。
- **发现**：2026-11-07，阶段 0 执行期间

---

## 报告里的"当前正在发生的故障"要自己复现一遍再信

- **现象**：审查报告称真实 `config.json` 里的 `meter.userInfoId` **已被破坏成 `{}`**，并把它列为"正在发生的故障"。实测 `loadConfig().meter.userInfoId` 确实是 `object`，数字 `{}` 也确实是 `{}`——看起来完全吻合。
- **真因**：**磁盘上的 config.json 一直是好的**，里面填的是 8 位数字。坏的不是文件，而是 `loadConfig()` 的**返回值**：`deepMerge(DEFAULTS, user)` 里 `DEFAULTS.meter.userInfoId` 是 `null`，而 `over` 是数字，走进对象分支被吞成 `{}`。
  这个区别很关键：如果按报告的理解去"从备份恢复 config.json"，会找不到备份（仓库 `*.bak` 被 gitignore，本地也没有），而且**即使恢复了也没用**——下一次 `loadConfig()` 照样把它变回 `{}`。
  正确顺序是**先修 `deepMerge`，再验证返回值**，文件本身根本不用动。
- **处置**：报告给的是"症状位置"，不一定等于"修复位置"。凡是"某字段值不对"的结论，先分清是**持久化数据错了**还是**加载路径错了**，再决定要不要改文件。
- **发现**：2026-11-07，阶段 0 执行期间（`lib/config.js`）

---

## `actions/cache` 的 key 固定=冻结，不是"提高命中率"

- **现象**：审查报告说 CI 的 `key: elec-state-${{ github.run_id }}` "含 run_id 所以永不命中"，看起来很有道理——每轮 key 都不同，怎么可能命中？于是改成固定的 `key: elec-state-v1`。
- **真因**：**反了。** `actions/cache` 的缓存是**不可变**的，restore 时一旦精确命中 primary key 就直接跳过保存：
  `Cache hit occurred on the primary key elec-state-v1, not saving cache.`
  所以固定 key 从第二轮起就再也存不进去，`data/state.json` 冻结在第一轮。
  而唯一 key + `restore-keys: elec-state-` 前缀匹配才是**官方推荐**形态：每轮 restore 到上一轮、且每轮都能保存新内容。
  官方原文（`actions/cache` 的 `tips-and-workarounds.md`）：
  > "A cache today is immutable and cannot be updated. But some use cases require the cache to be saved even though there was a 'hit' during restore. To do so, use a `key` which is unique for every run and use `restore-keys` to restore the nearest cache."
- **后果为什么严重**：冻结的不是"命中率"，是**登录熔断状态**（`loginFailures` / `loginLockedUntil`）。它们传不到下一轮 = 熔断失效 = 回到 AGENTS.md 第 1 条要防的锁号场景。
- **处置**：保持 `key: elec-state-${{ github.run_id }}` 原样，不要"修"它。
  教训：**"每轮都变"不等于"永不命中"**——`restore-keys` 做的是前缀匹配，变的是 primary key，不变的是前缀。
  凡是涉及第三方 Action 的语义，先查它自己的文档/源码，不要从参数名字推断行为。
- **发现**：2026-11-07，阶段 0 执行期间（独立复核者提出，主审用官方文档核实后回退）

## 5. 单元测试全绿 ≠ 程序能跑：CLI 执行路径必须冒烟测试

- **现象**：阶段 3 重构熔断段时，我把 `doQuery` 和 `ensureLogin` 两个函数连同旧代码块一起删掉了。
  `npm test` 的 **213 条全绿**，本地 `node --check` 也过。推到 main、触发真实 CI 后第一步就炸：
  `ERROR 查询失败: doQuery is not defined` → 退出码 1 → 整条定时任务失败。
- **真因**：`require('./bin/elec.js')` 只执行模块**顶层**。函数体内的引用错误要等函数**真被调用**才暴露。
  而原先没有任何测试碰 CLI 的执行路径——测试只 `require` 了它来拿几个纯函数。
  **函数被删掉这件事，对 require 式测试完全不可见。**
- **为什么"缺少配置"的测试也抓不到**：配置校验在调用 `doQuery` **之前**就 return 了。
  写了个"缺配置应报错"的测试，删掉 `doQuery` 后它依然全绿——它根本没走到出事的那一行。
- **正确做法**：必须有一条测试**走到出事的位置**。现在的 `test/cli.test.js` 有两条：
  1. 空目录 + 假凭据 → 命令必然失败，但失败的**原因**必须是网络/认证，不能是 `ReferenceError`；
  2. 断言输出里**没有**"配置错误"，即确实越过了配置校验。
  实测：删掉 `doQuery` → 第 2 条立刻红。这才是有效护栏。
- **测试自身也有陷阱**：第一版隔离只清空了 `QLGYDX_USER/PASS/METER`，结果命令读到了仓库根目录的
  真实 `config.json`，**成功查询并打印了真实房号与电表号**。
  `loadConfig()` 的默认路径是 `path.resolve(__dirname,'..')`，与 cwd 无关。
  修法：新增 `QLGYDX_CONFIG` 环境变量覆盖（原先不存在），并让测试在 `mkdtemp` 的空目录里跑。
  教训：**验证"缺配置"的测试，必须先确保配置真的不在**——否则它测的是"我有配置"。
- **发现**：2026-11-07，阶段 3 真实 CI（run 42364327489）

## 6. "损坏状态"必须能挡住登录，否则安全模式形同虚设

- **背景**：`state.json` 损坏时程序进入安全模式（`stateCorrupt: true` + 24 小时熔断），
  目的是不拿可能已失效的密码去打 SSO。
- **踩到的坑**：写测试时我图省事用 `delete state.loginLockedUntil` 来"解除熔断"，
  结果登录依然被拦——因为 `lockoutStatus` 在 `stateCorrupt` 为真时**直接判熔断**，
  与时间戳无关。
- **这不是 bug，是设计对了**：如果手改一个字段就能绕过安全模式，那安全模式没有意义。
  解除必须走 `clearLoginFailure()`（即 `check --reset-lockout`），它会一并清掉损坏标记。
- **教训**：写"解除熔断"的测试时，要按**用户真实会走的那条路**解除，
  不要用"删一个字段"这种生产环境不存在的手法——那会把设计意图测反。

## 7. 重构"发送逻辑"时，要检查"发出去的东西长什么样"，而不只是"有没有发"

- **现象**：用户截图反馈，手机上收到的 ntfy 推送是一条原始 JSON：
  ```
  {"message":"当前余额 44.27 元。\n示例校区-示例园1A101"}
  ```
  而不是「当前余额 44.27 元」。
- **真因**：阶段 5 把通知层拆成 `lib/notify/` 时，ntfy 的 body 从**纯文本**改成了
  `JSON.stringify({message: text})`。而 ntfy 的 `POST /<topic>` 端点把**整个 body
  当成消息正文**——你发什么它就显示什么。
  ntfy 确实支持 JSON 发布，但那是**另一套用法**：JSON 要发到根路径 `/`，
  且 JSON 里必须带 `topic` 字段。两种用法不能混。
- **为什么 343 条测试没抓到**：测试只验证"渠道被调用了""报告里 ok=true"，
  没有验证"发出去的 body 长什么样"。**测了行为的存在，没测行为的内容。**
- **同批被改坏的还有两处**（人眼比对改造前后代码才发现）：
  - **Bark** 从 `GET` 改成了 `POST` + 空 body。Bark 的 URL 式 API 只接受 GET，
    POST 会被忽略 → 表现为「日志说发送成功，手机没收到」，比报错难发现得多。
  - **企业微信** 从 `msgtype: markdown` 改成了 `text` → 正文里的 `**加粗**`
    和链接会原样显示成符号。
- **正确做法**：重构对外发送的代码时，必须做两件事——
  1. **逐渠道比对改造前后的请求形态**（方法、Content-Type、body 结构、header），
     不能只看"函数签名没变"；
  2. **加拦截 fetch 的测试**，直接断言发出去的 body。现在的 `test/notify.test.js`
     里有 `captureFetch()`，断言了「ntfy body 必须是纯文本」等 6 条。
     实测把 bug 注入回去 → 立刻红（fail 2）。
- **发现**：2026-11-07，由用户截图发现（自动化测试全部全绿）

## 8. 通过网页表单配置云服务时，"输入不进去"通常不是网络问题

- **背景**：用 Cloudflare Dashboard 配置 Worker 的 Secret 与 Cron Trigger，
  期间多次出现"点了输入框、文字却输进去了别的字段"或"输入后界面毫无变化"。
- **真因有三个，且都不是网络**：
  1. **受控组件不吃剪贴板粘贴**。Cloudflare 的表单是 React 受控组件，
     `ctrl+c/v` 方式粘贴时，值没有触发 onChange，界面看起来没反应。
     改用 `sendinput`（逐字符合成按键）才生效。
  2. **超长内容把容器撑宽，关键控件被挤出可视区**。粘入 93 字符的 GitHub token 后，
     对话框横向滚动，右侧的 `Secret` 复选框跑到视野外——差点把 token 存成明文。
     解决办法：**先填一个短占位值（如 `x`）→ 勾上 Secret → 再把真值替换进去**。
  3. **printwindow 截图会漏掉弹层**。对话框已经打开，但截图只渲染了背后页面，
     导致误判为"点击无效"。改用 desktop 截图（或直接查 accessibility tree）才看到真实状态。
- **教训**：
  - 判断"点击是否生效"不能只看截图字节数没变就重试——先查 accessibility tree 确认控件状态；
  - 涉及敏感值（token）时，**先勾 Secret 再填值**，避免长文本撑宽界面导致复选框被遮；
  - 界面操作路径很长时，优先找命令行或 API 途径（本次 wrangler 需要交互登录，才退回界面操作）。
- **发现**：2026-11-08，配置 Cloudflare Worker 期间
