(function () {
  'use strict';

  // ==========================================================================
  // NATIVE BRIDGE CONTRACT
  // Called by MainActivity / LocalBackendServer. Names and signatures are part
  // of the contract with every shipped native engine — do not rename.
  // ==========================================================================
  window.__setAndroidInsets = function (topPx, bottomPx) {
    document.documentElement.style.setProperty('--safe-top', topPx + 'px');
    document.documentElement.style.setProperty('--safe-bottom', bottomPx + 'px');
  };

  const DEFAULT_LAN_URL = 'http://127.0.0.1:3001';
  const hasBridge = typeof window.AndroidServer !== 'undefined';
  const pendingAndroidRequests = new Map();
  let androidReqCounter = 1;

  function decodeBase64Utf8(b64) {
    const binString = window.atob(b64);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) bytes[i] = binString.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  window.__onAndroidServerResponse = function (reqId, status, b64Json) {
    const entry = pendingAndroidRequests.get(reqId);
    if (!entry) return;
    pendingAndroidRequests.delete(reqId);
    try {
      const data = JSON.parse(decodeBase64Utf8(b64Json) || '{}');
      if (status >= 200 && status < 300) {
        entry.resolve(data);
      } else {
        const err = new Error(data.error || `Ошибка встроенного сервера (${status})`);
        err.data = data;
        err.status = status;
        entry.reject(err);
      }
    } catch (err) {
      entry.reject(err);
    }
  };

  function getServerBaseUrl() {
    const loc = window.location || {};
    if (loc.protocol !== 'file:' && loc.origin && loc.origin !== 'null') return loc.origin;
    return DEFAULT_LAN_URL;
  }

  async function api(endpoint, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const bodyStr = typeof options.body === 'string' ? options.body : (options.body ? JSON.stringify(options.body) : '');
    if (hasBridge && typeof window.AndroidServer.requestAsync === 'function') {
      const reqId = 'req_' + (androidReqCounter++) + '_' + Date.now();
      return new Promise((resolve, reject) => {
        pendingAndroidRequests.set(reqId, { resolve, reject });
        window.AndroidServer.requestAsync(reqId, method, endpoint, bodyStr);
      });
    }
    const res = await fetch(state.serverUrl + endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr || undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка сервера (${res.status})`);
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ==========================================================================
  // PURE HELPERS (unit-tested through window.__appInternals)
  // ==========================================================================
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripMarkdownPreview(rawText) {
    return String(rawText || '')
      .replace(/```[\s\S]*?```/g, '[код]')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\n+/g, ' ')
      .trim();
  }

  // Wraps spoken lines in a span so they can be tinted. Runs on already-escaped
  // text, where straight double quotes appear as &quot;.
  function highlightDialogue(escapedText) {
    return escapedText
      .replace(/«[^«»\n]{1,1200}»/g, '<span class="rp-dialogue">$&</span>')
      .replace(/„[^„“\n]{1,1200}“/g, '<span class="rp-dialogue">$&</span>')
      .replace(/“[^“”\n]{1,1200}”/g, '<span class="rp-dialogue">$&</span>')
      .replace(/&quot;(?:(?!&quot;)[^\n]){1,1200}&quot;/g, '<span class="rp-dialogue">$&</span>');
  }

  function formatInlineMarkdown(escapedText, inlineCodes, opts) {
    let s = escapedText;
    s = s.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code class="md-inline-code">${code}</code>`);
      return `\u0000INLINECODE_${idx}\u0000`;
    });
    if (opts && opts.dialogue) s = highlightDialogue(s);
    s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em class="rp-italic">$1</em></strong>');
    s = s.replace(/___([\s\S]+?)___/g, '<strong><em class="rp-italic">$1</em></strong>');
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+?)\*/g, '<em class="rp-italic">$1</em>');
    // Word-bounded so snake_case identifiers remain untouched
    s = s.replace(/(^|[\s(>«"'])_([^_\n]+?)_(?=$|[\s.,!?:;)<»"'])/g, '$1<em class="rp-italic">$2</em>');
    s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_, idx) => inlineCodes[Number(idx)] || '');
    return s;
  }

  /**
   * Markdown renderer for roleplay prose: *action* → muted italic, **bold**,
   * ***both***, ~~strike~~, `code`, fenced code, headings, quotes, lists, rules.
   * Input is escaped first; only the tags produced here reach the DOM.
   * opts.dialogue tints «…» / "…" speech.
   */
  function formatRoleplayHtml(rawText, opts) {
    if (!rawText) return '<p></p>';
    const escaped = escapeHtml(String(rawText).replace(/\r\n/g, '\n'));
    const codeBlocks = [];
    const inlineCodes = [];

    const withoutCodeBlocks = escaped.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const langBadge = lang ? `<div class="md-code-lang">${lang}</div>` : '';
      codeBlocks.push(`<pre class="md-code-block">${langBadge}<code>${code.replace(/\n$/, '')}</code></pre>`);
      return `\n\n\u0000CODEBLOCK_${idx}\u0000\n\n`;
    });

    const htmlBlocks = [];
    for (const block of withoutCodeBlocks.split(/\n{2,}/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const codeMatch = trimmed.match(/^\u0000CODEBLOCK_(\d+)\u0000$/);
      if (codeMatch) {
        htmlBlocks.push(codeBlocks[Number(codeMatch[1])] || '');
        continue;
      }
      if (/^(?:---|___|\*\*\*)$/.test(trimmed)) {
        htmlBlocks.push('<hr class="md-hr" />');
        continue;
      }

      const lines = trimmed.split('\n');
      if (lines.every(l => /^\s*&gt;\s?/.test(l))) {
        const quoteInner = lines.map(l => l.replace(/^\s*&gt;\s?/, '')).join('\n');
        htmlBlocks.push(`<blockquote class="md-quote">${formatInlineMarkdown(quoteInner, inlineCodes, opts).replace(/\n/g, '<br/>')}</blockquote>`);
        continue;
      }
      if (lines.every(l => /^\s*[-•]\s+/.test(l))) {
        htmlBlocks.push(`<ul class="md-list">${lines.map(l => `<li>${formatInlineMarkdown(l.replace(/^\s*[-•]\s+/, ''), inlineCodes, opts)}</li>`).join('')}</ul>`);
        continue;
      }
      if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
        htmlBlocks.push(`<ol class="md-list">${lines.map(l => `<li>${formatInlineMarkdown(l.replace(/^\s*\d+[.)]\s+/, ''), inlineCodes, opts)}</li>`).join('')}</ol>`);
        continue;
      }
      if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0])) {
        const hMatch = lines[0].match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
          htmlBlocks.push(`<div class="md-heading md-h${hMatch[1].length}">${formatInlineMarkdown(hMatch[2], inlineCodes, opts)}</div>`);
          continue;
        }
      }

      const formattedPara = formatInlineMarkdown(trimmed, inlineCodes, opts)
        .split('\n')
        .map(line => {
          const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
          return hMatch ? `<span class="md-heading-inline md-h${hMatch[1].length}">${hMatch[2]}</span>` : line;
        })
        .join('<br/>');
      htmlBlocks.push(`<p>${formattedPara.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_, idx) => codeBlocks[Number(idx)] || '')}</p>`);
    }
    return htmlBlocks.join('') || '<p></p>';
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  /** Parses SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) and ISO strings. */
  function parseServerTime(value) {
    if (!value) return null;
    const str = String(value).trim();
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m && !m[7]) {
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  /** Compact time for lists: "только что", "5 мин", "21:04", "вчера", "пн", "12 окт", "12.10.25". */
  function formatRelativeTime(date, now) {
    if (!date) return '';
    const ref = now || new Date();
    const diffSec = (ref.getTime() - date.getTime()) / 1000;
    if (diffSec < 60) return 'только что';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + ' мин';
    if (sameDay(date, ref)) return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    const yesterday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
    if (sameDay(date, yesterday)) return 'вчера';
    if (diffSec < 6 * 86400) return WEEKDAYS_SHORT[date.getDay()];
    if (date.getFullYear() === ref.getFullYear()) return date.getDate() + ' ' + MONTHS_SHORT[date.getMonth()];
    return pad2(date.getDate()) + '.' + pad2(date.getMonth() + 1) + '.' + String(date.getFullYear()).slice(2);
  }

  /** Message timestamp: "21:04" today, otherwise "12 окт, 21:04". */
  function formatMessageTime(date, now) {
    if (!date) return '';
    const ref = now || new Date();
    const hm = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    if (sameDay(date, ref)) return hm;
    const day = date.getDate() + ' ' + MONTHS_SHORT[date.getMonth()];
    return (date.getFullYear() === ref.getFullYear() ? day : day + ' ' + date.getFullYear()) + ', ' + hm;
  }

  function pluralRu(n, one, few, many) {
    const abs = Math.abs(Number(n) || 0);
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function formatCount(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = Array.from(parts[0])[0] || '';
    const second = parts.length > 1 ? (Array.from(parts[1])[0] || '') : '';
    return (first + second).toUpperCase();
  }

  function hueFromString(s) {
    let h = 0;
    for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  }

  function initialsAvatar(name) {
    const hue = hueFromString(name);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
      + `<rect width="100" height="100" fill="hsl(${hue},38%,30%)"/>`
      + `<text x="50" y="50" dy=".36em" text-anchor="middle" font-family="sans-serif" font-size="38" font-weight="600" fill="hsl(${hue},70%,88%)">${escapeHtml(initialsOf(name))}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function resolveAvatarUrl(url, name) {
    const u = String(url || '');
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('http://') || u.startsWith('https://') || u.startsWith('file:')) {
      return u;
    }
    if (u && !hasBridge) return state.serverUrl + (u.startsWith('/') ? u : '/' + u);
    return initialsAvatar(name || '');
  }

  function isClaudeCliModel(modelId) {
    return typeof modelId === 'string' && modelId.indexOf('claude-code-') === 0;
  }

  /** 'cli' (on-device Claude Code), 'vertex-claude' (Anthropic via Vertex) or 'gemini'. */
  function providerOf(modelId) {
    const id = String(modelId || '');
    if (isClaudeCliModel(id)) return 'cli';
    if (id.indexOf('claude-') === 0) return 'vertex-claude';
    return 'gemini';
  }

  const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

  /**
   * Reasoning levels a model really honours. Native engine 19+ reports them per
   * model (models[].efforts); otherwise per provider: Gemini maps MAX to HIGH,
   * Claude-on-Vertex ignores effort, the Claude CLI accepts up to xhigh/max.
   */
  function effortOptionsFor(modelId, models) {
    const known = (models || []).find(m => m.id === modelId);
    if (known && Array.isArray(known.efforts)) return known.efforts.slice();
    const p = providerOf(modelId);
    if (p === 'cli') return ['low', 'medium', 'high', 'xhigh', 'max'];
    if (p === 'vertex-claude') return [];
    return ['low', 'medium', 'high'];
  }

  /** The level actually used: unsupported levels fall back to the nearest lower one. */
  function effectiveEffort(modelId, effort, models) {
    const opts = effortOptionsFor(modelId, models);
    if (!opts.length) return '';
    const e = String(effort || 'high').toLowerCase();
    if (opts.includes(e)) return e;
    for (let i = EFFORT_ORDER.indexOf(e); i >= 0; i--) {
      if (opts.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
    }
    return opts.includes('high') ? 'high' : opts[0];
  }

  function chatActivityTime(chat) {
    return parseServerTime(chat && (chat.last_activity || chat.created_at));
  }

  /** Most recent activity first; chats without timestamps fall back to id order. */
  function sortChats(chats) {
    return (chats || []).slice().sort((a, b) => {
      const ta = chatActivityTime(a);
      const tb = chatActivityTime(b);
      if (ta && tb && tb.getTime() !== ta.getTime()) return tb - ta;
      if (ta && !tb) return -1;
      if (tb && !ta) return 1;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  }

  function filterChats(chats, opts) {
    const query = String((opts && opts.query) || '').trim().toLowerCase();
    const characterId = Number((opts && opts.characterId) || 0);
    return (chats || []).filter(c => {
      if (characterId && Number(c.character_id) !== characterId) return false;
      if (!query) return true;
      return [c.character_name, c.persona_name, c.title, stripMarkdownPreview(c.last_message)]
        .some(v => String(v || '').toLowerCase().includes(query));
    });
  }

  function isDefaultChatTitle(title, characterName) {
    const t = String(title || '').trim();
    return !t || t === 'Чат: ' + String(characterName || '').trim();
  }

  // ==========================================================================
  // STATE, PREFERENCES, FEATURES
  // ==========================================================================
  const state = {
    serverUrl: getServerBaseUrl(),
    engineBuild: 17,
    webVersion: '',
    settings: {
      projectId: '',
      selectedModel: 'gemini-4-argon',
      selectedEffort: 'high',
      safetyThreshold: 'OFF',
      activePersonaId: 0,
      agyAuthenticated: false,
      agyEmail: '',
      claudeRuntimeReady: false,
      claudeAuthenticated: false,
      claudeRuntimeUrlConfigured: null,
      claudeDownloadMb: 0,
      claudeInstalling: false,
      claudeInstallProgress: '',
      claudeLoginPending: false,
      claudeLoginError: '',
      claudeLoginUrl: '',
      claudeLoginAutoUrl: '',
      claudeLoginElapsed: 0,
      claudeLoginOutput: '',
      claudeLoginDebug: '',
      claudeLoginTimeout: 0,
      claudeSelftestRunning: false,
      claudeSelftestProgress: '',
      claudeSafeMode: false,
    },
    // Last Claude Code self-test result; survives closing the settings page.
    claudeSelftest: null,
    models: [],
    characters: [],
    personas: [],
    chats: [],
    loaded: false,
    loadError: '',
    tab: 'chats',
    chatsQuery: '',
    chatsSearchOpen: false,
    chatsFilter: 0,
    charsQuery: '',
    charsSearchOpen: false,
    charsSort: 'name',
    room: null,
    generations: {},
    drafts: {},
    updateInfo: null,
    updateToastShown: false,
    systemPromptText: null,
    lastGeneration: {},
  };

  const PREFS_KEY = 'agy_ui_prefs_v1';
  const DEFAULT_PREFS = {
    theme: 'dark',
    accent: 231,
    fontSize: 16,
    lineHeight: 1.6,
    serif: false,
    dialogue: true,
    thoughtsOpen: false,
    enterSends: false,
  };

  function loadPrefs() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(PREFS_KEY);
      return Object.assign({}, DEFAULT_PREFS, raw ? JSON.parse(raw) : {});
    } catch (e) {
      return Object.assign({}, DEFAULT_PREFS);
    }
  }

  const prefs = loadPrefs();

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      // storage may be unavailable; preferences then last for the session
    }
  }

  // Native engine capabilities (APK build 18 added these endpoints/bridges).
  const can = {
    cancel: () => state.engineBuild >= 18,
    promptPreview: () => state.engineBuild >= 18,
    rename: () => state.engineBuild >= 18,
    jsonPicker: () => !hasBridge || state.engineBuild >= 18,
    perChatModel: () => state.engineBuild >= 18,
    systemBars: () => !hasBridge || typeof window.AndroidServer.setSystemBars === 'function',
    claudeInstall: () => state.engineBuild >= 19,
    claudeLogin: () => state.engineBuild >= 20,
  };

  const THEMES = {
    dark: { label: 'Тёмная', bg: '#0f1115', nav: '#13161c', light: false, swatch: ['#0f1115', '#1c2029', '#a4abbb'] },
    amoled: { label: 'AMOLED', bg: '#000000', nav: '#000000', light: false, swatch: ['#000000', '#121419', '#a4abbb'] },
    light: { label: 'Светлая', bg: '#f4f5f8', nav: '#ffffff', light: true, swatch: ['#f4f5f8', '#ffffff', '#4f5768'] },
  };
  const ACCENTS = [
    { hue: 231, label: 'Индиго' },
    { hue: 265, label: 'Фиолетовый' },
    { hue: 172, label: 'Бирюзовый' },
    { hue: 32, label: 'Янтарный' },
    { hue: 340, label: 'Розовый' },
  ];

  function applyTheme() {
    const root = document.documentElement;
    const theme = THEMES[prefs.theme] ? prefs.theme : 'dark';
    if (root.dataset) root.dataset.theme = theme;
    root.style.setProperty('--accent-h', String(prefs.accent));
    root.style.setProperty('--reading-size', prefs.fontSize + 'px');
    root.style.setProperty('--reading-lh', String(prefs.lineHeight));
    root.style.setProperty('--reading-font', prefs.serif ? 'var(--font-serif)' : 'var(--font-ui)');
    const t = THEMES[theme];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
    if (hasBridge && typeof window.AndroidServer.setSystemBars === 'function') {
      try {
        window.AndroidServer.setSystemBars(t.bg, t.nav, t.light);
      } catch (e) {
        // older bridge signature — ignore
      }
    }
  }

  // ==========================================================================
  // DOM HELPERS
  // ==========================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ic = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  function htmlToElement(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function autoGrow(el, maxPx) {
    if (!el) return;
    el.style.height = 'auto';
    const max = maxPx || 10000;
    el.style.height = Math.min(el.scrollHeight + 2, max) + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }

  function findChar(id) {
    return state.characters.find(c => c.id === Number(id)) || null;
  }

  function findPersona(id) {
    return state.personas.find(p => p.id === Number(id)) || null;
  }

  function modelName(modelId) {
    const m = state.models.find(x => x.id === modelId);
    return m ? m.name : (modelId || '—');
  }

  const PROVIDERS = {
    gemini: { label: 'Google Vertex · Gemini', short: 'Gemini', icon: 'cloud' },
    'vertex-claude': { label: 'Google Vertex · Claude', short: 'Claude', icon: 'cloud' },
    cli: { label: 'Claude Code · на устройстве', short: 'Claude CLI', icon: 'terminal' },
  };
  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };

  function modelSummary(modelId, effort) {
    const e = effectiveEffort(modelId, effort, state.models);
    return modelName(modelId) + (e ? ' · ' + EFFORT_LABELS[e] : '');
  }

  function providerStatus(provider) {
    const s = state.settings;
    if (provider === 'cli') {
      if (!s.claudeRuntimeReady) return { ok: false, text: 'Среда не установлена' };
      if (!s.claudeAuthenticated) return { ok: false, text: 'Нужен вход в Claude' };
      return { ok: true, text: 'Готово' };
    }
    if (!s.agyAuthenticated) return { ok: false, text: 'Нужен вход в Google' };
    return { ok: true, text: 'Подключено' };
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Скопировано', { type: 'success' });
        return true;
      }
    } catch (e) {
      // fall through to the textarea fallback
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Скопировано', { type: 'success' });
      return true;
    } catch (e) {
      toast('Не удалось скопировать', { type: 'error' });
      return false;
    }
  }

  function openExternal(url) {
    if (hasBridge && typeof window.AndroidServer.openExternalUrl === 'function') {
      window.AndroidServer.openExternalUrl(url);
    } else {
      window.open(url, '_blank');
    }
  }

  function reloadApp() {
    if (hasBridge && typeof window.AndroidServer.reloadWebView === 'function') {
      window.AndroidServer.reloadWebView();
    } else {
      window.location.reload();
    }
  }

  function saveFile(filename, text, mime) {
    if (hasBridge && typeof window.AndroidServer.saveExportFile === 'function') {
      window.AndroidServer.saveExportFile(filename, text, mime);
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 300);
  }

  // ==========================================================================
  // UI KIT: toasts
  // ==========================================================================
  const toastQueue = [];
  let toastCurrent = null;

  function toast(message, opts) {
    const o = opts || {};
    toastQueue.push({
      message: String(message || ''),
      type: o.type || 'info',
      action: o.action || null,
      duration: o.duration || (o.action ? 6500 : 3000),
    });
    if (toastQueue.length > 2) toastQueue.splice(0, toastQueue.length - 2);
    if (toastCurrent) {
      toastCurrent.dismissSoon();
    } else {
      showNextToast();
    }
  }

  function showNextToast() {
    const host = $('#toastHost');
    const item = toastQueue.shift();
    if (!host || !item) {
      toastCurrent = null;
      return;
    }
    const iconName = item.type === 'error' ? 'alert' : (item.type === 'success' ? 'check-circle' : '');
    const el = htmlToElement(`<div class="toast ${item.type}" role="status">${iconName ? ic(iconName) : ''}<div class="toast-text">${escapeHtml(item.message)}</div>${item.action ? `<button class="toast-action">${escapeHtml(item.action.label)}</button>` : ''}</div>`);
    host.appendChild(el);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.classList.add('leaving');
      setTimeout(() => {
        el.remove();
        toastCurrent = null;
        showNextToast();
      }, 180);
    };
    const timer = setTimeout(finish, item.duration);
    toastCurrent = {
      dismissSoon() {
        clearTimeout(timer);
        setTimeout(finish, 350);
      },
    };
    el.addEventListener('click', (e) => {
      if (item.action && e.target.closest('.toast-action')) {
        try {
          item.action.fn();
        } catch (err) {
          console.error(err);
        }
      }
      finish();
    });
  }

  // ==========================================================================
  // UI KIT: layers (pages, sheets, dialogs, viewer)
  // Every layer is a .modal-overlay appended to #layers in opening order, so
  // the legacy native back handler ("hide the last visible .modal-overlay")
  // keeps working on older APK engines.
  // ==========================================================================
  const layerStack = [];

  function syncBodyFlags() {
    document.body.classList.toggle('layer-open', layerStack.length > 0);
    document.body.classList.toggle('room-open', Boolean(state.room));
  }

  function openLayer(opts) {
    const host = $('#layers');
    const el = document.createElement('div');
    el.className = `modal-overlay layer-${opts.kind}${opts.className ? ' ' + opts.className : ''}`;
    const backdrop = (opts.kind === 'sheet' || opts.kind === 'dialog')
      ? '<div class="layer-backdrop" data-action="layer-dismiss"></div>'
      : '';
    el.innerHTML = backdrop + opts.html;
    const layer = {
      el,
      kind: opts.kind,
      onClose: opts.onClose || null,
      onBack: opts.onBack || null,
      dismissible: opts.dismissible !== false,
      closed: false,
      refresh: null,
    };
    layer.close = (o) => closeLayer(layer, o);
    el._layer = layer;
    host.appendChild(el);
    layerStack.push(layer);
    syncBodyFlags();
    if (opts.kind === 'sheet') attachSheetDrag(layer);
    return layer;
  }

  function closeLayer(layer, opts) {
    if (!layer || layer.closed) return;
    layer.closed = true;
    const idx = layerStack.indexOf(layer);
    if (idx >= 0) layerStack.splice(idx, 1);
    syncBodyFlags();
    try {
      if (layer.onClose) layer.onClose();
    } catch (e) {
      console.error(e);
    }
    const el = layer.el;
    if ((opts && opts.immediate) || el.classList.contains('hidden')) {
      el.remove();
      return;
    }
    el.classList.add('closing');
    setTimeout(() => el.remove(), 220);
  }

  function requestCloseLayer(layer) {
    if (!layer) return;
    if (layer.onBack && layer.onBack() === false) return;
    closeLayer(layer);
  }

  function topLayer() {
    return layerStack[layerStack.length - 1] || null;
  }

  function layerOf(el) {
    const host = el && el.closest('.modal-overlay');
    return host ? host._layer || null : null;
  }

  function refreshLayers() {
    layerStack.forEach(l => {
      if (l.refresh) {
        try {
          l.refresh();
        } catch (e) {
          console.error(e);
        }
      }
    });
  }

  /** Delegated click handling for [data-act] elements inside one layer. */
  function bindActs(layer, handlers) {
    layer.el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || !layer.el.contains(t)) return;
      const fn = handlers[t.dataset.act];
      if (fn) fn(t, e);
    });
  }

  function attachSheetDrag(layer) {
    const sheet = $('.sheet', layer.el);
    if (!sheet) return;
    let startY = null;
    let dy = 0;
    const onStart = (e) => {
      if (!layer.dismissible || !e.touches || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      dy = 0;
      sheet.style.transition = 'none';
    };
    const onMove = (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      sheet.style.transition = 'transform 180ms ease';
      if (dy > 90) {
        requestCloseLayer(layer);
        if (!layer.closed) sheet.style.transform = '';
      } else {
        sheet.style.transform = '';
      }
    };
    $$('.sheet-handle, .sheet-head', layer.el).forEach(h => {
      h.addEventListener('touchstart', onStart, { passive: true });
      h.addEventListener('touchmove', onMove, { passive: true });
      h.addEventListener('touchend', onEnd);
      h.addEventListener('touchcancel', onEnd);
    });
  }

  function sheetHtml(o) {
    return `<div class="sheet${o.full ? ' full' : ''}" role="dialog" aria-label="${escapeHtml(o.title || '')}">
      <div class="sheet-handle"></div>
      ${o.title !== undefined ? `<div class="sheet-head"><div class="sheet-title">${escapeHtml(o.title)}</div>${o.headActions || ''}<button class="icon-btn sm" data-action="layer-close" aria-label="Закрыть">${ic('x', 'ic-sm')}</button></div>` : ''}
      <div class="sheet-body"${o.bodyStyle ? ` style="${o.bodyStyle}"` : ''}>${o.body || ''}</div>
      ${o.footer ? `<div class="sheet-footer">${o.footer}</div>` : ''}
    </div>`;
  }

  function openSheet(o) {
    const layer = openLayer({ kind: 'sheet', html: sheetHtml(o), onClose: o.onClose, onBack: o.onBack, dismissible: o.dismissible });
    layer.setBody = (html) => {
      const b = $('.sheet-body', layer.el);
      if (b) b.innerHTML = html;
    };
    return layer;
  }

  function pageHtml(o) {
    return `<header class="page-bar">
        <button class="icon-btn" data-action="layer-close" aria-label="Назад">${ic(o.backIcon || 'back')}</button>
        <div class="page-bar-title">${escapeHtml(o.title || '')}</div>
        ${o.actions || ''}
      </header>
      <div class="page-body"><div class="tab-inner">${o.body || ''}</div></div>
      ${o.footer ? `<div class="page-footer">${o.footer}</div>` : ''}`;
  }

  function openPage(o) {
    const layer = openLayer({ kind: 'page', html: pageHtml(o), onClose: o.onClose, onBack: o.onBack });
    const body = $('.page-body', layer.el);
    const bar = $('.page-bar', layer.el);
    body.addEventListener('scroll', () => bar.classList.toggle('scrolled', body.scrollTop > 4), { passive: true });
    layer.setBody = (html) => {
      $('.page-body > .tab-inner', layer.el).innerHTML = html;
    };
    layer.setTitle = (title) => {
      $('.page-bar-title', layer.el).innerHTML = title;
    };
    return layer;
  }

  function confirmDialog(o) {
    return new Promise((resolve) => {
      let result = false;
      const layer = openLayer({
        kind: 'dialog',
        html: `<div class="dialog" role="alertdialog">
          ${o.title ? `<h2 class="dialog-title">${escapeHtml(o.title)}</h2>` : ''}
          ${o.message ? `<p class="dialog-text">${escapeHtml(o.message)}</p>` : ''}
          <div class="dialog-actions">
            <button class="btn btn-ghost" data-act="cancel">${escapeHtml(o.cancelText || 'Отмена')}</button>
            <button class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(o.confirmText || 'OK')}</button>
          </div>
        </div>`,
        onClose: () => resolve(result),
      });
      bindActs(layer, {
        cancel: () => layer.close(),
        ok: () => {
          result = true;
          layer.close();
        },
      });
    });
  }

  /** items: [{ icon, label, danger, hidden, onSelect }] */
  function actionSheet(o) {
    const items = o.items.filter(i => !i.hidden);
    const layer = openSheet({
      title: o.title,
      bodyStyle: 'padding:0',
      body: `<div class="action-list">${items.map((it, i) => `<button class="action-item${it.danger ? ' danger' : ''}" data-act="pick" data-idx="${i}">${ic(it.icon)}<span>${escapeHtml(it.label)}</span></button>`).join('')}</div>`,
    });
    bindActs(layer, {
      pick: (el) => {
        const it = items[Number(el.dataset.idx)];
        layer.close();
        if (it && it.onSelect) setTimeout(() => it.onSelect(), 0);
      },
    });
    return layer;
  }

  function openTextSheet(title, text, opts) {
    const o = opts || {};
    const layer = openSheet({
      title,
      full: true,
      body: o.selectable
        ? `<textarea class="textarea tall" readonly>${escapeHtml(text)}</textarea><p class="section-hint">Выделите нужный фрагмент и скопируйте.</p>`
        : `<div class="prose">${escapeHtml(text)}</div>`,
      footer: `<button class="btn btn-secondary btn-block" data-act="copy">${ic('copy')}Скопировать всё</button>`,
    });
    bindActs(layer, { copy: () => copyText(text) });
    return layer;
  }

  function emptyHtml(icon, title, text, action) {
    return `<div class="empty">
      <div class="empty-icon">${ic(icon)}</div>
      <div class="empty-title">${escapeHtml(title)}</div>
      ${text ? `<div class="empty-text">${text}</div>` : ''}
      ${action || ''}
    </div>`;
  }

  // ==========================================================================
  // DATA LOADING
  // ==========================================================================
  function applySettings(s) {
    if (!s) return;
    state.engineBuild = Number(s.engineBuild) || 17;
    Object.assign(state.settings, {
      projectId: s.projectId || '',
      selectedModel: s.selectedModel || 'gemini-4-argon',
      selectedEffort: s.selectedEffort || 'high',
      safetyThreshold: s.safetyThreshold || 'OFF',
      activePersonaId: Number(s.activePersonaId) || 0,
      agyAuthenticated: Boolean(s.agyAuthenticated),
      agyEmail: s.agyUserEmail || s.agyEmail || '',
      claudeRuntimeReady: Boolean(s.claudeRuntimeReady),
      claudeAuthenticated: Boolean(s.claudeAuthenticated),
    });
  }

  async function loadAll() {
    const [settings, models, chars, personas, chats] = await Promise.all([
      api('/api/settings'),
      api('/api/models'),
      api('/api/characters'),
      api('/api/personas'),
      api('/api/chats'),
    ]);
    applySettings(settings);
    state.models = models.models || [];
    state.characters = chars.characters || [];
    state.personas = personas.personas || [];
    if (personas.activePersonaId) state.settings.activePersonaId = Number(personas.activePersonaId);
    state.chats = chats.chats || [];
    state.loaded = true;
    state.loadError = '';
    renderAllTabs();
  }

  async function loadChats() {
    try {
      const data = await api('/api/chats');
      state.chats = data.chats || [];
      if (state.tab === 'chats') renderChatsList();
      if (state.tab === 'characters') renderCharactersList();
      refreshLayers();
    } catch (e) {
      // list refresh is best-effort
    }
  }

  async function loadCards() {
    const [chars, personas] = await Promise.all([api('/api/characters'), api('/api/personas')]);
    state.characters = chars.characters || [];
    state.personas = personas.personas || [];
    if (personas.activePersonaId) state.settings.activePersonaId = Number(personas.activePersonaId);
    renderAllTabs();
    refreshLayers();
  }

  async function refreshSettings() {
    try {
      applySettings(await api('/api/settings'));
      renderRoomHeader();
      if (state.tab === 'settings') renderSettingsTab();
      refreshLayers();
    } catch (e) {
      // keep the last known state
    }
  }

  async function refreshClaudeStatus() {
    try {
      const data = await api('/api/claude/status');
      state.settings.claudeRuntimeReady = Boolean(data.runtimeReady);
      state.settings.claudeAuthenticated = Boolean(data.authenticated);
      state.settings.claudeRuntimeUrlConfigured = data.runtimeUrlConfigured !== undefined ? Boolean(data.runtimeUrlConfigured) : null;
      state.settings.claudeDownloadMb = Number(data.downloadMb) || 0;
      state.settings.claudeInstalling = Boolean(data.installing);
      state.settings.claudeInstallProgress = data.installProgress || '';
      state.settings.claudeLoginPending = Boolean(data.loginPending);
      state.settings.claudeLoginError = data.loginError || '';
      state.settings.claudeLoginUrl = data.loginUrl || '';
      state.settings.claudeLoginAutoUrl = data.loginAutoUrl || '';
      state.settings.claudeLoginElapsed = Number(data.loginElapsed) || 0;
      state.settings.claudeLoginOutput = data.loginOutput || '';
      state.settings.claudeLoginDebug = data.loginDebug || '';
      state.settings.claudeLoginTimeout = Number(data.loginTimeout) || 0;
      state.settings.claudeSelftestRunning = Boolean(data.selftestRunning);
      state.settings.claudeSelftestProgress = data.selftestProgress || '';
      state.settings.claudeSafeMode = Boolean(data.safeMode);
      if (state.tab === 'settings') renderSettingsTab();
      refreshLayers();
    } catch (e) {
      // ignore
    }
  }

  async function refreshAgyStatus() {
    try {
      const data = await api('/api/agy/auth/status');
      state.settings.agyAuthenticated = Boolean(data.authenticated);
      state.settings.agyEmail = data.email || state.settings.agyEmail;
      if (data.projectId) state.settings.projectId = data.projectId;
      renderRoomHeader();
      if (state.tab === 'settings') renderSettingsTab();
      refreshLayers();
    } catch (e) {
      // ignore
    }
  }

  window.__onAgyOAuthSuccess = function () {
    // Native engines call this without arguments once the loopback OAuth completes.
    refreshAgyStatus().then(() => {
      if (state.settings.agyAuthenticated) toast('Вход в Google выполнен', { type: 'success' });
    });
  };

  window.__onNativeFileSaved = function (success) {
    if (success) toast('Файл сохранён', { type: 'success' });
  };

  // ==========================================================================
  // TABS & ROUTING
  // ==========================================================================
  const TABS = ['chats', 'characters', 'personas', 'settings'];

  function openTab(tab) {
    const name = TABS.includes(tab) ? tab : (tab === 'updates' ? 'settings' : 'chats');
    state.tab = name;
    $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    renderTab(name);
    const fab = $('#newChatFab');
    if (fab) fab.classList.toggle('hidden', name !== 'chats' || !state.characters.length);
    if (name === 'settings') {
      refreshAgyStatus();
      refreshClaudeStatus();
    }
  }

  function renderTab(name) {
    if (name === 'chats') renderChatsTab();
    else if (name === 'characters') renderCharactersTab();
    else if (name === 'personas') renderPersonasTab();
    else if (name === 'settings') renderSettingsTab();
  }

  function renderAllTabs() {
    renderTab(state.tab);
    const fab = $('#newChatFab');
    if (fab) fab.classList.toggle('hidden', state.tab !== 'chats' || !state.characters.length);
    renderRoomHeader();
  }

  /**
   * Back navigation: closes the top-most layer, then the chat room, then search,
   * then returns to the Chats tab, and finally lets the app exit.
   * Called by MainActivity.onBackPressed on native engine 18+.
   */
  function handleBack() {
    const top = topLayer();
    if (top) {
      requestCloseLayer(top);
      return 'handled';
    }
    if (state.room) {
      closeChatRoom();
      return 'handled';
    }
    if (state.tab === 'chats' && (state.chatsSearchOpen || state.chatsFilter)) {
      state.chatsSearchOpen = false;
      state.chatsQuery = '';
      state.chatsFilter = 0;
      renderChatsTab();
      return 'handled';
    }
    if (state.tab === 'characters' && state.charsSearchOpen) {
      state.charsSearchOpen = false;
      state.charsQuery = '';
      renderCharactersTab();
      return 'handled';
    }
    if (state.tab !== 'chats') {
      openTab('chats');
      return 'handled';
    }
    return 'exit';
  }

  function skeletonList(n) {
    return Array.from({ length: n }, () => '<div style="display:flex;gap:14px;align-items:center;padding:12px 0"><div class="skeleton" style="width:52px;height:52px;border-radius:50%"></div><div style="flex:1"><div class="skeleton" style="height:14px;width:45%"></div><div class="skeleton" style="height:12px;width:80%;margin-top:8px"></div></div></div>').join('');
  }

  function loadErrorHtml() {
    return emptyHtml('alert', 'Не удалось загрузить данные', escapeHtml(state.loadError),
      `<button class="btn btn-primary" data-action="reload-data">${ic('reroll')}Повторить</button>`);
  }

  // ==========================================================================
  // CHATS TAB
  // ==========================================================================
  function renderChatsTab() {
    const pane = $('#tab-chats');
    if (!pane) return;
    const header = state.chatsSearchOpen
      ? `<div class="appbar"><label class="search-field">${ic('search', 'ic-sm')}<input id="chatsSearchInput" type="search" placeholder="Поиск по чатам" value="${escapeHtml(state.chatsQuery)}" autocomplete="off" enterkeyhint="search" /><button class="icon-btn sm" data-action="chats-search-close" aria-label="Закрыть поиск">${ic('x', 'ic-sm')}</button></label></div>`
      : `<div class="appbar"><h1 class="appbar-title">Чаты</h1><div class="appbar-actions">${state.chats.length ? `<button class="icon-btn" data-action="chats-search-open" aria-label="Поиск">${ic('search')}</button>` : ''}</div></div>`;
    pane.innerHTML = `<div class="tab-inner">${header}<div id="chatsFilters" class="chat-filters"></div><div id="chatsList" class="chat-list"></div><div style="height:88px"></div></div>`;
    renderChatsList();
    if (state.chatsSearchOpen) {
      const input = $('#chatsSearchInput');
      if (input && document.activeElement !== input) setTimeout(() => input.focus(), 30);
    }
  }

  function renderChatsList() {
    const listHost = $('#chatsList');
    const filtersHost = $('#chatsFilters');
    if (!listHost || !filtersHost) return;

    if (!state.loaded) {
      filtersHost.innerHTML = '';
      listHost.innerHTML = state.loadError ? loadErrorHtml() : `<div style="padding:0 16px">${skeletonList(5)}</div>`;
      return;
    }

    if (!state.chats.length) {
      filtersHost.innerHTML = '';
      listHost.innerHTML = state.characters.length
        ? emptyHtml('chat', 'Начните первую историю', 'Выберите персонажа, свою персону и модель — и сделайте первый ход.',
          `<button class="btn btn-primary" data-action="new-chat">${ic('chat-plus')}Новый чат</button>`)
        : emptyHtml('mask', 'Создайте первого персонажа', 'Чтобы начать ролевую игру, нужен хотя бы один персонаж: имя, описание и приветствие.',
          `<button class="btn btn-primary" data-action="new-character">${ic('plus')}Создать персонажа</button>`);
      return;
    }

    // Character filter chips (only when chats span several characters)
    const seen = new Map();
    sortChats(state.chats).forEach(c => {
      const id = Number(c.character_id) || 0;
      if (id && !seen.has(id)) seen.set(id, { id, name: c.character_name, avatar: c.character_avatar });
    });
    if (state.chatsFilter && !seen.has(state.chatsFilter)) state.chatsFilter = 0;
    filtersHost.innerHTML = seen.size > 1
      ? `<div class="chips"><button class="chip${!state.chatsFilter ? ' active' : ''}" data-action="chats-filter" data-id="0">Все</button>${Array.from(seen.values()).map(ch =>
        `<button class="chip${state.chatsFilter === ch.id ? ' active' : ''}" data-action="chats-filter" data-id="${ch.id}"><img class="avatar avatar-24" src="${escapeHtml(resolveAvatarUrl(ch.avatar, ch.name))}" alt="" />${escapeHtml(ch.name)}</button>`).join('')}</div>`
      : '';

    const list = filterChats(sortChats(state.chats), { query: state.chatsQuery, characterId: state.chatsFilter });
    listHost.innerHTML = list.length
      ? list.map(chatRowHtml).join('')
      : emptyHtml('search', 'Ничего не найдено', 'Попробуйте другой запрос или сбросьте фильтр.');
  }

  function chatRowHtml(c) {
    const time = formatRelativeTime(chatActivityTime(c));
    const P = PROVIDERS[providerOf(c.model_id)];
    const custom = !isDefaultChatTitle(c.title, c.character_name);
    const meta = [custom ? c.title : '', c.persona_name || 'Игрок'].filter(Boolean).map(escapeHtml).join(' · ');
    const preview = stripMarkdownPreview(c.last_message);
    const gen = state.generations[c.id];
    return `<div class="chat-row" data-chat-id="${c.id}">
      <div class="chat-row-actions">
        <button class="act-export" data-action="chat-export" data-id="${c.id}">${ic('share', 'ic-sm')}Экспорт</button>
        <button class="act-delete" data-action="chat-delete" data-id="${c.id}">${ic('trash', 'ic-sm')}Удалить</button>
      </div>
      <div class="chat-row-main" role="button" tabindex="0" data-action="open-chat" data-id="${c.id}">
        <img class="avatar avatar-52" src="${escapeHtml(resolveAvatarUrl(c.character_avatar, c.character_name))}" alt="" />
        <div class="chat-row-body">
          <div class="chat-row-top"><span class="chat-row-name">${escapeHtml(c.character_name || 'Персонаж')}</span><span class="chat-row-time">${escapeHtml(time)}</span></div>
          <div class="chat-row-meta"><span>${meta}</span><span class="provider-tag">${ic(P.icon)}${escapeHtml(P.short)}</span></div>
          <div class="chat-row-preview">${gen ? '<span style="color:var(--accent)">Генерирует ответ…</span>' : escapeHtml(preview || 'Пока без сообщений')}</div>
        </div>
      </div>
    </div>`;
  }

  function closeOpenChatRows(except) {
    $$('.chat-row.open').forEach(row => {
      if (row === except) return;
      row.classList.remove('open');
      const main = $('.chat-row-main', row);
      if (main) main.style.transform = '';
    });
  }

  function openChatActions(chatId) {
    const c = state.chats.find(x => x.id === chatId);
    if (!c) return;
    actionSheet({
      title: c.character_name || 'Чат',
      items: [
        { icon: 'chat', label: 'Открыть', onSelect: () => openChatRoom(chatId) },
        { icon: 'share', label: 'Экспорт', onSelect: () => openExport(chatId) },
        { icon: 'trash', label: 'Удалить чат', danger: true, onSelect: () => deleteChat(chatId) },
      ],
    });
  }

  async function deleteChat(chatId) {
    const c = state.chats.find(x => x.id === chatId);
    const n = c ? Number(c.message_count) || 0 : 0;
    const ok = await confirmDialog({
      title: 'Удалить чат?',
      message: c ? `Чат с «${c.character_name}» и ${n} ${pluralRu(n, 'сообщение', 'сообщения', 'сообщений')} будут удалены без возможности восстановления.` : 'Чат будет удалён без возможности восстановления.',
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) {
      closeOpenChatRows();
      return;
    }
    try {
      await api(`/api/chats/${chatId}`, { method: 'DELETE' });
      state.chats = state.chats.filter(x => x.id !== chatId);
      if (state.room && state.room.chatId === chatId) closeChatRoom();
      $$('.modal-overlay').forEach(el => {
        if (el._layer && el._layer.chatId === chatId) el._layer.close();
      });
      renderChatsList();
      toast('Чат удалён');
      loadChats();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  }

  // ==========================================================================
  // NEW CHAT
  // ==========================================================================
  function lastUsedCharacterId() {
    const latest = sortChats(state.chats)[0];
    return latest ? Number(latest.character_id) : 0;
  }

  function openNewChat(preselectCharId) {
    if (!state.characters.length) {
      toast('Сначала создайте персонажа');
      openCharacterEditor(null);
      return;
    }
    const sel = {
      charId: Number(preselectCharId) || Number(state.chatsFilter) || lastUsedCharacterId() || state.characters[0].id,
      personaId: state.settings.activePersonaId || (state.personas[0] ? state.personas[0].id : 0),
      modelId: state.settings.selectedModel,
      effort: state.settings.selectedEffort,
      q: '',
      busy: false,
    };
    if (!findChar(sel.charId)) sel.charId = state.characters[0].id;
    if (sel.personaId && !findPersona(sel.personaId)) sel.personaId = state.personas[0] ? state.personas[0].id : 0;

    const render = () => {
      const ch = findChar(sel.charId);
      const chars = state.characters.filter(c => !sel.q || c.name.toLowerCase().includes(sel.q.toLowerCase()));
      const prov = providerOf(sel.modelId);
      const status = providerStatus(prov);
      const greeting = ch ? stripMarkdownPreview(ch.first_message || '') : '';
      return `
        ${state.characters.length > 6 ? `<label class="search-field" style="margin-bottom:12px">${ic('search', 'ic-sm')}<input data-role="q" placeholder="Найти персонажа" value="${escapeHtml(sel.q)}" autocomplete="off" /></label>` : ''}
        <div class="section-title">Персонаж</div>
        <div class="pick-grid">${chars.map(c => `<button class="pick-card${c.id === sel.charId ? ' active' : ''}" data-act="char" data-id="${c.id}">
            <img class="avatar avatar-64" src="${escapeHtml(resolveAvatarUrl(c.avatar_url, c.name))}" alt="" />
            <span class="pick-name">${escapeHtml(c.name)}</span></button>`).join('') || '<div class="faint">Нет совпадений</div>'}</div>
        <div class="greeting-preview">${greeting
          ? `${ic('chat', 'ic-xs')}<span>Начнётся с приветствия: «${escapeHtml(greeting.slice(0, 140))}${greeting.length > 140 ? '…' : ''}»</span>`
          : `${ic('info', 'ic-xs')}<span>У персонажа нет приветствия — первым пишете вы.</span>`}</div>

        <div class="section">
          <div class="section-title">Вы играете за</div>
          ${state.personas.length
            ? `<div class="chips wrap">${state.personas.map(p => `<button class="chip${p.id === sel.personaId ? ' active' : ''}" data-act="persona" data-id="${p.id}"><img class="avatar avatar-24" src="${escapeHtml(resolveAvatarUrl(p.avatar_url, p.name))}" alt="" />${escapeHtml(p.name)}</button>`).join('')}</div>`
            : `<div class="card card-pad muted" style="font-size:var(--fs-sm)">Персон пока нет — модель будет звать вас «Игрок». Создать персону можно во вкладке «Персоны».</div>`}
        </div>

        <div class="section">
          <div class="section-title">Модель</div>
          <div class="list">
            <button class="row" data-act="model">
              <span class="row-icon">${ic(PROVIDERS[prov].icon)}</span>
              <div class="row-body"><div class="row-title">${escapeHtml(modelName(sel.modelId))}</div><div class="row-sub">${escapeHtml(PROVIDERS[prov].label)}${effectiveEffort(sel.modelId, sel.effort, state.models) ? ' · ' + EFFORT_LABELS[effectiveEffort(sel.modelId, sel.effort, state.models)] : ''}</div></div>
              ${ic('chevron-right', 'row-chevron')}
            </button>
          </div>
          ${status.ok ? '' : `<div class="inline-warn">${ic('alert', 'ic-xs')}<span>${escapeHtml(status.text)}. Чат можно создать, но для ответа нужно </span><button class="link" data-act="provider">настроить провайдера</button></div>`}
        </div>`;
    };

    const layer = openSheet({
      title: 'Новый чат',
      full: true,
      body: render(),
      footer: `<button class="btn btn-primary btn-block" data-act="start">${ic('chat-plus')}Начать историю</button>`,
    });
    const rerender = () => {
      const body = $('.sheet-body', layer.el);
      const scroll = body.scrollTop;
      const hadFocus = document.activeElement && document.activeElement.dataset.role === 'q';
      layer.setBody(render());
      body.scrollTop = scroll;
      if (hadFocus) {
        const q = $('[data-role="q"]', layer.el);
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      }
    };
    layer.refresh = rerender;
    layer.el.addEventListener('input', (e) => {
      if (e.target.dataset.role === 'q') {
        sel.q = e.target.value;
        rerender();
      }
    });
    bindActs(layer, {
      char: (el) => {
        sel.charId = Number(el.dataset.id);
        rerender();
      },
      persona: (el) => {
        sel.personaId = Number(el.dataset.id);
        rerender();
      },
      model: () => openModelPicker({
        title: 'Модель для чата',
        modelId: sel.modelId,
        effort: sel.effort,
        onPick: (r) => {
          sel.modelId = r.modelId;
          if (r.effort) sel.effort = r.effort;
          rerender();
        },
      }),
      provider: () => openProviderSettings(providerOf(sel.modelId)),
      start: async (btn) => {
        if (sel.busy) return;
        sel.busy = true;
        btn.disabled = true;
        try {
          const payload = { characterId: sel.charId, personaId: sel.personaId, modelId: sel.modelId, effort: sel.effort };
          if (isClaudeCliModel(sel.modelId)) payload.provider = 'claude-cli';
          const res = await api('/api/chats', { method: 'POST', body: payload });
          layer.close();
          loadChats();
          openTab('chats');
          openChatRoom(res.chat.id, res);
        } catch (e) {
          toast(e.message, { type: 'error' });
        } finally {
          sel.busy = false;
          btn.disabled = false;
        }
      },
    });
  }

  // ==========================================================================
  // MODEL PICKER
  // ==========================================================================
  function openModelPicker(o) {
    const sel = { modelId: o.modelId, effort: o.effort || 'high' };
    const groups = ['gemini', 'vertex-claude', 'cli'];

    const render = () => {
      const opts = effortOptionsFor(sel.modelId, state.models);
      const eff = effectiveEffort(sel.modelId, sel.effort, state.models);
      const effortBlock = opts.length
        ? `<div class="section-title">Глубина рассуждений</div><div class="segmented">${opts.map(e => `<button class="${e === eff ? 'active' : ''}" data-act="effort" data-effort="${e}">${EFFORT_LABELS[e]}</button>`).join('')}</div>
           <div class="effort-note">${providerOf(sel.modelId) === 'cli' ? 'Передаётся в Claude Code как --effort.' : 'Чем выше, тем дольше модель думает перед ответом.'}</div>`
        : `<div class="effort-note">${ic('info', 'ic-xs')} Для этой модели глубина рассуждений не настраивается.</div>`;
      const row = (m) => `<button class="row model-row${m.id === sel.modelId ? ' selected' : ''}" data-act="model" data-id="${escapeHtml(m.id)}">
          <span class="row-icon">${m.id === sel.modelId ? ic('check-circle') : ic('circle')}</span>
          <div class="row-body"><div class="row-title">${escapeHtml(m.name)}</div>${m.badge ? `<div class="row-sub">${escapeHtml(m.badge)}</div>` : ''}</div>
        </button>`;
      const lists = groups.map(g => {
        const models = state.models.filter(m => providerOf(m.id) === g);
        if (!models.length) return '';
        const st = providerStatus(g);
        const current = models.filter(m => !m.legacy);
        const older = models.filter(m => m.legacy);
        const olderOpen = older.some(m => m.id === sel.modelId);
        return `<div class="section">
          <div class="section-title" style="display:flex;align-items:center;gap:8px">${escapeHtml(PROVIDERS[g].label)}${st.ok ? '' : `<span class="pill warn">${escapeHtml(st.text)}</span>`}</div>
          <div class="list">${current.map(row).join('')}</div>
          ${older.length ? `<details class="disclosure"${olderOpen ? ' open' : ''}><summary>Предыдущие версии · ${older.length} ${ic('chevron-down', 'ic-sm')}</summary><div class="list">${older.map(row).join('')}</div></details>` : ''}
          ${st.ok ? '' : `<button class="btn btn-ghost btn-sm" style="margin-top:6px" data-act="provider" data-provider="${g}">Настроить ${escapeHtml(PROVIDERS[g].short)}</button>`}
        </div>`;
      }).join('');
      return `${effortBlock}${lists}`;
    };

    const layer = openSheet({
      title: o.title || 'Модель',
      full: true,
      body: render(),
      footer: `<button class="btn btn-primary btn-block" data-act="done">Готово</button>`,
    });
    const rerender = () => {
      const body = $('.sheet-body', layer.el);
      const scroll = body.scrollTop;
      const folded = $('details.disclosure', body);
      const wasOpen = folded && folded.open;
      layer.setBody(render());
      if (wasOpen && $('details.disclosure', body)) $('details.disclosure', body).open = true;
      body.scrollTop = scroll;
    };
    layer.refresh = rerender;
    bindActs(layer, {
      effort: (el) => {
        sel.effort = el.dataset.effort;
        rerender();
      },
      model: (el) => {
        sel.modelId = el.dataset.id;
        const e = effectiveEffort(sel.modelId, sel.effort, state.models);
        if (e) sel.effort = e;
        rerender();
      },
      provider: (el) => openProviderSettings(el.dataset.provider),
      done: () => {
        layer.close();
        o.onPick({ modelId: sel.modelId, effort: effectiveEffort(sel.modelId, sel.effort, state.models) || sel.effort });
      },
    });
  }

  // ==========================================================================
  // CHAT ROOM
  // ==========================================================================
  async function openChatRoom(chatId, preloaded) {
    const id = Number(chatId);
    let data = preloaded && preloaded.chat ? preloaded : null;
    if (!data) {
      try {
        data = await api(`/api/chats/${id}`);
      } catch (e) {
        toast(e.message, { type: 'error' });
        return;
      }
    }
    if (state.room) saveDraft();
    state.room = { chatId: id, data, error: null };
    const view = $('#chatRoomView');
    view.classList.remove('hidden');
    syncBodyFlags();
    renderRoomHeader();
    $('#chatFeed').innerHTML = '';
    syncFeed({ scroll: 'bottom' });
    const input = $('#chatInput');
    input.value = state.drafts[id] || '';
    autoGrow(input, 168);
    updateComposer();
    if (!state.generations[id]) attachToRunningGeneration(id);
    else ensurePolling(id);
  }

  function saveDraft() {
    if (!state.room) return;
    const input = $('#chatInput');
    state.drafts[state.room.chatId] = input ? input.value : '';
  }

  function closeChatRoom() {
    if (!state.room) return;
    saveDraft();
    state.room = null;
    const view = $('#chatRoomView');
    view.classList.add('hidden');
    $('#chatFeed').innerHTML = '';
    syncBodyFlags();
    const input = $('#chatInput');
    if (input) input.blur();
    loadChats();
  }

  function renderRoomHeader() {
    const room = state.room;
    if (!room) return;
    const d = room.data;
    const ch = d.character || {};
    const persona = d.persona || {};
    const title = isDefaultChatTitle(d.chat.title, ch.name) ? (ch.name || 'Персонаж') : d.chat.title;
    $('#chatHeaderAvatar').src = resolveAvatarUrl(ch.avatar_url, ch.name);
    $('#chatHeaderName').textContent = title;
    $('#chatHeaderSub').textContent = modelSummary(d.chat.model_id, d.chat.effort) + ' · ' + (persona.name || 'Игрок');
    const st = providerStatus(providerOf(d.chat.model_id));
    const dot = $('#chatStatusDot');
    dot.classList.toggle('off', !st.ok);
    dot.title = st.text;
  }

  function scroller() {
    return $('#chatScroll');
  }

  function isNearBottom() {
    const s = scroller();
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }

  function scrollToBottom(smooth) {
    const s = scroller();
    if (!s) return;
    if (smooth && s.scrollTo) s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
    else s.scrollTop = s.scrollHeight;
  }

  function updateJumpBtn() {
    const btn = $('#jumpBtn');
    if (btn) btn.classList.toggle('hidden', !state.room || isNearBottom());
  }

  function feedContext() {
    const d = state.room.data;
    const msgs = d.messages || [];
    let lastAiIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') {
        lastAiIdx = i;
        break;
      }
    }
    return { msgs, lastAiIdx, character: d.character || {}, persona: d.persona || {} };
  }

  function messageSig(m, idx, ctx, extra) {
    return JSON.stringify([
      m.content, m.swipe_index, (m.swipes || []).length, (m.thoughts || '').length, m.created_at,
      idx === ctx.lastAiIdx, idx === 0, ctx.character.name, ctx.character.avatar_url ? ctx.character.avatar_url.length : 0,
      ctx.persona.name, ctx.persona.avatar_url ? ctx.persona.avatar_url.length : 0, extra || '',
    ]);
  }

  function messageHtml(m, idx, ctx, opts) {
    const isUser = m.role === 'user';
    const name = isUser ? (ctx.persona.name || 'Вы') : (ctx.character.name || 'Персонаж');
    const avatar = resolveAvatarUrl(isUser ? ctx.persona.avatar_url : ctx.character.avatar_url, name);
    const time = formatMessageTime(parseServerTime(m.created_at));
    const swipes = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content];
    const si = Math.min(Math.max(0, Number(m.swipe_index) || 0), swipes.length - 1);
    const isLastAi = idx === ctx.lastAiIdx;
    const isGreeting = idx === 0 && !isUser;
    const busy = Boolean(state.room && state.generations[state.room.chatId]);
    const swipeable = !isUser && isLastAi && !isGreeting && !m._pending && !busy;
    const hiddenCls = opts && opts.hidden ? ' hidden' : '';

    const head = `<div class="msg-head">
        <img class="avatar avatar-28" src="${escapeHtml(avatar)}" alt="" data-action="view-avatar" data-who="${isUser ? 'persona' : 'character'}" />
        <span class="msg-name">${escapeHtml(name)}</span>
        ${time ? `<span class="msg-time">${escapeHtml(time)}</span>` : ''}
        ${m._pending ? '' : `<button class="icon-btn sm" data-action="msg-menu" data-id="${m.id}" aria-label="Действия с сообщением">${ic('more', 'ic-sm')}</button>`}
      </div>`;

    if (isUser) {
      return `<div class="msg user${hiddenCls}" data-msg-id="${m.id}">${head}<div class="msg-card"><div class="msg-text">${formatRoleplayHtml(m.content, { dialogue: prefs.dialogue })}</div></div></div>`;
    }

    const thoughts = m.thoughts || '';
    const thoughtsHtml = thoughts
      ? `<details class="thoughts"${prefs.thoughtsOpen ? ' open' : ''}><summary>${ic('bulb')}Мысли · ${formatCount(thoughts.length)} симв.${ic('chevron-down', 'chev')}</summary><div class="thoughts-body">${escapeHtml(thoughts)}</div></details>`
      : '';
    const nav = swipes.length > 1
      ? `<div class="swipe-nav"><button data-action="swipe-prev" data-id="${m.id}" aria-label="Предыдущий вариант"${si <= 0 || busy ? ' disabled' : ''}>${ic('chevron-left', 'ic-sm')}</button><span class="swipe-count">${si + 1}/${swipes.length}</span><button data-action="swipe-next" data-id="${m.id}" aria-label="Следующий вариант"${(si >= swipes.length - 1 && !swipeable) || busy ? ' disabled' : ''}>${ic('chevron-right', 'ic-sm')}</button></div>`
      : '';
    const reroll = swipeable ? `<button class="foot-btn" data-action="reroll" data-id="${m.id}">${ic('reroll')}Другой вариант</button>` : '';
    const foot = nav || reroll ? `<div class="msg-foot">${nav}${reroll}</div>` : '';
    return `<div class="msg assistant${hiddenCls}" data-msg-id="${m.id}"${swipeable ? ' data-swipeable="1"' : ''}>${head}${thoughtsHtml}<div class="msg-text">${formatRoleplayHtml(m.content, { dialogue: prefs.dialogue })}</div>${foot}</div>`;
  }

  function introHtml(ctx) {
    return `<div class="feed-intro">
      <img class="avatar avatar-64" src="${escapeHtml(resolveAvatarUrl(ctx.character.avatar_url, ctx.character.name))}" alt="" />
      <div class="empty-title">${escapeHtml(ctx.character.name || 'Персонаж')}</div>
      <div>У персонажа нет приветствия. Опишите сцену и сделайте первый ход.</div>
    </div>`;
  }

  function liveHtml(ctx) {
    const name = ctx.character.name || 'Персонаж';
    return `<div class="msg assistant live">
      <div class="msg-head">
        <img class="avatar avatar-28" src="${escapeHtml(resolveAvatarUrl(ctx.character.avatar_url, name))}" alt="" />
        <span class="msg-name">${escapeHtml(name)}</span>
        <span class="live-status"><span data-live="status">Подготовка…</span><span class="elapsed" data-live="elapsed"></span></span>
        <button class="icon-btn sm" data-action="open-diagnostics" aria-label="Ход генерации">${ic('activity', 'ic-sm')}</button>
      </div>
      <details class="thoughts hidden" data-live="thoughts-wrap"${prefs.thoughtsOpen ? ' open' : ''}><summary>${ic('bulb')}<span data-live="thoughts-label">Мысли</span>${ic('chevron-down', 'chev')}</summary><div class="thoughts-body" data-live="thoughts"></div></details>
      <div class="msg-text" data-live="text"><div class="typing-dots"><i></i><i></i><i></i></div></div>
    </div>`;
  }

  function isAuthError(message) {
    return /401|авториз|войдите|войти|токен|сесси|Среда Claude Code не установлена|Нет авторизации/i.test(String(message || ''));
  }

  function errorHtml(err) {
    const provider = providerOf(state.room.data.chat.model_id);
    const auth = !err.cancelled && isAuthError(err.message);
    return `<div class="error-card${err.cancelled ? ' cancelled' : ''}">
      <div class="error-head">${ic(err.cancelled ? 'info' : 'alert')}<div>${escapeHtml(err.cancelled ? 'Генерация остановлена.' : (err.message || 'Неизвестная ошибка'))}</div></div>
      <div class="error-actions">
        <button class="btn btn-sm btn-secondary" data-action="retry-generation">${ic('reroll')}Повторить</button>
        ${auth ? `<button class="btn btn-sm btn-tonal" data-action="open-provider-settings" data-provider="${provider}">Настроить ${escapeHtml(PROVIDERS[provider].short)}</button>` : ''}
        ${err.cancelled ? '' : '<button class="btn btn-sm btn-ghost" data-action="open-diagnostics">Подробнее</button>'}
        <button class="btn btn-sm btn-ghost" data-action="dismiss-error">Скрыть</button>
      </div>
    </div>`;
  }

  /** Reconciles the feed DOM with room data, patching only changed messages. */
  function syncFeed(opts) {
    const room = state.room;
    if (!room) return;
    const o = opts || {};
    const feed = $('#chatFeed');
    const wasNearBottom = isNearBottom();
    const ctx = feedContext();
    const gen = state.generations[room.chatId];
    const items = [];

    if (!ctx.msgs.length && !gen) items.push({ key: 'intro', sig: 'intro' + ctx.character.name, html: () => introHtml(ctx) });
    ctx.msgs.forEach((m, idx) => {
      const regenerating = gen && gen.kind === 'reroll' && gen.msgId === m.id;
      items.push({
        key: 'm' + m.id,
        sig: messageSig(m, idx, ctx, (regenerating ? 'regen' : '') + (gen ? 'busy' : '') + (prefs.dialogue ? 'd' : '') + (prefs.thoughtsOpen ? 't' : '')),
        html: () => messageHtml(m, idx, ctx, { hidden: regenerating }),
      });
      if (regenerating) items.push({ key: 'live', sig: 'live', html: () => liveHtml(ctx) });
      if (room.error && room.error.kind === 'reroll' && room.error.msgId === m.id) {
        items.push({ key: 'error', sig: 'err' + room.error.message + room.error.cancelled, html: () => errorHtml(room.error) });
      }
    });
    if (gen && gen.kind === 'send') items.push({ key: 'live', sig: 'live', html: () => liveHtml(ctx) });
    if (room.error && room.error.kind === 'send') {
      items.push({ key: 'error', sig: 'err' + room.error.message + room.error.cancelled, html: () => errorHtml(room.error) });
    }

    const existing = new Map();
    Array.from(feed.children).forEach(el => existing.set(el.dataset.key, el));
    let prev = null;
    for (const it of items) {
      let el = existing.get(it.key);
      if (el && el.dataset.sig !== it.sig) {
        const fresh = htmlToElement(it.html());
        el.replaceWith(fresh);
        el = fresh;
      } else if (!el) {
        el = htmlToElement(it.html());
      }
      el.dataset.key = it.key;
      el.dataset.sig = it.sig;
      existing.delete(it.key);
      const expected = prev ? prev.nextSibling : feed.firstChild;
      if (el !== expected) feed.insertBefore(el, expected);
      prev = el;
    }
    existing.forEach(el => el.remove());

    if (gen && gen.last) patchLive(gen.last);
    if (o.scroll === 'bottom' || (o.scroll !== 'keep' && wasNearBottom)) scrollToBottom();
    updateJumpBtn();
  }

  const PHASE_STATUS = {
    init: 'Подготовка…',
    context: 'Сборка контекста…',
    auth: 'Проверка доступа…',
    oauth_check: 'Проверка доступа…',
    oauth_refresh: 'Обновление токена…',
    connecting: 'Подключение…',
    streaming: 'Ожидание ответа…',
    waiting_first_token: 'Ожидание ответа…',
    thinking: 'Думает…',
    generating: 'Пишет…',
    streaming_text: 'Пишет…',
    completed: 'Готово',
    cancelled: 'Остановлено',
    error: 'Ошибка',
  };

  function patchLive(g) {
    const live = $('#chatFeed [data-key="live"]');
    if (!live || !g) return;
    const wasNearBottom = isNearBottom();
    const status = g.text ? 'Пишет…' : (g.thoughts ? 'Думает…' : (PHASE_STATUS[g.phase] || 'Генерация…'));
    const statusEl = $('[data-live="status"]', live);
    if (statusEl && statusEl.textContent !== status) statusEl.textContent = status;

    if (g.thoughts) {
      const wrap = $('[data-live="thoughts-wrap"]', live);
      wrap.classList.remove('hidden');
      $('[data-live="thoughts-label"]', live).textContent = `Мысли · ${formatCount(g.thoughts.length)} симв.`;
      const body = $('[data-live="thoughts"]', live);
      if (body.textContent.length !== g.thoughts.length) {
        body.textContent = g.thoughts;
        body.scrollTop = body.scrollHeight;
      }
    }
    if (g.text) {
      const textEl = $('[data-live="text"]', live);
      if (textEl.dataset.len !== String(g.text.length)) {
        textEl.dataset.len = String(g.text.length);
        textEl.innerHTML = formatRoleplayHtml(g.text, { dialogue: prefs.dialogue });
      }
    }
    if (wasNearBottom) scrollToBottom();
  }

  function tickElapsed() {
    const room = state.room;
    if (!room) return;
    const gen = state.generations[room.chatId];
    const el = $('#chatFeed [data-live="elapsed"]');
    if (gen && el) el.textContent = ((Date.now() - gen.startedAt) / 1000).toFixed(1) + ' с';
  }

  function updateComposer() {
    const btn = $('#sendBtn');
    if (!btn || !state.room) return;
    const gen = state.generations[state.room.chatId];
    btn.classList.remove('stop', 'busy');
    btn.disabled = false;
    if (gen) {
      if (can.cancel()) {
        btn.classList.add('stop');
        btn.dataset.action = 'stop';
        btn.setAttribute('aria-label', 'Остановить генерацию');
        btn.innerHTML = gen.stopping ? '<span class="spinner"></span>' : ic('stop');
        btn.disabled = Boolean(gen.stopping);
      } else {
        btn.classList.add('busy');
        btn.dataset.action = 'noop';
        btn.setAttribute('aria-label', 'Идёт генерация');
        btn.innerHTML = '<span class="spinner"></span>';
      }
    } else {
      btn.dataset.action = 'send';
      btn.setAttribute('aria-label', 'Отправить');
      btn.innerHTML = ic('send');
    }
  }

  // --- generation lifecycle ------------------------------------------------
  let pollTimer = null;
  let tickTimer = null;

  function startGeneration(chatId, info) {
    state.generations[chatId] = Object.assign({ startedAt: Date.now(), last: null, stopping: false }, info);
    ensurePolling(chatId);
    if (state.tab === 'chats') renderChatsList();
  }

  function ensurePolling() {
    if (!pollTimer) pollTimer = setInterval(pollGenerations, 450);
    if (!tickTimer) tickTimer = setInterval(tickElapsed, 100);
  }

  async function pollGenerations() {
    const ids = Object.keys(state.generations).map(Number);
    if (!ids.length) {
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      pollTimer = null;
      tickTimer = null;
      return;
    }
    // Only the chat the user looks at (or whose diagnostics are open) needs live data.
    const watched = ids.filter(id => (state.room && state.room.chatId === id) || (diag && diag.chatId === id));
    for (const id of watched) {
      try {
        const data = await api(`/api/chats/${id}/generation`);
        const gen = state.generations[id];
        if (!gen) continue;
        if (data.generation) {
          gen.last = data.generation;
          if (state.room && state.room.chatId === id) patchLive(data.generation);
          if (diag && diag.chatId === id) renderDiagnostics();
        }
        if (gen.attached && !data.active) {
          // A generation we only observed (started before the room was opened) finished.
          delete state.generations[id];
          if (state.room && state.room.chatId === id) {
            try {
              state.room.data = await api(`/api/chats/${id}`);
            } catch (e) {
              // keep current data
            }
            syncFeed();
            updateComposer();
          }
          loadChats();
        }
      } catch (e) {
        // transient bridge errors are ignored while polling
      }
    }
  }

  async function attachToRunningGeneration(chatId) {
    try {
      const data = await api(`/api/chats/${chatId}/generation`);
      if (data.active && !state.generations[chatId]) {
        startGeneration(chatId, { kind: 'send', attached: true, last: data.generation || null });
        if (state.room && state.room.chatId === chatId) {
          syncFeed({ scroll: 'bottom' });
          updateComposer();
        }
      }
    } catch (e) {
      // older engines or no generation yet
    }
  }

  function endGeneration(chatId, generation) {
    delete state.generations[chatId];
    if (generation) state.lastGeneration = Object.assign(state.lastGeneration || {}, { [chatId]: generation });
    if (diag && diag.chatId === chatId) {
      diag.final = generation || diag.final;
      renderDiagnostics();
    }
  }

  function generationError(err) {
    const g = err && err.data && err.data.generation;
    const cancelled = Boolean((err && err.status === 409) || (err && err.data && err.data.cancelled) || (g && g.cancelled));
    return { message: err ? err.message : 'Неизвестная ошибка', cancelled, generation: g || null };
  }

  function nowServerString() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  async function sendMessage() {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;
    if (state.generations[chatId]) return;
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    input.value = '';
    autoGrow(input, 168);
    state.drafts[chatId] = '';
    room.error = null;

    const temp = { id: -Date.now(), role: 'user', content: text, swipes: [text], swipe_index: 0, created_at: nowServerString(), _pending: true };
    room.data.messages.push(temp);
    startGeneration(chatId, { kind: 'send', text });
    syncFeed({ scroll: 'bottom' });
    updateComposer();

    try {
      const res = await api(`/api/chats/${chatId}/messages`, { method: 'POST', body: { content: text } });
      endGeneration(chatId, res.generation);
      if (state.room && state.room.chatId === chatId) state.room.data.messages = res.messages || state.room.data.messages;
    } catch (err) {
      const info = generationError(err);
      endGeneration(chatId, info.generation);
      if (state.room && state.room.chatId === chatId) {
        state.room.data.messages = state.room.data.messages.filter(m => m.id !== temp.id);
        state.room.error = Object.assign({ kind: 'send', text }, info);
        const box = $('#chatInput');
        if (!box.value.trim()) {
          box.value = text;
          autoGrow(box, 168);
        }
      } else {
        state.drafts[chatId] = state.drafts[chatId] || text;
        toast(info.cancelled ? 'Генерация остановлена' : 'Ошибка генерации: ' + info.message, {
          type: info.cancelled ? 'info' : 'error',
          action: { label: 'Открыть', fn: () => openChatRoom(chatId) },
        });
      }
    } finally {
      if (state.room && state.room.chatId === chatId) {
        syncFeed();
        updateComposer();
      }
      loadChats();
    }
  }

  async function regenerate(msgId) {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;
    if (state.generations[chatId]) return;
    room.error = null;
    startGeneration(chatId, { kind: 'reroll', msgId });
    syncFeed();
    updateComposer();
    try {
      const res = await api(`/api/messages/${msgId}/swipe`, { method: 'POST', body: { action: 'regenerate' } });
      endGeneration(chatId, res.generation);
      replaceMessage(chatId, res.message);
    } catch (err) {
      const info = generationError(err);
      endGeneration(chatId, info.generation);
      if (state.room && state.room.chatId === chatId) {
        state.room.error = Object.assign({ kind: 'reroll', msgId }, info);
      } else if (!info.cancelled) {
        toast('Ошибка генерации: ' + info.message, { type: 'error', action: { label: 'Открыть', fn: () => openChatRoom(chatId) } });
      }
    } finally {
      if (state.room && state.room.chatId === chatId) {
        syncFeed({ scroll: 'keep' });
        updateComposer();
      }
      loadChats();
    }
  }

  async function stopGeneration() {
    const room = state.room;
    if (!room) return;
    const gen = state.generations[room.chatId];
    if (!gen || !can.cancel() || gen.stopping) return;
    gen.stopping = true;
    updateComposer();
    try {
      await api(`/api/chats/${room.chatId}/generation/cancel`, { method: 'POST' });
    } catch (e) {
      gen.stopping = false;
      updateComposer();
      toast(e.message, { type: 'error' });
    }
  }

  function retryGeneration() {
    const room = state.room;
    if (!room || !room.error) return;
    const err = room.error;
    room.error = null;
    if (err.kind === 'reroll') {
      regenerate(err.msgId);
      return;
    }
    const input = $('#chatInput');
    if (!input.value.trim()) input.value = err.text || '';
    sendMessage();
  }

  function replaceMessage(chatId, msg) {
    if (!msg || !state.room || state.room.chatId !== chatId) return;
    const list = state.room.data.messages;
    const idx = list.findIndex(m => m.id === msg.id);
    if (idx >= 0) list[idx] = msg;
  }

  async function selectSwipe(msgId, index) {
    const room = state.room;
    if (!room || state.generations[room.chatId]) return;
    try {
      const res = await api(`/api/messages/${msgId}/swipe`, { method: 'POST', body: { action: 'select', index } });
      replaceMessage(room.chatId, res.message);
      syncFeed({ scroll: 'keep' });
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  }

  function swipeBy(msgId, delta) {
    const room = state.room;
    if (!room) return;
    const ctx = feedContext();
    const idx = ctx.msgs.findIndex(m => m.id === msgId);
    const m = ctx.msgs[idx];
    if (!m) return;
    const count = Array.isArray(m.swipes) && m.swipes.length ? m.swipes.length : 1;
    const next = (Number(m.swipe_index) || 0) + delta;
    if (next < 0) return;
    if (next >= count) {
      if (idx === ctx.lastAiIdx && idx !== 0) regenerate(msgId);
      return;
    }
    selectSwipe(msgId, next);
  }

  function insertAsterisks() {
    const input = $('#chatInput');
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const val = input.value;
    const selected = val.slice(start, end);
    if (selected) {
      input.value = val.slice(0, start) + '*' + selected + '*' + val.slice(end);
      input.setSelectionRange(end + 2, end + 2);
    } else {
      input.value = val.slice(0, start) + '**' + val.slice(end);
      input.setSelectionRange(start + 1, start + 1);
    }
    input.focus();
    autoGrow(input, 168);
  }

  // --- message actions ------------------------------------------------------
  function openMessageActions(msgId) {
    const room = state.room;
    if (!room) return;
    const ctx = feedContext();
    const idx = ctx.msgs.findIndex(m => m.id === msgId);
    const m = ctx.msgs[idx];
    if (!m || m._pending) return;
    const isUser = m.role === 'user';
    const isGreeting = idx === 0 && !isUser;
    const isLast = idx === ctx.msgs.length - 1;
    const busy = Boolean(state.generations[room.chatId]);
    const later = ctx.msgs.length - idx - 1;
    actionSheet({
      title: isUser ? (ctx.persona.name || 'Ваше сообщение') : (ctx.character.name || 'Сообщение'),
      items: [
        { icon: 'copy', label: 'Копировать', onSelect: () => copyText(m.content) },
        { icon: 'file', label: 'Выделить текст', onSelect: () => openTextSheet('Текст сообщения', m.content, { selectable: true }) },
        { icon: 'edit', label: 'Редактировать', hidden: busy, onSelect: () => openEditMessage(msgId) },
        { icon: 'reroll', label: 'Сгенерировать другой вариант', hidden: isUser || isGreeting || busy, onSelect: () => regenerate(msgId) },
        { icon: 'bulb', label: 'Показать мысли', hidden: !m.thoughts, onSelect: () => openTextSheet('Мысли', m.thoughts) },
        { icon: 'undo', label: `Откатить к этому сообщению (удалить ${later} ${pluralRu(later, 'последующее', 'последующих', 'последующих')})`, hidden: isLast || busy, onSelect: () => rewindTo(msgId) },
        { icon: 'trash', label: 'Удалить сообщение', danger: true, hidden: busy, onSelect: () => deleteMessage(msgId) },
      ],
    });
  }

  function openEditMessage(msgId) {
    const room = state.room;
    const m = room && room.data.messages.find(x => x.id === msgId);
    if (!m) return;
    const chatId = room.chatId;
    const layer = openSheet({
      title: 'Редактирование',
      full: true,
      body: `<textarea class="textarea tall" data-role="text">${escapeHtml(m.content)}</textarea>
        ${m.role !== 'user' && (m.swipes || []).length > 1 ? '<p class="section-hint">Изменится только текущий вариант ответа.</p>' : ''}`,
      footer: `<div class="btn-row"><button class="btn btn-secondary" data-action="layer-close">Отмена</button><button class="btn btn-primary" data-act="save">Сохранить</button></div>`,
      onBack: () => {
        const v = $('[data-role="text"]', layer.el).value;
        if (v === m.content) return true;
        confirmDialog({ title: 'Отменить изменения?', confirmText: 'Отменить', cancelText: 'Продолжить', danger: true })
          .then(ok => ok && layer.close());
        return false;
      },
    });
    bindActs(layer, {
      save: async (btn) => {
        const content = $('[data-role="text"]', layer.el).value;
        if (!content.trim()) {
          toast('Сообщение не может быть пустым');
          return;
        }
        btn.disabled = true;
        try {
          const res = await api(`/api/messages/${msgId}`, { method: 'PUT', body: { content } });
          replaceMessage(chatId, res.message);
          layer.close();
          if (state.room && state.room.chatId === chatId) syncFeed({ scroll: 'keep' });
          toast('Сообщение обновлено', { type: 'success' });
        } catch (e) {
          btn.disabled = false;
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  async function deleteMessage(msgId) {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;
    const ok = await confirmDialog({ title: 'Удалить сообщение?', message: 'Все его варианты тоже будут удалены.', confirmText: 'Удалить', danger: true });
    if (!ok) return;
    try {
      await api(`/api/messages/${msgId}`, { method: 'DELETE' });
      if (state.room && state.room.chatId === chatId) {
        state.room.data.messages = state.room.data.messages.filter(m => m.id !== msgId);
        if (state.room.error && state.room.error.msgId === msgId) state.room.error = null;
        syncFeed({ scroll: 'keep' });
      }
      loadChats();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  }

  async function rewindTo(msgId) {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;
    const msgs = room.data.messages;
    const idx = msgs.findIndex(m => m.id === msgId);
    const victims = msgs.slice(idx + 1).filter(m => m.id > 0);
    if (!victims.length) return;
    const ok = await confirmDialog({
      title: 'Откатить чат?',
      message: `${victims.length} ${pluralRu(victims.length, 'сообщение', 'сообщения', 'сообщений')} после выбранного будут удалены.`,
      confirmText: 'Откатить',
      danger: true,
    });
    if (!ok) return;
    let removed = 0;
    for (const m of victims.reverse()) {
      try {
        await api(`/api/messages/${m.id}`, { method: 'DELETE' });
        removed++;
      } catch (e) {
        toast(e.message, { type: 'error' });
        break;
      }
    }
    try {
      const data = await api(`/api/chats/${chatId}`);
      if (state.room && state.room.chatId === chatId) {
        state.room.data = data;
        state.room.error = null;
        syncFeed({ scroll: 'bottom' });
      }
    } catch (e) {
      // keep local view
    }
    if (removed) toast(`Удалено ${removed} ${pluralRu(removed, 'сообщение', 'сообщения', 'сообщений')}`);
    loadChats();
  }

  // --- chat settings sheet --------------------------------------------------
  async function patchChat(chatId, body) {
    const res = await api(`/api/chats/${chatId}`, { method: 'PATCH', body });
    if (state.room && state.room.chatId === chatId) {
      state.room.data.chat = res.chat;
      state.room.data.persona = res.persona;
      state.room.data.character = res.character;
      renderRoomHeader();
      syncFeed({ scroll: 'keep' });
    }
    loadChats();
    return res;
  }

  function openChatSettings() {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;

    const render = () => {
      const d = state.room && state.room.chatId === chatId ? state.room.data : null;
      if (!d) return '';
      const ch = d.character || {};
      const chat = d.chat;
      const prov = providerOf(chat.model_id);
      const custom = isDefaultChatTitle(chat.title, ch.name) ? '' : chat.title;
      const msgCount = (d.messages || []).length;
      return `
        <div style="display:flex;align-items:center;gap:14px;padding:4px 0 14px">
          <img class="avatar avatar-52" src="${escapeHtml(resolveAvatarUrl(ch.avatar_url, ch.name))}" alt="" />
          <div class="row-body"><div class="row-title" style="font-size:var(--fs-lg)">${escapeHtml(ch.name || 'Персонаж')}</div><div class="row-sub">${msgCount} ${pluralRu(msgCount, 'сообщение', 'сообщения', 'сообщений')}</div></div>
        </div>
        ${can.rename() ? `<label class="field"><span class="field-label">Название чата</span><input class="input" data-role="title" value="${escapeHtml(custom)}" placeholder="${escapeHtml(ch.name || 'Без названия')}" maxlength="120" autocomplete="off" /><span class="field-hint">Помогает различать несколько историй с одним персонажем.</span></label>` : ''}
        <div class="section">
          <div class="section-title">Модель этого чата</div>
          <div class="list"><button class="row" data-act="model"><span class="row-icon">${ic(PROVIDERS[prov].icon)}</span><div class="row-body"><div class="row-title">${escapeHtml(modelName(chat.model_id))}</div><div class="row-sub">${escapeHtml(PROVIDERS[prov].label)}${effectiveEffort(chat.model_id, chat.effort, state.models) ? ' · ' + EFFORT_LABELS[effectiveEffort(chat.model_id, chat.effort, state.models)] : ''}</div></div>${ic('chevron-right', 'row-chevron')}</button></div>
          ${can.perChatModel() ? '' : '<p class="section-hint">На текущей версии APK выбор модели здесь также меняет модель по умолчанию.</p>'}
        </div>
        <div class="section">
          <div class="section-title">Вы играете за</div>
          ${state.personas.length ? `<div class="chips wrap">${state.personas.map(p => `<button class="chip${p.id === Number(chat.persona_id) ? ' active' : ''}" data-act="persona" data-id="${p.id}"><img class="avatar avatar-24" src="${escapeHtml(resolveAvatarUrl(p.avatar_url, p.name))}" alt="" />${escapeHtml(p.name)}</button>`).join('')}</div>` : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Персон пока нет. Создайте её во вкладке «Персоны».</div>'}
        </div>
        <div class="section">
          <div class="section-title">Контекст</div>
          <div class="list">
            <button class="row" data-act="memory"><span class="row-icon">${ic('book')}</span><div class="row-body"><div class="row-title">Память чата</div><div class="row-sub">Заметки для модели в &lt;chat_memory&gt;</div></div>${ic('chevron-right', 'row-chevron')}</button>
            ${can.promptPreview() ? `<button class="row" data-act="prompt"><span class="row-icon">${ic('eye')}</span><div class="row-body"><div class="row-title">Итоговый системный промпт</div><div class="row-sub">Ровно то, что получает модель</div></div>${ic('chevron-right', 'row-chevron')}</button>` : ''}
            <button class="row" data-act="diag"><span class="row-icon">${ic('activity')}</span><div class="row-body"><div class="row-title">Последняя генерация</div><div class="row-sub">Журнал, мысли, параметры запроса</div></div>${ic('chevron-right', 'row-chevron')}</button>
          </div>
        </div>
        <div class="section">
          <div class="list">
            <button class="row" data-act="export"><span class="row-icon">${ic('share')}</span><div class="row-body"><div class="row-title">Экспорт чата</div></div>${ic('chevron-right', 'row-chevron')}</button>
            ${ch.id ? `<button class="row" data-act="character"><span class="row-icon">${ic('mask')}</span><div class="row-body"><div class="row-title">Карточка персонажа</div></div>${ic('chevron-right', 'row-chevron')}</button>` : ''}
            <button class="row danger" data-act="delete"><span class="row-icon">${ic('trash')}</span><div class="row-body"><div class="row-title">Удалить чат</div></div></button>
          </div>
        </div>`;
    };

    const layer = openSheet({ title: 'Настройки чата', full: true, body: render() });
    layer.chatId = chatId;
    layer.refresh = () => {
      if (!state.room || state.room.chatId !== chatId) return;
      const focused = document.activeElement && layer.el.contains(document.activeElement);
      if (focused) return;
      const body = $('.sheet-body', layer.el);
      const scroll = body.scrollTop;
      layer.setBody(render());
      body.scrollTop = scroll;
    };
    const saveTitle = async (input) => {
      const value = input.value.trim();
      const d = state.room && state.room.data;
      if (!d) return;
      const current = isDefaultChatTitle(d.chat.title, d.character.name) ? '' : d.chat.title;
      if (value === current) return;
      try {
        await patchChat(chatId, { title: value });
        toast(value ? 'Название сохранено' : 'Название сброшено', { type: 'success' });
      } catch (e) {
        toast(e.message, { type: 'error' });
      }
    };
    layer.el.addEventListener('change', (e) => {
      if (e.target.dataset.role === 'title') saveTitle(e.target);
    });
    layer.el.addEventListener('keydown', (e) => {
      if (e.target.dataset.role === 'title' && e.key === 'Enter') e.target.blur();
    });
    bindActs(layer, {
      model: () => {
        const chat = state.room.data.chat;
        openModelPicker({
          title: 'Модель этого чата',
          modelId: chat.model_id,
          effort: chat.effort,
          onPick: async (r) => {
            try {
              await patchChat(chatId, { modelId: r.modelId, effort: r.effort });
              layer.refresh();
            } catch (e) {
              toast(e.message, { type: 'error' });
            }
          },
        });
      },
      persona: async (el) => {
        try {
          await patchChat(chatId, { personaId: Number(el.dataset.id) });
          layer.refresh();
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
      memory: () => {
        const chat = state.room.data.chat;
        openMemoryEditor(chat.memory_file_path || `memories/chat_${chatId}.md`);
      },
      prompt: () => openPromptPreview(chatId),
      diag: () => openDiagnostics(chatId),
      export: () => openExport(chatId),
      character: () => {
        const id = state.room.data.character.id;
        if (findChar(id)) openCharacterPage(id);
      },
      delete: () => deleteChat(chatId),
    });
  }

  async function openPromptPreview(chatId) {
    const layer = openSheet({ title: 'Системный промпт чата', full: true, body: '<div class="empty"><span class="spinner"></span></div>' });
    try {
      const res = await api(`/api/chats/${chatId}/system-prompt`);
      const text = res.systemPrompt || '';
      layer.setBody(text
        ? `<p class="section-hint" style="margin:0 0 10px">${formatCount(text.length)} симв. Собирается заново перед каждым ответом.</p><div class="prose mono" style="font-size:13px">${escapeHtml(text)}</div>`
        : emptyHtml('scroll', 'Промпт пуст', 'Заполните «Системный промпт» в настройках и описания персонажа и персоны.'));
      if (text) {
        const footer = htmlToElement(`<div class="sheet-footer"><button class="btn btn-secondary btn-block" data-act="copy">${ic('copy')}Скопировать</button></div>`);
        $('.sheet', layer.el).appendChild(footer);
        bindActs(layer, { copy: () => copyText(text) });
      }
    } catch (e) {
      layer.setBody(emptyHtml('alert', 'Не удалось получить промпт', escapeHtml(e.message)));
    }
  }

  // --- diagnostics ----------------------------------------------------------
  let diag = null;

  function openDiagnostics(chatId) {
    const id = Number(chatId || (state.room && state.room.chatId));
    if (!id) return;
    const layer = openSheet({
      title: 'Ход генерации',
      full: true,
      body: '<div class="empty"><span class="spinner"></span></div>',
      onClose: () => {
        diag = null;
      },
    });
    diag = { layer, chatId: id, final: null };
    const gen = state.generations[id];
    if (gen && gen.last) {
      renderDiagnostics();
    } else {
      api(`/api/chats/${id}/generation`).then(data => {
        if (!diag || diag.chatId !== id) return;
        diag.final = data.generation || data.lastGeneration || (state.lastGeneration && state.lastGeneration[id]) || null;
        renderDiagnostics();
      }).catch(() => {
        if (!diag) return;
        diag.final = (state.lastGeneration && state.lastGeneration[id]) || null;
        renderDiagnostics();
      });
    }
    ensurePolling();
  }

  function renderDiagnostics() {
    if (!diag) return;
    const gen = state.generations[diag.chatId];
    const g = (gen && gen.last) || diag.final;
    if (!g) {
      diag.layer.setBody(emptyHtml('activity', 'Пока нет данных', 'Здесь появится журнал после первой генерации в этом чате. Журнал хранится до перезапуска приложения.'));
      return;
    }
    const body = $('.sheet-body', diag.layer.el);
    const consoleEl = $('.console', body);
    const stick = !consoleEl || consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 30;
    const scroll = body.scrollTop;
    const logs = Array.isArray(g.logs) ? g.logs : [];
    const phase = PHASE_STATUS[g.phase] || g.phase || '—';
    const item = (label, value, wide) => `<div class="diag-item${wide ? ' wide' : ''}"><div class="diag-label">${label}</div><div class="diag-value">${escapeHtml(value)}</div></div>`;
    const openThoughts = $('details[data-role="thoughts"]', body);
    const openText = $('details[data-role="text"]', body);
    diag.layer.setBody(`
      <div class="diag-grid">
        ${item('Статус', g.statusText || phase, true)}
        ${item('Модель', `${modelName(g.modelId || g.model)}${g.effort ? ' · ' + String(g.effort).toUpperCase() : ''}`)}
        ${item('Фаза', phase + (g.finishReason ? ` (${g.finishReason})` : ''))}
        ${item('Время', (g.elapsedSec || ((g.elapsedMs || 0) / 1000).toFixed(1)) + ' с')}
        ${item('HTTP / чанки', `${g.httpStatus || '—'} · ${g.chunksCount || 0}`)}
        ${item('Контекст', `${g.contextMessagesCount || 0} ходов · ${formatCount(g.promptChars || 0)} симв.`, true)}
        ${g.thinkingConfigSummary ? item('Параметры', g.thinkingConfigSummary, true) : ''}
        ${g.endpoint ? item('Endpoint', g.endpoint, true) : ''}
        ${g.error ? item('Ошибка', g.error, true) : ''}
      </div>
      <div class="section"><div class="section-title">Журнал · ${logs.length}</div>
        <div class="console">${logs.map(l => {
          const line = typeof l === 'string' ? l : `[${l.t || ''}] ${l.text || l.message || ''}`;
          const cls = /❌|ошибк/i.test(line) ? 'err' : (/✅/.test(line) ? 'ok' : '');
          return `<div class="${cls}">${escapeHtml(line)}</div>`;
        }).join('') || '<div>—</div>'}</div>
      </div>
      ${g.thoughts ? `<details class="thoughts" data-role="thoughts"${openThoughts && openThoughts.open ? ' open' : ''} style="margin-top:16px"><summary>${ic('bulb')}Мысли · ${formatCount(g.thoughts.length)} симв.${ic('chevron-down', 'chev')}</summary><div class="thoughts-body">${escapeHtml(g.thoughts)}</div></details>` : ''}
      ${g.text ? `<details class="thoughts" data-role="text"${openText && openText.open ? ' open' : ''}><summary>${ic('file')}Текст ответа · ${formatCount(g.text.length)} симв.${ic('chevron-down', 'chev')}</summary><div class="thoughts-body" style="font-style:normal;color:var(--text)">${escapeHtml(g.text)}</div></details>` : ''}
    `);
    body.scrollTop = scroll;
    const newConsole = $('.console', body);
    if (newConsole && stick) newConsole.scrollTop = newConsole.scrollHeight;
  }

  // ==========================================================================
  // EXPORT
  // ==========================================================================
  async function fetchFileText(relPath) {
    if (!relPath) return '';
    try {
      const res = await api(`/api/files/content?path=${encodeURIComponent(relPath)}`);
      return typeof res.content === 'string' ? res.content : '';
    } catch (e) {
      return '';
    }
  }

  function sanitizeFilenamePart(str) {
    return String(str || 'chat').trim().replace(/[^\wЀ-ӿ-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'chat';
  }

  function buildExport(src, o) {
    const { chat, character, persona } = src.data;
    const messages = src.data.messages || [];
    const ext = o.format === 'json' ? 'json' : 'md';
    const filename = `chat_${chat.id}_${sanitizeFilenamePart(character && character.name)}.${ext}`;
    const variants = (m) => {
      const swipes = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content || ''];
      const idx = Math.min(Math.max(0, Number(m.swipe_index) || 0), swipes.length - 1);
      const thoughtSwipes = Array.isArray(m.thought_swipes) ? m.thought_swipes : [];
      return { swipes, idx, text: swipes[idx] || m.content || '', thoughts: m.thoughts || thoughtSwipes[idx] || '', thoughtSwipes };
    };

    if (o.format === 'json') {
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: state.webVersion || (state.updateInfo && state.updateInfo.currentVersion) || '',
        chat: { id: chat.id, title: chat.title, model_id: chat.model_id, model_label: modelName(chat.model_id), effort: chat.effort, created_at: chat.created_at || '' },
        character: { id: character && character.id, name: character && character.name, file_path: character && character.file_path, first_message: character && character.first_message },
        persona: { id: persona && persona.id, name: persona && persona.name, file_path: persona && persona.file_path },
      };
      if (o.prompts) {
        payload.context = src.systemPrompt !== null
          ? { systemPrompt: src.systemPrompt }
          : { systemPrompt: src.rules, characterCard: src.characterMd, personaCard: src.personaMd, chatMemory: src.memoryMd };
      }
      payload.messages = messages.map((m, i) => {
        const v = variants(m);
        const out = { index: i + 1, id: m.id, role: m.role, author: m.role === 'user' ? (persona && persona.name) : (character && character.name), created_at: m.created_at, content: v.text };
        if (o.thoughts && v.thoughts) out.thoughts = v.thoughts;
        if (o.variants && v.swipes.length > 1) {
          out.swipe_index = v.idx;
          out.swipes = v.swipes;
          if (o.thoughts && v.thoughtSwipes.length) out.thought_swipes = v.thoughtSwipes;
        }
        return out;
      });
      if (o.variants && src.generation) payload.lastGenerationDiagnostics = src.generation;
      return { filename, text: JSON.stringify(payload, null, 2), mime: 'application/json' };
    }

    const lines = [];
    const charName = (character && character.name) || 'Персонаж';
    const personaName = (persona && persona.name) || 'Игрок';
    lines.push(`# ${isDefaultChatTitle(chat.title, charName) ? charName : chat.title}`);
    lines.push('');
    lines.push(`- **Персонаж:** ${charName}`);
    lines.push(`- **Персона:** ${personaName}`);
    lines.push(`- **Модель:** ${modelSummary(chat.model_id, chat.effort)} (\`${chat.model_id}\`)`);
    lines.push(`- **Сообщений:** ${messages.length}`);
    lines.push(`- **Экспорт:** ${new Date().toLocaleString('ru-RU')}`);
    lines.push('');
    if (o.prompts) {
      lines.push('---', '', '## Контекст', '');
      const block = (title, text) => {
        if (!String(text || '').trim()) return;
        lines.push('<details>', `<summary><b>${title}</b></summary>`, '', '```markdown', String(text).trim(), '```', '</details>', '');
      };
      if (src.systemPrompt !== null) {
        block('Итоговый системный промпт', src.systemPrompt);
      } else {
        block('Системный промпт', src.rules);
        block(`Карточка персонажа: ${charName}`, src.characterMd);
        block(`Персона: ${personaName}`, src.personaMd);
        block('Память чата', src.memoryMd);
      }
    }
    lines.push('---', '', '## История', '');
    messages.forEach((m, i) => {
      const v = variants(m);
      const author = m.role === 'user' ? personaName : charName;
      lines.push(`### ${i + 1}. ${author}`);
      const meta = [m.created_at ? m.created_at + ' UTC' : '', v.swipes.length > 1 ? `вариант ${v.idx + 1}/${v.swipes.length}` : ''].filter(Boolean).join(' · ');
      if (meta) lines.push(`*${meta}*`);
      lines.push('');
      if (o.thoughts && v.thoughts.trim()) {
        lines.push('<details>', `<summary>Мысли (${v.thoughts.length} симв.)</summary>`, '', '```text', v.thoughts.trim(), '```', '</details>', '');
      }
      lines.push(v.text || '*(пусто)*', '');
      if (o.variants && v.swipes.length > 1) {
        lines.push('<details>', `<summary>Все варианты (${v.swipes.length})</summary>`, '');
        v.swipes.forEach((s, si) => lines.push(`#### Вариант ${si + 1}${si === v.idx ? ' (выбран)' : ''}`, '', s || '*(пусто)*', ''));
        lines.push('</details>', '');
      }
    });
    if (o.variants && src.generation) {
      const g = src.generation;
      lines.push('---', '', '## Последняя генерация', '');
      lines.push(`- **Статус:** ${g.status || '—'}`, `- **Модель:** ${g.modelId || chat.model_id}`, `- **Время:** ${g.elapsedSec || '—'} с`);
      if (g.error) lines.push(`- **Ошибка:** ${g.error}`);
      if (Array.isArray(g.logs) && g.logs.length) lines.push('', '```text', ...g.logs.map(l => (typeof l === 'string' ? l : JSON.stringify(l))), '```');
      lines.push('');
    }
    return { filename, text: lines.join('\n'), mime: 'text/markdown' };
  }

  async function openExport(chatId) {
    const id = Number(chatId);
    const o = { format: 'markdown', thoughts: false, prompts: false, variants: false };
    let src = null;
    let result = null;

    const toggleRow = (key, title, sub) => `<button class="row" data-act="toggle" data-key="${key}"><div class="row-body"><div class="row-title">${title}</div><div class="row-sub">${sub}</div></div><span class="switch${o[key] ? ' on' : ''}"></span></button>`;
    const render = () => {
      if (!src) return '<div class="empty"><span class="spinner"></span></div>';
      result = buildExport(src, o);
      const kb = (new Blob([result.text]).size / 1024).toFixed(1);
      return `
        <div class="segmented"><button class="${o.format === 'markdown' ? 'active' : ''}" data-act="fmt" data-fmt="markdown">Markdown</button><button class="${o.format === 'json' ? 'active' : ''}" data-act="fmt" data-fmt="json">JSON</button></div>
        <div class="section"><div class="list flush">
          ${toggleRow('thoughts', 'Мысли модели', 'Рассуждения рядом с ответами')}
          ${toggleRow('prompts', 'Контекст', 'Системный промпт, карточки и память')}
          ${toggleRow('variants', 'Все варианты и диагностика', 'Свайпы и журнал последней генерации')}
        </div></div>
        <div class="section"><div class="section-title">${escapeHtml(result.filename)} · ${kb} КБ</div>
          <textarea class="textarea mono" readonly style="min-height:30vh">${escapeHtml(result.text.slice(0, 20000))}${result.text.length > 20000 ? '\n…' : ''}</textarea>
        </div>`;
    };

    const layer = openSheet({
      title: 'Экспорт чата',
      full: true,
      body: render(),
      footer: `<div class="btn-row"><button class="btn btn-secondary" data-act="copy">${ic('copy')}Копировать</button><button class="btn btn-secondary" data-act="share">${ic('share')}Поделиться</button></div><button class="btn btn-primary btn-block" style="margin-top:10px" data-act="save">${ic('download')}Сохранить файл</button>`,
    });
    layer.chatId = id;
    const rerender = () => {
      const body = $('.sheet-body', layer.el);
      const scroll = body.scrollTop;
      layer.setBody(render());
      body.scrollTop = scroll;
    };
    bindActs(layer, {
      fmt: (el) => {
        o.format = el.dataset.fmt;
        rerender();
      },
      toggle: (el) => {
        o[el.dataset.key] = !o[el.dataset.key];
        rerender();
      },
      copy: () => result && copyText(result.text),
      share: () => {
        if (!result) return;
        if (hasBridge && typeof window.AndroidServer.shareExportText === 'function') {
          window.AndroidServer.shareExportText(result.filename, result.text);
        } else if (navigator.share) {
          navigator.share({ title: result.filename, text: result.text }).catch(() => {});
        } else {
          copyText(result.text);
        }
      },
      save: () => result && saveFile(result.filename, result.text, result.mime),
    });

    try {
      const data = state.room && state.room.chatId === id ? state.room.data : await api(`/api/chats/${id}`);
      let systemPrompt = null;
      let rules = '';
      let characterMd = '';
      let personaMd = '';
      let memoryMd = '';
      if (can.promptPreview()) {
        try {
          systemPrompt = (await api(`/api/chats/${id}/system-prompt`)).systemPrompt || '';
        } catch (e) {
          systemPrompt = null;
        }
      }
      if (systemPrompt === null) {
        [rules, characterMd, personaMd, memoryMd] = await Promise.all([
          fetchFileText('GEMINI.md'),
          fetchFileText(data.character && data.character.file_path),
          fetchFileText(data.persona && data.persona.file_path),
          fetchFileText(data.chat.memory_file_path),
        ]);
      }
      let generation = (state.lastGeneration && state.lastGeneration[id]) || null;
      if (!generation) {
        try {
          const g = await api(`/api/chats/${id}/generation`);
          generation = g.generation || g.lastGeneration || null;
        } catch (e) {
          generation = null;
        }
      }
      src = { data, systemPrompt, rules, characterMd, personaMd, memoryMd, generation };
      if (!layer.closed) rerender();
    } catch (e) {
      layer.setBody(emptyHtml('alert', 'Не удалось подготовить экспорт', escapeHtml(e.message)));
    }
  }

  // ==========================================================================
  // CHARACTERS TAB
  // ==========================================================================
  function chatsOfCharacter(charId) {
    return sortChats(state.chats.filter(c => Number(c.character_id) === Number(charId)));
  }

  function renderCharactersTab() {
    const pane = $('#tab-characters');
    if (!pane) return;
    const header = state.charsSearchOpen
      ? `<div class="appbar"><label class="search-field">${ic('search', 'ic-sm')}<input id="charsSearchInput" type="search" placeholder="Поиск персонажей" value="${escapeHtml(state.charsQuery)}" autocomplete="off" /><button class="icon-btn sm" data-action="chars-search-close" aria-label="Закрыть поиск">${ic('x', 'ic-sm')}</button></label></div>`
      : `<div class="appbar"><h1 class="appbar-title">Персонажи</h1><div class="appbar-actions">
          ${state.characters.length > 1 ? `<button class="icon-btn" data-action="chars-search-open" aria-label="Поиск">${ic('search')}</button>` : ''}
          <button class="icon-btn accent" data-action="new-character" aria-label="Новый персонаж">${ic('plus')}</button></div></div>`;
    pane.innerHTML = `<div class="tab-inner">${header}<div id="charsToolbar"></div><div id="charsList"></div></div>`;
    renderCharactersList();
    if (state.charsSearchOpen) setTimeout(() => {
      const input = $('#charsSearchInput');
      if (input) input.focus();
    }, 30);
  }

  function renderCharactersList() {
    const host = $('#charsList');
    const toolbar = $('#charsToolbar');
    if (!host || !toolbar) return;
    if (!state.loaded) {
      toolbar.innerHTML = '';
      host.innerHTML = state.loadError ? loadErrorHtml() : '<div class="char-grid">' + Array.from({ length: 4 }, () => '<div class="skeleton" style="aspect-ratio:3/4.6"></div>').join('') + '</div>';
      return;
    }
    if (!state.characters.length) {
      toolbar.innerHTML = '';
      host.innerHTML = emptyHtml('mask', 'Персонажей пока нет', 'Персонаж — это имя, портрет, описание (оно попадает в &lt;character_persona&gt;) и приветствие, с которого начинается чат.',
        `<button class="btn btn-primary" data-action="new-character">${ic('plus')}Создать персонажа</button>`);
      return;
    }
    toolbar.innerHTML = state.characters.length > 1
      ? `<div class="chips" style="margin-bottom:12px"><button class="chip sm${state.charsSort === 'name' ? ' active' : ''}" data-action="chars-sort" data-sort="name">По имени</button><button class="chip sm${state.charsSort === 'recent' ? ' active' : ''}" data-action="chars-sort" data-sort="recent">Недавние</button></div>`
      : '';
    const q = state.charsQuery.trim().toLowerCase();
    let list = state.characters.filter(c => !q || c.name.toLowerCase().includes(q) || String(c.description_preview || '').toLowerCase().includes(q));
    if (state.charsSort === 'recent') {
      const lastOf = (c) => {
        const t = chatActivityTime(chatsOfCharacter(c.id)[0]);
        return t ? t.getTime() : 0;
      };
      list = list.slice().sort((a, b) => lastOf(b) - lastOf(a) || a.name.localeCompare(b.name, 'ru'));
    } else {
      list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }
    host.innerHTML = list.length
      ? `<div class="char-grid">${list.map(c => {
        const n = chatsOfCharacter(c.id).length;
        const desc = stripMarkdownPreview(c.description_preview || c.fileContent || '') || 'Без описания';
        return `<div class="char-card" role="button" tabindex="0" data-action="open-character" data-id="${c.id}">
          <div class="char-portrait"><img src="${escapeHtml(resolveAvatarUrl(c.avatar_url, c.name))}" alt="" /><div class="char-portrait-name">${escapeHtml(c.name)}</div></div>
          <div class="char-card-body"><div class="char-card-desc">${escapeHtml(desc)}</div><div class="char-card-meta">${ic('chat')}${n ? `${n} ${pluralRu(n, 'чат', 'чата', 'чатов')}` : 'Нет чатов'}</div></div>
        </div>`;
      }).join('')}</div>`
      : emptyHtml('search', 'Ничего не найдено', '');
  }

  function openCharacterPage(charId) {
    const id = Number(charId);
    if (!findChar(id)) return;
    let showFullDesc = false;
    let showFullGreeting = false;

    const render = () => {
      const c = findChar(id);
      if (!c) return emptyHtml('mask', 'Персонаж удалён', '');
      const chats = chatsOfCharacter(id);
      const desc = String(c.fileContent || c.description_preview || '').trim();
      const greeting = String(c.first_message || '').trim();
      return `
        <div class="hero" data-act="view"><img src="${escapeHtml(resolveAvatarUrl(c.avatar_url, c.name))}" alt="" /></div>
        <h1 class="hero-name">${escapeHtml(c.name)}</h1>
        <div class="hero-meta">${chats.length ? `${chats.length} ${pluralRu(chats.length, 'чат', 'чата', 'чатов')}` : 'Ещё нет чатов'}</div>
        <div class="section">
          <div class="section-title">Приветствие</div>
          ${greeting
            ? `<div class="card card-pad"><div class="prose msg-text${!showFullGreeting && greeting.length > 360 ? ' clamp' : ''}">${formatRoleplayHtml(greeting, { dialogue: prefs.dialogue })}</div>${greeting.length > 360 ? `<button class="btn btn-ghost btn-sm" style="margin-top:6px;padding:0" data-act="more-greeting">${showFullGreeting ? 'Свернуть' : 'Показать полностью'}</button>` : ''}</div>`
            : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Нет приветствия — первым пишет игрок.</div>'}
        </div>
        <div class="section">
          <div class="section-title">Описание · попадает в &lt;character_persona&gt;</div>
          ${desc
            ? `<div class="card card-pad"><div class="prose${!showFullDesc && desc.length > 420 ? ' clamp' : ''}">${escapeHtml(desc)}</div>${desc.length > 420 ? `<button class="btn btn-ghost btn-sm" style="margin-top:6px;padding:0" data-act="more-desc">${showFullDesc ? 'Свернуть' : 'Показать полностью'}</button>` : ''}</div>`
            : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Описание не заполнено — модель почти ничего не знает о персонаже.</div>'}
        </div>
        ${chats.length ? `<div class="section"><div class="section-title">Чаты</div><div class="list">${chats.map(ch => `<button class="row" data-act="chat" data-id="${ch.id}"><span class="row-icon">${ic('chat')}</span><div class="row-body"><div class="row-title">${escapeHtml(isDefaultChatTitle(ch.title, c.name) ? (ch.persona_name || 'Чат') : ch.title)}</div><div class="row-sub">${escapeHtml(stripMarkdownPreview(ch.last_message) || 'Без сообщений')}</div></div><span class="row-value">${escapeHtml(formatRelativeTime(chatActivityTime(ch)))}</span></button>`).join('')}</div></div>` : ''}
      `;
    };

    const c0 = findChar(id);
    const layer = openPage({
      title: c0.name,
      body: render(),
      actions: `<button class="icon-btn" data-act="edit" aria-label="Изменить">${ic('edit')}</button>`,
      footer: `<button class="btn btn-primary btn-block" data-act="start">${ic('chat-plus')}Начать новый чат</button>`,
    });
    layer.cardId = id;
    layer.cardKind = 'character';
    layer.refresh = () => {
      const c = findChar(id);
      if (c) layer.setTitle(escapeHtml(c.name));
      const body = $('.page-body', layer.el);
      const scroll = body.scrollTop;
      layer.setBody(render());
      body.scrollTop = scroll;
    };
    bindActs(layer, {
      view: () => {
        const c = findChar(id);
        if (c) openImageViewer(resolveAvatarUrl(c.avatar_url, c.name), c.name);
      },
      edit: () => openCharacterEditor(id),
      start: () => openNewChat(id),
      chat: (el) => {
        layer.close();
        closeLayersAbove(null);
        openChatRoom(Number(el.dataset.id));
      },
      'more-desc': () => {
        showFullDesc = !showFullDesc;
        layer.refresh();
      },
      'more-greeting': () => {
        showFullGreeting = !showFullGreeting;
        layer.refresh();
      },
    });
  }

  function closeLayersAbove(layer) {
    while (layerStack.length && topLayer() !== layer) closeLayer(topLayer(), { immediate: true });
  }

  // --- card editor (characters & personas) ----------------------------------
  function downscaleImage(file, maxSide) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
      reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          if (scale === 1 && file.size < 300 * 1024) {
            resolve(dataUrl);
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.84));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Shared editor for characters (kind='character') and personas (kind='persona').
   * The description is saved verbatim as the card file (rawFileContent) — that
   * exact text is what the model receives inside <character_persona>/<user_persona>.
   */
  function openCardEditor(kind, id) {
    const isChar = kind === 'character';
    const item = id ? (isChar ? findChar(id) : findPersona(id)) : null;
    const init = {
      name: item ? item.name : '',
      description: item ? String(item.fileContent ?? item.description_preview ?? '') : '',
      greeting: item && isChar ? (item.first_message || '') : '',
      avatarUrl: item ? (item.avatar_url || '') : '',
      filePath: item ? (item.file_path || '') : '',
    };
    const cur = Object.assign({}, init);
    let saving = false;
    const dirty = () => Object.keys(init).some(k => init[k] !== cur[k]);
    const noun = isChar ? 'персонажа' : 'персону';
    const tag = isChar ? '&lt;character_persona&gt;' : '&lt;user_persona&gt;';
    const chatsCount = item && isChar ? chatsOfCharacter(item.id).length : 0;

    const body = `
      <div class="avatar-picker">
        <button class="avatar-picker-btn${isChar ? '' : ' round'}" data-act="avatar" aria-label="Изменить изображение">
          <img data-role="avatar" src="${escapeHtml(resolveAvatarUrl(cur.avatarUrl, cur.name))}" alt="" />
          <span class="avatar-picker-badge">${ic('camera')}</span>
        </button>
        <input type="file" accept="image/*" class="hidden" data-role="file" />
      </div>
      <label class="field"><span class="field-label">Имя</span>
        <input class="input" data-field="name" value="${escapeHtml(cur.name)}" placeholder="${isChar ? 'Например, Кира' : 'Как вас зовут в истории'}" maxlength="80" autocomplete="off" /></label>
      <label class="field"><span class="field-label">${isChar ? 'Описание персонажа' : 'Описание персоны'}</span>
        <textarea class="textarea" data-field="description" placeholder="${isChar ? 'Кто это: внешность, характер, манера речи, прошлое, отношения с {{user}}…' : 'Кто вы: внешность, характер, навыки, цели…'}">${escapeHtml(cur.description)}</textarea>
        <span class="field-hint">Текст целиком попадает в системный промпт внутри ${tag}. Макросы {{char}} и {{user}} подставляются.</span></label>
      ${isChar ? `<label class="field"><span class="field-label">Приветствие</span>
        <textarea class="textarea" data-field="greeting" placeholder="Первое сообщение персонажа в новом чате. Можно оставить пустым.">${escapeHtml(cur.greeting)}</textarea>
        <div class="macro-chips"><button class="chip sm" data-act="macro" data-macro="{{char}}">{{char}}</button><button class="chip sm" data-act="macro" data-macro="{{user}}">{{user}}</button></div></label>` : ''}
      ${item ? `<div class="danger-zone"><button class="btn btn-danger btn-block" data-act="delete">${ic('trash')}Удалить ${noun}</button>
        ${chatsCount ? `<p class="section-hint">${chatsCount} ${pluralRu(chatsCount, 'чат останется', 'чата останутся', 'чатов останутся')} без карточки персонажа.</p>` : ''}</div>` : ''}`;

    const title = item ? (isChar ? 'Изменить персонажа' : 'Изменить персону') : (isChar ? 'Новый персонаж' : 'Новая персона');
    const layer = openPage({
      title,
      backIcon: 'x',
      body,
      actions: `<button class="btn btn-ghost" data-act="save">Сохранить</button>`,
      onBack: () => {
        if (!dirty() || saving) return true;
        confirmDialog({ title: 'Выйти без сохранения?', message: 'Изменения будут потеряны.', confirmText: 'Выйти', cancelText: 'Остаться', danger: true })
          .then(ok => ok && layer.close());
        return false;
      },
    });

    const updateTitle = () => layer.setTitle(escapeHtml(title) + (dirty() ? '<span class="dirty-dot" title="Есть несохранённые изменения"></span>' : ''));
    const updateAvatar = () => {
      $('[data-role="avatar"]', layer.el).src = resolveAvatarUrl(cur.avatarUrl, cur.name);
    };
    $$('textarea', layer.el).forEach(t => autoGrow(t));
    layer.el.addEventListener('input', (e) => {
      const f = e.target.dataset.field;
      if (!f) return;
      cur[f] = e.target.value;
      if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
      if (f === 'name' && !cur.avatarUrl) updateAvatar();
      updateTitle();
    });
    const fileInput = $('[data-role="file"]', layer.el);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const dataUrl = await downscaleImage(file, 640);
        const res = await api('/api/upload-avatar', { method: 'POST', body: { base64Data: dataUrl, filename: file.name } });
        cur.avatarUrl = res.avatarUrl || dataUrl;
        updateAvatar();
        updateTitle();
      } catch (e) {
        toast('Не удалось загрузить изображение: ' + e.message, { type: 'error' });
      }
    });

    bindActs(layer, {
      avatar: () => actionSheet({
        title: 'Изображение',
        items: [
          { icon: 'image', label: 'Выбрать с устройства', onSelect: () => fileInput.click() },
          { icon: 'eye', label: 'Посмотреть', hidden: !cur.avatarUrl, onSelect: () => openImageViewer(resolveAvatarUrl(cur.avatarUrl, cur.name), cur.name) },
          {
            icon: 'trash',
            label: 'Заменить на инициалы',
            hidden: !cur.avatarUrl,
            danger: true,
            onSelect: () => {
              cur.avatarUrl = '';
              updateAvatar();
              updateTitle();
            },
          },
        ],
      }),
      macro: (el) => {
        const ta = $('[data-field="greeting"]', layer.el);
        const s = ta.selectionStart || ta.value.length;
        const e2 = ta.selectionEnd || s;
        ta.value = ta.value.slice(0, s) + el.dataset.macro + ta.value.slice(e2);
        ta.focus();
        ta.setSelectionRange(s + el.dataset.macro.length, s + el.dataset.macro.length);
        cur.greeting = ta.value;
        autoGrow(ta);
        updateTitle();
      },
      save: async (btn) => {
        if (saving) return;
        const name = cur.name.trim();
        if (!name) {
          toast(isChar ? 'Введите имя персонажа' : 'Введите имя персоны');
          $('[data-field="name"]', layer.el).focus();
          return;
        }
        saving = true;
        btn.disabled = true;
        const payload = {
          name,
          filePath: cur.filePath.trim(),
          avatarUrl: cur.avatarUrl,
          description: cur.description,
          rawFileContent: cur.description,
        };
        if (isChar) payload.firstMessage = cur.greeting;
        try {
          const base = isChar ? '/api/characters' : '/api/personas';
          await api(item ? `${base}/${item.id}` : base, { method: item ? 'PUT' : 'POST', body: payload });
          await loadCards();
          loadChats();
          if (state.room) {
            try {
              state.room.data = await api(`/api/chats/${state.room.chatId}`);
              renderRoomHeader();
              syncFeed({ scroll: 'keep' });
            } catch (e) {
              // room refresh is best-effort
            }
          }
          layer.close();
          toast(isChar ? 'Персонаж сохранён' : 'Персона сохранена', { type: 'success' });
        } catch (e) {
          saving = false;
          btn.disabled = false;
          toast(e.message, { type: 'error' });
        }
      },
      delete: async () => {
        const ok = await confirmDialog({
          title: isChar ? `Удалить «${item.name}»?` : `Удалить персону «${item.name}»?`,
          message: isChar && chatsCount
            ? `Карточка и её файл будут удалены. ${chatsCount} ${pluralRu(chatsCount, 'чат останется', 'чата останутся', 'чатов останутся')} без персонажа.`
            : 'Карточка и её файл будут удалены.',
          confirmText: 'Удалить',
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`${isChar ? '/api/characters' : '/api/personas'}/${item.id}?deleteFile=1`, { method: 'DELETE' });
          saving = true;
          layer.close();
          // close the character page that opened this editor
          $$('.modal-overlay').forEach(el => {
            if (el._layer && el._layer.cardId === item.id && el._layer.cardKind === kind) el._layer.close();
          });
          await loadCards();
          loadChats();
          toast(isChar ? 'Персонаж удалён' : 'Персона удалена');
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
    });
    return layer;
  }

  function openCharacterEditor(id) {
    return openCardEditor('character', id ? Number(id) : null);
  }

  function openPersonaEditor(id) {
    return openCardEditor('persona', id ? Number(id) : null);
  }

  // ==========================================================================
  // PERSONAS TAB
  // ==========================================================================
  function renderPersonasTab() {
    const pane = $('#tab-personas');
    if (!pane) return;
    let body;
    if (!state.loaded) {
      body = state.loadError ? loadErrorHtml() : skeletonList(3);
    } else if (!state.personas.length) {
      body = emptyHtml('user', 'Создайте свою персону', 'Персона — это вы в истории. Её описание попадает в системный промпт внутри &lt;user_persona&gt;, а имя подставляется вместо {{user}}.',
        `<button class="btn btn-primary" data-action="new-persona">${ic('plus')}Создать персону</button>`);
    } else {
      const active = state.settings.activePersonaId;
      body = `<p class="section-hint" style="margin:0 4px 12px">Отмеченная персона выбирается по умолчанию в новых чатах. В открытом чате персону можно сменить в его настройках.</p>
        <div class="list">${state.personas.map(p => `<div class="row pressable" role="button" tabindex="0" data-action="open-persona" data-id="${p.id}">
            <img class="avatar avatar-48" src="${escapeHtml(resolveAvatarUrl(p.avatar_url, p.name))}" alt="" />
            <div class="row-body"><div class="row-title">${escapeHtml(p.name)}${p.id === active ? ' <span class="pill accent" style="margin-left:6px">По умолчанию</span>' : ''}</div>
              <div class="row-sub wrap">${escapeHtml(stripMarkdownPreview(p.description_preview || p.fileContent) || 'Без описания')}</div></div>
            <button class="icon-btn sm" data-action="activate-persona" data-id="${p.id}" aria-label="Сделать персоной по умолчанию"><span class="radio${p.id === active ? ' on' : ''}"></span></button>
          </div>`).join('')}</div>`;
    }
    pane.innerHTML = `<div class="tab-inner"><div class="appbar"><h1 class="appbar-title">Персоны</h1><div class="appbar-actions"><button class="icon-btn accent" data-action="new-persona" aria-label="Новая персона">${ic('plus')}</button></div></div>${body}</div>`;
  }

  async function activatePersona(id) {
    if (state.settings.activePersonaId === id) return;
    try {
      await api(`/api/personas/${id}/activate`, { method: 'POST' });
      state.settings.activePersonaId = id;
      renderPersonasTab();
      const p = findPersona(id);
      toast(`По умолчанию: ${p ? p.name : 'персона'}`);
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  }

  // ==========================================================================
  // SETTINGS TAB
  // ==========================================================================
  async function loadSystemPromptText() {
    try {
      const res = await api('/api/files/content?path=GEMINI.md');
      state.systemPromptText = typeof res.content === 'string' ? res.content : '';
    } catch (e) {
      state.systemPromptText = '';
    }
    if (state.tab === 'settings') renderSettingsTab();
  }

  function normalizedPromptText(text) {
    const t = String(text || '');
    return t.trim() === '# GEMINI.md' ? '' : t;
  }

  function settingsRow(o) {
    return `<button class="row" data-action="settings-open" data-page="${o.page}">
      <span class="row-icon">${ic(o.icon)}</span>
      <div class="row-body"><div class="row-title">${o.title}</div>${o.sub ? `<div class="row-sub">${o.sub}</div>` : ''}</div>
      ${o.value || ''}${ic('chevron-right', 'row-chevron')}
    </button>`;
  }

  function renderSettingsTab() {
    const pane = $('#tab-settings');
    if (!pane) return;
    if (state.systemPromptText === null && state.loaded) {
      state.systemPromptText = '';
      loadSystemPromptText();
    }
    const s = state.settings;
    const promptText = normalizedPromptText(state.systemPromptText).trim();
    const promptSub = promptText ? escapeHtml(stripMarkdownPreview(promptText).slice(0, 80)) : 'Не задан — модель получит только карточки';
    const vertex = providerStatus('gemini');
    const cli = providerStatus('cli');
    const upd = state.updateInfo;
    const updAvailable = upd && (upd.updateAvailable || upd.nativeUpdateRequired);
    const pill = (st) => `<span class="pill ${st.ok ? 'ok' : 'warn'}">${st.ok ? 'Готово' : 'Настроить'}</span>`;
    pane.innerHTML = `<div class="tab-inner">
      <div class="appbar"><h1 class="appbar-title">Настройки</h1></div>
      <div class="section"><div class="section-title">ИИ</div><div class="list">
        ${settingsRow({ page: 'prompt', icon: 'scroll', title: 'Системный промпт', sub: promptSub })}
        ${settingsRow({ page: 'model', icon: 'cpu', title: 'Модель по умолчанию', sub: escapeHtml(modelSummary(s.selectedModel, s.selectedEffort)) + ' · для новых чатов' })}
      </div></div>
      <div class="section"><div class="section-title">Провайдеры</div><div class="list">
        ${settingsRow({ page: 'vertex', icon: 'cloud', title: 'Google Vertex', sub: s.agyAuthenticated ? escapeHtml(s.agyEmail || 'Gemini и Claude через Google') : escapeHtml(vertex.text), value: pill(vertex) })}
        ${settingsRow({ page: 'claude', icon: 'terminal', title: 'Claude Code CLI', sub: cli.ok ? 'На устройстве, по подписке' : escapeHtml(cli.text), value: pill(cli) })}
      </div></div>
      <div class="section"><div class="section-title">Интерфейс</div><div class="list">
        ${settingsRow({ page: 'appearance', icon: 'palette', title: 'Оформление', value: `<span class="row-value">${escapeHtml(THEMES[prefs.theme] ? THEMES[prefs.theme].label : 'Тёмная')}</span>` })}
        ${settingsRow({ page: 'reading', icon: 'type', title: 'Чтение', value: `<span class="row-value">${prefs.fontSize} px${prefs.serif ? ' · с засечками' : ''}</span>` })}
      </div></div>
      <div class="section"><div class="section-title">Данные</div><div class="list">
        ${settingsRow({ page: 'backup', icon: 'database', title: 'Резервная копия', sub: 'Сохранить или восстановить все данные' })}
      </div></div>
      <div class="section"><div class="section-title">Приложение</div><div class="list">
        ${settingsRow({ page: 'updates', icon: 'update', title: 'Обновления', sub: upd ? `Установлена v${escapeHtml(upd.currentVersion || state.webVersion)}` : (state.webVersion ? `v${escapeHtml(state.webVersion)}` : ''), value: updAvailable ? '<span class="pill accent">Доступно</span>' : '' })}
      </div></div>
      <p class="section-hint" style="text-align:center;margin-top:24px">AGY Roleplay Studio${state.webVersion ? ' v' + escapeHtml(state.webVersion) : ''} · движок build ${state.engineBuild}</p>
    </div>`;
  }

  function openSettingsPage(page) {
    if (page === 'prompt') openSystemPromptPage();
    else if (page === 'model') openDefaultModelPicker();
    else if (page === 'vertex') openVertexPage();
    else if (page === 'claude') openClaudePage();
    else if (page === 'appearance') openAppearancePage();
    else if (page === 'reading') openReadingPage();
    else if (page === 'backup') openBackupPage();
    else if (page === 'updates') openUpdatesPage();
  }

  function openProviderSettings(provider) {
    if (provider === 'cli') openClaudePage();
    else openVertexPage();
  }

  function openDefaultModelPicker() {
    openModelPicker({
      title: 'Модель по умолчанию',
      modelId: state.settings.selectedModel,
      effort: state.settings.selectedEffort,
      onPick: async (r) => {
        if (!can.perChatModel()) {
          const ok = await confirmDialog({
            title: 'Сменить модель везде?',
            message: 'На текущей версии APK модель по умолчанию также применяется ко всем существующим чатам. Обновите APK, чтобы чаты сохраняли свою модель.',
            confirmText: 'Сменить',
          });
          if (!ok) return;
        }
        try {
          applySettings(await api('/api/settings', { method: 'POST', body: { selectedModel: r.modelId, selectedEffort: r.effort } }));
          renderSettingsTab();
          if (!can.perChatModel()) loadChats();
          toast('Модель по умолчанию: ' + modelSummary(r.modelId, r.effort), { type: 'success' });
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  // --- system prompt --------------------------------------------------------
  async function openSystemPromptPage() {
    let initial = '';
    try {
      initial = normalizedPromptText((await api('/api/files/content?path=GEMINI.md')).content || '');
    } catch (e) {
      initial = normalizedPromptText(state.systemPromptText || '');
    }
    let saving = false;
    const layer = openPage({
      title: 'Системный промпт',
      body: `
        <details class="card card-pad disclosure" style="margin-bottom:16px"${initial.trim() ? '' : ' open'}>
          <summary style="padding:0;min-height:0;line-height:1.5">Ваш текст — это весь системный промпт для Gemini и Claude. Что добавляется ниже? ${ic('chevron-down', 'ic-sm')}</summary>
          <div style="font-size:var(--fs-sm);line-height:1.55;color:var(--text-2);margin-top:10px">Встроенных скрытых инструкций нет. Под вашим текстом автоматически идут:</div>
          <pre class="prompt-schema" style="margin-top:10px">ваш текст
<b>&lt;character_persona&gt;</b>
  описание персонажа чата
<b>&lt;/character_persona&gt;</b>
<b>&lt;user_persona&gt;</b>
  описание вашей персоны
<b>&lt;/user_persona&gt;</b>
<b>&lt;chat_memory&gt;</b> — если память чата заполнена</pre>
        </details>
        <textarea class="textarea tall" data-role="text" placeholder="Например: Ты — ведущий ролевой игры. Пиши от третьего лица, живо и образно. Отвечай только за {{char}}, никогда не пиши действия и реплики {{user}}…">${escapeHtml(initial)}</textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <div class="macro-chips" style="margin:0"><button class="chip sm" data-act="macro" data-macro="{{char}}">{{char}}</button><button class="chip sm" data-act="macro" data-macro="{{user}}">{{user}}</button></div>
          <span class="char-count" data-role="count" style="margin-left:auto"></span>
        </div>
        <p class="section-hint">{{char}} — имя персонажа чата, {{user}} — имя вашей персоны.</p>`,
      actions: `<button class="btn btn-ghost" data-act="save">Сохранить</button>`,
      onBack: () => {
        if (saving || $('[data-role="text"]', layer.el).value === initial) return true;
        confirmDialog({ title: 'Выйти без сохранения?', confirmText: 'Выйти', cancelText: 'Остаться', danger: true }).then(ok => ok && layer.close());
        return false;
      },
    });
    const ta = $('[data-role="text"]', layer.el);
    const count = () => {
      $('[data-role="count"]', layer.el).textContent = formatCount(ta.value.length) + ' симв.';
      layer.setTitle('Системный промпт' + (ta.value !== initial ? '<span class="dirty-dot"></span>' : ''));
    };
    count();
    ta.addEventListener('input', count);
    bindActs(layer, {
      macro: (el) => {
        const s = ta.selectionStart || ta.value.length;
        const e = ta.selectionEnd || s;
        ta.value = ta.value.slice(0, s) + el.dataset.macro + ta.value.slice(e);
        ta.focus();
        ta.setSelectionRange(s + el.dataset.macro.length, s + el.dataset.macro.length);
        count();
      },
      save: async (btn) => {
        btn.disabled = true;
        try {
          await api('/api/files/file', { method: 'POST', body: { filePath: 'GEMINI.md', content: ta.value } });
          initial = ta.value;
          state.systemPromptText = ta.value;
          saving = true;
          layer.close();
          renderSettingsTab();
          toast('Системный промпт сохранён', { type: 'success' });
        } catch (e) {
          btn.disabled = false;
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  // --- Google Vertex --------------------------------------------------------
  const SAFETY_OPTIONS = [
    { value: 'OFF', title: 'Без фильтров + авто-обход', sub: 'Фильтры отключены. Если ответ заблокирован, до 4 повторов на той же модели.' },
    { value: 'NSFW_BYPASS', title: 'Обходной режим сразу', sub: 'Как предыдущий, но уже первая попытка идёт в обходном режиме.' },
    { value: 'BLOCK_NONE', title: 'Разрешить все категории + авто-обход', sub: 'Порог BLOCK_NONE для всех категорий и повторы при блокировке.' },
    { value: 'BLOCK_ONLY_HIGH', title: 'Стандартный фильтр Google', sub: 'Блокируется только высокий риск. Одна попытка, без обхода.' },
  ];

  function openVertexPage() {
    let pollAuth = null;
    const render = () => {
      const s = state.settings;
      return `
        <div class="card status-card">
          <span class="status-card-icon ${s.agyAuthenticated ? 'ok' : 'warn'}">${ic(s.agyAuthenticated ? 'check-circle' : 'alert')}</span>
          <div class="row-body"><div class="status-card-title">${s.agyAuthenticated ? 'Подключено' : 'Вход не выполнен'}</div>
            <div class="status-card-sub">${s.agyAuthenticated ? escapeHtml(s.agyEmail || 'Аккаунт Google') : 'Войдите через аккаунт Google — API-ключ не нужен.'}</div></div>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn ${s.agyAuthenticated ? 'btn-secondary' : 'btn-primary'}" data-act="login">${ic('login')}${s.agyAuthenticated ? 'Переподключить' : 'Войти через Google'}</button>
          ${s.agyAuthenticated ? `<button class="btn btn-danger" data-act="logout">${ic('logout')}Выйти</button>` : ''}
        </div>
        <details class="disclosure section"><summary>Браузер не вернул в приложение? ${ic('chevron-down', 'ic-sm')}</summary>
          <label class="field"><span class="field-label">Ссылка из адресной строки или код</span>
            <input class="input" data-role="code" placeholder="http://localhost:51121/oauth-callback?code=…" autocomplete="off" /></label>
          <button class="btn btn-secondary btn-block" style="margin-top:10px" data-act="exchange">Подтвердить</button>
        </details>
        <div class="section"><label class="field"><span class="field-label">Project ID</span>
          <input class="input mono" data-role="project" value="${escapeHtml(s.projectId)}" placeholder="project-…" autocomplete="off" />
          <span class="field-hint">Сохраняется автоматически. Обычно определяется при входе.</span></label></div>
        <div class="section"><div class="section-title">Фильтр безопасности (Gemini)</div><div class="list">
          ${SAFETY_OPTIONS.map(o => `<button class="row" data-act="safety" data-value="${o.value}"><span class="radio${s.safetyThreshold === o.value ? ' on' : ''}"></span><div class="row-body"><div class="row-title">${escapeHtml(o.title)}</div><div class="row-sub wrap">${escapeHtml(o.sub)}</div></div></button>`).join('')}
        </div></div>`;
    };
    const layer = openPage({
      title: 'Google Vertex',
      body: render(),
      onClose: () => clearInterval(pollAuth),
    });
    layer.refresh = () => {
      if (document.activeElement && layer.el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      const body = $('.page-body', layer.el);
      const scroll = body.scrollTop;
      layer.setBody(render());
      body.scrollTop = scroll;
    };
    layer.el.addEventListener('change', async (e) => {
      if (e.target.dataset.role !== 'project') return;
      const projectId = e.target.value.trim();
      if (!projectId || projectId === state.settings.projectId) return;
      try {
        applySettings(await api('/api/settings', { method: 'POST', body: { projectId } }));
        toast('Project ID сохранён', { type: 'success' });
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    });
    bindActs(layer, {
      login: async () => {
        try {
          const res = await api('/api/agy/auth/start', { method: 'POST' });
          if (res.authUrl && !hasBridge) window.open(res.authUrl, '_blank');
          toast('Завершите вход в браузере');
          let checks = 0;
          clearInterval(pollAuth);
          pollAuth = setInterval(async () => {
            checks++;
            await refreshAgyStatus();
            if (state.settings.agyAuthenticated || checks > 90) clearInterval(pollAuth);
          }, 2000);
        } catch (e) {
          toast('Не удалось начать вход: ' + e.message, { type: 'error' });
        }
      },
      logout: async () => {
        const ok = await confirmDialog({ title: 'Выйти из Google?', message: 'Gemini и Claude через Vertex перестанут отвечать до повторного входа.', confirmText: 'Выйти', danger: true });
        if (!ok) return;
        try {
          await api('/api/agy/auth/logout', { method: 'POST' });
          state.settings.agyAuthenticated = false;
          layer.refresh();
          renderSettingsTab();
          renderRoomHeader();
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
      exchange: async () => {
        const input = $('[data-role="code"]', layer.el);
        const codeOrUrl = input.value.trim();
        if (!codeOrUrl) {
          toast('Вставьте ссылку или код');
          return;
        }
        try {
          const res = await api('/api/agy/auth/exchange', { method: 'POST', body: { codeOrUrl } });
          state.settings.agyAuthenticated = Boolean(res.authenticated);
          state.settings.agyEmail = res.email || state.settings.agyEmail;
          if (res.projectId) state.settings.projectId = res.projectId;
          input.blur();
          layer.refresh();
          renderSettingsTab();
          renderRoomHeader();
          toast('Вход выполнен', { type: 'success' });
        } catch (e) {
          toast('Ошибка авторизации: ' + e.message, { type: 'error' });
        }
      },
      safety: async (el) => {
        const value = el.dataset.value;
        if (value === state.settings.safetyThreshold) return;
        try {
          applySettings(await api('/api/settings', { method: 'POST', body: { safetyThreshold: value } }));
          layer.refresh();
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  // --- Claude Code CLI ------------------------------------------------------
  function openClaudePage() {
    let installing = false;
    let progressTimer = null;
    let loginTimer = null;
    // Sign-in flow: idle -> waiting (CLI running; link shown when ready) -> done / error
    const login = { phase: 'idle', legacyUrl: '', error: '', submitting: false, codeDraft: '' };
    let selftestTimer = null;
    // The check also runs on when the page was closed and reopened meanwhile.
    const selftestRunning = () => Boolean((state.claudeSelftest && state.claudeSelftest.running) || state.settings.claudeSelftestRunning);

    const outputBlock = (text) => `<div class="console" style="margin-top:10px;max-height:28vh">${escapeHtml(text)}</div>`;

    const loginBody = (s) => {
      if (s.claudeAuthenticated) {
        return `<div class="step-text">Вход выполнен. Модели Claude Code готовы к работе.</div>
          <div class="btn-row"><button class="btn btn-secondary btn-sm" data-act="login">${ic('login')}Войти заново</button><button class="btn btn-danger btn-sm" data-act="logout">${ic('logout')}Выйти</button></div>`;
      }
      if (!s.claudeRuntimeReady) {
        return '<div class="step-text">Станет доступно после установки среды.</div>';
      }
      if (!can.claudeLogin()) {
        return '<div class="step-text">Для входа обновите приложение (APK) до версии 1.6.2 или новее.</div>';
      }
      if (login.phase === 'starting') {
        return `<div class="install-progress"><span class="spinner"></span><span>Запускаю Claude Code…</span></div>`;
      }
      if (login.phase === 'waiting') {
        const url = s.claudeLoginUrl || login.legacyUrl;
        const autoUrl = s.claudeLoginAutoUrl;
        const live = [s.claudeLoginOutput, s.claudeLoginDebug ? '--- debug ---\n' + s.claudeLoginDebug : ''].filter(Boolean).join('\n');
        const cancel = '<button class="btn btn-ghost btn-sm" style="margin-top:10px;padding:0" data-act="cancel-login">Отменить вход</button>';
        if (!url && !autoUrl) {
          const slow = s.claudeLoginElapsed >= 30;
          const limit = s.claudeLoginTimeout;
          const hint = limit
            ? `Дольше обычного. Если ссылка не появится за ${limit} с, вход остановится и покажет, на чём завис Claude Code.`
            : 'Дольше обычного. Ниже — что сейчас делает Claude Code; если так и не появится ссылка, скопируйте этот текст и пришлите.';
          return `<div class="install-progress"><span class="spinner"></span><span>Claude Code готовит ссылку для входа… ${s.claudeLoginElapsed}${limit ? ' из ' + limit : ''} с</span></div>
            ${slow ? `<p class="section-hint" style="margin:8px 0 0">${hint}</p>` : ''}
            ${live ? `<details class="disclosure"${slow ? ' open' : ''}><summary>Что происходит ${ic('chevron-down', 'ic-sm')}</summary>${outputBlock(live)}<button class="btn btn-ghost btn-sm" style="padding:0;margin-top:6px" data-act="copy-live">${ic('copy', 'ic-sm')}Скопировать</button></details>` : ''}
            ${cancel}`;
        }
        const link = url || autoUrl;
        return `<div class="step-text"><b>1.</b> Откройте ссылку и войдите в аккаунт Claude с подпиской.</div>
          <div class="link-box">${escapeHtml(link)}</div>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-primary btn-sm" data-act="open-link">${ic('external', 'ic-sm')}Открыть</button>
            <button class="btn btn-secondary btn-sm" data-act="copy-link">${ic('copy', 'ic-sm')}Скопировать</button>
          </div>
          ${url ? `<div class="step-text" style="margin-top:14px"><b>2.</b> После входа страница покажет код — вставьте его сюда целиком:</div>
            <input class="input mono" data-role="code" value="${escapeHtml(login.codeDraft)}" placeholder="xxxxxxxx#yyyyyyyy" autocomplete="off" autocapitalize="off" spellcheck="false" />
            <button class="btn btn-secondary btn-sm" style="margin-top:10px" data-act="exchange"${login.submitting ? ' disabled' : ''}>${login.submitting ? '<span class="spinner"></span>Проверяю…' : 'Подтвердить код'}</button>` : '<div class="step-text" style="margin-top:12px">После входа браузер сам вернёт подтверждение в приложение.</div>'}
          ${url && autoUrl ? '<p class="section-hint" style="margin:12px 0 0">Можно и без кода: <button class="link" data-act="open-auto">войти с автоматическим возвратом</button> — браузер сам передаст вход в приложение.</p>' : ''}
          <div class="install-progress" style="margin-top:14px"><span class="spinner"></span><span>Жду завершения входа…</span></div>
          ${cancel}`;
      }
      const errorCard = login.error ? `<div class="error-card" style="margin:0 0 12px">
          <div class="error-head">${ic('alert')}<div>Вход не удался. Подробности ниже — если ошибка повторяется, пришлите этот текст.</div></div>
          ${outputBlock(login.error)}
          <button class="btn btn-ghost btn-sm" style="padding:0;margin-top:6px" data-act="copy-error">${ic('copy', 'ic-sm')}Скопировать</button>
        </div>` : '';
      return `<div class="step-text">Приложение покажет ссылку: откройте её и войдите в аккаунт Claude с подпиской Pro, Max, Team или Enterprise.</div>
        ${errorCard}
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" data-act="login"${selftestRunning() ? ' disabled' : ''}>${ic('login')}${login.error ? 'Попробовать снова' : 'Войти'}</button>
          ${login.error && can.claudeLogin() ? `<button class="btn btn-secondary btn-sm" data-act="selftest"${selftestRunning() ? ' disabled' : ''}>${ic('activity', 'ic-sm')}Проверить запуск</button>` : ''}
        </div>`;
    };

    const selftestView = () => {
      const st = state.claudeSelftest;
      const s = state.settings;
      if (selftestRunning()) {
        const stage = s.claudeSelftestProgress ? `: ${s.claudeSelftestProgress}` : '';
        return `<div class="install-progress" style="margin-top:10px"><span class="spinner"></span><span>Проверяю${escapeHtml(stage)}…</span></div>
          <p class="section-hint" style="margin:8px 0 0">Если Claude Code зависает, проверка перебирает режимы запуска — это до 5 минут. Не закрывайте приложение.</p>`;
      }
      if (!st) return '';
      if (!Array.isArray(st.stages)) {
        return `<div style="margin-top:10px"><span class="pill ${st.ok ? 'ok' : 'err'}">${st.ok ? 'Работает' : 'Не запускается'}</span>${outputBlock(st.output || '(пустой вывод)')}</div>`;
      }
      const engine = st.engine === 'static' ? 'proot (static)' : 'proot (Termux)';
      return `<div class="selftest">
        <div class="selftest-summary"><span class="pill ${st.ok ? 'ok' : 'err'}">${st.ok ? 'Claude Code запускается' : 'Claude Code не запускается'}</span>
          ${st.engine ? `<span class="faint">движок: ${engine}${st.safeMode ? ' · безопасный режим Bun' : ''}</span>` : ''}</div>
        ${st.summary ? `<div class="step-text" style="margin-top:8px">${escapeHtml(st.summary)}</div>` : ''}
        ${st.ok ? '' : `<button class="btn btn-secondary btn-sm" style="margin-top:10px" data-act="copy-report">${ic('copy', 'ic-sm')}Скопировать отчёт</button>`}
        <details class="disclosure"${st.ok ? '' : ' open'}><summary>Этапы проверки ${ic('chevron-down', 'ic-sm')}</summary>
          ${st.stages.map(stage => `<div class="selftest-stage">
            <div class="selftest-head">${ic(stage.ok ? 'check-circle' : 'alert', 'ic-sm')}<span>${escapeHtml(stage.name)}</span><span class="faint">${escapeHtml(stage.exit || '')} · ${escapeHtml(stage.seconds || '0')} с</span></div>
            ${stage.output ? outputBlock(stage.output) : (stage.ok ? '' : outputBlock('(пустой вывод)'))}
            ${stage.verbose ? `<details class="disclosure"><summary>Подробный журнал ${ic('chevron-down', 'ic-sm')}</summary>${outputBlock(stage.verbose)}</details>` : ''}
            ${stage.snapshot ? `<details class="disclosure"><summary>Процессы в момент зависания ${ic('chevron-down', 'ic-sm')}</summary>${outputBlock(stage.snapshot)}</details>` : ''}
          </div>`).join('')}
        </details>
        ${st.ok ? `<button class="btn btn-ghost btn-sm" style="padding:0;margin-top:8px" data-act="copy-report">${ic('copy', 'ic-sm')}Скопировать отчёт</button>` : ''}
      </div>`;
    };

    const render = () => {
      const s = state.settings;
      const sizeMb = s.claudeDownloadMb || 128;
      const canInstall = can.claudeInstall();
      const busy = installing || s.claudeInstalling;
      let runtimeText;
      if (s.claudeRuntimeReady) runtimeText = 'Установлена. Новые чаты с моделями Claude Code работают в ней автоматически.';
      else if (!canInstall) runtimeText = 'Для установки среды обновите приложение (APK) до версии 1.6.1 или новее.';
      else runtimeText = `Разовая загрузка около ${sizeMb} МБ (после распаковки ~300 МБ), лучше по Wi-Fi. Компоненты берутся из официальных источников — Alpine Linux и npm — и проверяются по SHA-256.`;
      if (s.claudeRuntimeReady && s.claudeSafeMode) runtimeText += ' Включён безопасный режим Bun — его подобрала проверка запуска.';
      return `
        <p class="section-hint" style="margin:0 4px 14px">Claude Code работает прямо на телефоне — без ПК и без настройки папок. Системный промпт тот же, что и для Gemini.</p>
        <div class="card">
          <div class="step${s.claudeRuntimeReady ? ' done' : ''}">
            <span class="step-num">${s.claudeRuntimeReady ? ic('check', 'ic-xs') : '1'}</span>
            <div class="step-body"><div class="step-title">Среда выполнения</div>
              <div class="step-text">${escapeHtml(runtimeText)}</div>
              ${busy ? `<div class="install-progress"><span class="spinner"></span><span>${escapeHtml(s.claudeInstallProgress || 'Подготовка…')}</span></div><p class="section-hint" style="margin:8px 0 0">Не закрывайте приложение до окончания установки.</p>`
                : `<div class="btn-row">
                    ${s.claudeRuntimeReady && can.claudeLogin() ? `<button class="btn btn-secondary btn-sm" data-act="selftest"${selftestRunning() ? ' disabled' : ''}>${ic('activity', 'ic-sm')}Проверить запуск</button>` : ''}
                    <button class="btn ${s.claudeRuntimeReady ? 'btn-secondary' : 'btn-primary'} btn-sm" data-act="install"${canInstall && !selftestRunning() ? '' : ' disabled'}>${s.claudeRuntimeReady ? `${ic('reroll')}Переустановить` : `${ic('download')}Скачать среду`}</button>
                  </div>${selftestView()}`}
            </div>
          </div>
          <div class="step${s.claudeAuthenticated ? ' done' : ''}">
            <span class="step-num">${s.claudeAuthenticated ? ic('check', 'ic-xs') : '2'}</span>
            <div class="step-body"><div class="step-title">Вход по подписке Claude</div>${loginBody(s)}</div>
          </div>
        </div>`;
    };

    const layer = openPage({
      title: 'Claude Code CLI',
      body: render(),
      onClose: () => {
        clearInterval(progressTimer);
        clearInterval(loginTimer);
        clearInterval(selftestTimer);
      },
    });
    layer.isClaudePage = true;
    // The page re-renders while sign-in runs: keep a pasted code across renders.
    layer.el.addEventListener('input', (e) => {
      if (e.target.dataset.role === 'code') login.codeDraft = e.target.value;
    });
    layer.refresh = () => {
      if (document.activeElement && layer.el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      const body = $('.page-body', layer.el);
      const scroll = body.scrollTop;
      const openDetails = $$('details.disclosure', body).map(d => d.open);
      layer.setBody(render());
      $$('details.disclosure', body).forEach((d, i) => { if (openDetails[i]) d.open = true; });
      body.scrollTop = scroll;
    };
    const watchProgress = () => {
      clearInterval(progressTimer);
      progressTimer = setInterval(async () => {
        await refreshClaudeStatus();
        if (!installing && !state.settings.claudeInstalling) clearInterval(progressTimer);
      }, 1000);
    };
    const finishLogin = (ok, error) => {
      clearInterval(loginTimer);
      login.phase = 'idle';
      login.submitting = false;
      login.error = ok ? '' : (error || 'Неизвестная ошибка');
      layer.refresh();
      renderSettingsTab();
      renderRoomHeader();
      if (ok) toast('Вход в Claude выполнен', { type: 'success' });
    };
    // The CLI keeps running while the user signs in; poll its live output, the
    // links it produced and the result until done, failed, or 15 minutes pass.
    const watchLogin = () => {
      clearInterval(loginTimer);
      const startedAt = Date.now();
      loginTimer = setInterval(async () => {
        await refreshClaudeStatus();
        const s = state.settings;
        if (s.claudeAuthenticated) finishLogin(true);
        else if (!s.claudeLoginPending && s.claudeLoginError) finishLogin(false, s.claudeLoginError);
        else if (Date.now() - startedAt > 15 * 60 * 1000) finishLogin(false, 'Время ожидания входа истекло. Попробуйте снова.');
        else layer.refresh();
      }, 2000);
    };

    // While a check runs, follow its current stage (the status refresh re-renders).
    const watchSelftest = () => {
      clearInterval(selftestTimer);
      selftestTimer = setInterval(async () => {
        await refreshClaudeStatus();
        if (!selftestRunning()) clearInterval(selftestTimer);
      }, 1500);
    };

    refreshClaudeStatus().then(() => {
      if (state.settings.claudeInstalling) watchProgress();
      if (selftestRunning()) watchSelftest();
      if (state.settings.claudeLoginPending && !state.settings.claudeAuthenticated) {
        login.phase = 'waiting';
        layer.refresh();
        watchLogin();
      }
    });

    bindActs(layer, {
      install: async () => {
        const ok = await confirmDialog({
          title: state.settings.claudeRuntimeReady ? 'Переустановить среду?' : 'Скачать среду Claude Code?',
          message: `Около ${state.settings.claudeDownloadMb || 128} МБ. Нужны стабильный интернет и ~700 МБ свободного места. Загрузка займёт несколько минут. Вход в Claude сохранится.`,
          confirmText: 'Скачать',
        });
        if (!ok) return;
        installing = true;
        state.claudeSelftest = null;
        state.settings.claudeInstallProgress = 'Подготовка…';
        layer.refresh();
        watchProgress();
        try {
          // force: "Переустановить" must really download and unpack again.
          const res = await api('/api/claude/runtime/install', { method: 'POST', body: { force: Boolean(state.settings.claudeRuntimeReady) } });
          state.settings.claudeRuntimeReady = Boolean(res.runtimeReady);
          state.settings.claudeAuthenticated = Boolean(res.authenticated);
          toast(state.settings.claudeRuntimeReady ? 'Среда установлена' : 'Установка не завершилась', { type: state.settings.claudeRuntimeReady ? 'success' : 'error' });
        } catch (e) {
          toast('Ошибка установки: ' + e.message, { type: 'error', duration: 8000 });
        } finally {
          installing = false;
          state.settings.claudeInstalling = false;
          await refreshClaudeStatus();
          layer.refresh();
          renderSettingsTab();
        }
      },
      selftest: async () => {
        if (selftestRunning()) return;
        state.claudeSelftest = { running: true };
        state.settings.claudeSelftestProgress = '';
        layer.refresh();
        const body = $('.page-body', layer.el);
        if (body) body.scrollTop = 0;
        watchSelftest();
        let result;
        try {
          result = await api('/api/claude/selftest', { method: 'POST' });
        } catch (e) {
          result = { ok: false, output: e.message };
        }
        clearInterval(selftestTimer);
        state.claudeSelftest = result;
        await refreshClaudeStatus();
        layer.refresh();
        if (result.ok && Array.isArray(result.stages)) toast(result.summary || 'Claude Code запускается', { type: 'success' });
      },
      login: async () => {
        login.phase = 'starting';
        login.error = '';
        login.codeDraft = '';
        layer.refresh();
        try {
          const res = await api('/api/claude/auth/start', { method: 'POST' });
          if (!res.pending && !res.authUrl) {
            // Engine 19 and older: setup-token never produced a link.
            finishLogin(false, res.note || 'Claude Code не выдал ссылку для входа.');
            return;
          }
          // Engine 20-21 answered with the link directly; 22+ streams it via status.
          login.legacyUrl = res.pending ? '' : (res.manualUrl || res.authUrl || '');
          state.settings.claudeLoginUrl = '';
          state.settings.claudeLoginAutoUrl = '';
          state.settings.claudeLoginElapsed = 0;
          state.settings.claudeLoginOutput = '';
          state.settings.claudeLoginDebug = '';
          login.phase = 'waiting';
          layer.refresh();
          watchLogin();
        } catch (e) {
          finishLogin(false, e.message);
        }
      },
      'copy-report': () => {
        const st = state.claudeSelftest;
        if (st) copyText(st.report || st.output || '');
      },
      'copy-error': () => {
        if (login.error) copyText(login.error);
      },
      'open-link': () => {
        const link = state.settings.claudeLoginUrl || login.legacyUrl || state.settings.claudeLoginAutoUrl;
        if (link) openExternal(link);
      },
      'copy-link': () => {
        const link = state.settings.claudeLoginUrl || login.legacyUrl || state.settings.claudeLoginAutoUrl;
        if (link) copyText(link);
      },
      'open-auto': () => {
        if (state.settings.claudeLoginAutoUrl) openExternal(state.settings.claudeLoginAutoUrl);
      },
      'copy-live': () => {
        const s = state.settings;
        copyText([s.claudeLoginOutput, s.claudeLoginDebug ? '--- debug ---\n' + s.claudeLoginDebug : ''].filter(Boolean).join('\n'));
      },
      exchange: async () => {
        const input = $('[data-role="code"]', layer.el);
        const code = input ? input.value.trim() : '';
        if (!code) {
          toast('Вставьте код со страницы входа');
          return;
        }
        login.submitting = true;
        if (input) input.blur();
        layer.refresh();
        try {
          const res = await api('/api/claude/auth/exchange', { method: 'POST', body: { code } });
          state.settings.claudeAuthenticated = Boolean(res.authenticated);
          if (res.authenticated) finishLogin(true);
          else finishLogin(false, res.error || 'Вход не завершился.');
        } catch (e) {
          login.submitting = false;
          layer.refresh();
          toast(e.message, { type: 'error', duration: 6000 });
        }
      },
      'cancel-login': async () => {
        clearInterval(loginTimer);
        try {
          await api('/api/claude/auth/logout', { method: 'POST' });
        } catch (e) {
          // nothing to cancel
        }
        state.settings.claudeAuthenticated = false;
        login.phase = 'idle';
        login.error = '';
        login.codeDraft = '';
        layer.refresh();
      },
      logout: async () => {
        try {
          await api('/api/claude/auth/logout', { method: 'POST' });
          state.settings.claudeAuthenticated = false;
          login.phase = 'idle';
          layer.refresh();
          renderSettingsTab();
          renderRoomHeader();
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  // --- appearance & reading -------------------------------------------------
  function openAppearancePage() {
    const render = () => `
      <div class="section"><div class="section-title">Тема</div>
        <div class="theme-options">${Object.keys(THEMES).map(k => {
          const t = THEMES[k];
          return `<button class="theme-option${prefs.theme === k ? ' active' : ''}" data-act="theme" data-theme="${k}">
            <span class="theme-swatch" style="background:${t.swatch[0]}"><i style="background:${t.swatch[1]};width:80%"></i><i style="background:hsl(${prefs.accent} 70% 60%);width:50%"></i><i style="background:${t.swatch[1]};width:65%"></i></span>${t.label}</button>`;
        }).join('')}</div>
        ${can.systemBars() ? '' : '<p class="section-hint">Цвет строки состояния подстроится под тему после обновления APK.</p>'}
      </div>
      <div class="section"><div class="section-title">Акцентный цвет</div>
        <div class="accent-options">${ACCENTS.map(a => `<button class="accent-option${prefs.accent === a.hue ? ' active' : ''}" style="background:hsl(${a.hue} 68% 58%)" data-act="accent" data-hue="${a.hue}" aria-label="${a.label}"></button>`).join('')}</div>
      </div>`;
    const layer = openPage({ title: 'Оформление', body: render() });
    bindActs(layer, {
      theme: (el) => {
        prefs.theme = el.dataset.theme;
        savePrefs();
        applyTheme();
        layer.setBody(render());
        renderSettingsTab();
      },
      accent: (el) => {
        prefs.accent = Number(el.dataset.hue);
        savePrefs();
        applyTheme();
        layer.setBody(render());
      },
    });
  }

  function openReadingPage() {
    const sample = '*Кира отрывается от карты и медленно поднимает взгляд.* «Ты опоздал. Опять.»\n\n*Она кивает на стул напротив.* «Садись. У нас есть **проблема**.»';
    const toggle = (key, title, sub) => `<button class="row" data-act="toggle" data-key="${key}"><div class="row-body"><div class="row-title">${title}</div>${sub ? `<div class="row-sub wrap">${sub}</div>` : ''}</div><span class="switch${prefs[key] ? ' on' : ''}"></span></button>`;
    const render = () => `
      <div class="card reading-preview"><div class="msg-text">${formatRoleplayHtml(sample, { dialogue: prefs.dialogue })}</div></div>
      <div class="section"><div class="section-title" style="display:flex">Размер текста<span style="margin-left:auto" class="faint">${prefs.fontSize} px</span></div>
        <input type="range" class="slider" min="13" max="22" step="1" value="${prefs.fontSize}" data-role="size" aria-label="Размер текста" /></div>
      <div class="section"><div class="section-title">Межстрочный интервал</div>
        <div class="segmented">${[[1.45, 'Плотно'], [1.6, 'Обычно'], [1.8, 'Свободно']].map(([v, l]) => `<button class="${prefs.lineHeight === v ? 'active' : ''}" data-act="lh" data-value="${v}">${l}</button>`).join('')}</div></div>
      <div class="section"><div class="list">
        ${toggle('serif', 'Шрифт с засечками', 'Книжный шрифт для текста сообщений')}
        ${toggle('dialogue', 'Подсвечивать реплики', 'Текст в «кавычках» выделяется цветом')}
        ${toggle('thoughtsOpen', 'Раскрывать мысли модели', 'Иначе мысли свёрнуты под заголовком')}
        ${toggle('enterSends', 'Enter отправляет сообщение', 'Перенос строки — Shift+Enter. Ctrl+Enter отправляет всегда.')}
      </div></div>`;
    const layer = openPage({ title: 'Чтение', body: render() });
    const changed = () => {
      savePrefs();
      applyTheme();
      if (state.room) syncFeed({ scroll: 'keep' });
      renderSettingsTab();
    };
    layer.el.addEventListener('input', (e) => {
      if (e.target.dataset.role !== 'size') return;
      prefs.fontSize = Number(e.target.value);
      applyTheme();
      const label = e.target.parentElement.querySelector('.faint');
      if (label) label.textContent = prefs.fontSize + ' px';
    });
    layer.el.addEventListener('change', (e) => {
      if (e.target.dataset.role === 'size') changed();
    });
    bindActs(layer, {
      lh: (el) => {
        prefs.lineHeight = Number(el.dataset.value);
        changed();
        layer.setBody(render());
      },
      toggle: (el) => {
        const k = el.dataset.key;
        prefs[k] = !prefs[k];
        changed();
        layer.setBody(render());
      },
    });
  }

  // --- backup ---------------------------------------------------------------
  function openBackupPage() {
    const layer = openPage({
      title: 'Резервная копия',
      body: `
        <div class="card card-pad">
          <div class="status-card-title">Создать копию</div>
          <p class="step-text">Персонажи, персоны, все чаты (с мыслями и вариантами), системный промпт, память чатов и настройки. Токены входа не сохраняются — после восстановления войдите заново.</p>
          <button class="btn btn-primary btn-block" data-act="export">${ic('download')}Сохранить копию</button>
        </div>
        <div class="card card-pad section">
          <div class="status-card-title">Восстановить</div>
          <p class="step-text">Текущие персонажи, чаты и сообщения будут <b>полностью заменены</b> данными из копии.</p>
          ${can.jsonPicker()
            ? `<button class="btn btn-secondary btn-block" data-act="pick">${ic('upload')}Выбрать файл .json</button><input type="file" accept=".json,application/json" class="hidden" data-role="file" />
               <details class="disclosure" style="margin-top:6px"><summary>Вставить JSON вручную ${ic('chevron-down', 'ic-sm')}</summary><textarea class="textarea mono" data-role="paste" placeholder='{"backupFormat":1, …}'></textarea><button class="btn btn-secondary btn-block" style="margin-top:10px" data-act="paste">Восстановить из текста</button></details>`
            : `<textarea class="textarea mono" data-role="paste" placeholder='{"backupFormat":1, …}'></textarea><button class="btn btn-secondary btn-block" style="margin-top:10px" data-act="paste">Восстановить из текста</button><p class="section-hint">Выбор файла станет доступен после обновления APK.</p>`}
        </div>
        <p class="section-hint">Перед переустановкой приложения обязательно сделайте копию: при удалении APK все чаты стираются.</p>`,
    });
    const restore = async (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        toast('Это не похоже на JSON резервной копии', { type: 'error' });
        return;
      }
      const c = parsed.counts || {};
      const ok = await confirmDialog({
        title: 'Восстановить данные?',
        message: `В копии: персонажей ${c.characters ?? '?'}, чатов ${c.chats ?? '?'}, сообщений ${c.messages ?? '?'}.\n\nТекущие данные будут полностью заменены. Отменить это нельзя.`,
        confirmText: 'Восстановить',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await api('/api/backup/import', { method: 'POST', body: { backup: parsed } });
        toast(res.message || 'Данные восстановлены', { type: 'success' });
        closeChatRoom();
        state.systemPromptText = null;
        await loadAll();
        layer.close();
      } catch (e) {
        toast('Восстановление не удалось: ' + e.message, { type: 'error' });
      }
    };
    const fileInput = $('[data-role="file"]', layer.el);
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => restore(String(reader.result || ''));
        reader.onerror = () => toast('Не удалось прочитать файл', { type: 'error' });
        reader.readAsText(file);
      });
    }
    bindActs(layer, {
      export: async (btn) => {
        btn.disabled = true;
        try {
          const backup = await api('/api/backup/export');
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          saveFile(`agy-backup-${stamp}.json`, JSON.stringify(backup, null, 2), 'application/json');
          const c = backup.counts || {};
          toast(`Копия: персонажей ${c.characters ?? 0}, чатов ${c.chats ?? 0}, сообщений ${c.messages ?? 0}`, { type: 'success' });
        } catch (e) {
          toast('Не удалось создать копию: ' + e.message, { type: 'error' });
        } finally {
          btn.disabled = false;
        }
      },
      pick: () => fileInput && fileInput.click(),
      paste: () => {
        const raw = ($('[data-role="paste"]', layer.el).value || '').trim();
        if (!raw) {
          toast('Вставьте содержимое файла копии');
          return;
        }
        restore(raw);
      },
    });
  }

  // --- updates --------------------------------------------------------------
  async function checkForUpdates(manual) {
    try {
      const data = await api('/api/updates/check');
      state.updateInfo = data;
      const nativeRequired = Boolean(data.nativeUpdateRequired || (data.remoteReachable && Number(data.latestBuild || 0) > Number(data.bundledBuild || 0)));
      const available = Boolean(data.updateAvailable || nativeRequired);
      const badge = $('#navSettingsBadge');
      if (badge) badge.classList.toggle('hidden', !available);
      if (state.tab === 'settings') renderSettingsTab();
      refreshLayers();
      if (available && !manual && !state.updateToastShown) {
        state.updateToastShown = true;
        toast(nativeRequired && data.otaActive && Number(data.currentBuild || 0) >= Number(data.latestBuild || 0)
          ? `Нужен новый APK (build ${data.latestBuild})`
          : `Доступна версия ${data.latestVersion}`, {
          action: { label: 'Подробнее', fn: () => openUpdatesPage() },
          duration: 8000,
        });
      }
      if (manual) {
        toast(available ? `Доступна версия ${data.latestVersion}` : (data.remoteReachable ? 'Установлена последняя версия' : 'Репозиторий недоступен: ' + (data.remoteError || '')),
          { type: available ? 'info' : (data.remoteReachable ? 'success' : 'error') });
      }
    } catch (e) {
      if (manual) toast('Не удалось проверить обновления: ' + e.message, { type: 'error' });
    }
  }

  async function applyGitUpdate(ref, commitSha) {
    toast('Загружаю обновление…');
    try {
      const info = state.updateInfo || {};
      const res = await api('/api/updates/apply', {
        method: 'POST',
        body: { gitBranch: info.gitBranch || 'main', ref: ref || info.gitBranch || 'main', commitSha: commitSha || '' },
      });
      toast((res.message || 'Обновление установлено') + '. Перезапуск…', { type: 'success' });
      setTimeout(reloadApp, 700);
    } catch (e) {
      toast('Ошибка обновления: ' + e.message, { type: 'error' });
    }
  }

  function openUpdatesPage() {
    let checking = false;
    const render = () => {
      const d = state.updateInfo;
      if (!d) return '<div class="empty"><span class="spinner"></span></div>';
      const nativeRequired = Boolean(d.nativeUpdateRequired || (d.remoteReachable && Number(d.latestBuild || 0) > Number(d.bundledBuild || 0)));
      const apkOnly = nativeRequired && d.otaActive && Number(d.currentBuild || 0) >= Number(d.latestBuild || 0);
      let status;
      if (!d.remoteReachable) status = `<span class="pill warn">${ic('alert', 'ic-xs')}Репозиторий недоступен</span>`;
      else if (apkOnly) status = `<span class="pill warn">Нужен новый APK</span>`;
      else if (d.updateAvailable) status = `<span class="pill accent">Доступно обновление</span>`;
      else status = `<span class="pill ok">${ic('check', 'ic-xs')}Актуальная версия</span>`;
      const releases = d.releases || [];
      const commits = d.commits || [];
      return `
        <div class="version-hero">
          <div class="version-box"><div class="version-label">Установлена</div><div class="version-value">v${escapeHtml(d.currentVersion || state.webVersion || '—')}</div><div class="version-sub">build ${escapeHtml(d.currentBuild || '—')} · ${d.otaActive ? 'OTA' : 'APK'} · движок ${escapeHtml(d.bundledBuild || state.engineBuild)}</div></div>
          <div class="version-box highlight"><div class="version-label">В репозитории</div><div class="version-value">v${escapeHtml(d.latestVersion || '—')}</div><div class="version-sub">build ${escapeHtml(d.latestBuild || '—')}${d.latestCommit ? ' · ' + escapeHtml(d.latestCommit) : ''}</div></div>
        </div>
        <div style="margin:12px 0">${status}${d.remoteError && !d.remoteReachable ? `<p class="section-hint">${escapeHtml(d.remoteError)}</p>` : ''}</div>
        ${apkOnly
          ? `<button class="btn btn-primary btn-block" data-act="apk">${ic('package')}Скачать новый APK</button>`
          : `<button class="btn btn-primary btn-block" data-act="apply"${d.updateAvailable ? '' : ' disabled'}>${ic('update')}${d.updateAvailable ? `Обновить до v${escapeHtml(d.latestVersion)}` : 'Обновлений нет'}</button>`}
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-secondary" data-act="check"${checking ? ' disabled' : ''}>${checking ? '<span class="spinner"></span>' : ic('reroll')}Проверить</button>
          ${d.otaActive ? `<button class="btn btn-secondary" data-act="reset">${ic('undo')}Сброс к APK</button>` : `<button class="btn btn-secondary" data-act="apk">${ic('package')}APK</button>`}
        </div>
        ${releases.length ? `<div class="section"><div class="section-title">Что нового</div><div class="card">${releases.slice(0, 6).map(r => `<div class="release">
            <div class="release-head"><span class="release-ver">v${escapeHtml(r.version)}</span>${r.version === d.currentVersion ? '<span class="pill ok">Установлена</span>' : ''}<span class="release-date">${escapeHtml(r.date || '')}</span></div>
            ${r.title ? `<div class="release-title">${escapeHtml(r.title)}</div>` : ''}
            ${(r.changelog || []).length ? `<ul>${r.changelog.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
            ${r.version !== d.currentVersion ? `<button class="btn btn-ghost btn-sm" style="padding:0" data-act="release" data-ref="${escapeHtml(r.ref || d.gitBranch || 'main')}">Установить v${escapeHtml(r.version)}</button>` : ''}
          </div>`).join('')}</div></div>` : ''}
        <details class="disclosure section"><summary>${ic('code', 'ic-sm')}Для разработчиков ${ic('chevron-down', 'ic-sm')}</summary>
          <label class="field"><span class="field-label">Ветка</span><input class="input mono" data-role="branch" value="${escapeHtml(d.gitBranch || 'main')}" autocomplete="off" />
            <span class="field-hint">Репозиторий ${escapeHtml(d.gitRepo || '')} зафиксирован в подписанном APK.</span></label>
          <button class="btn btn-secondary btn-sm" style="margin-top:10px" data-act="branch">Сохранить ветку</button>
          <button class="btn btn-ghost btn-sm" style="margin-top:10px" data-act="github">${ic('external', 'ic-sm')}GitHub</button>
          ${commits.length ? `<div class="list section">${commits.slice(0, 15).map(c => `<div class="row"><div class="row-body"><div class="row-title">${escapeHtml(c.message)}</div><div class="row-sub"><span class="mono">${escapeHtml(c.shortSha)}</span> · ${escapeHtml(c.author || '')} · ${escapeHtml(String(c.date || '').replace('T', ' ').slice(0, 16))}</div></div>
            ${d.installedCommit && c.shortSha === d.installedCommit ? '<span class="pill ok">Активен</span>' : `<button class="btn btn-ghost btn-sm" data-act="commit" data-sha="${escapeHtml(c.sha)}">Установить</button>`}</div>`).join('')}</div>` : ''}
        </details>`;
    };
    const layer = openPage({ title: 'Обновления', body: render() });
    layer.refresh = () => {
      if (document.activeElement && layer.el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      const body = $('.page-body', layer.el);
      const scroll = body.scrollTop;
      const devOpen = $('details.disclosure', layer.el);
      const wasOpen = devOpen && devOpen.open;
      layer.setBody(render());
      if (wasOpen) $('details.disclosure', layer.el).open = true;
      body.scrollTop = scroll;
    };
    if (!state.updateInfo) checkForUpdates(false);
    bindActs(layer, {
      apply: async () => {
        const ok = await confirmDialog({ title: 'Установить обновление?', message: 'Приложение перезапустится. Чаты и настройки сохранятся.', confirmText: 'Обновить' });
        if (ok) applyGitUpdate('', '');
      },
      release: async (el) => {
        const ok = await confirmDialog({ title: 'Переключить версию?', message: 'Будут загружены файлы интерфейса этой версии. Приложение перезапустится.', confirmText: 'Установить' });
        if (ok) applyGitUpdate(el.dataset.ref, '');
      },
      commit: async (el) => {
        const ok = await confirmDialog({ title: 'Установить коммит?', message: 'Только для отладки. Приложение перезапустится.', confirmText: 'Установить' });
        if (ok) applyGitUpdate(el.dataset.sha, el.dataset.sha);
      },
      check: async () => {
        checking = true;
        layer.refresh();
        await checkForUpdates(true);
        checking = false;
        layer.refresh();
      },
      reset: async () => {
        const ok = await confirmDialog({ title: 'Вернуть интерфейс из APK?', message: 'OTA-обновление будет удалено, приложение перезапустится.', confirmText: 'Сбросить', danger: true });
        if (!ok) return;
        try {
          await api('/api/updates/reset', { method: 'POST' });
          setTimeout(reloadApp, 400);
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
      apk: () => {
        const d = state.updateInfo || {};
        openExternal(d.apkDownloadUrl || 'https://raw.githubusercontent.com/Kuka001/111/main/agy-roleplay-android16.apk');
      },
      github: () => {
        const d = state.updateInfo || {};
        openExternal(d.repoWebUrl || 'https://github.com/' + (d.gitRepo || 'Kuka001/111'));
      },
      branch: async () => {
        const gitBranch = ($('[data-role="branch"]', layer.el).value || 'main').trim();
        try {
          await api('/api/updates/config', { method: 'POST', body: { gitBranch } });
          toast('Ветка сохранена', { type: 'success' });
          await checkForUpdates(true);
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  // --- chat memory ----------------------------------------------------------
  async function openMemoryEditor(relPath) {
    let raw = '';
    try {
      raw = (await api(`/api/files/content?path=${encodeURIComponent(relPath)}`)).content || '';
    } catch (e) {
      raw = '';
    }
    // The auto-created "# Память чата #N" heading is never sent to the model; keep it out of sight.
    const heading = (raw.match(/^# Память чата[^\n]*\n*/) || [''])[0];
    let initial = raw.slice(heading.length);
    let saved = false;
    const layer = openPage({
      title: 'Память чата',
      backIcon: 'x',
      body: `<p class="section-hint" style="margin:0 4px 12px">Важные факты, договорённости и события, которые модель должна помнить. Текст попадает в системный промпт внутри &lt;chat_memory&gt;; {{char}} и {{user}} подставляются.</p>
        <textarea class="textarea tall" data-role="text" placeholder="Например: {{user}} обещал вернуться к рассвету. {{char}} не доверяет гильдии.">${escapeHtml(initial)}</textarea>`,
      actions: `<button class="btn btn-ghost" data-act="save">Сохранить</button>`,
      onBack: () => {
        if (saved || $('[data-role="text"]', layer.el).value === initial) return true;
        confirmDialog({ title: 'Выйти без сохранения?', confirmText: 'Выйти', cancelText: 'Остаться', danger: true }).then(ok => ok && layer.close());
        return false;
      },
    });
    const ta = $('[data-role="text"]', layer.el);
    ta.addEventListener('input', () => layer.setTitle('Память чата' + (ta.value !== initial ? '<span class="dirty-dot"></span>' : '')));
    bindActs(layer, {
      save: async (btn) => {
        btn.disabled = true;
        try {
          await api('/api/files/file', { method: 'POST', body: { filePath: relPath, content: heading + ta.value } });
          saved = true;
          initial = ta.value;
          layer.close();
          toast('Память сохранена', { type: 'success' });
        } catch (e) {
          btn.disabled = false;
          toast(e.message, { type: 'error' });
        }
      },
    });
  }

  // ==========================================================================
  // IMAGE VIEWER (pinch-zoom, double-tap, pan)
  // ==========================================================================
  function openImageViewer(src, title) {
    const layer = openLayer({
      kind: 'viewer',
      html: `<div class="viewer-bar"><div class="viewer-title">${escapeHtml(title || 'Изображение')}</div><span class="viewer-zoom" data-role="zoom">100%</span>
          <button class="icon-btn" data-action="layer-close" aria-label="Закрыть">${ic('x')}</button></div>
        <div class="viewer-stage" data-role="stage"><img class="viewer-img" data-role="img" src="${escapeHtml(src)}" alt="" draggable="false" /></div>`,
    });
    const stage = $('[data-role="stage"]', layer.el);
    const img = $('[data-role="img"]', layer.el);
    const zoomLabel = $('[data-role="zoom"]', layer.el);
    const v = { scale: 1, tx: 0, ty: 0, mode: null, startDist: 0, startScale: 1, midX: 0, midY: 0, startTx: 0, startTy: 0, panX: 0, panY: 0, lastTap: 0, moved: false };
    const apply = (animate) => {
      img.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
      img.style.transform = `translate3d(${v.tx}px, ${v.ty}px, 0) scale(${v.scale})`;
      zoomLabel.textContent = Math.round(v.scale * 100) + '%';
    };
    const reset = () => {
      v.scale = 1;
      v.tx = 0;
      v.ty = 0;
      apply(true);
    };
    const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        v.mode = 'pinch';
        v.moved = true;
        v.startDist = Math.max(dist(e.touches[0], e.touches[1]), 10);
        v.startScale = v.scale;
        v.midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        v.midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        v.startTx = v.tx;
        v.startTy = v.ty;
      } else if (e.touches.length === 1) {
        v.mode = 'pan';
        v.moved = false;
        v.panX = e.touches[0].clientX;
        v.panY = e.touches[0].clientY;
        v.startTx = v.tx;
        v.startTy = v.ty;
      }
    }, { passive: false });
    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && v.mode === 'pinch') {
        e.preventDefault();
        const next = Math.min(Math.max(v.startScale * (Math.max(dist(e.touches[0], e.touches[1]), 10) / v.startDist), 0.5), 6);
        const rect = stage.getBoundingClientRect();
        const fx = v.midX - (rect.left + rect.width / 2);
        const fy = v.midY - (rect.top + rect.height / 2);
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const ratio = next / v.startScale;
        v.scale = next;
        v.tx = fx - (fx - v.startTx) * ratio + (mx - v.midX);
        v.ty = fy - (fy - v.startTy) * ratio + (my - v.midY);
        apply(false);
      } else if (e.touches.length === 1 && v.mode === 'pan') {
        const dx = e.touches[0].clientX - v.panX;
        const dy = e.touches[0].clientY - v.panY;
        if (Math.hypot(dx, dy) > 6) v.moved = true;
        if (v.moved && v.scale > 1.02) {
          e.preventDefault();
          v.tx = v.startTx + dx;
          v.ty = v.startTy + dy;
          apply(false);
        }
      }
    }, { passive: false });
    stage.addEventListener('touchend', (e) => {
      if (e.touches.length === 1) {
        v.mode = 'pan';
        v.panX = e.touches[0].clientX;
        v.panY = e.touches[0].clientY;
        v.startTx = v.tx;
        v.startTy = v.ty;
        return;
      }
      if (e.touches.length) return;
      v.mode = null;
      if (v.scale < 0.9) {
        reset();
        return;
      }
      if (v.moved || !e.changedTouches || !e.changedTouches.length) return;
      const now = Date.now();
      const t = e.changedTouches[0];
      if (now - v.lastTap < 280) {
        v.lastTap = 0;
        if (v.scale > 1.2) {
          reset();
        } else {
          const rect = stage.getBoundingClientRect();
          v.scale = 2.5;
          v.tx = (rect.left + rect.width / 2 - t.clientX) * 1.5 * 0.6;
          v.ty = (rect.top + rect.height / 2 - t.clientY) * 1.5 * 0.6;
          apply(true);
        }
      } else {
        v.lastTap = now;
        if (e.target === stage && v.scale <= 1.05) {
          setTimeout(() => {
            if (v.lastTap === now) layer.close();
          }, 280);
        }
      }
    }, { passive: false });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      v.scale = Math.min(Math.max(v.scale * (e.deltaY < 0 ? 1.15 : 0.87), 0.5), 6);
      if (v.scale <= 1.02) {
        v.tx = 0;
        v.ty = 0;
      }
      apply(false);
    }, { passive: false });
    stage.addEventListener('click', (e) => {
      if (e.target === stage && !('ontouchstart' in window)) layer.close();
    });
    return layer;
  }

  // ==========================================================================
  // GESTURES: long-press menus, swipe-to-reveal chat rows, variant swipes
  // ==========================================================================
  let suppressClickUntil = 0;
  let lastMenuAt = 0;
  const ROW_REVEAL = 152;

  function openMenuFor(row, msg) {
    if (Date.now() - lastMenuAt < 800) return;
    lastMenuAt = Date.now();
    if (row) openChatActions(Number(row.dataset.chatId));
    else if (msg) openMessageActions(Number(msg.dataset.msgId));
  }

  function initGestures() {
    let g = null;
    const reset = () => {
      if (g) clearTimeout(g.timer);
      g = null;
    };

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0];
      const target = e.target;
      if (target.closest('.layer-viewer')) return;
      const row = target.closest('.chat-row');
      const msg = target.closest('#chatFeed .msg[data-msg-id]');
      const swipeMsg = msg && msg.dataset.swipeable === '1' ? msg : null;
      if (!target.closest('.chat-row.open')) closeOpenChatRows(row);
      g = { x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, row, msg, swipeMsg, axis: null, moved: false, fired: false, timer: null };
      const interactive = target.closest('button, a, input, textarea, summary, [data-action="view-avatar"]');
      if ((row || msg) && !interactive) {
        g.timer = setTimeout(() => {
          if (!g || g.moved) return;
          g.fired = true;
          suppressClickUntil = Date.now() + 600;
          try {
            if (navigator.vibrate) navigator.vibrate(10);
          } catch (err) {
            // vibration is optional
          }
          openMenuFor(row, msg);
        }, 480);
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!g || !e.touches.length) return;
      const t = e.touches[0];
      g.dx = t.clientX - g.x0;
      g.dy = t.clientY - g.y0;
      if (!g.moved && Math.hypot(g.dx, g.dy) > 9) {
        g.moved = true;
        clearTimeout(g.timer);
        g.axis = Math.abs(g.dx) > Math.abs(g.dy) * 1.3 ? 'x' : 'y';
      }
      if (g.axis !== 'x') return;
      if (g.row) {
        const main = $('.chat-row-main', g.row);
        const base = g.row.classList.contains('open') ? -ROW_REVEAL : 0;
        const x = Math.max(-ROW_REVEAL - 20, Math.min(0, base + g.dx));
        g.row.classList.add('dragging');
        main.style.transform = `translateX(${x}px)`;
      } else if (g.swipeMsg) {
        const text = $('.msg-text', g.swipeMsg);
        text.classList.remove('swipe-anim');
        text.style.transform = `translateX(${g.dx * 0.5}px)`;
        text.style.opacity = String(1 - Math.min(Math.abs(g.dx) / 500, 0.45));
      }
    }, { passive: true });

    const end = () => {
      if (!g) return;
      clearTimeout(g.timer);
      if (g.axis === 'x' && g.row) {
        const main = $('.chat-row-main', g.row);
        const base = g.row.classList.contains('open') ? -ROW_REVEAL : 0;
        const open = base + g.dx < -ROW_REVEAL / 2;
        g.row.classList.remove('dragging');
        g.row.classList.toggle('open', open);
        main.style.transform = open ? `translateX(${-ROW_REVEAL}px)` : '';
        suppressClickUntil = Date.now() + 350;
      } else if (g.axis === 'x' && g.swipeMsg) {
        const text = $('.msg-text', g.swipeMsg);
        text.classList.add('swipe-anim');
        text.style.transform = '';
        text.style.opacity = '';
        const id = Number(g.swipeMsg.dataset.msgId);
        if (g.dx < -70) swipeBy(id, 1);
        else if (g.dx > 70) swipeBy(id, -1);
        suppressClickUntil = Date.now() + 350;
      }
      g = null;
    };
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', () => {
      if (g && g.row) {
        g.row.classList.remove('dragging');
        $('.chat-row-main', g.row).style.transform = g.row.classList.contains('open') ? `translateX(${-ROW_REVEAL}px)` : '';
      }
      if (g && g.swipeMsg) {
        const text = $('.msg-text', g.swipeMsg);
        text.style.transform = '';
        text.style.opacity = '';
      }
      reset();
    });

    // Mouse / desktop: right click opens the same menus.
    document.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.chat-row');
      const msg = e.target.closest('#chatFeed .msg[data-msg-id]');
      if (!row && !msg) return;
      if (window.getSelection && String(window.getSelection())) return;
      e.preventDefault();
      openMenuFor(row, msg);
    });
  }

  // ==========================================================================
  // GLOBAL EVENTS
  // ==========================================================================
  const ACTIONS = {
    tab: (el) => {
      if (state.room) closeChatRoom();
      openTab(el.dataset.tab);
    },
    'layer-close': (el) => requestCloseLayer(layerOf(el)),
    'layer-dismiss': (el) => {
      const l = layerOf(el);
      if (l && l.dismissible) requestCloseLayer(l);
    },
    'reload-data': () => {
      state.loadError = '';
      renderAllTabs();
      loadAll().catch(showLoadError);
    },
    noop: () => {},

    'new-chat': (el) => openNewChat(Number(el.dataset.id) || 0),
    'open-chat': (el) => {
      const row = el.closest('.chat-row');
      if (row && row.classList.contains('open')) {
        closeOpenChatRows();
        return;
      }
      openChatRoom(Number(el.dataset.id));
    },
    'chat-export': (el) => {
      closeOpenChatRows();
      openExport(Number(el.dataset.id));
    },
    'chat-delete': (el) => deleteChat(Number(el.dataset.id)),
    'chats-search-open': () => {
      state.chatsSearchOpen = true;
      renderChatsTab();
    },
    'chats-search-close': () => {
      state.chatsSearchOpen = false;
      state.chatsQuery = '';
      renderChatsTab();
    },
    'chats-filter': (el) => {
      state.chatsFilter = Number(el.dataset.id) || 0;
      renderChatsList();
    },

    'close-chat': () => closeChatRoom(),
    'chat-settings': () => openChatSettings(),
    send: () => sendMessage(),
    stop: () => stopGeneration(),
    'insert-action': () => insertAsterisks(),
    'jump-bottom': () => scrollToBottom(true),
    'msg-menu': (el) => openMessageActions(Number(el.dataset.id)),
    'swipe-prev': (el) => swipeBy(Number(el.dataset.id), -1),
    'swipe-next': (el) => swipeBy(Number(el.dataset.id), 1),
    reroll: (el) => regenerate(Number(el.dataset.id)),
    'retry-generation': () => retryGeneration(),
    'dismiss-error': () => {
      if (!state.room) return;
      state.room.error = null;
      syncFeed({ scroll: 'keep' });
    },
    'open-diagnostics': () => openDiagnostics(state.room && state.room.chatId),
    'open-provider-settings': (el) => openProviderSettings(el.dataset.provider),
    'view-avatar': (el) => {
      if (!state.room) return;
      const who = el.dataset.who === 'persona' ? state.room.data.persona : state.room.data.character;
      if (who) openImageViewer(resolveAvatarUrl(who.avatar_url, who.name), who.name);
    },

    'open-character': (el) => openCharacterPage(Number(el.dataset.id)),
    'new-character': () => openCharacterEditor(null),
    'chars-search-open': () => {
      state.charsSearchOpen = true;
      renderCharactersTab();
    },
    'chars-search-close': () => {
      state.charsSearchOpen = false;
      state.charsQuery = '';
      renderCharactersTab();
    },
    'chars-sort': (el) => {
      state.charsSort = el.dataset.sort;
      renderCharactersList();
    },

    'open-persona': (el, e) => {
      if (e.target.closest('[data-action="activate-persona"]')) return;
      openPersonaEditor(Number(el.dataset.id));
    },
    'new-persona': () => openPersonaEditor(null),
    'activate-persona': (el) => activatePersona(Number(el.dataset.id)),

    'settings-open': (el) => openSettingsPage(el.dataset.page),
  };

  function initEvents() {
    document.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const fn = ACTIONS[el.dataset.action];
      if (fn) {
        if (el.dataset.action === 'activate-persona') e.stopPropagation();
        fn(el, e);
      }
    });

    document.addEventListener('keydown', (e) => {
      const el = e.target;
      if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute && el.getAttribute('role') === 'button' && el.dataset.action) {
        e.preventDefault();
        el.click();
      }
      if (e.key === 'Escape') handleBack();
    });

    document.addEventListener('input', (e) => {
      if (e.target.id === 'chatsSearchInput') {
        state.chatsQuery = e.target.value;
        renderChatsList();
      } else if (e.target.id === 'charsSearchInput') {
        state.charsQuery = e.target.value;
        renderCharactersList();
      }
    });

    const input = $('#chatInput');
    input.addEventListener('input', () => autoGrow(input, 168));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey || (prefs.enterSends && !e.shiftKey)) {
        e.preventDefault();
        if (state.room && !state.generations[state.room.chatId]) sendMessage();
      }
    });
    input.addEventListener('focus', () => {
      setTimeout(() => {
        if (isNearBottom()) scrollToBottom();
      }, 250);
    });

    const scroll = $('#chatScroll');
    let ticking = false;
    scroll.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        updateJumpBtn();
      });
    }, { passive: true });

    // Keep the layer stack honest when the legacy native back handler hides a layer.
    const layersHost = $('#layers');
    new MutationObserver((mutations) => {
      mutations.forEach(m => {
        const el = m.target;
        if (el && el._layer && el.classList.contains('hidden') && !el._layer.closed) closeLayer(el._layer, { immediate: true });
      });
    }).observe(layersHost, { attributes: true, attributeFilter: ['class'], subtree: true });

    // Keyboard visibility (native callback + visualViewport fallback)
    const setKeyboard = (open) => document.body.classList.toggle('kb-open', Boolean(open));
    window.onAndroidKeyboardVisibilityChanged = setKeyboard;
    if (window.visualViewport) {
      let base = window.visualViewport.height;
      window.visualViewport.addEventListener('resize', () => {
        const h = window.visualViewport.height;
        if (h > base) base = h;
        setKeyboard(base - h > 120);
        if (state.room && isNearBottom()) scrollToBottom();
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refreshAgyStatus();
        // Returning from the browser after the Claude sign-in.
        if (layerStack.some(l => l.isClaudePage)) refreshClaudeStatus();
      }
    });
  }

  function showLoadError(err) {
    state.loadError = (err && err.message) || 'Встроенный сервер не отвечает';
    renderAllTabs();
  }

  async function loadWebVersion() {
    try {
      const res = await fetch('version.json', { cache: 'no-store' });
      const v = await res.json();
      state.webVersion = v.version || '';
      if (state.tab === 'settings') renderSettingsTab();
    } catch (e) {
      // version is informational only
    }
  }

  function init() {
    applyTheme();
    initEvents();
    initGestures();
    renderAllTabs();
    loadWebVersion();
    loadAll()
      .then(() => setTimeout(() => checkForUpdates(false), 800))
      .catch(showLoadError);
  }

  document.addEventListener('DOMContentLoaded', init);

  // ==========================================================================
  // PUBLIC SURFACE
  // ==========================================================================
  window.appUI = {
    handleBack,
    openTab,
    openChatRoom,
    closeChatRoom,
    openNewChat,
    openCharacterEditor,
    openPersonaEditor,
    openSettingsPage,
    // Legacy name kept for older native back handlers / bookmarks.
    closeModal: (id) => {
      const el = document.getElementById(id);
      if (el && el._layer) el._layer.close();
    },
  };

  // Pure, side-effect-free helpers for the unit tests in mobile/tests/.
  // Not part of the UI API — do not call these from markup.
  window.__appInternals = {
    escapeHtml,
    stripMarkdownPreview,
    formatRoleplayHtml,
    highlightDialogue,
    resolveAvatarUrl,
    isClaudeCliModel,
    providerOf,
    effortOptionsFor,
    effectiveEffort,
    parseServerTime,
    formatRelativeTime,
    formatMessageTime,
    pluralRu,
    initialsOf,
    hueFromString,
    sortChats,
    filterChats,
    isDefaultChatTitle,
  };
})();
