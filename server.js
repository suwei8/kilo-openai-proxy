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

// —— 稳定选择器（来自备份gemini页的实际 DOM）——
const INPUT_SELECTOR = 'rich-textarea :is([contenteditable="true"][role="textbox"], div[contenteditable="true"])';
// 替换原来的 SEND_SELECTOR，新增一个候选数组
const SEND_SELECTORS = [
  '.send-button-container.visible button.send-button.submit[aria-label="Send message"]',
  'button[aria-label="Send message"]',
  'button[aria-label^="Send"]',
  'button[aria-label*="send" i]',
  'button[aria-label*="发送"]',     // 中文皮肤
];

// 旧变量保留名，兼容你 /debug 端点的检测
const SEND_SELECTOR = SEND_SELECTORS.join(',');

const SEND_BUTTON_PRIMARY = 'button[aria-label="Send message"]';
const SEND_BUTTON_SAFE = 'button[aria-label*="Send"]:not([aria-label*="Temporary"])';
const TEMP_CHAT_BUTTON = 'button[aria-label="Temporary chat"]';

const ANSWER_ROOT = 'div[id^="model-response-message-content"]';
const ANSWER_TEXT = `${ANSWER_ROOT} .markdown`;
const ANSWER_LIVE = '[aria-live="polite"], [aria-live="assertive"]';
const BUSY_BUTTON = 'button[aria-label*="Stop"],button[aria-label*="停止"],button[aria-label*="停止生成"]';
const AFTER_INPUT_SETTLE_MS = Number(process.env.AFTER_INPUT_SETTLE_MS ?? 1000); // 默认 1s

// ===== 回复区气泡：统一选择器 =====
const BUBBLE_ROOT_SELECTORS = [
  'div[id^="model-response-message-content"]',
  '[data-message-author="model"]',
  '[data-message-author="assistant"]',
  'chat-message[data-actor="model"]'
];
// 气泡内“加载/转圈”常见节点（取其一即可）
const SPINNER_SELECTORS = [
  '[data-testid*="spinner"]',
  '[aria-label*="loading" i]',
  '[role="progressbar"]',
  'md-circular-progress',
  'md-progress',
  '.loading,.spinner,.progress'
];
const BUBBLE_TEXT_SELECTOR = '.markdown, md-block, .prose, [data-testid="markdown"]';

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


// 判可见
function _visEval(el) {
  if (!el || !el.isConnected) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) return false;
  return true;
}

// 检查当前输入框里是否已有“非空白”文本
async function hasInputText(sel) {
  return await page.$eval(sel, el => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, '');
    return t.length > 0;
  }).catch(() => false);
}

// 更稳的按钮就绪：既看 send 按钮，也看容器类名（Gemini 会用样式禁点）
async function isSendButtonReady(timeoutMs = 2000) {
  const selectors = [
    '.send-button-container.visible button.send-button.submit[aria-label="Send message"]',
    'button[aria-label="Send message"]',
    'button[aria-label^="Send"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="发送"]'
  ];
  return await page.waitForFunction((sels) => {
    const pick = () => {
      for (const s of sels) {
        const n = document.querySelector(s);
        if (n) return n;
      }
      return null;
    };
    const n = pick();
    if (!n) return false;

    // 1) 可见
    const cs = getComputedStyle(n);
    const r  = n.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (r.width < 4 || r.height < 4) return false;

    // 2) 非禁用（属性或样式）
    const disAttr = n.disabled || n.getAttribute('disabled') || n.getAttribute('aria-disabled');
    const peNone  = cs.pointerEvents === 'none';
    return !(disAttr && String(disAttr).toLowerCase() !== 'false') && !peNone;
  }, { timeout: timeoutMs }, selectors).then(() => true).catch(() => false);
}


// 找“所有可见气泡根节点”（按出现顺序）
async function findAllBubbles() {
  return await page.evaluate(({ rootSels, textSel }) => {
    const roots = [];
    for (const s of rootSels) document.querySelectorAll(s).forEach(n => roots.push(n));

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      return true;
    };

    const uniq = Array.from(new Set(roots)).filter(isVisible);
    return uniq.map((el, i) => {
      const md = el.querySelector(textSel);
      const text = (md?.innerText || md?.textContent || el.innerText || el.textContent || '').trim();
      const id = el.id || el.getAttribute('data-message-id') || `bubble-${i}`;
      return { index: i, id, text_len: text.length, preview: text.slice(0, 80) };
    });
  }, { rootSels: BUBBLE_ROOT_SELECTORS, textSel: BUBBLE_TEXT_SELECTOR });
}


// 只取“最后一个可见气泡”的纯文本（配合 baseline 使用）
async function grabLatestBubbleText(baselineCount = 0) {
  return await page.evaluate(({ base, rootSels, textSel }) => {
    const roots = [];
    for (const s of rootSels) document.querySelectorAll(s).forEach(n => roots.push(n));

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      return true;
    };

    const list = Array.from(new Set(roots)).filter(isVisible);
    if (list.length <= base) return '';

    const last = list[list.length - 1];
    try { last.scrollIntoView({ block: 'nearest' }); } catch {}
    const md = last.querySelector(textSel);
    return (md?.innerText || md?.textContent || last.innerText || last.textContent || '').trim();
  }, { base: baselineCount, rootSels: BUBBLE_ROOT_SELECTORS, textSel: BUBBLE_TEXT_SELECTOR }).catch(() => '');
}

// 读取 baseline 之后“最后一个可见气泡”的状态：文本 & 是否仍在转圈
async function getBubbleState(baselineCount = 0) {
  return await page.evaluate(({ base, rootSels, textSel, spinSels }) => {
    const all = [];
    for (const s of rootSels) document.querySelectorAll(s).forEach(n => all.push(n));

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      return true;
    };

    const list = Array.from(new Set(all)).filter(isVisible);
    if (list.length <= base) return { hasBubble:false, text:'', spinning:false };

    const last = list[list.length - 1];
    try { last.scrollIntoView({ block: 'nearest' }); } catch {}

    const txtNode = last.querySelector(textSel);
    const text = (txtNode?.innerText || txtNode?.textContent || last.innerText || last.textContent || '').trim();

    let spinning = false;
    for (const s of spinSels) {
      const n = last.querySelector(s);
      if (n && isVisible(n)) { spinning = true; break; }
    }
    return { hasBubble:true, text, spinning };
  }, { base: baselineCount, rootSels: BUBBLE_ROOT_SELECTORS, textSel: BUBBLE_TEXT_SELECTOR, spinSels: SPINNER_SELECTORS })
  .catch(() => ({ hasBubble:false, text:'', spinning:false }));
}



// 选出“当前唯一可见”的编辑器（给它打上 data-kilo-target，便于就近找按钮）
async function pickActiveInput() {
  const sel = await page.evaluate(({ baseSel }) => {
    const cand = Array.from(document.querySelectorAll(baseSel))
      .filter(el => el.isConnected && el.getBoundingClientRect().width > 5 && el.getBoundingClientRect().height > 5);
    if (!cand.length) return null;
    document.querySelectorAll('[data-kilo-target]').forEach(n => n.removeAttribute('data-kilo-target'));
    cand[cand.length - 1].setAttribute('data-kilo-target', '1');
    return '[data-kilo-target="1"]';
  }, { baseSel: INPUT_SELECTOR }).catch(() => null);
  return sel;
}




// ===== 浏览器控制 =====
// 在 ensureBrowser() 里授予剪贴板权限（一次性）
async function ensureBrowser() {
  if (!context) {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: String(HEADLESS).toLowerCase() === 'true'
    });
    browser = context.browser();

    // ✨ 允许运行时使用剪贴板（用于 Ctrl+V 粘贴路径）
    await context.grantPermissions(
      ['clipboard-read', 'clipboard-write'],
      { origin: 'https://gemini.google.com' }
    );
  }
  if (!page || page.isClosed()) page = await context.newPage();
  if (!page.url() || page.url().startsWith('about:blank')) {
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForTimeout(Number(WAIT_READY_MS));
  }
}
  // 提交流程
// 1) 等“提交按钮”出现且可点
async function waitSendReady(timeoutMs = 4000) {
  return await isSendButtonReady(timeoutMs);
}


// 2) 写入校验（只保留一份）
async function verifyInputMatches(sel, expected, timeoutMs = 8000) {
  return await page.waitForFunction((s, exp) => {
    const el = document.querySelector(s);
    if (!el) return false;

    const norm = (txt) => String(txt)
      .replace(/\r/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')       // 零宽
      .trim();

    const cur0 = (el.innerText || el.textContent || '');
    const cur  = norm(cur0);
    const e    = norm(exp);

    if (!cur) return false;

    // ① 完全相等 / 尾随换行
    if (cur === e || cur + '\n' === e || e + '\n' === cur) return true;

    // ② 互为包含（处理“重复一遍”的情况）
    if (cur.includes(e) || e.includes(cur)) return true;

    // ③ 前缀命中（避免富文本插入空格/换行差异）
    const head = e.slice(0, Math.min(12, e.length)); // 降到 12，短提示也能命中
    if (head && cur.includes(head)) return true;

    // ④ 长度大致匹配（≥70%）
    if (cur.length >= Math.floor(e.length * 0.7)) return true;

    return false;
  }, { timeout: timeoutMs }, sel, expected).then(() => true).catch(() => false);
}

// 点击“发送”按钮（从候选里找一个能点的）
async function clickSendButton() {
  // 找到第一个存在的候选选择器
  const sel = await page.evaluate((sels) => {
    for (const s of sels) {
      const n = document.querySelector(s);
      if (n) return s;
    }
    return null;
  }, SEND_SELECTORS);

  if (!sel) throw new Error('send_button_not_found');

  // 等按钮就绪再点，force 触发完整指针事件序列
  await waitSendReady(3000);
  await page.locator(sel).click({ timeout: 2000, force: true });
  return true;
}


// 3) 聚焦到 contenteditable（Quill/Gemini 很吃这个）
async function focusIntoEditable(sel) {
  const box = await page.$eval(sel, el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 40) };
  }).catch(() => null);
  if (box) await page.mouse.click(box.x, box.y, { clickCount: 1 });
  await page.locator(sel).focus().catch(() => {});
}

// 4) 写入文本（成功条件：文本匹配 或 “提交按钮变可点”二选一）
async function setInputFast(sel, text) {
  const expected = String(text).replace(/\r/g, '').replace(/\u00A0/g, ' ');
  const loc = page.locator(sel);

  // 聚焦 + 清空
  const focusAndClear = async () => {
    // 点击可编辑区中心，触发富文本激活
    const box = await page.$eval(sel, el => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 40) };
    }).catch(() => null);
    if (box) await page.mouse.click(box.x, box.y, { clickCount: 1 });
    await loc.focus().catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return;
      el.innerHTML = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }, sel).catch(() => {});
  };

  // 成功判定：文本匹配 或 按钮就绪 或 输入框里已有非空白
  const okAfter = async (verifyMs = 1800, sendMs = 2000) => {
    // 写入 → DOM/样式 有动画，先静置一会
    await page.waitForTimeout(AFTER_INPUT_SETTLE_MS);
    // 轻触空格/退格，促发 UI 更新
    try { await page.keyboard.type(' '); await page.keyboard.press('Backspace'); } catch {}
    // 三种成功信号：文本匹配 / 发送按钮就绪 / 输入框已有非空白
    const matched = await verifyInputMatches(sel, expected, verifyMs);
    if (matched) return true;
    if (await isSendButtonReady(sendMs)) return true;
    if (await hasInputText(sel)) return true;
    return false;
  };


  // —— A：execCommand('insertText') / insertHTML
  await focusAndClear();
  try {
    const ok = await page.evaluate((s, t) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel2 = window.getSelection();
      sel2.removeAllRanges(); sel2.addRange(range);
      const ok1 = document.execCommand && document.execCommand('insertText', false, t);
      if (!ok1) {
        const html = String(t).split(/\r?\n/).map(line => line || '<br>').join('<br>');
        document.execCommand('insertHTML', false, html);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      return true;
    }, sel, expected);
    if (ok && await okAfter()) return true;
  } catch {}

  // —— B：剪贴板 + Ctrl+V（先清空再试，避免叠加）
  await focusAndClear();
  try {
    await page.evaluate(async (t) => { try { await navigator.clipboard.writeText(t); } catch {} }, expected);
    await page.keyboard.down('Control').catch(()=>{});
    await page.keyboard.press('KeyV').catch(()=>{});
    await page.keyboard.up('Control').catch(()=>{});
    if (await okAfter()) return true;
  } catch {}

  // —— C：insertText / type（再清一次）
  await focusAndClear();
  try {
    await page.keyboard.insertText(expected);
    if (await okAfter()) return true;
  } catch {
    try {
      await loc.type(expected, { delay: 0 });
      if (await okAfter()) return true;
    } catch {}
  }

  // —— D：终局兜底：按钮亮了也算成功
  if (await isSendButtonReady(2000)) return true;

  return false;
}

// 5) 提交流程（先写入→等按钮出现→只点按钮，不靠回车；按两次兜底）
async function submitPrompt(prompt) {
  await waitUntilIdle(15000);

  const sel = await pickActiveInput();
  if (!sel) throw new Error('未找到输入框');

  const beforeCount = await page.$$eval('div[id^="model-response-message-content"]', n => n.length).catch(()=>0);

  const ok = await setInputFast(sel, prompt);
  if (!ok) throw new Error('paste_failed');
  await page.waitForTimeout(AFTER_INPUT_SETTLE_MS);
  

  await waitSendReady(5000);

  // 先回车一次（有的皮肤支持）
  try { await page.keyboard.press('Enter'); } catch {}

  // 再点击按钮
  try { await clickSendButton(); } catch {}

  const started = await page.waitForFunction((count) => {
    const roots = document.querySelectorAll('div[id^="model-response-message-content"]');
    const last  = roots.length ? roots[roots.length-1] : null;
    const t     = last ? (last.innerText || last.textContent || '').trim() : '';
    return (roots.length > count) || (t.length > 0);
  }, { timeout: 4000 }, beforeCount).then(() => true).catch(() => false);

  if (started) return beforeCount;

  // 兜底再点一次
  try { await clickSendButton(); } catch {}
  const started2 = await page.waitForFunction((count) => {
    const roots = document.querySelectorAll('div[id^="model-response-message-content"]');
    const last  = roots.length ? roots[roots.length-1] : null;
    const t     = last ? (last.innerText || last.textContent || '').trim() : '';
    return (roots.length > count) || (t.length > 0);
  }, { timeout: 2000 }, beforeCount).then(() => true).catch(() => false);

  if (started2) return beforeCount;

  throw new Error('submit_not_started');
}

// 说明：我们已经在上面实现了 grabLatestBubbleText()，这里直接复用，保证“只读 baseline 之后的新气泡”。
async function grabAnswerText(baselineCount = 0) {
  const st = await getBubbleState(baselineCount);
  return st.text || '';
}


// ===== 流式增量读取 =====
async function* readAnswerInChunks(baselineCount = 0) {
  let last = '';
  let lastChangeAt = Date.now();
  const t0 = Date.now();
  const maxMs = Number(MAX_ANSWER_MS);
  const stableMs = Number(STABLE_MS);

  while (Date.now() - t0 < maxMs) {
    const raw = await grabAnswerText(baselineCount);      // ← 传 baseline
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

  const final = await grabAnswerText(baselineCount);      // ← 传 baseline
  const finalClean = (final || '').replace(/\b(Gemini is typing|Gemini replied|正在输入.*?)\b/gi, '').trim();
  if (finalClean && finalClean.length > last.length) {
    yield finalClean.slice(last.length);
  }
}



// 非流式：更稳的等待逻辑（结束条件更稳）
async function waitForFinalAnswer(baselineCount = 0) {
  let lastText = '';
  let lastChangeAt = Date.now();
  const maxMs = Number(MAX_ANSWER_MS);
  const stableMs = Number(STABLE_MS);
  const t0 = Date.now();
  let everHadText = false;

  while (Date.now() - t0 < maxMs) {
    const { hasBubble, text, spinning } = await getBubbleState(baselineCount);

    const clean = (text || '').replace(/\b(Gemini is typing|Gemini replied|正在输入|思考中|生成中|加载中)\b/gi, '').trim();

    if (clean && clean !== lastText) {
      lastText = clean;
      everHadText = true;
      lastChangeAt = Date.now();
      if (lastText.length <= 5 && !spinning) return lastText; // 极短且已停，直接返回
    }

    // 结束条件：已出现文本 && 不在转圈 && 文本在稳定窗口内未变化
    if (everHadText && !spinning && Date.now() - lastChangeAt >= stableMs) {
      return lastText;
    }

    await new Promise(r => setTimeout(r, 100));
  }

  if (!everHadText) throw new Error('no_text_captured');
  return lastText;
}

// 两个小工具-等到“没有在生成中”
async function waitUntilIdle(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const busyBtn = await page.$(BUSY_BUTTON);
    if (!busyBtn) return true;           // 没有“停止生成”按钮 => 空闲
    await page.waitForTimeout(120);
  }
  return false; // 超时也算空闲（放行），你也可以选择抛错
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
    const vis = { [INPUT_SELECTOR]: !!(await page.$(INPUT_SELECTOR)) };
    const sendBtn = !!(await page.$(SEND_SELECTOR));
    const ans1 = !!(await page.$(ANSWER_TEXT));
    const ans2 = !!(await page.$(ANSWER_ROOT));
    const ans3 = !!(await page.$(ANSWER_LIVE));
    res.json({
      ok: true,
      url: page.url(),
      inputSelectors: vis,
      buttons: { sendSubmit: sendBtn },
      answerArea: { markdown: ans1, root: ans2, live: ans3 }
    });
  } catch {
    res.status(500).json({ ok: false, error: 'debug failed' });
  }
});


app.get('/gemini-nodes', async (_req, res) => {
  await ensureBrowser();
  const inputCount = await page.$$eval(INPUT_SELECTOR, els => els.length).catch(()=>0);
  const btnCount   = await page.$$eval(SEND_SELECTOR, els => els.length).catch(()=>0);
  res.json({ ok:true, inputCount, btnCount });
});

app.post('/type-test', async (req, res) => {
  try {
    await ensureBrowser();
    const sel = await pickActiveInput();
    if (!sel) return res.status(500).json({ ok:false, error:'no_input' });

    const prompt = (req.body && String(req.body.text||'').trim()) || 'hello from type-test';
    const ok = await setInputFast(sel, prompt);
    const ready = await waitSendReady(3000);
    const html = await page.$eval(sel, el => el.innerHTML).catch(()=>null);
    const txt  = await page.$eval(sel, el => (el.innerText||el.textContent||'')).catch(()=>null);
    res.json({ ok:true, writeOk: ok, sendReady: !!ready, textLen: (txt||'').length, preview: (txt||'').slice(0,80), htmlLen: (html||'').length });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

app.get('/v1/models', (_, res) =>
  res.json({ object: 'list', data: [{ id: 'gemini-webui', object: 'model', created: nowSec(), owned_by: 'local' }] })
);

// 临时诊断：增加 /peek 看「我们此刻能抓到什么」
app.get('/peek', async (_req, res) => {
  try {
    await ensureBrowser();
    const base = (await findAllBubbles()).length;
    const st = await getBubbleState(base);
    res.json({ ok:true, bubbles: base, spinning: st.spinning, text_len: (st.text||'').length, text: st.text?.slice(0,300) || '' });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
});


app.get('/bubbles', async (_req, res) => {
  try {
    await ensureBrowser();
    const all = await findAllBubbles();
    res.json({ ok: true, count: all.length, bubbles: all });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
});
// 调试端点，随时看我们能抓到哪些气泡：
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
  const baseline = await submitPrompt(prompt);      // ← 拿到提交前的气泡数

  if (stream) {
    sseHead(res);
    let full = '';
    for await (const delta of readAnswerInChunks(baseline)) {  // ← 传 baseline
      full += delta;
      res.write(sseChunk(id, delta));
    }
    res.write(sseDone(id, full));
    res.end();
    return;
  } else {
    const full = await waitForFinalAnswer(baseline);           // ← 传 baseline
    const safe = typeof full === 'string' ? full : '';
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
