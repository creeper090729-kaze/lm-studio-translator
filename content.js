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

  let mouseupOn = true;
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

  chrome.storage.local.get('settings', function (bag) {
    const settings = bag && bag.settings;
    mouseupOn = !settings || settings.triggerOnMouseup !== false;
    displayMode = settings && settings.displayMode === 'sidebar' ? 'sidebar' : 'tooltip';
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (!live()) return;
    if (area !== 'local' || !changes.settings) return;
    const settings = changes.settings.newValue;
    mouseupOn = !settings || settings.triggerOnMouseup !== false;
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
    if (event.key === 'Escape' && open) hide(true);
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
    return path.indexOf(host) !== -1;
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

  controller.dispose = function () {
    clearTimeout(timer);
    seq += 1;
    host.remove();
  };
}
