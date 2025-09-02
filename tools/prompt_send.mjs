// tools/prompt_send.mjs
// Node 20+ ESM
// 用法示例见文末

import fs from "node:fs";
import path from "node:path";

// -------------------- CLI 解析 --------------------
function pickFlag(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  if (i === process.argv.length - 1) return true; // 布尔开关
  const v = process.argv[i + 1];
  if (v?.startsWith("--")) return true;
  return v;
}

const template = pickFlag("template", "code-task"); // code-task | switch | ask-xml
const task     = pickFlag("task", "");
const mode     = pickFlag("mode", "code");          // 用于 --template switch
const reason   = pickFlag("reason", "进入编码阶段以开始实现/修改代码");
const showOnly = !process.argv.includes("--post");
const stream   = process.argv.includes("--stream");
const endpoint = pickFlag("endpoint", "http://127.0.0.1:8033/v1/chat/completions");
const model    = pickFlag("model", "gemini-webui");

// -------------------- 模板生成 --------------------
function tplCodeTask(t) {
  return `你现在处于 Kilo Code 的 Code Mode。
只允许输出“一个”XML 工具调用（或在任务完全结束时输出 <attempt_completion>），禁止任何工具标签外的字符和空行。

可用工具（按官方默认格式，列常用项）：
- <write_to_file> 必填：<path>、<content>、<line_count>
- <read_file>     必填：<args> 内含 1..N 个 <file><path>…</path></file>
- <apply_diff>    必填：<path>、<diff><![CDATA[ 按行号的 SEARCH/REPLACE 块 ]]></diff>
- <create_directory> 必填：<path>
- <execute_command>  必填：<command>

【任务】
${t}

【硬性要求】
1) 只能输出一个工具 XML 标签，禁止额外文本或空行。
2) 写入文件必须提供正确 <line_count>（按内容实际行数）。
3) 如无需工具，请输出：
<attempt_completion>
  <result>（中文说明当前步骤总结/结论）</result>
</attempt_completion>
输出完立即停止。`;
}

function tplSwitch(m, r) {
  return `仅输出以下 XML，不得有任何额外文字或空行；输出完立即停止：
<switch_mode>
  <mode_slug>${m}</mode_slug>
  <reason>${r}</reason>
</switch_mode>`;
}

function tplAskXML(t) {
  return `你现在是“只输出指定 XML 的打印机”。你的整条回复必须完全匹配：
^<attempt_completion>\\s*<result>[\\s\\S]+<\\/result>\\s*<\\/attempt_completion>$

请把我的任务答案写进 <result>（中文），不得有任何额外字符；输出后立即停止。

任务：${t}

只允许输出：
<attempt_completion>
<result>（把最终答案放这里）</result>
</attempt_completion>`;
}

function buildPrompt() {
  if (template === "switch") return tplSwitch(mode, reason);
  if (template === "ask-xml") return tplAskXML(task || "你好");
  // 默认：code-task
  return tplCodeTask(task || "在项目根目录创建 1.txt 并写入内容 123");
}

const prompt = buildPrompt();

// -------------------- 控制台展示 --------------------
console.log("=== kilo prompt send ===");
console.log("Template:", template, "| Mode:", mode, "| Stream:", stream ? "on" : "off");
console.log("Endpoint:", endpoint);
console.log("--- Prompt ---\n" + prompt + "\n----------------\n");

if (showOnly) {
  console.log("（仅展示，不发送。若要直接发送，请加 --post）");
  process.exit(0);
}

// -------------------- 发送到代理 --------------------
const payload = {
  model,
  messages: [{ role: "user", content: prompt }],
  stream,
};

// Node 18+ 自带 fetch；若没有（极少数环境），再兜底按需加载 node-fetch
const fetchImpl = globalThis.fetch ?? (await import("node-fetch")).default;

const res = await fetchImpl(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});


if (!res.ok || !res.body) {
  console.error("HTTP error:", res.status, res.statusText);
  process.exit(1);
}

if (stream) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  console.log("\n=== SSE BEGIN ===");
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p) continue;
      if (p === "[DONE]") { console.log("\n=== SSE DONE ==="); break; }
      try {
        const obj = JSON.parse(p);
        const delta = obj?.choices?.[0]?.delta?.content ?? "";
        if (delta) process.stdout.write(delta);
      } catch {}
    }
  }
  console.log("\n=== END ===");
} else {
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content ?? "";
  console.log("\n=== RESULT ===\n" + text + "\n=== END ===");
}



// 用法示例
// 1) 只生成“Code 模式·极简提示词”，打印到控制台
// node tools/prompt_send.mjs --template code-task --task "在项目根目录创建 1.txt，并写入内容 123"

// 2) 直接把上面的提示词发给你的代理（SSE）
// node tools/prompt_send.mjs --template code-task --task "在项目根目录创建 1.txt，并写入内容 123" --post --stream

// 3) 切换到 Code 模式（生成 <switch_mode> 指令并发送）
// node tools/prompt_send.mjs --template switch --mode code --reason "进入编码阶段以开始实现/修改代码" --post

// 4) Ask 模式：要求产出 <attempt_completion> 包裹的回答
// node tools/prompt_send.mjs --template ask-xml --task "写一首春天的诗" --post --stream


// 默认 endpoint：http://127.0.0.1:8033/v1/chat/completions
// 如需修改：--endpoint http://127.0.0.1:8033/v1/chat/completions
// 默认模型：gemini-webui，可用 --model 覆盖。