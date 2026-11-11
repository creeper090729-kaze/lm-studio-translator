'use strict';

initPageTranslator();

function initPageTranslator() {
  if (self.__lmController && self.__lmController.dispose) self.__lmController.dispose();
  const controller = {};
  self.__lmController = controller;
  function live() { return self.__lmController === controller; }

  document.querySelectorAll('[data-lm-translate="1"]').forEach(function (node) { node.remove(); });
  const host = document.createElement('div');
  host.setAttribute('data-lm-translate', '1');
  host.dataset.state = 'idle';
  lockBox(host);
  host.style.setProperty('display', 'none', 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = [
    ':host{color-scheme:light dark;}',
    '.panel{box-sizing:border-box;width:min(380px,calc(100vw - 16px));max-height:min(280px,calc(100vh - 16px));overflow:auto;',
    'background:#fff;color:#1c1b1f;border:1px solid rgba(0,0,0,.14);border-radius:12px;',
    'box-shadow:0 10px 28px rgba(0,0,0,.18);padding:10px 12px 8px;',
    'font:14px/1.55 system-ui,"Segoe UI","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;}',
    '.meta{font-size:11px;color:#5f6368;margin:0 0 6px;}',
    '.body{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;margin:0;}',
    '.body.error{color:#9d1c1c;}',
    '.actions{display:flex;gap:6px;margin-top:8px;}',
    'button{appearance:none;border:1px solid rgba(0,0,0,.14);background:#f3f4f6;color:#1c1b1f;',
    'border-radius:999px;padding:4px 10px;font:12px/1.4 inherit;cursor:pointer;}',
    'button:hover{background:#e6e8eb;}',
    'button:disabled{opacity:.45;cursor:default;}',
    '@media (prefers-color-scheme:dark){',
    '.panel{background:#1f1f1f;color:#f2f2f2;border-color:rgba(255,255,255,.16);box-shadow:0 12px 32px rgba(0,0,0,.5);}',
    '.meta{color:#c4c7c5;}',
    '.body.error{color:#ffb4ab;}',
    'button{background:#2c2c2c;color:#f2f2f2;border-color:rgba(255,255,255,.16);}',
    'button:hover{background:#383838;}',
    '}'
  ].join('');

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'LM Studio 翻译');

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = 'LM Studio';

  const body = document.createElement('p');
  body.className = 'body';
  body.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = '复制';

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.textContent = '重试';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';

  actions.append(copyBtn, retryBtn, closeBtn);
  panel.append(meta, body, actions);
  shadow.append(style, panel);

  let mouseupOn = false;
  let open = false;
  let seq = 0;
  let activeId = '';
  let currentText = '';
  let anchorRange = null;
  let timer = 0;
  let lastResult = '';
  let displayMode = 'tooltip';
  let sideKey = '';
  let sideState = 'idle';
  let pageToken = 0;
  let pageRunning = false;
  let pageDone = 0;
  let pageFailed = 0;
  let pageFatal = '';
  let pageSeq = 0;
  let pageBar = null;
  let pageBarText = null;
  let pageStopBtn = null;
  let pageClearBtn = null;
  let pageCloseBtn = null;

  chrome.storage.local.get('settings', function (bag) {
    const settings = bag && bag.settings;
    mouseupOn = !!(settings && settings.triggerMode === 'select');
    displayMode = settings && settings.displayMode === 'sidebar' ? 'sidebar' : 'tooltip';
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (!live()) return;
    if (area !== 'local' || !changes.settings) return;
    const settings = changes.settings.newValue;
    mouseupOn = !!(settings && settings.triggerMode === 'select');
    displayMode = settings && settings.displayMode === 'sidebar' ? 'sidebar' : 'tooltip';
    if (displayMode === 'sidebar' && open) closeTooltip();
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!live()) return false;
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'translate-page') {
      if (!LMShared || !LMShared.createPageWalker) {
        sendResponse({ ok: false, error: '请刷新网页后再试' });
        return false;
      }
      if (pageRunning) {
        haltPage('stop');
        sendResponse({ ok: true, stopped: true });
        return false;
      }
      if (!document.body) {
        sendResponse({ ok: false, error: '这个页面没有正文' });
        return false;
      }
      pageToken += 1;
      pageRunning = true;
      sendResponse({ ok: true, started: true });
      runPage();
      return false;
    }
    if (msg.type === 'translate-selection') {
      const text = readSelectedText().trim();
      if (!text) {
        if (displayMode === 'sidebar') {
          notify({ type: 'side-push', id: 'empty-' + Date.now(), state: 'error', original: '', text: '请先选中文字' });
        } else {
          showMessage('请先选中文字', true);
        }
        sendResponse({ ok: false, error: '请先选中文字' });
        return false;
      }
      rememberRange();
      startTranslate(text);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  document.addEventListener('mouseup', function (event) {
    if (!live() || !mouseupOn || event.button !== 0) return;
    if (eventInside(event)) return;
    if (displayMode === 'sidebar' && !selectionInEditable()) {
      const preview = readSelectedText().trim();
      if (preview.length >= 2) notify({ type: 'open-side-panel' });
    }
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!live()) return;
      if (selectionInEditable()) return;
      const text = readSelectedText().trim();
      if (text.length < 2) return;
      rememberRange();
      startTranslate(text);
    }, 120);
  }, true);

  document.addEventListener('mousedown', function (event) {
    if (!live() || !open || eventInside(event)) return;
    hide(true);
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!live()) return;
    if (event.key !== 'Escape') return;
    if (open) hide(true);
    if (pageRunning) haltPage('stop');
  }, true);

  window.addEventListener('resize', function () {
    if (live() && open) place(currentRect());
  });
  window.addEventListener('scroll', function () {
    if (live() && open) place(currentRect());
  }, true);

  copyBtn.addEventListener('click', function () {
    const value = body.classList.contains('error') ? '' : body.textContent;
    if (!value) return;
    copyText(value).then(function (ok) {
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
    });
  });
  retryBtn.addEventListener('click', function () {
    if (currentText) startTranslate(currentText, true);
  });
  closeBtn.addEventListener('click', function () {
    hide(true);
  });

  function startTranslate(text, force) {
    if (!live()) return;
    if (pageRunning) haltPage('stop');
    const useSide = displayMode === 'sidebar';
    if (useSide) {
      if (!force && sideKey === text && sideState === 'loading') return;
    } else {
      if (!force && open && currentText === text && (host.dataset.state === 'loading' || host.dataset.state === 'result')) {
        return;
      }
      if (!force && foreignOwns(text)) return;
    }
    if (useSide && open) closeTooltip();
    seq += 1;
    const mySeq = seq;
    const requestId = Date.now().toString(36) + '-' + mySeq.toString(36);
    if (activeId) notify({ type: 'abort', requestId: activeId });
    activeId = requestId;
    currentText = text;
    host.dataset.source = text;
    if (useSide) {
      sideKey = text;
      sideState = 'loading';
      notify({ type: 'side-push', id: requestId, state: 'loading', original: text, text: '' });
    } else {
      showLoading(!!force && !!lastResult);
    }
    chrome.storage.local.get('settings', function (bag) {
      if (!live() || mySeq !== seq) return;
      const timeoutSec = bag && bag.settings && Number(bag.settings.timeoutSec);
      const waitMs = ((Number.isFinite(timeoutSec) ? timeoutSec : 45) + 15) * 1000;
      ask({ type: 'translate-text', text: text, requestId: requestId }, waitMs).then(function (res) {
        if (!live() || mySeq !== seq) return;
        if (!res || res.aborted) {
          if (useSide) return;
          if (host.dataset.state === 'loading') {
            if (lastResult) showMessage(lastResult, false);
            else hide(false);
          }
          return;
        }
        if (!res.ok) {
          if (useSide) {
            sideState = 'error';
            notify({ type: 'side-push', id: requestId, state: 'error', original: text, text: res.error || '翻译失败' });
            return;
          }
          showMessage(res.error || '翻译失败', true);
          return;
        }
        if (useSide) {
          sideState = 'result';
          notify({ type: 'side-push', id: requestId, state: 'result', original: text, text: res.text || '' });
          return;
        }
        showMessage(res.text || '', false);
        meta.textContent = res.cached ? 'LM Studio · 缓存' : 'LM Studio';
      }, function (err) {
        if (!live() || mySeq !== seq) return;
        const message = err && err.message ? err.message : '翻译失败';
        if (useSide) {
          sideState = 'error';
          notify({ type: 'side-push', id: requestId, state: 'error', original: text, text: message });
          return;
        }
        showMessage(message, true);
      });
    });
  }

  function showLoading(keepResult) {
    open = true;
    host.dataset.state = 'loading';
    meta.textContent = '正在翻译…';
    if (!keepResult) {
      body.textContent = '正在翻译…';
      body.classList.remove('error');
      copyBtn.disabled = true;
      lastResult = '';
    }
    retryBtn.disabled = true;
    sweep();
    ensureMounted();
    showHost();
    place(currentRect());
  }

  function showMessage(text, isError) {
    open = true;
    host.dataset.state = isError ? 'error' : 'result';
    body.textContent = text || (isError ? '翻译失败' : '');
    body.classList.toggle('error', !!isError);
    copyBtn.disabled = !!isError || !text;
    retryBtn.disabled = !currentText;
    if (!isError) lastResult = text || '';
    if (meta.textContent === '正在翻译…') meta.textContent = 'LM Studio';
    sweep();
    ensureMounted();
    showHost();
    place(currentRect());
  }

  function hide(abort) {
    open = false;
    seq += 1;
    host.dataset.state = 'idle';
    host.style.setProperty('display', 'none', 'important');
    if (abort && activeId) notify({ type: 'abort', requestId: activeId });
    activeId = '';
  }

  function closeTooltip() {
    open = false;
    host.dataset.state = 'idle';
    host.style.setProperty('display', 'none', 'important');
  }

  function sweep() {
    const nodes = document.querySelectorAll('[data-lm-translate="1"]');
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i] !== host) nodes[i].remove();
    }
  }

  function foreignOwns(text) {
    const nodes = document.querySelectorAll('[data-lm-translate="1"]');
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node === host) continue;
      if (node.dataset.source === text && (node.dataset.state === 'loading' || node.dataset.state === 'result')) return true;
    }
    return false;
  }

  function showHost() {
    host.style.setProperty('display', 'block', 'important');
  }

  function lockBox(node) {
    const props = {
      position: 'fixed',
      'z-index': '2147483647',
      margin: '0',
      padding: '0',
      border: 'none',
      background: 'transparent',
      width: 'max-content',
      height: 'max-content',
      'max-width': 'min(380px, calc(100vw - 16px))',
      right: 'auto',
      bottom: 'auto',
      overflow: 'visible',
      'pointer-events': 'auto',
      'color-scheme': 'light dark',
      'box-sizing': 'border-box'
    };
    Object.keys(props).forEach(function (key) {
      node.style.setProperty(key, props[key], 'important');
    });
  }

  function ensureMounted() {
    const root = document.documentElement || document.body;
    if (!root) return;
    if (host.parentNode !== root) {
      try { root.appendChild(host); } catch (err) { /* XML documents can reject the node. */ }
    }
  }

  function place(rect) {
    const margin = 8;
    const width = panel.offsetWidth || 320;
    const height = panel.offsetHeight || 72;
    const viewportW = window.innerWidth || 800;
    const viewportH = window.innerHeight || 600;
    let left = rect ? rect.left : margin;
    let top = rect ? rect.bottom + margin : margin;
    if (left + width > viewportW - margin) left = viewportW - width - margin;
    if (left < margin) left = margin;
    if (top + height > viewportH - margin) {
      const above = rect ? rect.top - height - margin : margin;
      top = above >= margin ? above : margin;
    }
    host.style.setProperty('left', Math.round(left) + 'px', 'important');
    host.style.setProperty('top', Math.round(top) + 'px', 'important');
  }

  function currentRect() {
    if (!anchorRange) return null;
    try {
      const rect = anchorRange.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    } catch (err) {
      return null;
    }
    return null;
  }

  function rememberRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      anchorRange = null;
      return;
    }
    try { anchorRange = selection.getRangeAt(0).cloneRange(); } catch (err) { anchorRange = null; }
  }

  function eventInside(event) {
    const path = event.composedPath ? event.composedPath() : [];
    for (let i = 0; i < path.length; i += 1) {
      const node = path[i];
      if (node === host || node === pageBar) return true;
      if (node && node.nodeType === 1 && node.hasAttribute &&
          (node.hasAttribute('data-lm-slot') || node.hasAttribute('data-lm-page-bar'))) return true;
    }
    return false;
  }

  function readSelectedText() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || isTextInput(active))) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        return active.value.slice(start, end);
      }
    }
    const selection = window.getSelection();
    return selection ? String(selection.toString() || '') : '';
  }

  function selectionInEditable() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) {
      return true;
    }
    const selection = window.getSelection();
    if (!selection || !selection.anchorNode) return false;
    const element = selection.anchorNode.nodeType === 1
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
    return !!(element && element.closest && element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
  }

  function isTextInput(element) {
    if (!element || element.tagName !== 'INPUT') return false;
    const type = String(element.type || 'text').toLowerCase();
    return type === 'text' || type === 'search';
  }

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
    } catch (err) { /* Extension reloaded. */ }
  }

  function ask(msg, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('后台无响应，请再试一次'));
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(mapRuntimeError(runtimeError.message)));
            return;
          }
          resolve(res);
        });
      } catch (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(mapRuntimeError(err && err.message)));
      }
    });
  }

  function mapRuntimeError(message) {
    const text = String(message || '');
    if (/invalidated|context/i.test(text)) return '插件刚更新或重载，请刷新这个网页';
    if (/port closed|channel closed/i.test(text)) return '后台中断了这次翻译，请重试';
    if (/Receiving end does not exist/i.test(text)) return '页面上的翻译脚本没挂上，请刷新网页';
    return text || '插件通信失败';
  }

  function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () { return true; }, function () {
        return copyWithTextarea(value);
      });
    }
    return Promise.resolve(copyWithTextarea(value));
  }

  function copyWithTextarea(value) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.documentElement.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    area.remove();
    return ok;
  }

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, MATH: 1, CANVAS: 1,
    IFRAME: 1, OBJECT: 1, VIDEO: 1, AUDIO: 1, IMG: 1, INPUT: 1, TEXTAREA: 1,
    SELECT: 1, BUTTON: 1, OPTION: 1, NAV: 1
  };
  const INLINE_TAGS = {
    SPAN: 1, A: 1, EM: 1, STRONG: 1, B: 1, I: 1, U: 1, SMALL: 1, MARK: 1,
    SUB: 1, SUP: 1, ABBR: 1, CITE: 1, Q: 1, CODE: 1, SAMP: 1, KBD: 1, VAR: 1,
    TIME: 1, FONT: 1, BDO: 1, BDI: 1, RUBY: 1, RT: 1, RP: 1, WBR: 1, INS: 1,
    DEL: 1, LABEL: 1, BR: 1
  };
  const NO_SLOT_PARENT = {
    UL: 1, OL: 1, MENU: 1, DL: 1, TABLE: 1, TBODY: 1, THEAD: 1, TFOOT: 1, TR: 1, SELECT: 1
  };
  const BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, CENTER: 1, DD: 1, DETAILS: 1,
    DIV: 1, DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, HGROUP: 1, HR: 1, LI: 1,
    MAIN: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, TABLE: 1, TBODY: 1, TD: 1, TFOOT: 1,
    TH: 1, THEAD: 1, TR: 1, UL: 1, CAPTION: 1, SUMMARY: 1
  };
  const PAGE_SLOT_CSS = [
    ':host{color-scheme:light dark;}',
    '.line{margin:0.35em 0 0.65em;padding:0 0 0 0.65em;',
    'border-left:3px solid light-dark(#3f6b54,#8fbfa2);',
    'color:light-dark(#143026,#d5f5e3);',
    'font:16px/1.65 system-ui,"Segoe UI","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;',
    'white-space:pre-wrap;overflow-wrap:anywhere;}',
    '.line.err{border-left-color:light-dark(#b91c1c,#ffb4ab);color:light-dark(#9d1c1c,#ffb4ab);}'
  ].join('');

  function runPage() {
    const token = pageToken;
    pageDone = 0;
    pageFailed = 0;
    pageFatal = '';
    if (host.dataset.state === 'loading') hide(true);
    else if (open) closeTooltip();
    if (activeId && activeId.indexOf('page-') !== 0) {
      notify({ type: 'abort', requestId: activeId });
      activeId = '';
      seq += 1;
    }
    showBar('正在按段落翻译…', 'running');
    walk(document.body, { token: token }, 0).then(function (status) {
      if (token !== pageToken || !live()) return;
      pageRunning = false;
      if (status === 'fatal') {
        showBar(pageFatal || '整页翻译失败', 'error');
        return;
      }
      if (pageDone === 0 && pageFailed === 0) showBar('没有需要翻译的段落', 'done');
      else if (pageFailed) showBar('整页翻译完成 · 成功 ' + pageDone + ' 段，失败 ' + pageFailed + ' 段', 'done');
      else showBar('整页翻译完成 · ' + pageDone + ' 段', 'done');
    }, function (err) {
      if (token !== pageToken || !live()) return;
      pageRunning = false;
      showBar(err && err.message ? err.message : '整页翻译失败', 'error');
    });
  }

  function haltPage(mode) {
    const was = pageRunning;
    pageToken += 1;
    pageRunning = false;
    if (activeId && activeId.indexOf('page-') === 0) {
      const id = activeId;
      activeId = '';
      notify({ type: 'abort', requestId: id });
    }
    if (!was) return;
    if (mode === 'stop') {
      showBar(pageDone > 0 ? ('已停止 · 已译 ' + pageDone + ' 段') : '已停止整页翻译', 'stopped');
      return;
    }
    hideBar();
  }

  function clearPageTranslations() {
    haltPage('quiet');
    const slots = document.querySelectorAll('[data-lm-slot]');
    for (let i = slots.length - 1; i >= 0; i -= 1) slots[i].remove();
    const marked = document.querySelectorAll('[data-lm-src],[data-lm-before],[data-lm-tail]');
    for (let i = 0; i < marked.length; i += 1) {
      marked[i].removeAttribute('data-lm-src');
      marked[i].removeAttribute('data-lm-before');
      marked[i].removeAttribute('data-lm-tail');
    }
    pageDone = 0;
    pageFailed = 0;
    hideBar();
  }

  // Reads one paragraph (or one maxChars slice of a long paragraph) at a time.
  async function walk(el, ctx, depth) {
    if (!live() || ctx.token !== pageToken) return 'stop';
    if (!el || el.nodeType !== 1) return 'ok';
    if (skipElement(el) || isHidden(el) || inClosedDetails(el)) return 'ok';
    if (el.getAttribute('data-lm-src') === '1') return 'ok';
    if (depth > 80) return translateLeaf(el, ctx);
    if (!hasBlockChild(el)) {
      if (el.tagName === 'HTML') return 'ok';
      return translateLeaf(el, ctx);
    }
    const snapshot = [];
    for (let i = 0; i < el.childNodes.length; i += 1) snapshot.push(el.childNodes[i]);
    let inline = [];
    for (let i = 0; i < snapshot.length; i += 1) {
      if (!live() || ctx.token !== pageToken) return 'stop';
      const node = snapshot[i];
      if (node.nodeType === 1 && (isOurNode(node) || skipElement(node) || isHidden(node) || inClosedDetails(node))) {
        continue;
      }
      if (node.nodeType === 1 && isBlockElement(node)) {
        if (!NO_SLOT_PARENT[el.tagName]) {
          const seg = await translateSegment(inline, el, node, ctx);
          if (seg === 'stop' || seg === 'fatal') return seg;
        }
        inline = [];
        const childStatus = await walk(node, ctx, depth + 1);
        if (childStatus === 'stop' || childStatus === 'fatal') return childStatus;
        continue;
      }
      inline.push(node);
    }
    if (NO_SLOT_PARENT[el.tagName]) return 'ok';
    return translateSegment(inline, el, null, ctx);
  }

  async function translateLeaf(el, ctx) {
    if (!el || el.getAttribute('data-lm-src') === '1') return 'ok';
    const status = await streamNodes(el, el.tagName === 'PRE', ctx, function (peek) {
      return locateLeaf(el, peek);
    });
    if (status === 'ok' && ctx.token === pageToken && live()) el.setAttribute('data-lm-src', '1');
    return status === 'empty' ? 'ok' : status;
  }

  async function translateSegment(nodes, parent, beforeNode, ctx) {
    if (!nodes.length || !segmentHasText(nodes)) return 'ok';
    if (beforeNode && beforeNode.getAttribute('data-lm-before') === '1') return 'ok';
    if (!beforeNode && parent.getAttribute('data-lm-tail') === '1') return 'ok';
    const fake = { nodeType: 1, tagName: 'DIV', childNodes: nodes };
    const status = await streamNodes(fake, false, ctx, function (peek) {
      return locateSeg(parent, beforeNode, peek);
    });
    if (status === 'ok' && ctx.token === pageToken && live()) {
      if (beforeNode) beforeNode.setAttribute('data-lm-before', '1');
      else parent.setAttribute('data-lm-tail', '1');
    }
    return status === 'empty' ? 'ok' : status;
  }

  async function streamNodes(root, pre, ctx, locateSlot) {
    const settings = await readPageSettings();
    if (ctx.token !== pageToken || !live()) return 'stop';
    const limit = settings.maxChars;
    let slot = locateSlot(true);
    let pendingSkip = 0;
    if (slot) {
      if (slot.getAttribute('data-lm-done') === '1') return 'ok';
      pendingSkip = prepareSlot(slot, limit);
    }
    const walker = LMShared.createPageWalker(root, { pre: !!pre, skip: walkerSkip });
    let consumed = pendingSkip;
    while (true) {
      if (ctx.token !== pageToken || !live()) return 'stop';
      const piece = walker.pull(limit);
      if (!piece) break;
      if (!LMShared.meaningfulText(piece)) continue;
      if (pendingSkip > 0) {
        pendingSkip -= 1;
        continue;
      }
      if (!slot) {
        slot = locateSlot(false);
        if (!slot) {
          pageFatal = '这一段没法插入译文';
          return 'fatal';
        }
        prepareSlot(slot, limit);
      }
      showBar('正在按段落翻译 · 第 ' + (pageDone + 1) + ' 段', 'running');
      const result = await requestPiece(piece, ctx);
      if (result.kind === 'stop') return 'stop';
      if (result.kind === 'error') {
        appendLine(slot, result.error || '翻译失败', true);
        pageFailed += 1;
        if (isFatalPageError(result.error)) {
          pageFatal = result.error || '整页翻译失败';
          return 'fatal';
        }
        consumed += 1;
        slot.setAttribute('data-lm-count', String(consumed));
        continue;
      }
      appendLine(slot, result.text, false);
      pageDone += 1;
      consumed += 1;
      slot.setAttribute('data-lm-count', String(consumed));
      showBar('正在按段落翻译 · 第 ' + pageDone + ' 段', 'running');
    }
    if (!slot) return 'empty';
    slot.setAttribute('data-lm-done', '1');
    return 'ok';
  }

  async function requestPiece(text, ctx) {
    const settings = await readPageSettings();
    if (ctx.token !== pageToken || !live()) return { kind: 'stop' };
    const payload = text;
    pageSeq += 1;
    const requestId = 'page-' + ctx.token + '-' + pageSeq;
    activeId = requestId;
    if (ctx.token !== pageToken || !live()) {
      if (activeId === requestId) activeId = '';
      return { kind: 'stop' };
    }
    try {
      const res = await ask({
        type: 'translate-text',
        text: payload,
        requestId: requestId
      }, (settings.timeoutSec + 15) * 1000);
      if (activeId === requestId) activeId = '';
      if (ctx.token !== pageToken || !live()) return { kind: 'stop' };
      if (!res || res.aborted) return { kind: 'stop' };
      if (!res.ok) return { kind: 'error', error: res.error || '翻译失败' };
      return { kind: 'ok', text: res.text || '' };
    } catch (err) {
      if (activeId === requestId) activeId = '';
      if (ctx.token !== pageToken || !live()) return { kind: 'stop' };
      return { kind: 'error', error: err && err.message ? err.message : '翻译失败' };
    }
  }

  function readPageSettings() {
    return new Promise(function (resolve) {
      const fallback = { maxChars: 2000, timeoutSec: 45 };
      try {
        chrome.storage.local.get('settings', function (bag) {
          if (chrome.runtime.lastError) {
            resolve(fallback);
            return;
          }
          const src = bag && bag.settings ? bag.settings : {};
          resolve({
            maxChars: clampNum(Number(src.maxChars), 50, 8000, 2000),
            timeoutSec: clampNum(Number(src.timeoutSec), 10, 180, 45)
          });
        });
      } catch (err) {
        resolve(fallback);
      }
    });
  }

  function clampNum(n, min, max, fallback) {
    if (!Number.isFinite(n)) return fallback;
    n = Math.round(n);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function isFatalPageError(message) {
    return /连不上|没有加载模型|还没有加载|认证失败|接口不存在|找不到这个模型|后台无响应|后台中断|插件刚更新|插件通信失败|无法在此页面|设置无效|地址无效|超过\s*\d+\s*秒|连接超时/.test(String(message || ''));
  }

  function segmentHasText(nodes) {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.nodeType === 3 && LMShared.meaningfulText(node.nodeValue || '')) return true;
      if (node.nodeType === 1 && !isOurNode(node) && !skipElement(node)) return true;
    }
    return false;
  }

  function skipElement(el) {
    if (!el || el.nodeType !== 1) return true;
    if (isOurNode(el)) return true;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute('role');
    return role === 'navigation' || role === 'menu' || role === 'menubar';
  }

  function inClosedDetails(el) {
    if (!el.closest) return false;
    const details = el.closest('details');
    if (!details || details === el || details.open) return false;
    if (el.tagName === 'SUMMARY' || el.closest('summary')) return false;
    return true;
  }

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || (el.getAttribute && el.getAttribute('aria-hidden') === 'true')) return true;
    try {
      const style = window.getComputedStyle(el);
      if (!style) return false;
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    } catch (err) {
      return false;
    }
  }

  function isBlockElement(el) {
    const tag = el.tagName;
    if (INLINE_TAGS[tag] || tag === 'BR') return false;
    if (BLOCK_TAGS[tag]) return true;
    try {
      const display = window.getComputedStyle(el).display;
      return display === 'block' || display === 'list-item' || display === 'table' ||
        display === 'table-row' || display === 'table-cell' || display === 'table-caption' ||
        display === 'flex' || display === 'grid' || display === 'flow-root';
    } catch (err) {
      return false;
    }
  }

  function hasBlockChild(el) {
    const kids = el.children;
    if (!kids) return false;
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i];
      if (isOurNode(child) || skipElement(child) || isHidden(child)) continue;
      if (isBlockElement(child)) return true;
    }
    return false;
  }

  function walkerSkip(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === 'RT' || node.tagName === 'RP') return true;
    return isOurNode(node) || skipElement(node) || isHidden(node) || inClosedDetails(node);
  }

  function isOurNode(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
    return !!(el.getAttribute('data-lm-slot') || el.getAttribute('data-lm-page') ||
      el.getAttribute('data-lm-page-bar') || el.getAttribute('data-lm-translate'));
  }

  function slotPlace(el) {
    const tag = el.tagName;
    if (tag === 'P' || tag === 'DT' || tag === 'PRE' || tag === 'BLOCKQUOTE' ||
        tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
      return 'after';
    }
    return 'inside';
  }

  function findLeafSlot(el, place) {
    if (place === 'after') {
      const next = el.nextElementSibling;
      if (next && next.getAttribute('data-lm-slot') === 'leaf') return next;
      return null;
    }
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      if (kids[i].getAttribute('data-lm-slot') === 'leaf') return kids[i];
    }
    return null;
  }

  function locateLeaf(el, peek) {
    const place = slotPlace(el);
    const found = findLeafSlot(el, place);
    if (found || peek) return found;
    const slot = buildSlot('leaf');
    if (place === 'after') {
      if (!el.parentNode) return null;
      el.insertAdjacentElement('afterend', slot);
    } else {
      el.appendChild(slot);
    }
    return slot;
  }

  function locateSeg(parent, beforeNode, peek) {
    const candidate = beforeNode ? beforeNode.previousElementSibling : parent.lastElementChild;
    if (candidate && candidate.getAttribute('data-lm-slot') === 'seg') return candidate;
    if (peek) return null;
    const slot = buildSlot('seg');
    if (beforeNode) parent.insertBefore(slot, beforeNode);
    else parent.appendChild(slot);
    return slot;
  }

  function buildSlot(kind) {
    const slot = document.createElement('div');
    slot.setAttribute('data-lm-slot', kind);
    slot.setAttribute('data-lm-page', '1');
    slot.setAttribute('translate', 'no');
    slot.setAttribute('contenteditable', 'false');
    const props = {
      all: 'initial',
      display: 'block',
      margin: '0.25em 0 0.7em',
      padding: '0',
      border: 'none',
      background: 'transparent',
      clear: 'both',
      'user-select': 'text',
      'pointer-events': 'auto',
      'max-width': '100%',
      'box-sizing': 'border-box'
    };
    Object.keys(props).forEach(function (key) {
      slot.style.setProperty(key, props[key], 'important');
    });
    const shadow = slot.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PAGE_SLOT_CSS;
    const lines = document.createElement('div');
    lines.className = 'lines';
    shadow.append(style, lines);
    return slot;
  }

  function slotLines(slot) {
    return slot.shadowRoot.querySelector('.lines');
  }

  function appendLine(slot, text, isError) {
    const line = document.createElement('div');
    line.className = isError ? 'line err' : 'line';
    line.textContent = text;
    slotLines(slot).appendChild(line);
  }

  function clearLines(slot) {
    const lines = slotLines(slot);
    while (lines.firstChild) lines.removeChild(lines.firstChild);
  }

  function stripUncountedErrors(slot, count) {
    const lines = slot.shadowRoot.querySelectorAll('.line');
    for (let i = lines.length - 1; i >= count; i -= 1) {
      if (lines[i].classList.contains('err')) lines[i].remove();
    }
  }

  function prepareSlot(slot, limit) {
    const prev = slot.getAttribute('data-lm-limit');
    if (prev && Number(prev) !== limit) {
      clearLines(slot);
      slot.setAttribute('data-lm-count', '0');
    } else {
      stripUncountedErrors(slot, Number(slot.getAttribute('data-lm-count')) || 0);
    }
    slot.setAttribute('data-lm-limit', String(limit));
    const count = Number(slot.getAttribute('data-lm-count'));
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function ensurePageBar() {
    if (pageBar && pageBar.isConnected) return pageBar;
    pageBar = document.createElement('div');
    pageBar.setAttribute('data-lm-page-bar', '1');
    pageBar.setAttribute('translate', 'no');
    const hostStyle = {
      position: 'fixed',
      'z-index': '2147483646',
      left: '50%',
      bottom: '16px',
      transform: 'translateX(-50%)',
      margin: '0',
      padding: '0',
      border: 'none',
      background: 'transparent',
      width: 'max-content',
      'max-width': 'min(92vw, 560px)',
      display: 'block',
      'pointer-events': 'auto',
      'color-scheme': 'light dark',
      'box-sizing': 'border-box'
    };
    Object.keys(hostStyle).forEach(function (key) {
      pageBar.style.setProperty(key, hostStyle[key], 'important');
    });
    const shadow = pageBar.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      ':host{color-scheme:light dark;}',
      '.bar{display:flex;align-items:center;gap:8px;max-width:min(92vw,560px);',
      'padding:8px 10px 8px 14px;border-radius:999px;',
      'background:light-dark(#1c1b1f,#f4f4f5);color:light-dark(#f4f4f5,#1c1b1f);',
      'box-shadow:0 8px 24px rgba(0,0,0,.28);',
      'font:13px/1.4 system-ui,"Segoe UI","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;}',
      '.text{overflow-wrap:anywhere;}',
      '.bar.error .text{color:light-dark(#ffb4ab,#9d1c1c);}',
      'button{appearance:none;border:0;border-radius:999px;padding:4px 10px;cursor:pointer;font:inherit;',
      'background:light-dark(#3a3a3e,#e4e4e7);color:inherit;}',
      'button:hover{filter:brightness(1.08);}'
    ].join('');
    const bar = document.createElement('div');
    bar.className = 'bar';
    pageBarText = document.createElement('span');
    pageBarText.className = 'text';
    pageStopBtn = document.createElement('button');
    pageStopBtn.type = 'button';
    pageStopBtn.textContent = '停止';
    pageClearBtn = document.createElement('button');
    pageClearBtn.type = 'button';
    pageClearBtn.textContent = '清除译文';
    pageCloseBtn = document.createElement('button');
    pageCloseBtn.type = 'button';
    pageCloseBtn.textContent = '关闭';
    pageStopBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      haltPage('stop');
    });
    pageClearBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      clearPageTranslations();
    });
    pageCloseBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideBar();
    });
    bar.append(pageBarText, pageStopBtn, pageClearBtn, pageCloseBtn);
    shadow.append(style, bar);
    pageBar._lmBar = bar;
    const root = document.documentElement || document.body;
    if (root) root.appendChild(pageBar);
    return pageBar;
  }

  function showBar(text, mode) {
    ensurePageBar();
    pageBar.style.setProperty('display', 'block', 'important');
    pageBarText.textContent = text;
    if (pageBar._lmBar) pageBar._lmBar.classList.toggle('error', mode === 'error');
    const running = mode === 'running';
    pageStopBtn.hidden = !running;
    pageClearBtn.hidden = running;
    pageCloseBtn.hidden = running;
  }

  function hideBar() {
    if (!pageBar) return;
    pageBar.style.setProperty('display', 'none', 'important');
  }

  controller.dispose = function () {
    clearTimeout(timer);
    seq += 1;
    pageToken += 1;
    pageRunning = false;
    if (activeId && activeId.indexOf('page-') === 0) {
      notify({ type: 'abort', requestId: activeId });
      activeId = '';
    }
    host.remove();
    if (pageBar && pageBar.parentNode) pageBar.remove();
    pageBar = null;
  };
}
