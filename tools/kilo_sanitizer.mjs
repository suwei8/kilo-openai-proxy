// tools/kilo_sanitizer.mjs
// ESM module
// 作用：针对 Kilo Code 的原始请求体进行“可配置、可调试”的精简/脱敏，
// 仅在检测到消息内容包含“Kilo Code”或模式标签（Current Mode <slug>...</slug>）时才生效。
// 特性：
// - 多模式（ask/code/debug/architect/orchestrator）预设工具白名单
// - 可通过 --keep 指定额外保留的工具
// - 可移除冗长的系统提示与工具说明，重写为极简系统提示（中文）
// - 可移除 <environment_details> 与其他噪音块
// - 可选择性移除顶层 model 字段（支持精确或通配阻断列表）
// - 可选择性移除 stream_options / 其他字段
// - 提供详细变更原因与体积对比
//
// 设计要点：
// 1) 只在 isKiloRequest(...) 为 true 时改写；否则原样返回，确保不会影响非 Kilo 请求。
// 2) 尽可能保留用户最后一条自然语言需求（去掉环境块），保证工具调用协议仍可被模型理解。
// 3) 工具白名单通过极简 system 提示给出，防止模型胡乱调用未授权工具。

import fs from 'node:fs/promises';

/** @typedef {import('node:fs').PathLike} PathLike */

/**
 * @typedef {Object} SanitizeOptions
 * @property {"tools-minimal"|"tools-off"|"passthrough"} [mode]
 * @property {string[]} [keep]  // 额外保留工具名（XML 标签名）
 * @property {boolean} [stripEnv] // 是否移除 <environment_details> ... 块
 * @property {boolean} [stripStreamOptions]
 * @property {boolean} [stripUnknownTopFields] // 非常用字段是否剔除
 * @property {boolean} [stripModel] // 无条件移除顶层 model
 * @property {string[]} [blockModels] // 命中这些模式名时才移除 model；支持 * 通配
 * @property {string} [lang] // zh|en
 * @property {boolean} [pretty]
 */

export const VERSION = '1.2.0';

export const MODE_PRESETS = /** @type {const} */ ({
  ask: [
    'read_file',
    'search_files',
    'list_files',
    'list_code_definition_names',
    'browser_action',
    'use_mcp_tool',
    'access_mcp_resource',
    'ask_followup_question',
    'attempt_completion',
  ],
  code: [
    'read_file',
    'apply_diff',
    'write_to_file',
    'insert_content',
    'search_and_replace',
    'search_files',
    'list_files',
    'list_code_definition_names',
    'browser_action',
    'use_mcp_tool',
    'access_mcp_resource',
    'ask_followup_question',
    'attempt_completion',
  ],
  debug: [
    'read_file',
    'apply_diff',
    'write_to_file',
    'insert_content',
    'search_and_replace',
    'search_files',
    'list_files',
    'list_code_definition_names',
    'browser_action',
    'use_mcp_tool',
    'access_mcp_resource',
    'ask_followup_question',
    'attempt_completion',
  ],
  architect: [
    'read_file',
    'search_files',
    'list_files',
    'list_code_definition_names',
    // 有些实现会限制只写 markdown；这里默认不暴露写工具，避免误写
    'ask_followup_question',
    'attempt_completion',
  ],
  orchestrator: [
    'new_task',
    'switch_mode',
    'ask_followup_question',
    'update_todo_list',
    'attempt_completion',
  ],
});

const DEFAULTS = {
  mode: 'tools-minimal',
  keep: [],
  stripEnv: true,
  stripStreamOptions: false,
  stripUnknownTopFields: false,
  stripModel: true,
  // 按需阻断顶层 model —— 用户曾提出要过滤 gemini-2.5-flash
  blockModels: ['gemini-2.5-flash', 'gemini-webui'],
  lang: 'zh',
  pretty: true,
};

const PROMPT_TEXTS = {
  zh: {
    header: `根据<task>中的任务描述选择使用XML标签将完成任务的完整代码包裹，并且确保代码都保持正确的缩进。
`,
    allowPrefix: '允许使用的工具（白名单）：\n- ',
    noTools: '本轮会话不允许调用任何工具。',
    osBlock: ``,
    tail: '回答我的问题后等待我返回执行结果再继续下一步。',
  },
  en: {
    header: `You are a software engineering assistant. Always respond in English.
Use XML-like tool tags when needed (at most one tool call per message).
Format:
<tool_name>
 <代码...>
</tool_name>`,
    allowPrefix: 'Allowed tools:\n- ',
    noTools: 'No tool calls are allowed in this session.',
    osBlock: `Windows & Encoding:
- Use PowerShell and force UTF-8 for <execute_command> on Windows:
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); <YOUR_CMD>"
- Prefer Remove-Item for deletion; avoid Linux rm.`,
    tail: 'Note: Call tools only when necessary; after each call, wait for the user to return the result before proceeding.',
  },
};

/** 判定是否为 Kilo Code 请求 */
export function isKiloRequest(payload) {
  try {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    const joined = msgs.map(m => (typeof m?.content === 'string' ? m.content : '')).join('\n');
    if (/You are Kilo Code/i.test(joined)) return true;
    if (/Current\s+Mode\s*<slug>.*?<\/slug>/is.test(joined)) return true;
    if (/Kilo\s*Code/i.test(joined)) return true;
  } catch {}
  return false;
}

/** 提取模式 slug（ask/code/debug/architect/orchestrator） */
export function detectModeSlug(payload) {
  try {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    for (const m of msgs) {
      const c = typeof m?.content === 'string' ? m.content : '';
      const m1 = c.match(/<slug>(ask|code|debug|architect|orchestrator)<\/slug>/i);
      if (m1) return m1[1].toLowerCase();
    }
  } catch {}
  return undefined;
}

/** 将 * 通配的字符串转正则 */
function globLikeToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, r => `\\${r}`);
  return new RegExp(`^${esc.replace(/\*/g, '.*')}$`, 'i');
}

/** 是否命中需阻断的 model 名 */
function shouldBlockModel(value, list) {
  if (!value) return false;
  for (const s of list || []) {
    const rx = globLikeToRegex(String(s));
    if (rx.test(String(value))) return true;
  }
  return false;
}

/** 构造极简 system 提示（中文/英文） */
function buildMinimalSystemPrompt({ lang = 'zh', keepTools = [], modeSlug = 'code' }) {
  const t = PROMPT_TEXTS[lang] || PROMPT_TEXTS.zh;

  const allow = keepTools.length
    ? t.allowPrefix + keepTools.map(tl => `<${tl}>...</${tl}>`).join('\n- ')
    : t.noTools;

  return [
    `${t.header}\n\n当前模式：${modeSlug}`,
    allow,
    t.osBlock,
    t.tail
  ].join('\n\n');
}

/**
 * 从用户消息中剔除 <environment_details> 与其他噪音块，仅保留用户需求文本
 */
function stripNoiseFromUserContent(text, { stripEnv = true } = {}) {
  if (typeof text !== 'string') return text;
  let out = text;
  if (stripEnv) {
    out = out.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '').trim();
  }
  // 额外：去掉多余的系统描述性大段（可按需扩展）
  out = out.replace(/^\s*Current\s+Mode[\s\S]*?<\/slug>\s*/i, '').trim();
  return out || text; // 兜底
}

/** 生成新的 messages（极简） */
function rebuildMessages(original, { lang, keep, modeSlug, stripEnv }) {
  const minimal = [];
  const keepTools = Array.from(new Set([...(keep || []), ...((MODE_PRESETS[modeSlug] || []))]));
  minimal.push({
    role: 'system',
    content: buildMinimalSystemPrompt({ lang, keepTools, modeSlug }),
  });

  // 选择最后一条 user 消息作为输入，并剔除环境与噪音
  const users = (original?.messages || []).filter(m => m?.role === 'user');
  const lastUser = users.length ? users[users.length - 1] : null;
  const userContent = stripNoiseFromUserContent(lastUser?.content ?? '', { stripEnv });
  if (userContent && userContent.trim()) {
    minimal.push({ role: 'user', content: userContent.trim() });
  }
  return minimal;
}

/** 仅保留常用顶层字段（可选） */
function pruneTopFields(obj) {
  const allowed = new Set([
    'model',
    'messages',
    'temperature',
    'top_p',
    'stream',
    'stream_options',
    'max_tokens',
    'stop',
    // 根据上游实际接口再增减
  ]);
  const out = {};
  for (const k of Object.keys(obj)) {
    if (allowed.has(k)) out[k] = obj[k];
  }
  return out;
}

/**
 * 主入口：根据选项精简/脱敏请求体
 * @param {any} payload 原始 JSON 请求
 * @param {Partial<SanitizeOptions>} opts 用户选项
 * @returns {{json:any, changed:boolean, reason:string, bytesBefore:number, bytesAfter:number}}
 */
export function sanitizeKiloRequest(payload, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const before = Buffer.byteLength(JSON.stringify(payload));

  let changed = false;
  let reason = 'passthrough';

  // 非 Kilo 请求：直接返回
  if (!isKiloRequest(payload)) {
    return { json: payload, changed, reason, bytesBefore: before, bytesAfter: before };
  }

  const modeSlug = detectModeSlug(payload) || 'code';

  // 生成极简 messages
  let next = { ...payload };

  if (options.mode === 'tools-minimal') {
    next.messages = rebuildMessages(payload, {
      lang: options.lang,
      keep: options.keep,
      modeSlug,
      stripEnv: options.stripEnv,
    });
    changed = true;
    reason = 'tools-minimal';
  } else if (options.mode === 'tools-off') {
    next.messages = rebuildMessages(payload, {
      lang: options.lang,
      keep: [],
      modeSlug,
      stripEnv: options.stripEnv,
    });
    changed = true;
    reason = 'tools-off';
  } else {
    // passthrough，仍可做少量字段级处理
  }

  // 处理 stream_options
  if (options.stripStreamOptions && 'stream_options' in next) {
    delete next.stream_options;
    changed = true;
    reason += ' +strip-stream-options';
  }

  // 处理顶层 model
  const modelVal = next?.model;
  if (options.stripModel || shouldBlockModel(modelVal, options.blockModels)) {
    if ('model' in next) {
      delete next.model;
      changed = true;
      reason += ' +strip-model';
    }
  }

  // 可选：裁剪顶层字段
  if (options.stripUnknownTopFields) {
    next = pruneTopFields(next);
    changed = true;
    reason += ' +prune-top-fields';
  }

  const after = Buffer.byteLength(JSON.stringify(next));
  return { json: next, changed, reason: reason.trim(), bytesBefore: before, bytesAfter: after };
}

/**
 * 读取 JSON 文件并应用精简（供 CLI 复用）
 * @param {PathLike} filePath
 * @param {Partial<SanitizeOptions>} opts
 */
export async function sanitizeFile(filePath, opts = {}) {
  const raw = await fs.readFile(filePath, 'utf8');
  const json = JSON.parse(raw);
  return sanitizeKiloRequest(json, opts);
}

export default {
  VERSION,
  MODE_PRESETS,
  isKiloRequest,
  detectModeSlug,
  sanitizeKiloRequest,
  sanitizeFile,
};
