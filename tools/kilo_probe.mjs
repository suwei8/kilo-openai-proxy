// tools/kilo_probe.mjs
// 用法：node tools/kilo_probe.mjs test/request-20250901-204518-d4e9758cc3400aac.bin [--show] [--max-bytes 3072]

import fs from 'node:fs';
import path from 'node:path';

// ---------- 读入与解析 ----------
function readUtf8(file) {
  const buf = fs.readFileSync(file);
  return buf.toString('utf8');
}

function tryParseJSONLoose(text) {
  // 1) 直接 parse
  try { return { ok: true, json: JSON.parse(text), hint: 'raw JSON' }; } catch {}

  // 2) 若包含 URL 编码尝试解码
  if (/%7B/i.test(text) && /%7D/i.test(text)) {
    try {
      const decoded = decodeURIComponent(text);
      return { ok: true, json: JSON.parse(decoded), hint: 'urldecoded JSON' };
    } catch {}
  }

  // 3) 从首尾大括号间截取
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    const mid = text.slice(s, e + 1);
    try { return { ok: true, json: JSON.parse(mid), hint: 'sliced JSON' }; } catch {}
  }

  return { ok: false, error: 'not a JSON body (or requires a different decode path)' };
}

// ---------- Kilo 提取逻辑 ----------
function isKiloPayload(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const sys = msgs.find(m => m?.role === 'system')?.content || '';
  const lastUser = [...msgs].reverse().find(m => m?.role === 'user');
  const userStr = typeof lastUser?.content === 'string' ? lastUser.content : '';

  const reason = [];
  if (/Kilo Code|MARKDOWN RULES/i.test(sys)) reason.push('system contains "Kilo Code"/"MARKDOWN RULES"');
  if (/<task>|<environment_details>/i.test(userStr)) reason.push('user content has <task>/<environment_details>');

  return { isKilo: reason.length > 0, reason, sysLen: sys.length, userLen: userStr.length };
}

function extractBetween(str, startTag, endTag) {
  const re = new RegExp(`${startTag}([\\s\\S]*?)${endTag}`, 'i');
  const m = (str || '').match(re);
  return (m?.[1] || '').trim();
}

function pickEnvLines(envText, titleRe, maxLines = 5) {
  const re = new RegExp(`${titleRe.source}[\\r\\n]+([\\s\\S]*?)(?:\\n\\n|$)`, 'i');
  const m = envText.match(re);
  if (!m) return '';
  const lines = (m[1] || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return lines.join('\n');
}

function buildPromptFromKilo(userStr, { maxBytes = 3 * 1024 } = {}) {
  const meta = { mode: 'natural', usedEnv: [], truncated: false };

  const task = extractBetween(userStr, '<task>', '</task>');
  if (!task) return { prompt: '', meta: { ...meta, mode: 'empty-task' } };

  const isNatural =
    /[\u4e00-\u9fa5]/.test(task) || /[。？！?!.，,；;]/.test(task) || /\s/.test(task);

  if (isNatural) {
    meta.mode = 'natural';
    const prompt = task.trim();
    return { prompt, meta };
  }

  // slug 模式：拼少量环境摘要
  meta.mode = 'slug';
  const env = extractBetween(userStr, '<environment_details>', '</environment_details>');
  if (!env) return { prompt: task, meta };

  const visible = pickEnvLines(env, /#\s*VSCode Visible Files/, 5);
  const tabs    = pickEnvLines(env, /#\s*VSCode Open Tabs/, 5);

  const parts = [task.trim()];
  const clues = [];
  if (visible) { clues.push(`可见文件:\n${visible}`); meta.usedEnv.push('Visible Files'); }
  if (tabs)    { clues.push(`打开的标签:\n${tabs}`);   meta.usedEnv.push('Open Tabs'); }

  let prompt = parts.join('\n\n').trim();
  if (clues.length) prompt = `${prompt}\n\n工作区线索（截取）\n${clues.join('\n\n')}`;

  // 尺寸限制
  const enc = new TextEncoder();
  while (enc.encode(prompt).length > maxBytes && clues.length) {
    clues.pop();
    meta.truncated = true;
    prompt = [task.trim(), clues.length ? '工作区线索（截取）\n' + clues.join('\n\n') : '']
      .filter(Boolean).join('\n\n').trim();
  }
  return { prompt, meta };
}

function toPromptSmart(body, { maxBytes = 3 * 1024 } = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...msgs].reverse().find(m => m?.role === 'user');
  const userStr = typeof lastUser?.content === 'string' ? lastUser.content : '';

  const kilo = isKiloPayload(body);
  if (kilo.isKilo) {
    const { prompt, meta } = buildPromptFromKilo(userStr, { maxBytes });
    if (prompt) return { prompt, meta, kilo };
  }

  // 回退：原始拼接（system+user）
  const extractTextFromMessage = (m) => {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map(p => (typeof p === 'string'
        ? p
        : (p?.type === 'text' ? (p.text || '') : '')
      )).filter(Boolean).join('\n');
    }
    return '';
  };
  const prompt = msgs.map(extractTextFromMessage).filter(Boolean).join('\n\n---\n\n').trim();
  return { prompt, meta: { mode: 'fallback' }, kilo };
}

// ---------- CLI ----------
function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node tools/kilo_probe.mjs <request.bin> [--show] [--max-bytes 3072]');
    process.exit(2);
  }
  const opts = {
    show: process.argv.includes('--show'),
    maxBytes: (() => {
      const i = process.argv.indexOf('--max-bytes');
      return i > -1 ? Number(process.argv[i + 1] || 3072) : 3072;
    })(),
  };

  const raw = readUtf8(file);
  const parsed = tryParseJSONLoose(raw);
  if (!parsed.ok) {
    console.error('❌ 解析失败：', parsed.error);
    process.exit(1);
  }

  const body = parsed.json;
  const { prompt, meta, kilo } = toPromptSmart(body, { maxBytes: opts.maxBytes });

  // 输出报告
  console.log('=== Kilo Probe ===');
  console.log('File:', path.resolve(file));
  console.log('ParseHint:', parsed.hint || 'raw');
  console.log('Detected KiloCode:', Boolean(kilo?.isKilo));
  if (kilo?.reason?.length) console.log('Reasons:', kilo.reason.join(' | '));
  console.log('SystemLen:', kilo?.sysLen ?? 0, 'UserLen:', kilo?.userLen ?? 0);
  console.log('Mode:', meta.mode, 'UsedEnv:', (meta.usedEnv || []).join(', ') || '-',
              'Truncated:', Boolean(meta.truncated));
  console.log('PromptBytes:', new TextEncoder().encode(prompt).length);
  console.log('--- Prompt Preview ---');
  const prev = opts.show ? prompt : (prompt.length > 800 ? (prompt.slice(0, 800) + '\n...[trimmed, use --show to print all]') : prompt);
  console.log(prev);
  console.log('----------------------\n');

  // 便于直接复制到 /v1/chat/completions 测试
  const payload = {
    model: 'gemini-webui',
    messages: [{ role: 'user', content: prompt }],
    stream: true
  };
  console.log('示例 payload（SSE）：');
  console.log(JSON.stringify(payload, null, 2));
}

main();
