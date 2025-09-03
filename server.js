// server.js — kilo-openai-proxy (Node.js v20 ESM)
// ------------------------------------------------
// - .env 统一配置解析（提供默认值）
// - 启动即拉起浏览器（持久化用户目录）
// - OpenAI 兼容 /v1/chat/completions（SSE/非流式）
// - /healthz /status /reset /debug 等诊断端点
// - 清理冗余：移除未用常量与函数，合并重复逻辑

import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';
import { sanitizeKiloRequest } from './tools/kilo_sanitizer.mjs';

// ========= 配置集中解析（含默认值） =========
const flag = (v, def = false) => {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return ['1','true','on','yes','y'].includes(s);
};

const CFG = {
  PORT: parseInt(process.env.PORT || '8033', 10),
  HEADLESS: String(process.env.HEADLESS || 'false').toLowerCase() === 'true',
  USER_DATA_DIR: process.env.USER_DATA_DIR || '.userdata',
  GEMINI_URL: process.env.GEMINI_URL || 'https://gemini.google.com/app',
  WAIT_READY_MS: parseInt(process.env.WAIT_READY_MS || '1500', 10),
  MAX_ANSWER_MS: parseInt(process.env.MAX_ANSWER_MS || '60000', 10),
  STABLE_MS: parseInt(process.env.STABLE_MS || '1200', 10),
  AFTER_INPUT_SETTLE_MS: parseInt(process.env.AFTER_INPUT_SETTLE_MS || '800', 10),
  FORCE_ENTER_ONLY: String(process.env.FORCE_ENTER_ONLY || 'false').toLowerCase() === 'true',

  // ====== Sanitizer 相关（可在 .env 调整）======
  SAN_ON: flag(process.env.KILO_SANITIZE_ON, true),              // 总开关：默认启用
  SAN_MODE: process.env.KILO_SANITIZE_MODE || 'tools-minimal',   // tools-minimal | tools-off | passthrough
  SAN_KEEP: (process.env.KILO_KEEP_TAGS || '')                   // 白名单工具追加
              .split(',').map(s => s.trim()).filter(Boolean),
  SAN_STRIP_ENV: flag(process.env.KILO_STRIP_ENV, true),         // 去 <environment_details>
  SAN_STRIP_STREAM: flag(process.env.KILO_STRIP_STREAM_OPTIONS, true), // 去 stream_options
  SAN_STRIP_MODEL: flag(process.env.KILO_STRIP_MODEL, true),     // 顶层 model 固定移除（你要求的默认）
  SAN_BLOCK_MODELS: (process.env.KILO_BLOCK_MODELS || 'gemini-2.5-flash,gemini-webui')
              .split(',').map(s => s.trim()).filter(Boolean),
  SAN_PRUNE_TOP: flag(process.env.KILO_PRUNE_TOP_FIELDS, false), // 仅保留常见顶层字段（安全模式）
  SAN_LANG: process.env.KILO_LANG || 'zh',                       // 极简 system 提示语言
};


// ========= App 状态 =========
const app = express();
app.use(express.json({ limit: '2mb' }));

let browser, context, page;
let busy = false;

// ========= 选择器（统一来源） =========
const INPUT_SELECTOR =
  'rich-textarea :is([contenteditable="true"][role="textbox"], div[contenteditable="true"])';

// 统一的“发送按钮”候选（只保留一份，其他逻辑全部共用）
const SEND_SELECTORS = [
  '.send-button-container.visible button.send-button.submit[aria-label="Send message"]',
  'button[aria-label="Send message"]',
  'button[aria-label^="Send"]',
  'button[aria-label*="send" i]',
  'button[aria-label*="发送"]'
];
// 为 /debug & /gemini-nodes 做兼容输出
const SEND_SELECTOR = SEND_SELECTORS.join(',');

// 回复区（/debug 使用）
const ANSWER_ROOT = 'div[id^="model-response-message-content"]';
const ANSWER_TEXT = `${ANSWER_ROOT} .markdown`;
const ANSWER_LIVE = '[aria-live="polite"], [aria-live="assertive"]';

// Busy 判断（是否存在“停止”按钮）
const BUSY_BUTTON =
  'button[aria-label*="Stop"],button[aria-label*="停止"],button[aria-label*="停止生成"]';

// 回复气泡统一选择器
const BUBBLE_ROOT_SELECTORS = [
  'div[id^="model-response-message-content"]',
  '[data-message-author="model"]',
  '[data-message-author="assistant"]',
  'chat-message[data-actor="model"]'
];
// 气泡内 Loading 节点
const SPINNER_SELECTORS = [
  '[data-testid*="spinner"]',
  '[aria-label*="loading" i]',
  '[role="progressbar"]',
  'md-circular-progress',
  'md-progress',
  '.loading,.spinner,.progress'
];
const BUBBLE_TEXT_SELECTOR = '.markdown, md-block, .prose, [data-testid="markdown"]';

// ========= 小工具 =========
const nowSec = () => Math.floor(Date.now() / 1000);

const extractTextFromMessage = (m) => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (typeof p === 'string' ? p : (p?.type === 'text' ? (p.text || '') : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const toPrompt = (body) => {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.map(extractTextFromMessage).filter(Boolean).join('\n\n---\n\n').trim();
};

const wantStream = (body) => (typeof body?.stream === 'boolean' ? body.stream : true);

// 只过滤典型占位文本
const isPlaceholderText = (t) => {
  if (!t) return true;
  const s = String(t).trim();
  const placeholders = [
    'Gemini is typing',
    'Gemini replied',
    '正在输入', '正在思考', '思考中', '生成中', '加载中'
  ];
  const onlyEllipsisOrSpace = /^[.\u2026\s]+$/.test(s);
  return onlyEllipsisOrSpace || placeholders.some((p) => s.includes(p));
};

// ========= 浏览器控制 =========
async function ensureBrowser() {
  if (!context) {
    context = await chromium.launchPersistentContext(CFG.USER_DATA_DIR, {
      headless: CFG.HEADLESS
    });
    browser = context.browser();
    // 允许剪贴板（用于粘贴）
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://gemini.google.com'
    });
  }
  if (!page || page.isClosed()) page = await context.newPage();
  if (!page.url() || page.url().startsWith('about:blank')) {
    await page.goto(CFG.GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(CFG.WAIT_READY_MS);
  }
}

async function waitUntilIdle(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const busyBtn = await page.$(BUSY_BUTTON);
    if (!busyBtn) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

// ========= 编辑区与发送 =========
async function hasInputText(sel) {
  return await page
    .$eval(sel, (el) => ((el.innerText || el.textContent || '').replace(/\s+/g, '')).length > 0)
    .catch(() => false);
}

async function isSendButtonReady(timeoutMs = 2000) {
  return await page
    .waitForFunction(
      (sels) => {
        const pick = () => {
          for (const s of sels) {
            const n = document.querySelector(s);
            if (n) return n;
          }
          return null;
        };
        const n = pick();
        if (!n) return false;
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        if (r.width < 4 || r.height < 4) return false;
        const disabled = n.disabled || n.getAttribute('disabled') || n.getAttribute('aria-disabled');
        if (disabled && String(disabled).toLowerCase() !== 'false') return false;
        if (cs.pointerEvents === 'none') return false;
        return true;
      },
      { timeout: timeoutMs },
      SEND_SELECTORS
    )
    .then(() => true)
    .catch(() => false);
}

async function pickActiveInput() {
  const sel = await page
    .evaluate(({ baseSel }) => {
      const cand = Array.from(document.querySelectorAll(baseSel)).filter(
        (el) =>
          el.isConnected &&
          el.getBoundingClientRect().width > 5 &&
          el.getBoundingClientRect().height > 5
      );
      if (!cand.length) return null;
      document.querySelectorAll('[data-kilo-target]').forEach((n) =>
        n.removeAttribute('data-kilo-target')
      );
      cand[cand.length - 1].setAttribute('data-kilo-target', '1');
      return '[data-kilo-target="1"]';
    }, { baseSel: INPUT_SELECTOR })
    .catch(() => null);
  return sel;
}

async function focusIntoEditable(sel) {
  const box = await page
    .$eval(sel, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 40) };
    })
    .catch(() => null);
  if (box) await page.mouse.click(box.x, box.y, { clickCount: 1 });
  await page.locator(sel).focus().catch(() => {});
}

async function verifyInputMatches(sel, expected, timeoutMs = 6000) {
  return await page
    .waitForFunction(
      (s, exp) => {
        const el = document.querySelector(s);
        if (!el) return false;
        const norm = (txt) =>
          String(txt).replace(/\r/g, '').replace(/\u00A0/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        const cur0 = el.innerText || el.textContent || '';
        const cur = norm(cur0);
        const e = norm(exp);
        if (!cur) return false;
        if (cur === e || cur + '\n' === e || e + '\n' === cur) return true;
        if (cur.includes(e) || e.includes(cur)) return true;
        const head = e.slice(0, Math.min(12, e.length));
        if (head && cur.includes(head)) return true;
        if (cur.length >= Math.floor(e.length * 0.7)) return true;
        return false;
      },
      { timeout: timeoutMs },
      sel,
      expected
    )
    .then(() => true)
    .catch(() => false);
}

async function clickSendButton() {
  const sel = await page.evaluate((sels) => {
    for (const s of sels) {
      const n = document.querySelector(s);
      if (n) return s;
    }
    return null;
  }, SEND_SELECTORS);
  if (!sel) throw new Error('send_button_not_found');
  await isSendButtonReady(3000);
  await page.locator(sel).click({ timeout: 2000, force: true });
  return true;
}

// 核心：快速写入（统一清空→多策略写入→以“文本匹配/按钮可点/有非空文本”为成功）
async function setInputFast(sel, text) {
  const expected = String(text).replace(/\r/g, '').replace(/\u00A0/g, ' ');
  const loc = page.locator(sel);

  const focusAndClear = async () => {
    const box = await page
      .$eval(sel, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 40) };
      })
      .catch(() => null);
    if (box) await page.mouse.click(box.x, box.y, { clickCount: 1 });
    await loc.focus().catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return;
        el.innerHTML = '';
        el.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
        );
      }, sel)
      .catch(() => {});
  };

  const okAfter = async (verifyMs = 1600, sendMs = 1800) => {
    await page.waitForTimeout(CFG.AFTER_INPUT_SETTLE_MS);
    try {
      await page.keyboard.type(' ');
      await page.keyboard.press('Backspace');
    } catch {}
    if (await verifyInputMatches(sel, expected, verifyMs)) return true;
    if (await isSendButtonReady(sendMs)) return true;
    if (await hasInputText(sel)) return true;
    return false;
  };

  // A：execCommand('insertText') / insertHTML
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
      sel2.removeAllRanges();
      sel2.addRange(range);
      const ok1 = document.execCommand && document.execCommand('insertText', false, t);
      if (!ok1) {
        const html = String(t).split(/\r?\n/).map((line) => line || '<br>').join('<br>');
        document.execCommand('insertHTML', false, html);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      return true;
    }, sel, expected);
    if (ok && (await okAfter())) return true;
  } catch {}

  // B：剪贴板 + Ctrl+V
  await focusAndClear();
  try {
    await page.evaluate(async (t) => {
      try {
        await navigator.clipboard.writeText(t);
      } catch {}
    }, expected);
    await page.keyboard.down('Control').catch(() => {});
    await page.keyboard.press('KeyV').catch(() => {});
    await page.keyboard.up('Control').catch(() => {});
    if (await okAfter()) return true;
  } catch {}

  // C：insertText / type
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

  // D：按钮亮也算成功
  if (await isSendButtonReady(2000)) return true;

  return false;
}

// 先写入 → 再提交（优先按钮，Enter 兜底/或按需强制）
async function submitPrompt(prompt) {
  await waitUntilIdle(15000);

  const sel = await pickActiveInput();
  if (!sel) throw new Error('未找到输入框');

  const beforeCount = await page.$$eval(ANSWER_ROOT, (n) => n.length).catch(() => 0);

  const ok = await setInputFast(sel, prompt);
  if (!ok) throw new Error('paste_failed');
  await page.waitForTimeout(CFG.AFTER_INPUT_SETTLE_MS);

  if (CFG.FORCE_ENTER_ONLY) {
    await focusIntoEditable(sel);
    try {
      await page.keyboard.press('Enter');
    } catch {}
  } else {
    await isSendButtonReady(5000);
    try {
      await page.keyboard.press('Enter');
    } catch {}
    try {
      await clickSendButton();
    } catch {}
  }

  const started = await page
    .waitForFunction(
      (count) => {
        const roots = document.querySelectorAll('div[id^="model-response-message-content"]');
        const last = roots.length ? roots[roots.length - 1] : null;
        const t = last ? (last.innerText || last.textContent || '').trim() : '';
        return roots.length > count || t.length > 0;
      },
      { timeout: 4000 },
      beforeCount
    )
    .then(() => true)
    .catch(() => false);

  if (started) return beforeCount;

  // 兜底再试一次
  if (CFG.FORCE_ENTER_ONLY) {
    await focusIntoEditable(sel);
    try {
      await page.keyboard.press('Enter');
    } catch {}
  } else {
    try {
      await clickSendButton();
    } catch {}
  }

  const started2 = await page
    .waitForFunction(
      (count) => {
        const roots = document.querySelectorAll('div[id^="model-response-message-content"]');
        const last = roots.length ? roots[roots.length - 1] : null;
        const t = last ? (last.innerText || last.textContent || '').trim() : '';
        return roots.length > count || t.length > 0;
      },
      { timeout: 2000 },
      beforeCount
    )
    .then(() => true)
    .catch(() => false);

  if (started2) return beforeCount;

  throw new Error('submit_not_started');
}

// ========= 抓取气泡文本 / 状态 =========
async function findAllBubbles() {
  return await page.evaluate(({ rootSels, textSel }) => {
    const roots = [];
    for (const s of rootSels) document.querySelectorAll(s).forEach((n) => roots.push(n));
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const uniq = Array.from(new Set(roots)).filter(isVisible);
    return uniq.map((el, i) => {
      const md = el.querySelector(textSel);
      const text =
        (md?.innerText || md?.textContent || el.innerText || el.textContent || '').trim();
      const id = el.id || el.getAttribute('data-message-id') || `bubble-${i}`;
      return { index: i, id, text_len: text.length, preview: text.slice(0, 80) };
    });
  }, { rootSels: BUBBLE_ROOT_SELECTORS, textSel: BUBBLE_TEXT_SELECTOR });
}

async function getBubbleState(baselineCount = 0) {
  return await page
    .evaluate(
      ({ base, rootSels, textSel, spinSels }) => {
        const all = [];
        for (const s of rootSels) document.querySelectorAll(s).forEach((n) => all.push(n));
        const isVisible = (el) => {
          if (!el || !el.isConnected) return false;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
            return false;
          const r = el.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        };
        const list = Array.from(new Set(all)).filter(isVisible);
        if (list.length <= base) return { hasBubble: false, text: '', spinning: false };
        const last = list[list.length - 1];
        try {
          last.scrollIntoView({ block: 'nearest' });
        } catch {}
        const txtNode = last.querySelector(textSel);
        const text =
          (txtNode?.innerText || txtNode?.textContent || last.innerText || last.textContent || '')
            .trim();
        let spinning = false;
        for (const s of spinSels) {
          const n = last.querySelector(s);
          if (n && isVisible(n)) {
            spinning = true;
            break;
          }
        }
        return { hasBubble: true, text, spinning };
      },
      { base: baselineCount, rootSels: BUBBLE_ROOT_SELECTORS, textSel: BUBBLE_TEXT_SELECTOR, spinSels: SPINNER_SELECTORS }
    )
    .catch(() => ({ hasBubble: false, text: '', spinning: false }));
}

async function grabAnswerText(baselineCount = 0) {
  const st = await getBubbleState(baselineCount);
  return st.text || '';
}

// ========= 流式 / 非流式 =========
async function* readAnswerInChunks(baselineCount = 0) {
  let last = '';
  let lastChangeAt = Date.now();
  const t0 = Date.now();

  while (Date.now() - t0 < CFG.MAX_ANSWER_MS) {
    const raw = await grabAnswerText(baselineCount);
    if (!raw) {
      await new Promise((r) => setTimeout(r, 80));
      continue;
    }
    const cur = raw.replace(/\b(Gemini is typing|Gemini replied|正在输入.*?)\b/gi, '').trim();
    if (cur && !isPlaceholderText(cur) && cur !== last) {
      const delta = cur.slice(last.length);
      if (delta) {
        last = cur;
        lastChangeAt = Date.now();
        yield delta;
      }
    }
    if (last && Date.now() - lastChangeAt >= CFG.STABLE_MS) break;
    await new Promise((r) => setTimeout(r, 80));
  }

  const final = await grabAnswerText(baselineCount);
  const finalClean = (final || '').replace(/\b(Gemini is typing|Gemini replied|正在输入.*?)\b/gi, '').trim();
  if (finalClean && finalClean.length > last.length) {
    yield finalClean.slice(last.length);
  }
}

async function waitForFinalAnswer(baselineCount = 0) {
  let lastText = '';
  let lastChangeAt = Date.now();
  const t0 = Date.now();
  let everHadText = false;

  while (Date.now() - t0 < CFG.MAX_ANSWER_MS) {
    const { hasBubble, text, spinning } = await getBubbleState(baselineCount);
    const clean = (text || '')
      .replace(/\b(Gemini is typing|Gemini replied|正在输入|思考中|生成中|加载中)\b/gi, '')
      .trim();

    if (clean && clean !== lastText) {
      lastText = clean;
      everHadText = true;
      lastChangeAt = Date.now();
      if (lastText.length <= 5 && !spinning) return lastText;
    }
    if (everHadText && !spinning && Date.now() - lastChangeAt >= CFG.STABLE_MS) {
      return lastText;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!everHadText) throw new Error('no_text_captured');
  return lastText;
}

// ========= SSE 帮助 =========
const sseHead = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
};

// 中途增量帧
const sseChunk = (id, delta) =>
  `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: nowSec(),
    model: 'gemini-webui',
    choices: [
      { index: 0, delta: { content: delta }, finish_reason: null }
    ]
  })}\n\n`;

// 收尾帧（finish_reason = stop）
const sseStop = (id) =>
  `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: nowSec(),
    model: 'gemini-webui',
    choices: [
      { index: 0, delta: {}, finish_reason: 'stop' }
    ]
  })}\n\n`;


  // ========= Sanitizer 适配 =========
function buildSanitizeOptionsFromCFG() {
  return {
    mode: CFG.SAN_MODE,                 // tools-minimal | tools-off | passthrough
    keep: CFG.SAN_KEEP,                 // 追加白名单
    stripEnv: CFG.SAN_STRIP_ENV,
    stripStreamOptions: CFG.SAN_STRIP_STREAM,
    stripUnknownTopFields: CFG.SAN_PRUNE_TOP,
    stripModel: CFG.SAN_STRIP_MODEL,    // 固定移除 model（你已经要求默认 true）
    blockModels: CFG.SAN_BLOCK_MODELS,
    lang: CFG.SAN_LANG,
  };
}

// 封装一个“条件精简”辅助 & 两个诊断端点
/** 仅当识别为 Kilo Code 请求时才做精简；否则原样返回 */
function maybeSanitizeKiloBody(inBody) {
  if (!CFG.SAN_ON) return { body: inBody, changed: false, report: { on:false } };
  const opts = buildSanitizeOptionsFromCFG();
  const { json, changed, reason, bytesBefore, bytesAfter } =
    sanitizeKiloRequest(inBody, opts);
  return {
    body: json,
    changed,
    report: { on:true, reason, bytesBefore, bytesAfter, saved: Math.max(0, bytesBefore - bytesAfter) }
  };
}

// ====== 诊断端点：查看 Sanitizer 配置 ======
app.get('/sanitize-config', (_req, res) => {
  res.json({
    on: CFG.SAN_ON,
    options: buildSanitizeOptionsFromCFG()
  });
});

// ====== 诊断端点：试跑一次精简（不真正调用网页）======
app.post('/sanitize-dryrun', (req, res) => {
  try {
    const { body, changed, report } = maybeSanitizeKiloBody(req.body);
    res.json({ ok: true, changed, report, out: body });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});



// ========= 路由 =========
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/status', (_, res) =>
  res.json({ ok: true, busy, url: page?.url?.() || null, ts: Date.now() })
);

app.post('/reset', async (_req, res) => {
  try {
    busy = false;
    if (page) {
      try {
        await page.close();
      } catch {}
    }
    page = await context.newPage();
    await page.goto(CFG.GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(CFG.WAIT_READY_MS);
    res.json({ ok: true, reset: true, url: page.url() });
  } catch {
    res.status(500).json({ ok: false, error: 'reset failed' });
  }
});

app.get('/debug', async (_req, res) => {
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
  const inputCount = await page.$$eval(INPUT_SELECTOR, (els) => els.length).catch(() => 0);
  const btnCount = await page.$$eval(SEND_SELECTOR, (els) => els.length).catch(() => 0);
  res.json({ ok: true, inputCount, btnCount });
});

app.post('/type-test', async (req, res) => {
  try {
    await ensureBrowser();
    const sel = await pickActiveInput();
    if (!sel) return res.status(500).json({ ok: false, error: 'no_input' });

    const prompt =
      (req.body && String(req.body.text || '').trim()) || 'hello from type-test';
    const ok = await setInputFast(sel, prompt);
    const ready = await isSendButtonReady(3000);
    const html = await page.$eval(sel, (el) => el.innerHTML).catch(() => null);
    const txt = await page
      .$eval(sel, (el) => el.innerText || el.textContent || '')
      .catch(() => null);
    res.json({
      ok: true,
      writeOk: ok,
      sendReady: !!ready,
      textLen: (txt || '').length,
      preview: (txt || '').slice(0, 80),
      htmlLen: (html || '').length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/v1/models', (_req, res) =>
  res.json({
    object: 'list',
    data: [{ id: 'gemini-webui', object: 'model', created: nowSec(), owned_by: 'local' }]
  })
);

app.get('/peek', async (_req, res) => {
  try {
    await ensureBrowser();
    const base = (await findAllBubbles()).length;
    const st = await getBubbleState(base);
    res.json({
      ok: true,
      bubbles: base,
      spinning: st.spinning,
      text_len: (st.text || '').length,
      text: st.text?.slice(0, 300) || ''
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/bubbles', async (_req, res) => {
  try {
    await ensureBrowser();
    const all = await findAllBubbles();
    res.json({ ok: true, count: all.length, bubbles: all });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  if (busy) return res.status(429).json({ error: { message: 'busy: single-flight in progress' } });
  busy = true;

  const id = 'chatcmpl_' + Date.now().toString(36);
  const watchdog = setTimeout(() => {
    busy = false;
  }, CFG.MAX_ANSWER_MS + 2000);
  res.once('close', () => {
    clearTimeout(watchdog);
    busy = false;
  });
  res.once('finish', () => {
    clearTimeout(watchdog);
    busy = false;
  });

  try {
    // ① 进入 Sanitizer（仅 Kilo Code 命中时才改写）
    const { body: sanitizedBody, changed, report } = maybeSanitizeKiloBody(req.body);
    if (changed) {
      res.setHeader('X-KiloSanitize', '1');
      res.setHeader('X-KiloSanitize-Reason', String(report?.reason || ''));
    } else {
      res.setHeader('X-KiloSanitize', '0');
    }

    const stream = wantStream(sanitizedBody);
    const prompt = toPrompt(sanitizedBody);

    if (!prompt) return res.status(400).json({ error: { message: 'empty prompt' } });

    await ensureBrowser();
    const baseline = await submitPrompt(prompt);

    if (stream) {
      // ========= 流式返回 =========
      sseHead(res);
      let full = '';

      for await (const delta of readAnswerInChunks(baseline)) {
        full += delta;
        res.write(sseChunk(id, delta));
      }

      // ✅ 正确收尾
      res.write(sseStop(id));         // 发出 finish_reason=stop 的收尾 chunk
      res.write('data: [DONE]\n\n');  // 发标准 [DONE] 结束帧
      res.end();
      return;
    } else {
      // ========= 非流式返回 =========
      const full = await waitForFinalAnswer(baseline);
      const safe = typeof full === 'string' ? full : '';
      res.json({
        id,
        object: 'chat.completion',
        created: nowSec(),
        model: 'gemini-webui',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: safe },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
      return;
    }
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('[proxy error]', msg);
    if (!res.headersSent) {
      const reason = msg.includes('submit_not_started')
        ? 'submit_not_started'
        : msg.includes('no_text_captured')
        ? 'no_text_captured'
        : 'proxy_error';
      res.status(502).json({ error: { message: reason } });
    }
  }
});


// ========= 启动 =========
await ensureBrowser();
console.log('[kilo-openai-proxy] browser ready');
app.listen(CFG.PORT, () =>
  console.log(`[kilo-openai-proxy] listening on http://127.0.0.1:${CFG.PORT}`)
);
