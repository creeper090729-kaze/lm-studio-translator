'use strict';

importScripts('shared.js');

let currentJob = null;
const memoryCache = new Map();
const MAX_CACHE = 120;
let modelMemo = { at: 0, base: '', id: '' };
let menuTask = null;
let displayMode = 'tooltip';
let feedChain = Promise.resolve();

chrome.storage.local.get('settings', function (bag) {
  try {
    displayMode = LMShared.normalizeSettings(bag.settings || {}).displayMode;
  } catch (err) {
    displayMode = 'tooltip';
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.settings) return;
  try {
    displayMode = LMShared.normalizeSettings(changes.settings.newValue || {}).displayMode;
  } catch (err) {
    displayMode = 'tooltip';
  }
});

chrome.runtime.onInstalled.addListener(function () {
  ensureDefaults();
  setupMenus();
  enableSidePanel();
  injectOpenTabs();
});

chrome.runtime.onStartup.addListener(function () {
  setupMenus();
  enableSidePanel();
});

setupMenus();
enableSidePanel();
chrome.alarms.create('update-check', { periodInMinutes: 360 });
checkForUpdate(false);

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === 'update-check') checkForUpdate(false);
});

chrome.contextMenus.onClicked.addListener(function (_info, tab) {
  if (!tab || !tab.id) return;
  if (displayMode === 'sidebar') openSidePanel(tab);
  translateTab(tab.id);
});

chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'translate-selection') return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs && tabs[0];
    if (displayMode === 'sidebar' && tab) openSidePanel(tab);
    if (tab && tab.id) translateTab(tab.id, tab.url || '');
  });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'open-side-panel') {
    openSidePanel(sender.tab || {}).then(function (ok) {
      sendResponse({ ok: !!ok });
    });
    return true;
  }
  handle(msg).then(sendResponse, function (err) {
    sendResponse({ ok: false, error: err && err.message ? err.message : '后台出错' });
  });
  return true;
});

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: '无效请求' };
  if (msg.type === 'health') return health();
  if (msg.type === 'list-models') return listModels();
  if (msg.type === 'translate-text') return translateText(msg);
  if (msg.type === 'abort') {
    abortJob(msg.requestId);
    return { ok: true };
  }
  if (msg.type === 'translate-active-tab') return translateActiveTab();
  if (msg.type === 'side-push') return pushSide(msg);
  if (msg.type === 'side-clear') return clearSide();
  if (msg.type === 'check-update') return checkForUpdate(false);
  return { ok: false, error: '未知请求' };
}

async function injectOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch (err) {
    return;
  }
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    if (!tab.id) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (err) {
      /* Restricted pages and discarded tabs are skipped. */
    }
  }
}

async function ensureDefaults() {
  const bag = await chrome.storage.local.get('settings');
  if (!bag.settings) {
    await chrome.storage.local.set({ settings: LMShared.DEFAULTS });
  }
}

function enableSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(function () {});
}

function openSidePanel(tab) {
  if (!chrome.sidePanel || !chrome.sidePanel.open || !tab) return Promise.resolve(false);
  const first = tab.id
    ? chrome.sidePanel.open({ tabId: tab.id })
    : Promise.reject(new Error('no tab'));
  return first.then(function () {
    return true;
  }, function () {
    if (!tab.windowId) return false;
    return chrome.sidePanel.open({ windowId: tab.windowId }).then(function () { return true; }, function () { return false; });
  });
}

function enqueueFeed(task) {
  feedChain = feedChain.then(task, task);
  return feedChain;
}

function cleanSideEntry(msg) {
  const state = msg.state === 'loading' || msg.state === 'error' ? msg.state : 'result';
  return {
    id: String(msg.id || ('side-' + Date.now())).slice(0, 80),
    state: state,
    original: String(msg.original || '').slice(0, 8000),
    text: String(msg.text || '').slice(0, 16000),
    at: Date.now()
  };
}

function pushSide(msg) {
  const entry = cleanSideEntry(msg);
  return enqueueFeed(async function () {
    const bag = await chrome.storage.session.get('sideFeed');
    let feed = Array.isArray(bag.sideFeed) ? bag.sideFeed : [];
    if (entry.state === 'loading') {
      feed = feed.filter(function (item) { return item.state !== 'loading'; });
      feed.unshift(entry);
    } else {
      let found = false;
      feed = feed.map(function (item) {
        if (item.id !== entry.id) return item;
        found = true;
        return entry;
      });
      if (!found) feed.unshift(entry);
    }
    if (feed.length > 40) feed = feed.slice(0, 40);
    await chrome.storage.session.set({ sideFeed: feed });
    return { ok: true };
  });
}

function clearSide() {
  return enqueueFeed(async function () {
    await chrome.storage.session.set({ sideFeed: [] });
    return { ok: true };
  });
}

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const bag = await chrome.storage.local.get('updateNotice');
  const cached = bag.updateNotice;
  if (cached && cached.at && cached.current === current && Date.now() - cached.at < UPDATE_INTERVAL_MS) {
    await paintUpdateBadge(cached, current);
    return { ok: true, notice: publicNotice(cached, current) };
  }
  try {
    const response = await fetch(LMShared.UPDATE_MANIFEST_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'lm-studio-translator'
      }
    });
    if (!response.ok) throw new Error('http ' + response.status);
    const remote = LMShared.readRemoteVersion(await response.text());
    if (!/^\d+(?:\.\d+){0,3}$/.test(remote)) throw new Error('bad version');
    const notice = {
      at: Date.now(),
      current: current,
      remote: remote,
      newer: LMShared.compareVersions(remote, current) > 0,
      url: LMShared.UPDATE_PAGE_URL
    };
    await chrome.storage.local.set({ updateNotice: notice });
    await paintUpdateBadge(notice, current);
    return { ok: true, notice: publicNotice(notice, current) };
  } catch (err) {
    if (cached && cached.current === current) {
      await paintUpdateBadge(cached, current);
      return { ok: true, notice: publicNotice(cached, current), stale: true };
    }
    await paintUpdateBadge(null, current);
    return { ok: false, error: '没能检查更新' };
  }
}

function publicNotice(notice, current) {
  if (!notice || !notice.newer || notice.current !== current) return { newer: false, current: current };
  return { newer: true, current: current, remote: notice.remote, url: notice.url };
}

async function paintUpdateBadge(notice, current) {
  if (!chrome.action) return;
  const show = notice && notice.newer && notice.current === current;
  try {
    if (show) {
      await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
      await chrome.action.setBadgeText({ text: '新' });
      await chrome.action.setTitle({ title: '有新版本 ' + notice.remote + '，打开插件查看' });
      return;
    }
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'LM Studio 划词翻译' });
  } catch (err) { /* Badge is optional. */ }
}

function setupMenus() {
  if (!menuTask) {
    menuTask = (async function () {
      await chrome.contextMenus.removeAll();
      await chrome.contextMenus.create({
        id: 'lm-translate',
        title: '用 LM Studio 翻译',
        contexts: ['selection']
      });
    })().finally(function () {
      menuTask = null;
    });
  }
  return menuTask;
}

async function getSettings() {
  const bag = await chrome.storage.local.get('settings');
  return LMShared.normalizeSettings(bag.settings || {});
}

function authHeaders(settings, json) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
  return headers;
}

function beginJob(id, timeoutMs) {
  if (currentJob) {
    clearTimeout(currentJob.timeoutId);
    currentJob.controller.abort();
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(function () {
    controller.__timeout = true;
    controller.abort();
  }, timeoutMs);
  currentJob = { id: String(id), controller: controller, timeoutId: timeoutId };
  return controller.signal;
}

function finishJob(id) {
  if (currentJob && currentJob.id === String(id)) {
    clearTimeout(currentJob.timeoutId);
    currentJob = null;
  }
}

function isCurrent(id) {
  return !!(currentJob && currentJob.id === String(id));
}

function abortJob(id) {
  if (currentJob && currentJob.id === String(id)) currentJob.controller.abort();
}

async function health() {
  try {
    const settings = await getSettings();
    const models = await fetchModelIds(settings, AbortSignal.timeout(5000));
    return { ok: true, models: models, baseUrl: settings.baseUrl };
  } catch (err) {
    return { ok: false, error: errorText(err, '检测失败') };
  }
}

async function listModels() {
  try {
    const settings = await getSettings();
    const models = await fetchModelIds(settings, AbortSignal.timeout(8000));
    return { ok: true, models: models };
  } catch (err) {
    return { ok: false, error: errorText(err, '读取模型失败'), models: [] };
  }
}

async function translateText(msg) {
  const text = String(msg.text || '').replace(/\u0000/g, '').trim();
  if (!text) return { ok: false, error: '没有文字' };

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    return { ok: false, error: err.message || '设置无效' };
  }
  if (text.length > settings.maxChars) {
    return {
      ok: false,
      error: '选区有 ' + text.length + ' 字，超过上限 ' + settings.maxChars + '。请缩短选区，或到设置里提高上限。'
    };
  }

  const requestId = String(msg.requestId || ('job-' + Date.now()));
  const signal = beginJob(requestId, settings.timeoutSec * 1000);
  try {
    const model = await resolveModel(settings, signal);
    if (!isCurrent(requestId)) return { ok: false, aborted: true };
    const key = await cacheKey(settings, model, text);
    const cached = key ? await cacheGet(key) : null;
    if (cached) return { ok: true, text: cached, cached: true, model: model };
    const translated = await complete(settings, model, text, signal);
    if (!isCurrent(requestId)) return { ok: false, aborted: true };
    if (key) await cacheSet(key, translated);
    return { ok: true, text: translated, model: model };
  } catch (err) {
    if (!isCurrent(requestId)) return { ok: false, aborted: true };
    if (currentJob && currentJob.controller.__timeout) {
      return { ok: false, error: '超过 ' + settings.timeoutSec + ' 秒还没译完。可以加大超时，或缩短选区。' };
    }
    if (err && err.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: errorText(err, '翻译失败') };
  } finally {
    finishJob(requestId);
  }
}

async function resolveModel(settings, signal) {
  if (settings.model) return settings.model;
  const fresh = modelMemo.id && modelMemo.base === settings.baseUrl && Date.now() - modelMemo.at < 60000;
  if (fresh) return modelMemo.id;
  const ids = await fetchModelIds(settings, signal);
  if (!ids.length) throw new Error('服务器在线，但没有可用模型。请先在 LM Studio 加载模型。');
  modelMemo = { at: Date.now(), base: settings.baseUrl, id: ids[0] };
  return ids[0];
}

async function fetchModelIds(settings, signal) {
  let response;
  try {
    response = await fetch(settings.baseUrl + '/models', {
      method: 'GET',
      headers: authHeaders(settings, false),
      signal: signal
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    throw new Error('连不上 ' + settings.baseUrl + '。请确认 LM Studio 已在 Developer 里启动本地服务器。');
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(LMShared.friendlyHttpError(response.status, raw));
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error('模型列表不是 JSON。请确认地址是 LM Studio 的 /v1。');
  }
  const rows = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  const ids = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const id = typeof row === 'string' ? row : (row && (row.id || row.name));
    if (id) ids.push(String(id));
  }
  return ids;
}

async function complete(settings, model, text, signal) {
  if (LMShared.isPlamoTranslate(model)) return completePlamo(settings, model, text, signal);
  const response = await fetch(settings.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: authHeaders(settings, true),
    body: JSON.stringify({
      model: model,
      messages: LMShared.buildMessages(settings, text),
      temperature: settings.temperature,
      max_tokens: Math.max(256, Math.min(2048, Math.ceil(text.length * 2))),
      stream: false
    }),
    signal: signal
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(LMShared.friendlyHttpError(response.status, raw));
  if (/^\s*data:/i.test(raw)) {
    throw new Error('服务器返回了流式数据。本插件只使用非流式接口。');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error('服务器返回的不是 JSON。请确认这是 LM Studio 的 /v1 地址。');
  }
  const choice = LMShared.readChoice(data);
  const cleaned = LMShared.cleanTranslation(choice.content);
  if (!cleaned && choice.reasoning) {
    throw new Error('模型只返回了思考过程，没有译文。请在 LM Studio 关掉 Thinking / 推理，或改用翻译模型。');
  }
  if (!cleaned) throw new Error('模型返回了空内容');
  if (sameText(cleaned, text)) {
    throw new Error('模型把原文原样返回了。聊天模型请确认目标语言是「简体中文」，并关掉 Thinking。');
  }
  return cleaned;
}

async function completePlamo(settings, model, text, signal) {
  const response = await fetch(settings.baseUrl + '/completions', {
    method: 'POST',
    headers: authHeaders(settings, true),
    body: JSON.stringify({
      model: model,
      prompt: LMShared.buildPlamoPrompt(settings, text),
      temperature: settings.temperature,
      max_tokens: Math.max(256, Math.min(2048, Math.ceil(text.length * 2))),
      stream: false,
      stop: ['<|plamo:tag|>', '<|plamo:bos|>']
    }),
    signal: signal
  });
  const raw = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('这版 LM Studio 没有 /v1/completions。请更新 LM Studio，或改用 Gemma、Qwen 这类聊天模型。');
    }
    throw new Error(LMShared.friendlyHttpError(response.status, raw));
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error('服务器返回的不是 JSON。请确认这是 LM Studio 的 /v1 地址。');
  }
  const choice = data && data.choices && data.choices[0];
  const content = choice && (typeof choice.text === 'string' ? choice.text : '');
  const cleaned = LMShared.cleanTranslation(content).replace(/<\|plamo:[^|]*\|>/g, '').trim();
  if (!cleaned) throw new Error('PLaMo 返回了空内容。请确认加载的是 Translate 模型，而不是普通 PLaMo 聊天模型。');
  if (sameText(cleaned, text)) {
    throw new Error('PLaMo 仍原样返回了日文。请更新 LM Studio，并确认模型名里同时有 plamo 和 translate。');
  }
  return cleaned;
}

function sameText(a, b) {
  return String(a || '').replace(/\s+/g, '') === String(b || '').replace(/\s+/g, '');
}

async function cacheKey(settings, model, text) {
  try {
    const raw = JSON.stringify({
      v: 2,
      u: settings.baseUrl,
      m: model,
      l: settings.targetLang,
      t: settings.temperature,
      g: settings.glossary,
      s: settings.systemPrompt,
      x: text
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  } catch (err) {
    return '';
  }
}

async function cacheGet(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const bag = await chrome.storage.session.get('trCache');
    const entry = bag.trCache && bag.trCache[key];
    if (entry && typeof entry.text === 'string') {
      memoryCache.set(key, entry.text);
      return entry.text;
    }
  } catch (err) {
    return null;
  }
  return null;
}

async function cacheSet(key, text) {
  memoryCache.set(key, text);
  try {
    const bag = await chrome.storage.session.get('trCache');
    const cache = bag.trCache || {};
    cache[key] = { text: text, at: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) {
      keys.sort(function (a, b) { return (cache[a].at || 0) - (cache[b].at || 0); });
      for (let i = 0; i < keys.length - MAX_CACHE; i += 1) delete cache[keys[i]];
    }
    await chrome.storage.session.set({ trCache: cache });
  } catch (err) {
    /* Cache is optional. A full quota must not fail the translation. */
  }
}

async function translateActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) return { ok: false, error: '没有可翻译的标签页' };
  return translateTab(tab.id, tab.url || '');
}

async function translateTab(tabId, knownUrl) {
  let url = knownUrl;
  if (url == null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab.url || '';
    } catch (err) {
      url = '';
    }
  }
  if (url && !/^https?:/i.test(url)) {
    return { ok: false, error: '这个页面不能注入脚本，只支持普通 http / https 网页' };
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
    } catch (injectErr) {
      return { ok: false, error: '无法在此页面使用。请换普通网页，或刷新后再试。' };
    }
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'translate-selection' });
    return response || { ok: false, error: '页面没有响应' };
  } catch (err) {
    return { ok: false, error: '页面上的翻译脚本没挂上，请刷新网页后再试' };
  }
}

function errorText(err, fallback) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return '连接超时';
  if (err && err.message && /Failed to fetch|NetworkError|Load failed|network/i.test(err.message)) {
    return '连不上 LM Studio。请确认本地服务器已经启动。';
  }
  if (err && err.message) return err.message;
  return fallback;
}
