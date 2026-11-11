/* Shared by the service worker (importScripts) and the extension pages. No DOM. */
(function (root) {
  const DEFAULT_SYSTEM = [
    '你是翻译引擎，不是聊天助手。',
    '只输出译文正文。',
    '不要解释，不要注释，不要标题，不要重复原文，不要加「译文：」之类的前缀，不要使用 Markdown。',
    '术语表里出现的专有名词必须使用表中的译名，保持前后一致。',
    '原文是轻小说时，保留说话口气和对话引号，不要添加原文没有的内容。'
  ].join('\n');

  const DEFAULTS = {
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    apiKey: '',
    targetLang: '简体中文',
    timeoutSec: 45,
    maxChars: 2000,
    temperature: 0.1,
    glossary: '',
    systemPrompt: '',
    triggerMode: 'menu',
    displayMode: 'tooltip'
  };

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function integer(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(n);
  }

  function number(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n;
  }

  function normalizeBaseUrl(value) {
    let raw = String(value == null ? '' : value).trim();
    if (!raw) raw = DEFAULTS.baseUrl;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;
    let url;
    try {
      url = new URL(raw);
    } catch (err) {
      throw new Error('服务器地址无法解析');
    }
    if (url.protocol !== 'http:') {
      throw new Error('请使用 http，例如 http://127.0.0.1:1234/v1');
    }
    if (url.username || url.password) {
      throw new Error('不要把账号密码写进地址，令牌填在 API Token');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new Error('只允许连接本机 localhost 或 127.0.0.1');
    }
    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/\/chat\/completions$/i, '');
    path = path.replace(/\/models$/i, '');
    if (!path || path === '/') path = '/v1';
    else if (!/\/v1$/i.test(path)) path = path + '/v1';
    const port = url.port ? ':' + url.port : '';
    return url.protocol + '//' + url.hostname + port + path;
  }

  function normalizeSettings(input) {
    const src = input && typeof input === 'object' ? input : {};
    const targetLang = String(src.targetLang == null ? DEFAULTS.targetLang : src.targetLang).trim().slice(0, 40);
    const model = String(src.model == null ? '' : src.model).replace(/[\r\n]/g, '').trim().slice(0, 200);
    const apiKey = String(src.apiKey == null ? '' : src.apiKey).replace(/[\r\n]/g, '').trim().slice(0, 500);
    const glossary = String(src.glossary == null ? '' : src.glossary).slice(0, 20000);
    const systemPrompt = String(src.systemPrompt == null ? '' : src.systemPrompt).slice(0, 4000);
    return {
      baseUrl: normalizeBaseUrl(src.baseUrl),
      model: model,
      apiKey: apiKey,
      targetLang: targetLang || DEFAULTS.targetLang,
      timeoutSec: clamp(integer(src.timeoutSec, DEFAULTS.timeoutSec), 10, 180),
      maxChars: clamp(integer(src.maxChars, DEFAULTS.maxChars), 50, 8000),
      temperature: Math.round(clamp(number(src.temperature, DEFAULTS.temperature), 0, 1.5) * 100) / 100,
      glossary: glossary,
      systemPrompt: systemPrompt,
      triggerMode: src.triggerMode === 'select' ? 'select' : 'menu',
      displayMode: src.displayMode === 'sidebar' ? 'sidebar' : 'tooltip'
    };
  }

  function parseGlossary(raw) {
    const pairs = [];
    const lines = String(raw || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.charAt(0) === '#') continue;
      let sep = -1;
      let len = 1;
      const arrow = trimmed.indexOf('=>');
      if (arrow !== -1) {
        sep = arrow;
        len = 2;
      } else if (trimmed.indexOf('=') !== -1) {
        sep = trimmed.indexOf('=');
      } else if (trimmed.indexOf('\t') !== -1) {
        sep = trimmed.indexOf('\t');
      } else {
        continue;
      }
      const source = trimmed.slice(0, sep).trim();
      const target = trimmed.slice(sep + len).trim();
      if (!source || !target || source.length > 80 || target.length > 80) continue;
      pairs.push({ src: source, dst: target });
      if (pairs.length >= 80) break;
    }
    return pairs;
  }

  function buildMessages(settings, text) {
    const system = (settings.systemPrompt.trim() || DEFAULT_SYSTEM) +
      '\n目标语言是' + settings.targetLang + '。只输出该语言的译文，不要原样复述原文。';
    const pairs = parseGlossary(settings.glossary);
    const glossaryBlock = pairs.length
      ? pairs.map(function (pair) { return '- ' + pair.src + ' => ' + pair.dst; }).join('\n')
      : '（无）';
    const user = [
      '把下面原文翻译成' + settings.targetLang + '。',
      '术语表（专有名词必须使用右侧译名）：',
      glossaryBlock,
      '',
      '只翻译两条横线之间的原文，不要输出横线：',
      '---',
      text,
      '---',
      '只输出' + settings.targetLang + '译文：'
    ].join('\n');
    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }

  function isPlamoTranslate(model) {
    const name = String(model || '');
    return /plamo/i.test(name) && /translat/i.test(name);
  }

  function plamoLang(label) {
    const value = String(label || '').trim().toLowerCase();
    if (!value || value === '简体中文' || value === '简体' || value === '中文' || value === 'zh' || value === 'zh-cn' || value === 'zh-hans' || value === 'chinese') {
      return 'zh-hans';
    }
    if (value === '繁体中文' || value === '繁體中文' || value === '繁体' || value === '繁體' || value === 'zh-tw' || value === 'zh-hk' || value === 'zh-hant') {
      return 'zh-hant';
    }
    if (value === '英语' || value === '英文' || value === 'en' || value === 'english') return 'en';
    if (value === '日语' || value === '日文' || value === 'ja' || value === 'japanese') return 'ja';
    if (value === '韩语' || value === '韩文' || value === 'ko' || value === 'korean') return 'ko';
    if (/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(value)) return value;
    return 'zh-hans';
  }

  function buildPlamoPrompt(settings, text) {
    const pairs = parseGlossary(settings.glossary);
    let glossary = '';
    if (pairs.length) {
      glossary = '<|plamo:tag|>glossary';
      for (let i = 0; i < pairs.length; i += 1) {
        glossary += '<|plamo:index|>' + pairs[i].src + '<|plamo:item|>' + pairs[i].dst;
      }
    }
    return '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      glossary +
      '<|plamo:tag|>input<|plamo:msg|>' + text +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>' + plamoLang(settings.targetLang) + '<|plamo:msg|>';
  }

  function cleanTranslation(raw) {
    let text = String(raw || '').replace(/\r\n/g, '\n').trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fenced = text.match(/^```[a-z0-9_-]*\n([\s\S]*?)\n```$/i);
    if (fenced) text = fenced[1].trim();
    text = text.replace(/^(译文|翻译结果|翻译|translation)\s*[:：]\s*/i, '').trim();
    if (
      (text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') ||
      (text.charAt(0) === '“' && text.charAt(text.length - 1) === '”')
    ) {
      const inner = text.slice(1, -1).trim();
      if (inner) text = inner;
    }
    return text.trim();
  }

  function readChoice(data) {
    const choice = data && data.choices && data.choices[0];
    if (!choice) return { content: '', reasoning: '' };
    const message = choice.message || {};
    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      }).join('');
    }
    if (typeof content !== 'string') {
      content = typeof choice.text === 'string' ? choice.text : '';
    }
    const reasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : (typeof message.reasoning === 'string' ? message.reasoning : '');
    return { content: content, reasoning: reasoning };
  }

  function friendlyHttpError(status, bodyText) {
    let message = '';
    try {
      const parsed = JSON.parse(bodyText);
      message = (parsed.error && parsed.error.message) || parsed.message || '';
    } catch (err) {
      message = String(bodyText || '').trim().slice(0, 240);
    }
    if (/no models loaded/i.test(message)) {
      return 'LM Studio 里还没有加载模型。请先加载，再翻译。';
    }
    if (/model/i.test(message) && /not found|does not exist|unknown/i.test(message)) {
      return '找不到这个模型名。打开设置，点「刷新模型」，用列表里的名字。';
    }
    if (status === 401 || status === 403) {
      return '认证失败。如果在 LM Studio 打开了 Require authentication，请填写 API Token。';
    }
    if (status === 404) {
      return '接口不存在（404）。地址应类似 http://127.0.0.1:1234/v1，末尾不要再加 /chat/completions。';
    }
    if (message) return 'LM Studio 返回错误：' + message;
    return 'LM Studio 返回 HTTP ' + status;
  }

  root.LMShared = {
    DEFAULTS: DEFAULTS,
    DEFAULT_SYSTEM: DEFAULT_SYSTEM,
    normalizeSettings: normalizeSettings,
    parseGlossary: parseGlossary,
    buildMessages: buildMessages,
    isPlamoTranslate: isPlamoTranslate,
    plamoLang: plamoLang,
    buildPlamoPrompt: buildPlamoPrompt,
    cleanTranslation: cleanTranslation,
    readChoice: readChoice,
    friendlyHttpError: friendlyHttpError
  };
})(typeof self !== 'undefined' ? self : globalThis);
