// obs.mjs — 极简观测脚本：打开 Gemini → 输入 "123" → 点击发送
import { chromium } from 'playwright';

const GEMINI_URL     = process.env.GEMINI_URL     || 'https://gemini.google.com/app';
const USER_DATA_DIR  = process.env.USER_DATA_DIR  || './.pw-gemini-profile';
const HEADLESS       = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
const WAIT_READY_MS  = Number(process.env.WAIT_READY_MS || 2500);

// 更宽松的输入与发送按钮候选
const INPUT_SELECTORS = [
  'rich-textarea .ql-editor.textarea.new-input-ui[contenteditable="true"][role="textbox"]',
  'rich-textarea [contenteditable="true"][role="textbox"]',
  'rich-textarea div[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]'
];

const SEND_SELECTORS = [
  '.send-button-container.visible button.send-button.submit[aria-label="Send message"]',
  'button[aria-label="Send message"]',
  'button[aria-label^="Send"]',
  'button[aria-label*="send" i]',
  'button[aria-label*="发送"]'
];

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();

  // 1) 打开页面
  console.log('[obs] goto:', GEMINI_URL);
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(WAIT_READY_MS);

  // 2) 选中一个“可见/可编辑”的输入框，并标记
  const activeInputSel = await page.evaluate((sels) => {
    const visible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      const r  = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      if (r.width < 5 || r.height < 5) return false;
      return true;
    };
    const all = [];
    for (const s of sels) document.querySelectorAll(s).forEach(n => all.push(n));
    const cand = all.filter(visible);
    const el = cand.at(-1);
    if (!el) return null;
    document.querySelectorAll('[data-obs-target]').forEach(n => n.removeAttribute('data-obs-target'));
    el.setAttribute('data-obs-target', '1');
    return '[data-obs-target="1"]';
  }, INPUT_SELECTORS);

  if (!activeInputSel) {
    console.error('[obs] 未找到可用输入框');
    return;
  }
  console.log('[obs] input found:', activeInputSel);

  // 聚焦 + 输入 "123"（尽量触发富文本编辑器的输入事件）
  const focusCenter = async () => {
    const box = await page.$eval(activeInputSel, el => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) };
    }).catch(() => null);
    if (box) { await page.mouse.click(box.x, box.y); }
    await page.locator(activeInputSel).focus().catch(() => {});
  };

  await focusCenter();

  // 尝试多种写入方式，任一成功即可
  const tryWrite = async () => {
    // A) execCommand('insertText') / insertHTML（对 Quill/ContentEditable 友好）
    const okA = await page.evaluate((sel, t) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      const rng = document.createRange();
      rng.selectNodeContents(el);
      rng.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(rng);
      const ok = document.execCommand && document.execCommand('insertText', false, t);
      if (!ok) {
        const html = String(t).split(/\r?\n/).map(x => x || '<br>').join('<br>');
        document.execCommand('insertHTML', false, html);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      return true;
    }, activeInputSel, '123').catch(() => false);
    if (okA) return true;

    // B) 直接 insertText
    try { await page.keyboard.insertText('123'); return true; } catch {}

    // C) 回退到 type
    try { await page.locator(activeInputSel).type('123', { delay: 0 }); return true; } catch {}

    return false;
  };

  // 先清空再写入
  await page.keyboard.press('Control+A').catch(()=>{});
  await page.keyboard.press('Delete').catch(()=>{});
  await page.keyboard.press('Backspace').catch(()=>{});
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) {
      el.innerHTML = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
  }, activeInputSel).catch(()=>{});

  const wrote = await tryWrite();
  console.log('[obs] wrote "123"?', wrote);

  // 读取输入框当前文本，确认是否真的有内容
  const curText = await page.$eval(activeInputSel, el => (el.innerText || el.textContent || '').trim()).catch(()=> '');
  console.log('[obs] input content:', JSON.stringify(curText));

  // 轻触空格/退格，帮助样式刷新（某些皮肤会根据是否“非空”来点亮按钮）
  try { await page.keyboard.type(' '); await page.keyboard.press('Backspace'); } catch {}
  await page.waitForTimeout(600);

  // 找“就近”的发送按钮（优先在输入框附近找，找不到再全局兜底）
  const getSendBtnBoxNear = async () => {
    return await page.evaluate((sels) => {
      const vis = (el) => {
        if (!el || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        const r  = el.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        if (r.width < 4 || r.height < 4) return false;
        if (cs.pointerEvents === 'none') return false;
        const dis = el.disabled || el.getAttribute('disabled') || el.getAttribute('aria-disabled');
        if (dis && String(dis).toLowerCase() !== 'false') return false;
        return true;
      };

      const input = document.querySelector('[data-obs-target="1"]');
      const up = (el, n = 6) => {
        let cur = el;
        for (let i = 0; i < n && cur && cur.parentElement; i++) cur = cur.parentElement;
        return cur || document;
      };
      const scope = input ? up(input, 4) : document;

      const pool = [];
      for (const s of sels) scope.querySelectorAll(s).forEach(n => pool.push(n));
      if (!pool.length) for (const s of sels) document.querySelectorAll(s).forEach(n => pool.push(n));

      const btn = pool.find(vis);
      if (!btn) return null;
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = btn.getBoundingClientRect();
      return { x: Math.floor(r.left + r.width/2), y: Math.floor(r.top + r.height/2) };
    }, SEND_SELECTORS).catch(() => null);
  };

  const btnBox = await getSendBtnBoxNear();
  console.log('[obs] send button found?', !!btnBox, btnBox || '');

  // 点击一次（完整 pointer 事件）
  if (btnBox) {
    await page.mouse.move(btnBox.x, btnBox.y);
    await page.mouse.click(btnBox.x, btnBox.y);
    console.log('[obs] clicked send button once.');
  } else {
    console.warn('[obs] 未找到发送按钮（可能仍在登录页/或皮肤改版）');
  }

  // 留在前台观察（无头模式才自动退出）
  if (HEADLESS) { await ctx.close(); }
  else { console.log('[obs] 浏览器保持打开，按 Ctrl+C 退出'); }
})().catch(e => {
  console.error('[obs] error:', e);
});
