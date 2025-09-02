// server.js — kilo-openai-proxy (Node.js v20 ESM 现代写法)
// ---------------------------------------------------------
// - 依赖 .env 提供全部配置
// - 启动即拉起浏览器，持久化用户目录保存登录态
// - OpenAI 兼容 /v1/chat/completions（SSE/非流式）
// - 提供 /healthz /status /reset /debug 路由

import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';

// ===== 读取 .env =====
const {
  PORT,
  HEADLESS,
  USER_DATA_DIR,
  GEMINI_URL,
  WAIT_READY_MS,
  MAX_ANSWER_MS,
  STABLE_MS
} = process.env;

// ===== App 状态 =====
const app = express();
app.use(express.json({ limit: '2mb' }));

let browser, context, page;
let busy = false;

// ===== 选择器（来自页面解包后的稳定路径） =====
const INPUT_SELECTORS = [
  'rich-textarea div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"][role="textbox"]'
];
const SEND_BUTTON_PRIMARY = 'button[aria-label="Send message"]';
const SEND_BUTTON_SAFE = 'button[aria-label*="Send"]:not([aria-label*="Temporary"])';
const TEMP_CHAT_BUTTON = 'button[aria-label="Temporary chat"]';

const ANSWER_ROOT = 'div[id^="model-response-message-content"]';
const ANSWER_TEXT = `${ANSWER_ROOT} .markdown`;
const ANSWER_LIVE = '[aria-live="polite"], [aria-live="assertive"]';

// ===== 工具函数 =====
const nowSec = () => Math.floor(Date.now() / 1000);

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
const toPrompt = (body) => {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.map(extractTextFromMessage).filter(Boolean).join('\n\n---\n\n').trim();
};
const wantStream = (body) => body?.stream ?? true;

// 只过滤典型占位文本，不按长度阈值误伤 “OK”
const isPlaceholderText = (t) => {
  if (!t) return true;
  const s = String(t).trim();

  // 明确的占位短语
  const placeholders = [
    'Gemini is typing',
    'Gemini replied',
    '正在输入', '正在思考', '思考中', '生成中', '加载中'
  ];

  // 纯省略号 / 空白（全是 . 或 … 或空格）
  const onlyEllipsisOrSpace = /^[.\u2026\s]+$/.test(s);

  return onlyEllipsisOrSpace || placeholders.some(p => s.includes(p));
};

// ===== 浏览器控制 =====
async function ensureBrowser() {
  if (!context) {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: String(HEADLESS).toLowerCase() === 'true'
    });
    browser = context.browser();
  }
  if (!page || page.isClosed()) page = await context.newPage();
  if (!page.url() || page.url().startsWith('about:blank')) {
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForTimeout(Number(WAIT_READY_MS));
  }
}


// 输入 + 回车（首选），若没触发回答，再尝试按钮（轻微增强：提交后等待“新消息气泡出现”）
async function submitPrompt(prompt) {
  // 1) 找输入框
  let sel = null;
  for (const s of INPUT_SELECTORS) {
    if (await page.$(s)) { sel = s; break; }
  }
  if (!sel) throw new Error('未找到输入框');

  // 记录提交前的消息气泡数量，用来确认是否真的开始生成
  const beforeCount = await page.$$eval('div[id^="model-response-message-content"]', n => n.length).catch(()=>0);

  const loc = page.locator(sel);
  await loc.focus().catch(()=>{});
  await page.keyboard.press('Control+A').catch(()=>{});
  await page.keyboard.press('Backspace').catch(()=>{});

  // 输入
  await loc.type(prompt, { delay: 0 }).catch(async () => {
    await page.evaluate((s, text) => {
      const el = document.querySelector(s);
      if (!el) return;
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, sel, prompt);
  });

  // 2) 先回车
  await loc.press('Enter').catch(()=>{});

  // 等待“气泡数量增加”或“文本变化”，两者任一即可视为开始
  const started = await page.waitForFunction((count) => {
    const roots = document.querySelectorAll('div[id^="model-response-message-content"]');
    const lastText = roots.length ? (roots[roots.length-1].innerText || roots[roots.length-1].textContent || '').trim() : '';
    // 数量增了 或 最后一条已有非空文本
    return (roots.length > count) || (lastText && lastText.length > 0);
  }, { timeout: 2000 }, beforeCount).then(() => true).catch(() => false);

  if (started) return;

  // 仅回车模式则到此为止
  if (String(process.env.FORCE_ENTER_ONLY).toLowerCase() === 'true') return;

  // 3) 再兜底点击“发送”按钮（排除临时聊天）
  await page.evaluate((primary, safe, block) => {
    const temp = document.querySelector(block);
    if (temp) temp.setAttribute('data-kilo-block', 'true');
    const tryClick = (sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return false;
      const label = (btn.getAttribute('aria-label') || btn.title || '').toLowerCase();
      if (label.includes('temporary')) return false;
      btn.click();
      return true;
    };
    return tryClick(primary) || tryClick(safe);
  }, 'button[aria-label="Send message"]', 'button[aria-label*="Send"]:not([aria-label*="Temporary"])', 'button[aria-label="Temporary chat"]');
}


// ===== 抓取回答文本（优先：消息气泡；退化：aria-live）=====
async function grabAnswerText() {
  return await page.evaluate(() => {
    // 1) 优先读取“消息气泡”——这才是最终渲染的答案
    const roots = Array.from(document.querySelectorAll('div[id^="model-response-message-content"]'));
    if (roots.length) {
      const last = roots[roots.length - 1];
      // 尝试把最后一条滚进可视区，避免虚拟列表未渲染
      try { last.scrollIntoView({ block: 'nearest' }); } catch {}
      // 优先 markdown，再退回到 root 的可见文本
      const md = last.querySelector('.markdown');
      const text = (md?.innerText || md?.textContent || last.innerText || last.textContent || '').trim();
      if (text) return text;
    }

    // 2) 退化到 aria-live（注意：这块容易混入“正在输入/提示”）
    const lives = document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
    if (lives && lives.length) {
      const el = lives[lives.length - 1];
      return (el.innerText || el.textContent || '').trim();
    }

    return '';
  }).catch(() => '');
}


// ===== 流式增量读取 =====
async function* readAnswerInChunks() {
  let last = '';
  let lastChangeAt = Date.now();
  const t0 = Date.now();
  const maxMs = Number(MAX_ANSWER_MS);
  const stableMs = Number(STABLE_MS);

  while (Date.now() - t0 < maxMs) {
    const raw = await grabAnswerText();
    if (!raw) { await new Promise(r => setTimeout(r, 80)); continue; }
    const cur = raw.replace(/\b(Gemini is typing|Gemini replied|正在输入.*?)\b/gi, '').trim();
    if (cur && !isPlaceholderText(cur) && cur !== last) {
      const delta = cur.slice(last.length);
      if (delta) {
        last = cur;
        lastChangeAt = Date.now();
        yield delta;
      }
    }
    if (last && Date.now() - lastChangeAt >= stableMs) break;
    await new Promise(r => setTimeout(r, 80));
  }

  const final = await grabAnswerText();
  const finalClean = (final || '').replace(/\b(Gemini is typing|Gemini replied|正在输入.*?)\b/gi, '').trim();
  if (finalClean && finalClean.length > last.length) {
    yield finalClean.slice(last.length);
  }
}

// 非流式：更稳的等待逻辑（结束条件更稳）
async function waitForFinalAnswer() {
  let last = '';
  let lastChangeAt = Date.now();
  const maxMs = Number(MAX_ANSWER_MS);
  const stableMs = Number(STABLE_MS);
  const t0 = Date.now();

  while (Date.now() - t0 < maxMs) {
    let raw = '';
    try { raw = await grabAnswerText(); } catch {}
    const clean = (raw || '')
      .replace(/\b(Gemini is typing|Gemini replied|正在输入|思考中|生成中|加载中)\b/gi, '')
      .trim();

    if (clean && clean !== last) {
      last = clean;
      lastChangeAt = Date.now();
      // 超短回答（OK/Hi/Yes）直接返回
      if (last.length <= 5) return last;
    }

    // 有文本且在稳定窗口内未变化 => 完成
    if (last && Date.now() - lastChangeAt >= stableMs) return last;

    await new Promise(r => setTimeout(r, 80));
  }

  // 超时：返回已有文本，避免挂死
  return last;
}



// ===== SSE 辅助 =====
const sseHead = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
};
const sseChunk = (id, delta) =>
  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: nowSec(),
    model: 'gemini-webui',
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`;
const sseDone = (id, full) =>
  `data: ${JSON.stringify({ id, object: 'chat.completion', created: nowSec(),
    model: 'gemini-webui',
    choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n` +
  `data: [DONE]\n\n`;

// ===== 路由 =====
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/status',  (_, res) => res.json({ ok: true, busy, url: page?.url?.() || null, ts: Date.now() }));
app.post('/reset',  async (_req, res) => {
  try {
    busy = false;
    if (page) { try { await page.close(); } catch {} }
    page = await context.newPage();
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForTimeout(Number(WAIT_READY_MS));
    res.json({ ok: true, reset: true, url: page.url() });
  } catch {
    res.status(500).json({ ok: false, error: 'reset failed' });
  }
});
app.get('/debug',  async (_req, res) => {
  try {
    await ensureBrowser();
    const vis = {};
    for (const s of INPUT_SELECTORS) vis[s] = !!(await page.$(s));
    const send1 = !!(await page.$(SEND_BUTTON_PRIMARY));
    const send2 = !!(await page.$(SEND_BUTTON_SAFE));
    const temp  = !!(await page.$(TEMP_CHAT_BUTTON));
    const ans1 = !!(await page.$(ANSWER_TEXT));
    const ans2 = !!(await page.$(ANSWER_ROOT));
    const ans3 = !!(await page.$(ANSWER_LIVE));
    res.json({
      ok: true, url: page.url(),
      inputSelectors: vis,
      buttons: { sendPrimary: send1, sendSafe: send2, tempButton: temp },
      answerArea: { markdown: ans1, root: ans2, live: ans3 }
    });
  } catch {
    res.status(500).json({ ok: false, error: 'debug failed' });
  }
});

app.get('/v1/models', (_, res) =>
  res.json({ object: 'list', data: [{ id: 'gemini-webui', object: 'model', created: nowSec(), owned_by: 'local' }] })
);

// 临时诊断：增加 /peek 看「我们此刻能抓到什么」
app.get('/peek', async (_req, res) => {
  try {
    await ensureBrowser();
    const raw = await grabAnswerText();
    const bubbles = await page.$$eval('div[id^="model-response-message-content"]', n => n.length).catch(()=>0);
    res.json({ ok:true, bubbles, text_len: (raw||'').length, text: raw?.slice(0,300) || '' });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
});




app.post('/v1/chat/completions', async (req, res) => {
  if (busy) return res.status(429).json({ error: { message: 'busy: single-flight in progress' } });
  busy = true;

  const stream = wantStream(req.body);
  const id = 'chatcmpl_' + Date.now().toString(36);

  // 看门狗：超时/断开都释放 busy
  const watchdog = setTimeout(() => { busy = false }, Number(MAX_ANSWER_MS) + 2000);
  res.once('close',  () => { clearTimeout(watchdog); busy = false; });
  res.once('finish', () => { clearTimeout(watchdog); busy = false; });

  try {
    const prompt = toPrompt(req.body);
    if (!prompt) return res.status(400).json({ error: { message: 'empty prompt' } });

    await ensureBrowser();
    await submitPrompt(prompt);

  if (stream) {
    sseHead(res);
    let full = '';
    for await (const delta of readAnswerInChunks()) {
      full += delta;
      res.write(sseChunk(id, delta));
    }
    res.write(sseDone(id, full));
    res.end();
    return;
  } else {
    const full = await waitForFinalAnswer();          // 永不抛错
    const safe = typeof full === 'string' ? full : ''; // 防御
    res.json({
      id,
      object: 'chat.completion',
      created: nowSec(),
      model: 'gemini-webui',
      choices: [{ index: 0, message: { role: 'assistant', content: safe }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
    return;
  }
} catch (e) {
  const msg = String(e?.message || e);
  console.error('[proxy error]', msg);
  if (!res.headersSent) {
    const reason = (msg.includes('submit_not_started') ? 'submit_not_started'
                  : msg.includes('no_text_captured') ? 'no_text_captured'
                  : 'proxy_error');
    res.status(502).json({ error: { message: reason } });
  }
}
});

// ===== 启动（顶层预热） =====
await ensureBrowser();
console.log('[kilo-openai-proxy] browser ready');
app.listen(PORT, () => console.log(`[kilo-openai-proxy] listening on http://127.0.0.1:${PORT}`));
