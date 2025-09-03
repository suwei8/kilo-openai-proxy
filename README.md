# kilo-openai-proxy · 极简设计文档

## 目标：** WebUI驱动Gemini以OpenAI 兼容接口代理为本地个人使用的API服务 、 极简、高性能、Node 实现,支持清洗 KiloCode 请求头与请求体、稳定流式返回的API代理服务器*

##  默认适配 Windows/PowerShell 开发环境。

## 0. 核心理念（和以前版本的不同点）

* **只做一件事**：把 *OpenAI 兼容* 的 `/v1/chat/completions` 请求，转成一次 Gemini WebUI 的对话提交，并把增量 Token 以 **SSE** 回给调用方（KiloCode）。
* **固定单页单实例**：仅维护一个 Playwright 上下文和一个 Gemini 页面，**不随请求拉起新进程**，规避“每发一次请求就多两个进程”的老问题。
* **请求“清洗”**：对 KiloCode 的请求头和请求体进行**严格白名单**提取，**仅保留必要字段**，不把大而乱的原始体转给 Gemini，实测仍可得到带标签的回复。
* **串行队列**：**同一时间只处理一个在途请求**（本地个人用足够），避免复杂并发同步与崩溃。
* **极简可维护**：**一个 Node 进程 + 一份 server.js**（MVP），如需更清爽，可拆到 2\~3 个文件，但默认一文件够用。

---

## 1. 目录结构（两套方案）

### 方案 A：**单文件 MVP**（最简单）

```
kilo-openai-proxy/
├─ package.json
├─ .env                # 仅少量变量
└─ src/
   └─ server.js        # 全部逻辑：Express + Playwright + SSE + 清洗器
```
---

## 2. .env 最小集合

```ini
PORT=8033
HEADLESS=false          # true/false
USER_DATA_DIR=.userdata # 持久化登录（避免每次扫码/登录）
GEMINI_URL=https://gemini.google.com/app
WAIT_READY_MS=2000      # 页面加载稳定等待
MAX_INPUT_TOKENS=12000  # 输入上限（简单裁剪）
```

---

## 3. 接口与契约

### 3.1 路由（仅 3 个）

* `GET  /healthz`：返回 `{ok:true}`
* `GET  /v1/models`：返回最小模型列表（写死一两个别名，满足 KiloCode）
* `POST /v1/chat/completions`：

  * **请求体（白名单）**：

    * `model`（忽略实际值，统一映射到 Gemini WebUI）
    * `messages`（**只取最后一段合成 prompt**；保留 `<task>` 等标签原文）
    * `stream`（true/false，默认 true）
    * 可选：`temperature`、`top_p`、`max_tokens`（仅用于说明，**不传 Gemini**）
  * **响应**：OpenAI 兼容格式；SSE 时发送 `data: {id, object, choices:[{delta:{content}}] ... }`

### 3.2 KiloCode 请求头清洗（白名单 + 屏蔽）

* **保留**：`content-type`, `accept`, `user-agent`（可替换成统一 UA）
* **显示屏蔽**：`X-Title`, `X-KiloCode-Version`, `X-Stainless-*`, `Referer`, `Authorization`（你本地使用，无需这类元信息）
* **统一 UA**：避免外部信息泄露与分支逻辑

  * 例：`User-Agent: kilo-openai-proxy/0.1 (+node)`

---

## 4. 运行机制（关键路径）

### 4.1 启动时

1. 启动 Express。
2. `ensureBrowser()`：

   * Playwright 打开持久化上下文（`USER_DATA_DIR`）。
   * 打开 `GEMINI_URL`，等待页面 ready（`WAIT_READY_MS` + DOM 心跳）。
   * 注入少量 DOM 辅助逻辑（输入框选择器、发送按钮、响应区监听）。

### 4.2 请求 lifecycle（串行）

1. `/v1/chat/completions` 收到请求 → 进入“单请求锁”（队列实现或简单互斥）
2. 清洗 Header、Body。
3. `submitPrompt(prompt)`：

   * 定位输入框 → 填写 → 点击“发送”（或回车退化）
4. `readStream()`：

   * 监听 Gemini 的答案区域（通过 `MutationObserver`/aria-live），**按段增量**提取纯文本。
   * **过滤 UI 杂质**（保留原始标签 `<task>...</task>` 这类用户重要标记）
   * 每次增量 → 组装为 OpenAI SSE 分片 → `res.write(...)`
5. 结尾发送 `[DONE]` 或一次性 JSON（非流式）。

> **注意**：**不做二次加工**，不插入你自己的标签，避免触发 KiloCode 的模板歧义。

---

## 6. KiloCode 兼容策略

### 6.1 为什么“清洗请求体”也能拿到带标签回复？

* 已验证：**不需要把 KiloCode 的大而全请求体原封转发**，只要把 **最终 prompt 文本**（含 `<task>`、`<write_to_file>` 这类标签）送给 Gemini，**Gemini 也会输出带标签的结构化内容**。
* 因此：只需从 `messages` 聚合出文本并传给 WebUI，其他 metadata（工具、函数调用、system prompt 等）**不强依赖**。

### 6.2 黑名单头/体

* **头**：`X-Title`, `X-KiloCode-Version`, `X-Stainless-*`, `Authorization`, `Referer` 等全部丢弃。
* **体**：仅保留 `model/messages/stream/temperature/top_p/max_tokens`，**其它忽略**。

---

## 7. 稳定性与性能要点

* **不额外 spawn 进程**：只用一个 Playwright *persistent* context + 一个 page，避免“请求触发拉新进程”。
* **串行**：`busy` 锁避免并发引起 DOM 冲突、监听错乱、回答串线。
* **短轮询 + MutationObserver** 双保：极简可靠；**不打印 URL**、不做花哨日志。
* **输入/输出裁剪**：可在 `toPrompt()` 里做简单长度裁剪，防止极端长文本拖慢页面。
* **失败恢复**：页面 crash 时可在 `ensureBrowser()` 中检测并重启（后续再加）。

---

## 8. 启动与测试

### 8.1 安装

```bash
npm init -y
npm i express playwright
npx playwright install chromium
```

### 8.2 运行

```bash
node src/server.js
# 首次需在打开的 Gemini 页面完成登录；之后 USER_DATA_DIR 会记住登录态
```

### 8.3 PowerShell 测试（不打印 URL，UTF-8 正常）

```powershell
$headers = @{ 'Content-Type'='application/json' }
$body = @{
  model='gemini-webui'
  messages=@(@{role='user'; content='你好，请用中文回答：测试下流式 OK？<task>echo hi</task>'})
  stream=$true
} | ConvertTo-Json -Depth 5
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Invoke-WebRequest -Uri 'http://127.0.0.1:8033/v1/chat/completions' -Method POST -Headers $headers -Body $body -UseBasicParsing
```


---

## 9. 故障排查（针对最近遇到的问题）

* **请求引发多进程**：本设计**不在请求时 launch 浏览器**，而是进程启动时 `launchPersistentContext()` 一次到位，**单实例复用**。
* **KiloCode 死问不结束**：我们在 `readAnswerInChunks()` 中同时观察“增量变化”和 `aria-busy`，**确保能正确判定完成并 `[DONE]`**。
* **乱码/中文**：测试脚本里统一 `UTF-8`，并且 SSE 输出不强制设置奇怪编码。
* **URL 垃圾日志**：默认**不打印**页面资源 URL；log 仅一行监听端口。

---

## 10. 后续可选的“小幅增强”（保持极简前提下）

* **队列化**：把 `busy` 升级为简易 FIFO 队列，避免 429。
* **更稳的 DOM 选择器**：针对你当前 Gemini UI 的具体版本固化三个选择器：

  * 输入框（`textarea`）
  * 发送按钮（fallback：Enter）
  * 回答容器（`div[id^="model-response-message-content"] .markdown`）
* **最小监控**：只加 `/metrics` 返回当前 in-flight、browser 状态与 uptime。
* **“软重启”**：异常时自动 `page.close()` → `newPage()`，尽量不杀上下文。

---

## 11. 版本边界与非目标

* **不做**：多模型路由、鉴权、多租户、缓存集群、复杂 A/B、日志平台对接。
* **不做**：对 Gemini 回答进行语义加工或二次标签注入。
* **不做**：复杂错误面板与 UI。

---

## 12. 小结

这份 **kilo-openai-proxy（极简 WebUI 代理）** 的设计，严格围绕你“**本地个人用、极简高效**”的诉求：

* 单进程、单页面、单接口；
* 清洗 KiloCode 请求头与请求体，仅取 **必要字段**；
* 稳定流式、**无额外进程风暴**；
* **不打印 URL**、日志极简；
* 直接可跑、易于维护。

