下面是对整个项目的结构化分析、理解与总结，涵盖目标、架构、运行机制、接口契约、关键逻辑、工具与测试、以及注意事项与改进建议，帮助你快速全面把握项目现状并顺畅使用。

一、项目定位与总体目标
- 定位：本地个人使用的“极简 OpenAI 兼容代理”，用 Playwright 自动化驱动 Gemini WebUI，把 OpenAI 兼容的 /v1/chat/completions 请求转为 WebUI 对话，并以 SSE 流式返回。
- 侧重：简单可靠、低维护成本、稳定流式输出、串行单请求（single-flight）。
- 目标使用场景：本地 KiloCode（或其他兼容 OpenAI API 的客户端）直接调用本代理，无需官方 API Key，通过模拟浏览器页面交互获得 Gemini 回答。

二、技术栈与运行要求
- Node.js 20+（package.json engines >=20）
- Express 4.x 提供 HTTP 接口
- Playwright（chromium）用于浏览器自动化与页面 DOM 读取
- .env 配置驱动运行（端口、无头模式、用户数据目录、URL、等待时间等）
- Windows/PowerShell 优先适配（README 已按此说明）
- 依赖清单见 <mcfile name="package.json" path="d:\dev_root\kilo-openai-proxy\package.json"></mcfile>

三、目录结构与主要文件
- 核心服务
  - <mcfile name="server.js" path="d:\dev_root\kilo-openai-proxy\server.js"></mcfile>：核心服务进程，包含 Express 路由、Playwright 控制、SSE 输出、流式/非流式抓取逻辑、串行互斥等。
  - <mcfile name=".env.example" path="d:\dev_root\kilo-openai-proxy\.env.example"></mcfile>：环境变量示例。
  - <mcfile name="README.md" path="d:\dev_root\kilo-openai-proxy\README.md"></mcfile>：设计与使用说明（较长，详细描述了目标与机制）。
- 工具与调试
  - <mcfile name="kilo_probe.mjs" path="d:\dev_root\kilo-openai-proxy\tools\kilo_probe.mjs"></mcfile>：分析/提取 KiloCode 风格 payload 的 CLI 工具，用于从复杂请求文件中构建合适的 prompt（线索提取、截断等）。
  - <mcfile name="prompt_send.mjs" path="d:\dev_root\kilo-openai-proxy\tools\prompt_send.mjs"></mcfile>：构建特定模板 prompt 并发送至代理，支持 stream/非 stream，便于验证代理可用性。
- 测试脚本
  - <mcfile name="test_stream.mjs" path="d:\dev_root\kilo-openai-proxy\test\test_stream.mjs"></mcfile>：SSE 流式测试（诗歌示例）。
  - <mcfile name="test_once.mjs" path="d:\dev_root\kilo-openai-proxy\test\test_once.mjs"></mcfile>：非流式测试（“OK”自检）。
  - <mcfile name="code.json" path="d:\dev_root\kilo-openai-proxy\test\code.json"></mcfile>：一份 KiloCode 风格的大型系统提示示例数据（用于工具/兼容性验证）。
- 文档
  - <mcfile name="dev-log-2025-09-02.md" path="d:\dev_root\kilo-openai-proxy\docs\dev-log-2025-09-02.md"></mcfile>：开发日志（用于研发记录）。

四、运行配置（.env 关键项）
- PORT=8033：监听端口
- HEADLESS=false：无头模式（false 会弹出真实浏览器，便于登录）
- USER_DATA_DIR=.userdata：持久化用户目录（保存 Gemini 登录态）
- GEMINI_URL=https://gemini.google.com/app
- WAIT_READY_MS=2000：页面初始等待时间
- MAX_ANSWER_MS=180000：回答最大等待时长（看门狗超时）
- STABLE_MS=800：稳定窗口（该时间内内容未更新即认为回答完成）
提示：server.js 里还使用了 FORCE_ENTER_ONLY（可选）来控制只用回车提交，不走按钮兜底；该变量未在 .env.example 中列出，属于可选高级开关。

五、服务接口与契约
- 健康类
  - GET /healthz → { ok: true }
  - GET /status → { ok, busy, url, ts }（可看当前页面 URL、忙闲状态）
  - POST /reset → 重建页面并重新打开 GEMINI_URL，用于快速恢复
  - GET /debug → 返回页面关键元素是否存在、输入/按钮/回答区域探测信息
  - GET /peek → 返回当前可抓到的回答片段预览（bubbles 数量、text_len 与部分 text）
- OpenAI 兼容
  - GET /v1/models → 最小模型列表（固定 gemini-webui）
  - POST /v1/chat/completions
    - 请求体关键字段：model（忽略值，用于兼容）、messages（拼合为 prompt）、stream（默认 true）
    - 返回：
      - stream=true → SSE，按 data: {object:'chat.completion.chunk', choices[0].delta.content} 增量输出，最后发送 [DONE]
      - stream=false → 一次性返回标准 OpenAI completion 对象结构

六、核心工作流（请求生命周期）
- 单请求串行：使用内存标志 busy 控制同一时间只处理一个请求；并发时后续请求返回 429。
- ensureBrowser()
  - 启动持久化 context（USER_DATA_DIR，保留登录态），必要时创建新 page，打开 GEMINI_URL，等待 WAIT_READY_MS。
- prompt 构造
  - toPrompt() 从请求体 messages 提取文本，按 “段落 + 分割线”拼为一个长 prompt。
  - 注意：服务端未做复杂的 KiloCode 环境信息筛选（这是 tools/kilo_probe 的职责），服务端仅做“朴素拼接”。
- 提交消息
  - submitPrompt(prompt)：优先定位 contenteditable 输入框，输入文本后尝试两次 Enter 提交；若未启动回答，再尝试点击发送按钮；提交前记录“消息气泡数量”作为 baseline。
- 抓取回答
  - 基于 baselineCount 只读取“本次新气泡”，避免复读上次的内容。
  - 流式：readAnswerInChunks() 周期性抓取文本，去除占位/打字中提示，按差量输出；若在 STABLE_MS 内无新增则认为结束。
  - 非流式：waitForFinalAnswer() 类似逻辑，但等待稳定后一次性返回；对“极短文本（<=5）”做了快速返回。
- 超时与清理
  - 通过 watchdog 定时器保护 MAX_ANSWER_MS 超时后释放 busy。
  - res close/finish 事件也会清理 busy，避免僵锁。
- 异常处理
  - 若提交未启动：返回 502 错误码，message: submit_not_started
  - 若未抓到文本：返回 502 错误码，message: no_text_captured
  - 其他异常：message: proxy_error

七、关键稳定性策略
- 仅单实例（一个持久化浏览器+一个页面）：避免反复拉起进程的开销与不稳定。
- 输入与发送路径：Enter 提交为主、按钮点击为兜底；并在提交后用“气泡数变化/最后一条有字”作为是否开始的判定。
- 回答选择器与占位过滤：优先抓取 markdown 容器文本；对“Gemini is typing/正在输入/省略号”等占位内容剔除；使用 STABLE_MS 作为完成信号。
- 只读“新增气泡”：基于 baselineCount 保证不读到旧内容，从根上减少复读问题。

八、调试与测试
- 内置调试路由：/healthz、/status、/debug、/peek 可快速定位“输入框/按钮是否可见”“当前抓到什么文本”“页面是否已载入”等问题。
- 测试脚本：
  - 非流式：<mcfile name="test_once.mjs" path="d:\dev_root\kilo-openai-proxy\test\test_once.mjs"></mcfile>
  - 流式：<mcfile name="test_stream.mjs" path="d:\dev_root\kilo-openai-proxy\test\test_stream.mjs"></mcfile>
- 提示构建与发送工具：
  - <mcfile name="prompt_send.mjs" path="d:\dev_root\kilo-openai-proxy\tools\prompt_send.mjs"></mcfile> 支持多模板（code-task/switch/ask-xml）、--post、--stream、--endpoint、--model 等参数。
- Kilo 请求体分析工具：
  - <mcfile name="kilo_probe.mjs" path="d:\dev_root\kilo-openai-proxy\tools\kilo_probe.mjs"></mcfile> 可从存档的请求文件中提取 <task> 与 <environment_details>，构建摘要 prompt，并按字节上限截断。

九、如何快速上手（Windows PowerShell 5.1）
- 安装依赖
  - npm i
  - npx playwright install chromium
- 创建 .env
  - 复制 <mcfile name=".env.example" path="d:\dev_root\kilo-openai-proxy\.env.example"></mcfile> 为 .env，并按需修改（建议 HEADLESS=false 以便初次登录 Gemini）。
- 启动服务
  - 开发：npm run dev（nodemon 监听）
  - 生产：npm start
  - 首次启动会打开 Chromium，使用 USER_DATA_DIR 持久化登录态；手动登录一次后后续可自动复用。
- 验证
  - 非流式：node .\test\test_once.mjs
  - 流式：node .\test\test_stream.mjs
  - 也可用工具：node .\tools\prompt_send.mjs --post --stream

十、已知限制与注意事项
- 并发：当前只支持串行单请求（busy 锁）；并发请求会返回 429。
- 登录态：必须在 USER_DATA_DIR 下保持已登录 Gemini，否则无法正常提交/抓取。
- 页面结构变动：依赖选择器路径，若 Gemini WebUI 更新，可能需要调整 INPUT/ANSWER 选择器。
- 代理无“上游 API 调用”行为：本项目通过 WebUI 获取回答，未进行真实的 API Key 认证或上游 API 请求。
- 配置项 FORCE_ENTER_ONLY（可选）：仅用回车提交，禁用按钮兜底，适合特定环境回归验证。

十一、代码中的关键功能块（概念解读）
- 浏览器生命周期
  - ensureBrowser：启动/复用持久化 context 与页面，打开 GEMINI_URL 并等待稳定。
- 提交与判定
  - submitPrompt：定位输入框、输入、Enter 提交、必要时按钮兜底，并返回提交前“气泡数 baseline”。
- 抓取回答
  - grabAnswerText：只读 baseline 之后的新气泡 markdown 文本。
  - readAnswerInChunks：循环抓取差量，过滤占位文本，按 STABLE_MS 判稳后结束（流式）。
  - waitForFinalAnswer：非流式最终文本聚合（同样判稳，且对极短文本快速返回）。
- SSE 输出
  - sseHead/sseChunk/sseDone：OpenAI 兼容 SSE 包装，choices[0].delta.content 增量输出。
- 辅助与路由
  - /healthz /status /reset /debug /peek /v1/models /v1/chat/completions 路由完整。

十二、可扩展点与改进建议
- 并发能力：从单 busy 锁扩展为有界队列（如 p-queue），按顺序处理但支持排队状态查询。
- 健壮性：
  - 输入框/按钮选择器多路冗余、失败重试与指标统计；
  - 登录态检测与“未登录重定向”自动识别（如出现登录页，触发提示/报警）。
- 观测性：
  - 统一日志格式（请求 ID、耗时、流式 chunk 计数、超时原因），可选 debug 日志开关；
  - /metrics 供 Prometheus 采集（QPS、平均回答时长、超时率等）。
- 兼容性：
  - 支持更多 OpenAI 兼容端点（如 /v1/responses），或支持 tools/function_call 的最小映射。
- 维护性：
  - 将 server.js 适度拆分为 modules（browser.ts、sse.ts、routes.ts 等），并写少量单测/集成测试脚本。

如果你需要，我可以：
- 帮你新增一个“排队队列 + /queue/status 查询”的小功能；
- 为选择器与提交路径增加更健壮的回退与日志；
- 增加 Dockerfile 与一键启动脚本（Windows/PowerShell 友好）；
- 将 toPrompt 替换为与 tools/kilo_probe.mjs 一致的“智能提取模式”，在服务端直接做 KiloCode 适配。
        