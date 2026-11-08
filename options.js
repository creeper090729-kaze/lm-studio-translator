'use strict';

const fields = [
  'baseUrl', 'model', 'apiKey', 'targetLang', 'timeoutSec', 'maxChars',
  'temperature', 'glossary', 'systemPrompt', 'triggerOnMouseup'
];

const connEl = document.getElementById('conn');
const saveMsg = document.getElementById('saveMsg');
const glossaryCount = document.getElementById('glossaryCount');

chrome.storage.local.get('settings', function (bag) {
  let settings;
  try {
    settings = LMShared.normalizeSettings(bag.settings || {});
  } catch (err) {
    settings = Object.assign({}, LMShared.DEFAULTS);
    setConn(err.message || '已保存的地址无效', false);
  }
  fill(settings);
  countGlossary();
});

document.getElementById('glossary').addEventListener('input', countGlossary);

document.getElementById('save').addEventListener('click', function () {
  let settings;
  try {
    settings = LMShared.normalizeSettings(read());
  } catch (err) {
    setSave(err.message || '没法保存', false);
    return;
  }
  chrome.storage.local.set({ settings: settings }, function () {
    if (chrome.runtime.lastError) {
      setSave('保存失败', false);
      return;
    }
    fill(settings);
    setSave('已保存', true);
  });
});

document.getElementById('refresh').addEventListener('click', function () {
  withDraft(function () {
    setConn('正在读取模型…', true);
    chrome.runtime.sendMessage({ type: 'list-models' }, function (res) {
      if (chrome.runtime.lastError) {
        setConn('后台没有响应', false);
        return;
      }
      if (!res || !res.ok) {
        setConn((res && res.error) || '读取失败', false);
        return;
      }
      const list = document.getElementById('modelList');
      list.replaceChildren();
      (res.models || []).forEach(function (id) {
        const option = document.createElement('option');
        option.value = id;
        list.appendChild(option);
      });
      if (!document.getElementById('model').value && res.models && res.models[0]) {
        document.getElementById('model').value = res.models[0];
      }
      setConn(res.models && res.models.length ? ('读到 ' + res.models.length + ' 个模型') : '服务器在线，但列表是空的', true);
    });
  });
});

document.getElementById('probe').addEventListener('click', function () {
  withDraft(function () {
    setConn('正在试译…', true);
    chrome.runtime.sendMessage({
      type: 'translate-text',
      text: 'こんにちは',
      requestId: 'probe-' + Date.now()
    }, function (res) {
      if (chrome.runtime.lastError) {
        setConn('后台没有响应', false);
        return;
      }
      if (!res || res.aborted) {
        setConn('试译被中断', false);
        return;
      }
      if (!res.ok) {
        setConn(res.error || '试译失败', false);
        return;
      }
      setConn('试译结果：' + res.text, true);
    });
  });
});

function withDraft(run) {
  let settings;
  try {
    settings = LMShared.normalizeSettings(read());
  } catch (err) {
    setConn(err.message || '地址无效', false);
    return;
  }
  chrome.storage.local.set({ settings: settings }, function () {
    if (chrome.runtime.lastError) {
      setConn('没法保存当前设置', false);
      return;
    }
    fill(settings);
    run();
  });
}

function read() {
  return {
    baseUrl: value('baseUrl'),
    model: value('model'),
    apiKey: value('apiKey'),
    targetLang: value('targetLang'),
    timeoutSec: value('timeoutSec'),
    maxChars: value('maxChars'),
    temperature: value('temperature'),
    glossary: value('glossary'),
    systemPrompt: value('systemPrompt'),
    triggerOnMouseup: document.getElementById('triggerOnMouseup').checked,
    displayMode: document.getElementById('modeSidebar').checked ? 'sidebar' : 'tooltip'
  };
}

function fill(settings) {
  fields.forEach(function (key) {
    const el = document.getElementById(key);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key] == null ? '' : settings[key];
  });
  const sidebar = settings.displayMode === 'sidebar';
  document.getElementById(sidebar ? 'modeSidebar' : 'modeTooltip').checked = true;
}

function value(id) {
  return document.getElementById(id).value;
}

function countGlossary() {
  const pairs = LMShared.parseGlossary(document.getElementById('glossary').value);
  glossaryCount.textContent = '当前会使用 ' + pairs.length + ' 条';
}

function setConn(text, ok) {
  connEl.textContent = text;
  connEl.classList.toggle('ok', !!ok);
  connEl.classList.toggle('bad', !ok);
}

function setSave(text, ok) {
  saveMsg.textContent = text;
  saveMsg.classList.toggle('ok', !!ok);
  saveMsg.classList.toggle('bad', ok === false);
}
