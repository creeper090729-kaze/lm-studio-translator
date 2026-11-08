'use strict';

const statusEl = document.getElementById('status');
const noteEl = document.getElementById('note');
const mouseupEl = document.getElementById('mouseup');
const modeEl = document.getElementById('displayMode');
const shortcutEl = document.getElementById('shortcut');

let settings = Object.assign({}, LMShared.DEFAULTS);

chrome.commands.getAll(function (commands) {
  const found = (commands || []).find(function (command) {
    return command.name === 'translate-selection';
  });
  if (found && found.shortcut) shortcutEl.textContent = found.shortcut;
});

chrome.storage.local.get('settings', function (bag) {
  try {
    settings = LMShared.normalizeSettings(bag.settings || {});
  } catch (err) {
    noteEl.textContent = err.message || '设置无效';
  }
  mouseupEl.checked = settings.triggerOnMouseup !== false;
  modeEl.value = settings.displayMode === 'sidebar' ? 'sidebar' : 'tooltip';
  chrome.runtime.sendMessage({ type: 'health' }, function (res) {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message || '后台没有响应', false);
      return;
    }
    if (res && res.ok) {
      const count = res.models ? res.models.length : 0;
      const name = settings.model || (res.models && res.models[0]) || '未命名模型';
      setStatus(count ? ('在线 · ' + name) : '在线，但没有加载模型', count > 0);
      return;
    }
    setStatus((res && res.error) || '离线', false);
  });
});

mouseupEl.addEventListener('change', function () {
  savePatch(function (next) { next.triggerOnMouseup = mouseupEl.checked; }, function () {
    mouseupEl.checked = !mouseupEl.checked;
  });
});

modeEl.addEventListener('change', function () {
  const chosen = modeEl.value === 'sidebar' ? 'sidebar' : 'tooltip';
  savePatch(function (next) { next.displayMode = chosen; }, function () {
    modeEl.value = settings.displayMode === 'sidebar' ? 'sidebar' : 'tooltip';
  });
});

function savePatch(apply, rollback) {
  chrome.storage.local.get('settings', function (bag) {
    let next;
    try {
      next = LMShared.normalizeSettings(bag.settings || {});
    } catch (err) {
      noteEl.textContent = err.message || '设置无效，没能保存';
      rollback();
      return;
    }
    apply(next);
    settings = next;
    chrome.storage.local.set({ settings: next }, function () {
      noteEl.textContent = chrome.runtime.lastError ? '没能保存' : '';
    });
  });
}

document.getElementById('openSide').addEventListener('click', function () {
  noteEl.textContent = '';
  chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(function () {
    noteEl.textContent = '没能打开边栏';
  });
});

document.getElementById('options').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});

document.getElementById('translate').addEventListener('click', function () {
  noteEl.textContent = '';
  if (settings.displayMode === 'sidebar') {
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(function () {});
  }
  chrome.runtime.sendMessage({ type: 'translate-active-tab' }, function (res) {
    if (chrome.runtime.lastError) {
      noteEl.textContent = '请刷新网页后再试';
      return;
    }
    if (!res || res.ok) {
      window.close();
      return;
    }
    noteEl.textContent = res.error || '没有开始翻译';
  });
});

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', !!ok);
  statusEl.classList.toggle('bad', !ok);
}
