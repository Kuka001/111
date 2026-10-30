(function () {
  'use strict';

  // ==========================================================================
  // NATIVE BRIDGE CONTRACT
  // Called by MainActivity / LocalBackendServer. Names and signatures are part
  // of the contract with the native engine — do not rename.
  // ==========================================================================
  const hasBridge = typeof window.AndroidServer !== 'undefined';
  const pendingAndroidRequests = new Map();
  let androidReqCounter = 1;

  function decodeBase64Utf8(b64) {
    const binString = window.atob(b64);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) bytes[i] = binString.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // The engine passes the JSON text itself; engines before 1.7.0 sent it as
  // base64, which never starts with "{" or "[".
  window.__onAndroidServerResponse = function (reqId, status, payload) {
    const entry = pendingAndroidRequests.get(reqId);
    if (!entry) return;
    pendingAndroidRequests.delete(reqId);
    try {
      const text = String(payload || '');
      const data = JSON.parse((/^[[{]/.test(text) ? text : decodeBase64Utf8(text)) || '{}');
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

  /** Calls the native backend (LocalBackendServer.routeRequest) through the bridge. */
  function api(endpoint, options = {}) {
    if (!hasBridge || typeof window.AndroidServer.requestAsync !== 'function') {
      return Promise.reject(new Error('Нет связи с приложением: интерфейс открыт вне AGY Roleplay.'));
    }
    const method = (options.method || 'GET').toUpperCase();
    const bodyStr = typeof options.body === 'string' ? options.body : (options.body ? JSON.stringify(options.body) : '');
    const reqId = 'req_' + (androidReqCounter++) + '_' + Date.now();
    return new Promise((resolve, reject) => {
      pendingAndroidRequests.set(reqId, { resolve, reject });
      window.AndroidServer.requestAsync(reqId, method, endpoint, bodyStr);
    });
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
      // Markers left unpaired, e.g. when the engine cut the text to a preview.
      .replace(/\*+/g, '')
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

  // Photo avatars are data: URIs of ~100 KB. Each becomes one blob: URL, so the
  // DOM (a chat repeats the avatar on every message) and the image cache hold a
  // short URL instead of another copy of the picture.
  const avatarObjectUrls = new Map();

  function objectUrlFor(dataUrl) {
    const cached = avatarObjectUrls.get(dataUrl);
    if (cached) return cached;
    let url;
    try {
      const comma = dataUrl.indexOf(',');
      const meta = dataUrl.slice(5, comma);
      const base64 = /;base64$/i.test(meta);
      const mime = meta.split(';')[0] || 'application/octet-stream';
      const payload = dataUrl.slice(comma + 1);
      let bytes;
      if (base64) {
        const bin = atob(payload);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      }
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch (e) {
      return dataUrl;
    }
    avatarObjectUrls.set(dataUrl, url);
    return url;
  }

  function resolveAvatarUrl(url, name) {
    const u = String(url || '');
    if (u.startsWith('data:')) return u.length > 2048 ? objectUrlFor(u) : u;
    if (u.startsWith('blob:') || u.startsWith('https://')) return u;
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
   * Reasoning levels a model really honours. The native engine reports them per
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
      return [c.character_name, c.character_title, c.persona_name, c.persona_title, c.title, stripMarkdownPreview(c.last_message)]
        .some(v => String(v || '').toLowerCase().includes(query));
    });
  }

  /** Empty, or "Чат: …" with the card's name or title (the engine names new chats so). */
  function isDefaultChatTitle(title, characterName, cardTitle) {
    const t = String(title || '').trim();
    if (!t) return true;
    return [characterName, cardTitle].some(n => String(n || '').trim() !== '' && t === 'Чат: ' + String(n).trim());
  }

  // --- cards, cast & macros (mirror of "CARDS, CAST & MACROS" in LocalBackendServer.java) ---

  /** What the user calls a card in lists: its title, else its (first character's) name. */
  function cardLabel(c) {
    if (!c) return 'Персонаж';
    return String(c.title || '').trim() || String(c.name || '').trim() || 'Без названия';
  }

  function personaLabel(p) {
    if (!p) return 'Игрок';
    return String(p.title || '').trim() || String(p.name || '').trim() || 'Игрок';
  }

  /** The card's characters: a structured card's list, or a free-text card as character 1. */
  function cardCast(character) {
    if (!character) return [];
    const card = character.card;
    if (card && Array.isArray(card.chars)) {
      return card.chars.map(c => ({ n: Number(c.n) || 0, name: String(c.name || ''), text: String(c.text || '') }));
    }
    return [{ n: 1, name: character.name || 'Персонаж', text: character.fileContent || '', legacy: true }];
  }

  /** The characters replies introduced, from the variant each reply shows. */
  function storyCast(messages) {
    const out = [];
    (messages || []).forEach((m, idx) => {
      if (!m || m.role === 'user' || !Array.isArray(m.cast)) return;
      m.cast.forEach(c => out.push({ n: Number(c.n) || 0, name: String(c.name || ''), text: String(c.text || ''), msgId: m.id, msgIndex: idx }));
    });
    return out;
  }

  /**
   * What the macros of a chat stand for: {{user}} the persona's name, {{charN}}
   * character N (the card's first, then those the replies introduced), {{char}}
   * character 1 or, without one, the card's first character.
   */
  function castMacros(character, persona, messages) {
    const card = cardCast(character);
    const names = {};
    card.concat(storyCast(messages)).forEach(c => {
      if (!(c.n in names)) names[c.n] = c.name;
    });
    return {
      user: persona ? (persona.name || 'Игрок') : null,
      names,
      alias: (1 in names) ? names[1] : (card[0] ? card[0].name : null),
    };
  }

  const MACRO_RE = /\{\{(user|char(\d{0,5}))\}\}/gi;

  /** Fills in {{user}}, {{char}}, {{charN}} (any letter case); a macro without a name stays as written. */
  function applyMacros(text, macros) {
    const m = macros || {};
    return String(text == null ? '' : text).replace(MACRO_RE, (all, word, digits) => {
      let v;
      if (word.toLowerCase() === 'user') v = m.user;
      else if (!digits) v = m.alias;
      else v = (m.names || {})[Number(digits)];
      return v == null ? all : v;
    });
  }

  /**
   * A reply still being written, without its <new_character> blocks: a
   * finished block is cut out, an unfinished one hides everything after it.
   * names: the characters being created ('' while the name is not out yet).
   */
  function splitLiveText(text) {
    const names = [];
    const nameOf = (attrs) => {
      const m = String(attrs || '').match(/name\s*=\s*(?:"([^"]*)"|'([^']*)'|«([^»]*)»|“([^”]*)”|([^\s>"'«“]+))/i);
      return m ? String(m[1] || m[2] || m[3] || m[4] || m[5] || '').trim() : '';
    };
    let out = String(text || '').replace(/<\s*new_character\b([^>]*)>[\s\S]*?<\s*\/\s*new_character\s*>/gi, (all, attrs) => {
      names.push(nameOf(attrs));
      return '';
    });
    const open = out.search(/<\s*new_character\b/i);
    if (open >= 0) {
      const head = out.slice(open).match(/^<\s*new_character\b([^>]*)/i);
      names.push(nameOf(head && head[1]));
      out = out.slice(0, open);
    } else {
      // The tag may be arriving one piece at a time: "<", "<new_", …
      const tail = out.match(/<[a-z_]*$/i);
      if (tail && '<new_character'.startsWith(tail[0].toLowerCase())) out = out.slice(0, tail.index);
    }
    return { text: names.length ? out.replace(/\n{3,}/g, '\n\n').trim() : out, names };
  }

  /**
   * How strong an encryption password looks: a rough estimate from its length
   * and character sets, with obvious patterns marked down. The engine only
   * enforces the minimum length; the meter steers towards a passphrase.
   */
  function passwordStrength(pw, minChars) {
    const s = String(pw || '');
    const chars = Array.from(s);
    const min = minChars || 10;
    if (!chars.length) return { score: 0, label: '', ok: false, hint: `Не короче ${min} символов. Лучше фраза из нескольких слов.` };
    let pool = 0;
    if (/[a-z]/.test(s)) pool += 26;
    if (/[A-Z]/.test(s)) pool += 26;
    if (/[а-яё]/.test(s)) pool += 33;
    if (/[А-ЯЁ]/.test(s)) pool += 33;
    if (/[0-9]/.test(s)) pool += 10;
    if (/[^a-zA-Zа-яёА-ЯЁ0-9]/.test(s)) pool += 20;
    let bits = chars.length * Math.log2(Math.max(pool, 2));
    if (new Set(chars.map(c => c.toLowerCase())).size <= 3) bits = Math.min(bits, 20);
    if (/^(?:0123456789|1234567890|qwerty|йцукен|password|пароль|abcdef)/i.test(s)) bits = Math.min(bits, 25);
    const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
    const missing = min - chars.length;
    let hint = '';
    if (missing > 0) hint = `Ещё ${missing} ${pluralRu(missing, 'символ', 'символа', 'символов')}`;
    else if (score < 2) hint = 'Слишком простой: добавьте слов, цифр или знаков';
    else if (score === 2) hint = 'Можно надёжнее: фраза из 4–5 слов';
    return { score, label: ['', 'Слабый', 'Средний', 'Хороший', 'Сильный'][score], ok: missing <= 0 && score >= 2, hint };
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' Б';
    if (v < 1024 * 1024) return Math.round(v / 1024) + ' КБ';
    return (v / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  /** "только что", "5 мин назад", "21:04", "вчера"… */
  function agoText(ts, now) {
    if (!ts) return '';
    const t = formatRelativeTime(new Date(Number(ts)), now);
    return /мин$/.test(t) ? t + ' назад' : t;
  }

  /** The cloud's state in one line (settings list, page header) from /api/cloud/status. */
  function cloudSummary(c, now) {
    if (!c || !c.configured) return { tone: 'warn', label: 'Настроить', text: 'Не подключено — данные только на этом телефоне' };
    if (!c.signedIn) {
      return { tone: 'warn', label: 'Войти', text: c.linked ? 'Вход в облако истёк — войдите снова' : 'Войдите через Google' };
    }
    if (c.vault === 'none') {
      return { tone: 'warn', label: 'Настроить', text: c.linked ? 'Хранилище в облаке удалено — создайте его заново' : 'Создайте пароль шифрования' };
    }
    if (c.vault === 'locked') return { tone: 'warn', label: 'Пароль', text: 'Введите пароль шифрования' };
    if (c.vault !== 'ready') return { tone: '', label: '…', text: 'Проверяю хранилище…' };
    const who = c.email || 'Аккаунт Google';
    if (c.busy) {
      const phases = { upload: 'загрузка в облако', download: 'загрузка из облака', wipe: 'удаление', sync: 'синхронизация' };
      const n = c.total ? ` ${formatCount(c.done)} из ${formatCount(c.total)}` : (c.done ? ` ${formatCount(c.done)}` : '');
      return { tone: 'ok', label: 'Синхр.', text: `${who} · ${phases[c.phase] || 'синхронизация'}${n}…` };
    }
    if (c.quotaUntil) return { tone: 'warn', label: 'Лимит', text: 'Бесплатный лимит на сегодня исчерпан — данные на телефоне в порядке' };
    if (c.lastError && c.errorKind !== 'skipped') return { tone: 'err', label: 'Ошибка', text: c.lastError };
    const last = agoText(c.lastSyncAt, now);
    const queue = c.pending ? ` · в очереди ${formatCount(c.pending)}` : '';
    return { tone: 'ok', label: 'Готово', text: `${who} · ${last ? 'синхронизировано ' + last : 'ещё не синхронизировано'}${queue}` };
  }

  // ==========================================================================
  // STATE, PREFERENCES, FEATURES
  // ==========================================================================
  const state = {
    engineBuild: 0,
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
    // /api/cloud/status (account, vault, sync); null until the engine answers.
    cloud: null,
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

  // The native engine (APK build) this web layer is made for. The engine only
  // installs an OTA web layer of its own build; this guards against an older
  // engine that still accepts any build.
  const MIN_ENGINE_BUILD = 27;

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

  /** A card found by its title, its characters' names or its description. */
  function cardMatches(c, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [cardLabel(c), c.name, c.description_preview, ...cardCast(c).map(m => m.name)]
      .some(v => String(v || '').toLowerCase().includes(q));
  }

  /** Persona chips (a sheet's data-act="persona"); a persona with a title shows the title. */
  function personaChipsHtml(activeId) {
    return `<div class="chips wrap">${state.personas.map(p => `<button class="chip${p.id === Number(activeId) ? ' active' : ''}" data-act="persona" data-id="${p.id}"><img class="avatar avatar-24" src="${escapeHtml(resolveAvatarUrl(p.avatar_url, personaLabel(p)))}" alt="" />${escapeHtml(personaLabel(p))}</button>`).join('')}</div>`;
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
  // Every layer is a .modal-overlay appended to #layers in opening order; the
  // system Back button closes them top-down (handleBack).
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
    state.engineBuild = Number(s.engineBuild) || 0;
    if (s.appVersion) state.webVersion = s.appVersion;
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
    warnOldEngine();
    state.models = models.models || [];
    state.characters = chars.characters || [];
    state.personas = personas.personas || [];
    if (personas.activePersonaId) state.settings.activePersonaId = Number(personas.activePersonaId);
    state.chats = chats.chats || [];
    state.loaded = true;
    state.loadError = '';
    renderAllTabs();
  }

  let engineWarned = false;

  function warnOldEngine() {
    if (engineWarned || !state.engineBuild || state.engineBuild >= MIN_ENGINE_BUILD) return;
    engineWarned = true;
    toast(`Этот интерфейс сделан для APK build ${MIN_ENGINE_BUILD}, а установлен build ${state.engineBuild}. Скачайте новый APK или сбросьте интерфейс к APK на странице «Обновления».`, {
      type: 'error',
      duration: 15000,
      action: { label: 'Обновления', fn: () => openUpdatesPage() },
    });
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
      // Sign-in is done when new credentials appear (not old ones).
      state.settings.claudeCredentialsStamp = data.credentialsStamp;
      state.settings.claudeLoginBaseStamp = data.loginBaseStamp;
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

  async function refreshCloudStatus() {
    try {
      state.cloud = await api('/api/cloud/status');
    } catch (e) {
      // keep the last known state
      return state.cloud;
    }
    if (state.tab === 'settings') renderSettingsTab();
    refreshLayers();
    return state.cloud;
  }

  // The browser came back from the cloud's Google sign-in (CloudSync.onBrowserSignIn).
  window.__onCloudAuthDone = function (ok) {
    refreshCloudStatus().then((c) => {
      if (ok) toast('Вход выполнен: ' + ((c && c.email) || 'аккаунт Google'), { type: 'success' });
      else toast((c && c.loginError) || 'Вход не выполнен', { type: 'error', duration: 9000 });
    });
  };

  // Another device changed data and this one took it in: reload what is shown.
  window.__onCloudSyncChanged = function (info) {
    const changed = info || {};
    if (changed.prompt) state.systemPromptText = null;
    const room = state.room;
    const roomId = room ? room.chatId : 0;
    loadAll().then(async () => {
      if (!room || state.room !== room) return;
      if ((changed.deletedChatIds || []).includes(roomId)) {
        closeChatRoom();
        toast('Этот чат удалили на другом устройстве');
        return;
      }
      if (!(changed.chatIds || []).includes(roomId) && !changed.cards) return;
      // A reply being generated here will refresh the chat itself when it ends.
      if (state.generations[roomId]) return;
      try {
        const data = withCardImages(await api(`/api/chats/${roomId}`));
        if (state.room !== room) return;
        room.data = data;
        renderRoomHeader();
        syncFeed();
      } catch (e) {
        // the chat stays as shown
      }
    }).catch(() => {});
    refreshCloudStatus();
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
      refreshCloudStatus();
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
   * then returns to the Chats tab, and finally lets the app go to the background.
   * Called by MainActivity.onBackPressed.
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
      if (id && !seen.has(id)) seen.set(id, { id, name: chatCardLabel(c), avatar: (findChar(id) || {}).avatar_url });
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

  /** The card's label for a row of the chat list (the list comes without the cards). */
  function chatCardLabel(c) {
    return String(c.character_title || '').trim() || c.character_name || 'Персонаж';
  }

  /** A chat list row's last message with the names filled in (characters of later replies are not in the list). */
  function chatPreview(c) {
    const card = findChar(c.character_id) || { name: c.character_name };
    return stripMarkdownPreview(applyMacros(c.last_message, castMacros(card, { name: c.persona_name }, [])));
  }

  function chatRowHtml(c) {
    const time = formatRelativeTime(chatActivityTime(c));
    const P = PROVIDERS[providerOf(c.model_id)];
    const custom = !isDefaultChatTitle(c.title, c.character_name, c.character_title);
    const meta = [custom ? c.title : '', String(c.persona_title || '').trim() || c.persona_name || 'Игрок'].filter(Boolean).map(escapeHtml).join(' · ');
    const preview = chatPreview(c);
    const gen = state.generations[c.id];
    const ch = findChar(c.character_id);
    const label = chatCardLabel(c);
    return `<div class="chat-row" data-chat-id="${c.id}">
      <div class="chat-row-actions">
        <button class="act-export" data-action="chat-export" data-id="${c.id}">${ic('share', 'ic-sm')}Экспорт</button>
        <button class="act-delete" data-action="chat-delete" data-id="${c.id}">${ic('trash', 'ic-sm')}Удалить</button>
      </div>
      <div class="chat-row-main" role="button" tabindex="0" data-action="open-chat" data-id="${c.id}">
        <img class="avatar avatar-52" src="${escapeHtml(resolveAvatarUrl(ch && ch.avatar_url, label))}" alt="" />
        <div class="chat-row-body">
          <div class="chat-row-top"><span class="chat-row-name">${escapeHtml(label)}</span><span class="chat-row-time">${escapeHtml(time)}</span></div>
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
      title: chatCardLabel(c),
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
      message: c ? `Чат с «${chatCardLabel(c)}» и ${n} ${pluralRu(n, 'сообщение', 'сообщения', 'сообщений')} будут удалены без возможности восстановления.` : 'Чат будет удалён без возможности восстановления.',
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
      const chars = state.characters.filter(c => !sel.q || cardMatches(c, sel.q));
      const prov = providerOf(sel.modelId);
      const status = providerStatus(prov);
      const greeting = ch ? stripMarkdownPreview(applyMacros(ch.first_message || '', castMacros(ch, findPersona(sel.personaId), []))) : '';
      return `
        ${state.characters.length > 6 ? `<label class="search-field" style="margin-bottom:12px">${ic('search', 'ic-sm')}<input data-role="q" placeholder="Найти персонажа" value="${escapeHtml(sel.q)}" autocomplete="off" /></label>` : ''}
        <div class="section-title">Персонаж</div>
        <div class="pick-grid">${chars.map(c => `<button class="pick-card${c.id === sel.charId ? ' active' : ''}" data-act="char" data-id="${c.id}">
            <img class="avatar avatar-64" src="${escapeHtml(resolveAvatarUrl(c.avatar_url, cardLabel(c)))}" alt="" />
            <span class="pick-name">${escapeHtml(cardLabel(c))}</span></button>`).join('') || '<div class="faint">Нет совпадений</div>'}</div>
        <div class="greeting-preview">${greeting
          ? `${ic('chat', 'ic-xs')}<span>Начнётся с приветствия: «${escapeHtml(greeting.slice(0, 140))}${greeting.length > 140 ? '…' : ''}»</span>`
          : `${ic('info', 'ic-xs')}<span>У персонажа нет приветствия — первым пишете вы.</span>`}</div>

        <div class="section">
          <div class="section-title">Вы играете за</div>
          ${state.personas.length
            ? personaChipsHtml(sel.personaId)
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
  /**
   * Chat details come without card images (a photo is ~100-200 KB and the
   * character and persona lists already hold it): fill them in from there.
   */
  function withCardImages(data) {
    if (data && data.character && data.character.avatar_url === undefined) {
      const c = findChar(data.character.id);
      data.character.avatar_url = c ? c.avatar_url : '';
    }
    if (data && data.persona && data.persona.avatar_url === undefined) {
      const p = findPersona(data.persona.id);
      data.persona.avatar_url = p ? p.avatar_url : '';
    }
    return data;
  }

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
    withCardImages(data);
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
    const title = isDefaultChatTitle(d.chat.title, ch.name, ch.title) ? cardLabel(ch) : d.chat.title;
    $('#chatHeaderAvatar').src = resolveAvatarUrl(ch.avatar_url, cardLabel(ch));
    $('#chatHeaderName').textContent = title;
    $('#chatHeaderSub').textContent = modelSummary(d.chat.model_id, d.chat.effort) + ' · ' + personaLabel(persona);
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
    const character = d.character || {};
    const persona = d.persona || {};
    const macros = castMacros(character, persona, msgs);
    return { msgs, lastAiIdx, character, persona, macros, macroSig: JSON.stringify(macros) };
  }

  function messageSig(m, idx, ctx, extra) {
    return JSON.stringify([
      m.content, m.swipe_index, (m.swipes || []).length, (m.thoughts || '').length, m.created_at,
      idx === ctx.lastAiIdx, idx === 0, cardLabel(ctx.character), ctx.character.avatar_url ? ctx.character.avatar_url.length : 0,
      ctx.persona.name, ctx.persona.avatar_url ? ctx.persona.avatar_url.length : 0, ctx.macroSig, m.cast || [], extra || '',
    ]);
  }

  /** The chips under a reply for the characters its shown variant introduced. */
  function castChipsHtml(m) {
    if (!Array.isArray(m.cast) || !m.cast.length) return '';
    return `<div class="cast-chips">${m.cast.map(c => `<button class="cast-chip" data-action="story-character" data-msg="${m.id}" data-n="${Number(c.n)}">${ic('user-plus', 'ic-xs')}<span class="cast-chip-name">${escapeHtml(c.name)}</span><span class="cast-num">{{char${Number(c.n)}}}</span></button>`).join('')}</div>`;
  }

  function messageHtml(m, idx, ctx, opts) {
    const isUser = m.role === 'user';
    const name = isUser ? (ctx.persona.name || 'Вы') : cardLabel(ctx.character);
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

    const text = formatRoleplayHtml(applyMacros(m.content, ctx.macros), { dialogue: prefs.dialogue });
    if (isUser) {
      return `<div class="msg user${hiddenCls}" data-msg-id="${m.id}">${head}<div class="msg-card"><div class="msg-text">${text}</div></div></div>`;
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
    return `<div class="msg assistant${hiddenCls}" data-msg-id="${m.id}"${swipeable ? ' data-swipeable="1"' : ''}>${head}${thoughtsHtml}<div class="msg-text">${text}</div>${castChipsHtml(m)}${foot}</div>`;
  }

  function introHtml(ctx) {
    return `<div class="feed-intro">
      <img class="avatar avatar-64" src="${escapeHtml(resolveAvatarUrl(ctx.character.avatar_url, cardLabel(ctx.character)))}" alt="" />
      <div class="empty-title">${escapeHtml(cardLabel(ctx.character))}</div>
      <div>У персонажа нет приветствия. Опишите сцену и сделайте первый ход.</div>
    </div>`;
  }

  function liveHtml(ctx) {
    const name = cardLabel(ctx.character);
    return `<div class="msg assistant live">
      <div class="msg-head">
        <img class="avatar avatar-28" src="${escapeHtml(resolveAvatarUrl(ctx.character.avatar_url, name))}" alt="" />
        <span class="msg-name">${escapeHtml(name)}</span>
        <span class="live-status"><span data-live="status">Подготовка…</span><span class="elapsed" data-live="elapsed"></span></span>
        <button class="icon-btn sm" data-action="open-diagnostics" aria-label="Ход генерации">${ic('activity', 'ic-sm')}</button>
      </div>
      <details class="thoughts hidden" data-live="thoughts-wrap"${prefs.thoughtsOpen ? ' open' : ''}><summary>${ic('bulb')}<span data-live="thoughts-label">Мысли</span>${ic('chevron-down', 'chev')}</summary><div class="thoughts-body" data-live="thoughts"></div></details>
      <div class="msg-text" data-live="text"><div class="typing-dots"><i></i><i></i><i></i></div></div>
      <div class="cast-chips" data-live="cast"></div>
    </div>`;
  }

  function isAuthError(message) {
    return /401|авториз|войдите|войти|Нужен вход|токен|сесси|Project ID|Среда Claude Code не установлена|Нет авторизации/i.test(String(message || ''));
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

    if (!ctx.msgs.length && !gen) items.push({ key: 'intro', sig: 'intro' + cardLabel(ctx.character), html: () => introHtml(ctx) });
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
        // A <new_character> block is not shown raw: a chip stands for it until the reply is saved.
        const parts = splitLiveText(g.text);
        textEl.innerHTML = formatRoleplayHtml(parts.text, { dialogue: prefs.dialogue });
        const castEl = $('[data-live="cast"]', live);
        if (castEl) {
          castEl.innerHTML = parts.names.map(n => `<span class="cast-chip pending">${ic('user-plus', 'ic-xs')}<span class="cast-chip-name">${escapeHtml(n ? `Создаётся персонаж «${n}»…` : 'Создаётся новый персонаж…')}</span></span>`).join('');
        }
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
      btn.classList.add('stop');
      btn.dataset.action = 'stop';
      btn.setAttribute('aria-label', 'Остановить генерацию');
      btn.innerHTML = gen.stopping ? '<span class="spinner"></span>' : ic('stop');
      btn.disabled = Boolean(gen.stopping);
    } else {
      btn.dataset.action = 'send';
      btn.setAttribute('aria-label', 'Отправить');
      btn.innerHTML = ic('send');
    }
  }

  // --- generation lifecycle ------------------------------------------------
  let pollTimer = null;
  let tickTimer = null;
  let pollBusy = false;

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
    if (pollBusy || document.visibilityState === 'hidden') return;
    pollBusy = true;
    try {
      await pollWatched(ids);
    } finally {
      pollBusy = false;
    }
  }

  async function pollWatched(ids) {
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
              state.room.data = withCardImages(await api(`/api/chats/${id}`));
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
    const cancelled = Boolean((err && err.data && err.data.cancelled) || (g && g.cancelled));
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
      if (state.room && state.room.chatId === chatId) {
        const list = state.room.data.messages.filter(m => m.id !== temp.id);
        if (res.userMessage) list.push(res.userMessage);
        if (res.assistantMessage) list.push(res.assistantMessage);
        state.room.data.messages = Array.isArray(res.messages) ? res.messages : list;
        announceNewCharacters(res.assistantMessage);
      }
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
      if (state.room && state.room.chatId === chatId) announceNewCharacters(res.message);
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
    if (!gen || gen.stopping) return;
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

  /** A toast for the characters a new reply introduced (its <new_character> blocks). */
  function announceNewCharacters(msg) {
    const cast = msg && Array.isArray(msg.cast) ? msg.cast : [];
    if (!cast.length) return;
    toast(`${cast.length > 1 ? 'Новые персонажи' : 'Новый персонаж'}: ${cast.map(c => c.name).join(', ')}`, {
      type: 'success',
      action: { label: 'Открыть', fn: () => openStoryCharacter(msg.id, Number(cast[0].n)) },
    });
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
    const shown = applyMacros(m.content, ctx.macros);
    actionSheet({
      title: isUser ? (ctx.persona.name || 'Ваше сообщение') : cardLabel(ctx.character),
      items: [
        { icon: 'copy', label: 'Копировать', onSelect: () => copyText(shown) },
        { icon: 'file', label: 'Выделить текст', onSelect: () => openTextSheet('Текст сообщения', shown, { selectable: true }) },
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
      body: `<textarea class="textarea tall" data-role="text" data-macro-target="1">${escapeHtml(m.content)}</textarea>
        ${macroBarHtml(feedContext().macros)}
        <p class="section-hint">Макросы {{user}} и {{charN}} хранятся как есть, а в ленте и для модели заменяются именами.</p>
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
    bindMacroBar(layer);
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
    const m = room.data.messages.find(x => x.id === msgId);
    const ok = await confirmDialog({
      title: 'Удалить сообщение?',
      message: 'Все его варианты тоже будут удалены.' + castLossNote(m ? [m] : []),
      confirmText: 'Удалить',
      danger: true,
    });
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
      message: `${victims.length} ${pluralRu(victims.length, 'сообщение', 'сообщения', 'сообщений')} после выбранного будут удалены.` + castLossNote(victims),
      confirmText: 'Откатить',
      danger: true,
    });
    if (!ok) return;
    let removed = 0;
    try {
      const res = await api(`/api/chats/${chatId}/messages?after=${msgId}`, { method: 'DELETE' });
      removed = Number(res.removed) || 0;
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
    try {
      const data = withCardImages(await api(`/api/chats/${chatId}`));
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

  // --- macros in editors ------------------------------------------------------
  /** Chips that insert {{user}} / {{charN}} where the cursor was in the layer's last focused [data-macro-target] field. */
  function macroBarHtml(macros) {
    const names = (macros && macros.names) || {};
    const nums = Object.keys(names).map(Number).sort((a, b) => a - b);
    return `<div class="macro-chips"><button class="chip sm" data-act="macro" data-macro="{{user}}">{{user}}</button>${nums.map(n =>
      `<button class="chip sm" data-act="macro" data-macro="{{char${n}}}">{{char${n}}}${names[n] ? `<span class="chip-sub">${escapeHtml(names[n])}</span>` : ''}</button>`).join('')}</div>`;
  }

  function bindMacroBar(layer) {
    let target = null;
    layer.el.addEventListener('focusin', (e) => {
      if (e.target.matches && e.target.matches('[data-macro-target]')) target = e.target;
    });
    // A tap on a chip must not move the cursor out of the field.
    layer.el.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-act="macro"]')) e.preventDefault();
    });
    bindActs(layer, {
      macro: (el) => {
        const field = target && layer.el.contains(target) ? target : $('[data-macro-target]', layer.el);
        if (!field) return;
        const macro = el.dataset.macro;
        const s = field.selectionStart ?? field.value.length;
        const e2 = field.selectionEnd ?? s;
        field.value = field.value.slice(0, s) + macro + field.value.slice(e2);
        field.focus();
        field.setSelectionRange(s + macro.length, s + macro.length);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      },
    });
  }

  /** " Вместе с ним удалятся персонажи…" when replies about to go introduced characters (in any variant). */
  function castLossNote(messages) {
    const names = [];
    (messages || []).forEach(m => (m.cast_swipes || [m.cast || []]).forEach(list => (list || []).forEach(c => {
      if (!names.includes(c.name)) names.push(c.name);
    })));
    if (!names.length) return '';
    return ` Вместе с ${messages.length > 1 ? 'ними' : 'ним'} удалятся персонажи из ответов: ${names.join(', ')}.`;
  }

  // --- the chat's characters: the card's and those the replies introduced ----
  function scrollToMessage(msgId) {
    const el = $(`#chatFeed [data-msg-id="${Number(msgId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }

  function openCastSheet() {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;
    const data = () => (state.room && state.room.chatId === chatId ? state.room.data : null);

    const render = () => {
      const d = data();
      if (!d) return '';
      const ch = d.character || {};
      const macros = castMacros(ch, d.persona, d.messages);
      const card = cardCast(ch);
      const story = storyCast(d.messages);
      const world = ch.card ? String(ch.card.world || '').trim() : '';
      const preview = (text) => stripMarkdownPreview(applyMacros(text, macros)).slice(0, 160) || 'Без описания';
      const row = (c, act) => `<button class="row" data-act="${act}" data-n="${c.n}"${c.msgId ? ` data-msg="${c.msgId}"` : ''}>
          <img class="avatar avatar-36" src="${escapeHtml(initialsAvatar(c.name))}" alt="" />
          <div class="row-body"><div class="row-title">${escapeHtml(c.name)} <span class="cast-num">{{char${c.n}}}</span></div><div class="row-sub">${escapeHtml(preview(c.text))}</div></div>
          ${ic('chevron-right', 'row-chevron')}</button>`;
      return `
        ${world ? `<div class="section"><div class="section-title">Мир</div><div class="list"><button class="row" data-act="world"><span class="row-icon">${ic('book')}</span><div class="row-body"><div class="row-title">Настройки мира</div><div class="row-sub">${escapeHtml(preview(world))}</div></div>${ic('chevron-right', 'row-chevron')}</button></div></div>` : ''}
        <div class="section"><div class="section-title">Из карточки</div>
          ${card.length ? `<div class="list">${card.map(c => row(c, 'card-char')).join('')}</div>` : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">В карточке нет персонажей — только мир.</div>'}
        </div>
        <div class="section"><div class="section-title">Появились в истории${story.length ? ' · ' + story.length : ''}</div>
          ${story.length ? `<div class="list">${story.map(c => row(c, 'story-char')).join('')}</div>`
            : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Пока никого. Когда модель введёт важного персонажа блоком &lt;new_character name="…"&gt;, он появится здесь: полное описание уйдёт в &lt;character_persona&gt;, а в ответе останется короткое. Формат блока задаёт ваш системный промпт.</div>'}
        </div>`;
    };

    const layer = openSheet({ title: 'Персонажи', full: true, body: render() });
    layer.chatId = chatId;
    layer.refresh = () => {
      const body = $('.sheet-body', layer.el);
      const scroll = body.scrollTop;
      layer.setBody(render());
      body.scrollTop = scroll;
    };
    bindActs(layer, {
      world: () => {
        const d = data();
        if (!d || !d.character.card) return;
        openTextSheet('Настройки мира', applyMacros(d.character.card.world || '', castMacros(d.character, d.persona, d.messages)));
      },
      'card-char': (el) => openCardCharacter(Number(el.dataset.n)),
      'story-char': (el) => openStoryCharacter(Number(el.dataset.msg), Number(el.dataset.n)),
    });
  }

  /** A character of the chat's card, read-only (the card editor changes it). */
  function openCardCharacter(n) {
    const room = state.room;
    if (!room) return;
    const d = room.data;
    const ch = d.character || {};
    const c = cardCast(ch).find(x => x.n === n);
    if (!c) return;
    const text = applyMacros(c.text, castMacros(ch, d.persona, d.messages)).trim();
    const layer = openSheet({
      title: c.name,
      full: true,
      body: `<div class="cast-meta"><span class="cast-num">{{char${n}}}</span><span>из карточки «${escapeHtml(cardLabel(ch))}»</span></div>
        ${text ? `<div class="prose">${escapeHtml(text)}</div>` : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Описание не заполнено.</div>'}`,
      footer: findChar(ch.id) ? `<button class="btn btn-secondary btn-block" data-act="edit">${ic('edit')}Изменить карточку</button>` : '',
    });
    bindActs(layer, { edit: () => openCharacterEditor(ch.id) });
  }

  /** A character a reply introduced: rename, rewrite or delete its full description. */
  function openStoryCharacter(msgId, n) {
    const room = state.room;
    if (!room) return;
    const chatId = room.chatId;
    const find = () => {
      const d = state.room && state.room.chatId === chatId ? state.room.data : null;
      const m = d && d.messages.find(x => x.id === msgId);
      const c = m && Array.isArray(m.cast) ? m.cast.find(x => Number(x.n) === n) : null;
      return { m, c };
    };
    const found = find();
    if (!found.c) {
      toast('Персонаж не найден: у ответа выбран другой вариант');
      return;
    }
    const init = { name: found.c.name, text: found.c.text || '' };
    const cur = Object.assign({}, init);
    const dirty = () => cur.name !== init.name || cur.text !== init.text;
    const busy = () => Boolean(state.generations[chatId]);
    const layer = openSheet({
      title: 'Персонаж из истории',
      full: true,
      body: `<div class="cast-meta"><span class="cast-num">{{char${n}}}</span><span>появился в ответе модели</span></div>
        <label class="field"><span class="field-label">Имя</span><input class="input" data-field="name" value="${escapeHtml(cur.name)}" maxlength="80" autocomplete="off" /></label>
        <label class="field"><span class="field-label">Полное описание · попадает в &lt;character_persona&gt;</span><textarea class="textarea" data-field="text">${escapeHtml(cur.text)}</textarea></label>
        <div class="list"><button class="row" data-act="goto"><span class="row-icon">${ic('chat')}</span><div class="row-body"><div class="row-title">К сообщению</div><div class="row-sub">Ответ, в котором появился персонаж</div></div>${ic('chevron-right', 'row-chevron')}</button></div>
        <div class="danger-zone"><button class="btn btn-danger btn-block" data-act="delete">${ic('trash')}Удалить персонажа</button>
          <p class="section-hint">Полное описание удалится и больше не попадёт к модели. Короткое упоминание в ответе останется.</p></div>`,
      footer: `<div class="btn-row"><button class="btn btn-secondary" data-action="layer-close">Закрыть</button><button class="btn btn-primary" data-act="save">Сохранить</button></div>`,
      onBack: () => {
        if (!dirty()) return true;
        confirmDialog({ title: 'Выйти без сохранения?', message: 'Изменения будут потеряны.', confirmText: 'Выйти', cancelText: 'Остаться', danger: true })
          .then(ok => ok && layer.close());
        return false;
      },
    });
    layer.chatId = chatId;
    $$('textarea', layer.el).forEach(t => autoGrow(t));
    layer.el.addEventListener('input', (e) => {
      const f = e.target.dataset.field;
      if (!f) return;
      cur[f] = e.target.value;
      if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
    });
    const putCast = async (cast) => {
      const res = await api(`/api/messages/${msgId}`, { method: 'PUT', body: { cast } });
      replaceMessage(chatId, res.message);
      if (state.room && state.room.chatId === chatId) syncFeed({ scroll: 'keep' });
      refreshLayers();
    };
    bindActs(layer, {
      save: async (btn) => {
        const name = cur.name.trim();
        if (!name) {
          toast('Введите имя персонажа');
          return;
        }
        const { m } = find();
        if (!m || busy()) {
          toast(busy() ? 'Дождитесь окончания генерации' : 'Сообщение не найдено');
          return;
        }
        btn.disabled = true;
        try {
          await putCast(m.cast.map(x => (Number(x.n) === n ? { n, name, text: cur.text } : x)));
          Object.assign(init, cur);
          layer.close();
          toast('Персонаж сохранён', { type: 'success' });
        } catch (e) {
          btn.disabled = false;
          toast(e.message, { type: 'error' });
        }
      },
      delete: async () => {
        const ok = await confirmDialog({
          title: `Удалить «${init.name}»?`,
          message: 'Полное описание удалится и больше не попадёт к модели. Короткое упоминание в ответе останется.',
          confirmText: 'Удалить',
          danger: true,
        });
        if (!ok) return;
        const { m } = find();
        if (!m || busy()) {
          toast(busy() ? 'Дождитесь окончания генерации' : 'Сообщение не найдено');
          return;
        }
        try {
          await putCast(m.cast.filter(x => Number(x.n) !== n));
          Object.assign(cur, init);
          layer.close();
          toast('Персонаж удалён');
        } catch (e) {
          toast(e.message, { type: 'error' });
        }
      },
      goto: () => {
        if (dirty()) {
          toast('Сначала сохраните изменения или закройте без сохранения');
          return;
        }
        closeLayersAbove(null);
        scrollToMessage(msgId);
      },
    });
  }

  // --- chat settings sheet --------------------------------------------------
  async function patchChat(chatId, body) {
    const res = withCardImages(await api(`/api/chats/${chatId}`, { method: 'PATCH', body }));
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
      const custom = isDefaultChatTitle(chat.title, ch.name, ch.title) ? '' : chat.title;
      const msgCount = (d.messages || []).length;
      const castCount = cardCast(ch).length + storyCast(d.messages).length;
      return `
        <div style="display:flex;align-items:center;gap:14px;padding:4px 0 14px">
          <img class="avatar avatar-52" src="${escapeHtml(resolveAvatarUrl(ch.avatar_url, cardLabel(ch)))}" alt="" />
          <div class="row-body"><div class="row-title" style="font-size:var(--fs-lg)">${escapeHtml(cardLabel(ch))}</div><div class="row-sub">${msgCount} ${pluralRu(msgCount, 'сообщение', 'сообщения', 'сообщений')}</div></div>
        </div>
        <label class="field"><span class="field-label">Название чата</span><input class="input" data-role="title" value="${escapeHtml(custom)}" placeholder="${escapeHtml(cardLabel(ch))}" maxlength="120" autocomplete="off" /><span class="field-hint">Помогает различать несколько историй с одним персонажем.</span></label>
        <div class="section">
          <div class="section-title">Модель этого чата</div>
          <div class="list"><button class="row" data-act="model"><span class="row-icon">${ic(PROVIDERS[prov].icon)}</span><div class="row-body"><div class="row-title">${escapeHtml(modelName(chat.model_id))}</div><div class="row-sub">${escapeHtml(PROVIDERS[prov].label)}${effectiveEffort(chat.model_id, chat.effort, state.models) ? ' · ' + EFFORT_LABELS[effectiveEffort(chat.model_id, chat.effort, state.models)] : ''}</div></div>${ic('chevron-right', 'row-chevron')}</button></div>
        </div>
        <div class="section">
          <div class="section-title">Вы играете за</div>
          ${state.personas.length ? personaChipsHtml(chat.persona_id) : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Персон пока нет. Создайте её во вкладке «Персоны».</div>'}
        </div>
        <div class="section">
          <div class="section-title">Контекст</div>
          <div class="list">
            <button class="row" data-act="cast"><span class="row-icon">${ic('users')}</span><div class="row-body"><div class="row-title">Персонажи · ${castCount}</div><div class="row-sub">Из карточки и появившиеся в истории</div></div>${ic('chevron-right', 'row-chevron')}</button>
            <button class="row" data-act="memory"><span class="row-icon">${ic('book')}</span><div class="row-body"><div class="row-title">Память чата</div><div class="row-sub">Заметки для модели в &lt;chat_memory&gt;</div></div>${ic('chevron-right', 'row-chevron')}</button>
            <button class="row" data-act="prompt"><span class="row-icon">${ic('eye')}</span><div class="row-body"><div class="row-title">Итоговый системный промпт</div><div class="row-sub">Ровно то, что получает модель</div></div>${ic('chevron-right', 'row-chevron')}</button>
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
      const current = isDefaultChatTitle(d.chat.title, d.character.name, d.character.title) ? '' : d.chat.title;
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
      cast: () => openCastSheet(),
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

  /**
   * What a model gets besides the system prompt; nothing else is added or
   * changed. Mirrors buildClaudeTranscript() / generateRoleplayReply() in
   * LocalBackendServer.java (character: the chat's card).
   */
  function deliveryNote(modelId, character) {
    const card = cardCast(character || null);
    const single = card.length === 1 ? card[0].name : '';
    const shared = ' Макросы {{user}} и {{charN}} в сообщениях заменяются именами. Блоки <new_character name="…"> из ответов модели вынимаются: полное описание уходит в <character_persona>, а в истории остаётся остальной текст ответа.';
    if (isClaudeCliModel(modelId)) {
      const task = single
        ? `Продолжи ролевую игру одной следующей репликой за персонажа «${single}». Выведи только сам ответ персонажа без имени в начале и мета-комментариев.`
        : 'Продолжи ролевую игру одной следующей репликой. Выведи только сам ответ без имени в начале и мета-комментариев.';
      return `Claude Code получает историю чата одним сообщением: каждая реплика с именем говорящего (ответы модели подписаны «${single || 'Рассказчик'}»), а в конце задание — «${task}»` + shared;
    }
    return 'История чата передаётся целиком, текст сообщений не переписывается. Если чат начинается с приветствия персонажа, перед ним стоит служебная реплика «[Начало ролевой игры]»: API требует, чтобы первой шла реплика игрока.' + shared;
  }

  async function openPromptPreview(chatId) {
    const layer = openSheet({ title: 'Системный промпт чата', full: true, body: '<div class="empty"><span class="spinner"></span></div>' });
    const room = state.room && state.room.chatId === chatId ? state.room.data : null;
    const chat = room ? room.chat : null;
    const note = `<details class="disclosure" style="margin:0 0 12px"><summary>Что ещё получает модель ${ic('chevron-down', 'ic-sm')}</summary><p class="section-hint" style="margin:6px 0 0">${escapeHtml(deliveryNote(chat && chat.model_id, room && room.character))}</p></details>`;
    try {
      const res = await api(`/api/chats/${chatId}/system-prompt`);
      const text = res.systemPrompt || '';
      layer.setBody(text
        ? `<p class="section-hint" style="margin:0 0 10px">${formatCount(text.length)} симв. Собирается заново перед каждым ответом.</p>${note}<div class="prose mono" style="font-size:13px">${escapeHtml(text)}</div>`
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
  function sanitizeFilenamePart(str) {
    return String(str || 'chat').trim().replace(/[^\wЀ-ӿ-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'chat';
  }

  function buildExport(src, o) {
    const { chat, character, persona } = src.data;
    const messages = src.data.messages || [];
    const ext = o.format === 'json' ? 'json' : 'md';
    const filename = `chat_${chat.id}_${sanitizeFilenamePart(cardLabel(character))}.${ext}`;
    // As the chat shows it: names instead of {{user}} / {{charN}}.
    const macros = castMacros(character, persona, messages);
    const variants = (m) => {
      const swipes = (Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content || '']).map(t => applyMacros(t, macros));
      const idx = Math.min(Math.max(0, Number(m.swipe_index) || 0), swipes.length - 1);
      const thoughtSwipes = Array.isArray(m.thought_swipes) ? m.thought_swipes : [];
      return { swipes, idx, text: swipes[idx] || applyMacros(m.content || '', macros), thoughts: m.thoughts || thoughtSwipes[idx] || '', thoughtSwipes };
    };

    if (o.format === 'json') {
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: state.webVersion || (state.updateInfo && state.updateInfo.currentVersion) || '',
        chat: { id: chat.id, title: chat.title, model_id: chat.model_id, model_label: modelName(chat.model_id), effort: chat.effort, created_at: chat.created_at || '' },
        character: { id: character && character.id, name: character && character.name, title: character && character.title, file_path: character && character.file_path, first_message: character && character.first_message },
        persona: { id: persona && persona.id, name: persona && persona.name, title: persona && persona.title, file_path: persona && persona.file_path },
      };
      if (o.prompts) {
        payload.context = { systemPrompt: src.systemPrompt };
      }
      payload.messages = messages.map((m, i) => {
        const v = variants(m);
        const out = { index: i + 1, id: m.id, role: m.role, author: m.role === 'user' ? (persona && persona.name) : cardLabel(character), created_at: m.created_at, content: v.text };
        if (Array.isArray(m.cast) && m.cast.length) out.new_characters = m.cast;
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
    const charName = cardLabel(character);
    const personaName = (persona && persona.name) || 'Игрок';
    lines.push(`# ${isDefaultChatTitle(chat.title, character && character.name, character && character.title) ? charName : chat.title}`);
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
      block('Итоговый системный промпт', src.systemPrompt);
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
      if (Array.isArray(m.cast) && m.cast.length) {
        lines.push(`*${m.cast.length > 1 ? 'Новые персонажи' : 'Новый персонаж'}: ${m.cast.map(c => `${c.name} ({{char${c.n}}})`).join(', ')}*`, '');
      }
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
        // Android hands shared text over in one Binder transaction (about 1 MB,
        // two bytes per character); a long chat does not fit.
        if (result.text.length > 200000) {
          toast('Чат слишком большой, чтобы поделиться текстом. Сохраните его файлом.', {
            action: { label: 'Сохранить', fn: () => saveFile(result.filename, result.text, result.mime) },
          });
          return;
        }
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
      let systemPrompt = '';
      try {
        systemPrompt = (await api(`/api/chats/${id}/system-prompt`)).systemPrompt || '';
      } catch (e) {
        systemPrompt = '';
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
      src = { data, systemPrompt, generation };
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
      host.innerHTML = emptyHtml('mask', 'Персонажей пока нет', 'Карточка — это портрет, настройки мира и один или несколько персонажей (всё попадает в &lt;character_persona&gt;) и приветствие, с которого начинается чат.',
        `<button class="btn btn-primary" data-action="new-character">${ic('plus')}Создать персонажа</button>`);
      return;
    }
    toolbar.innerHTML = state.characters.length > 1
      ? `<div class="chips" style="margin-bottom:12px"><button class="chip sm${state.charsSort === 'name' ? ' active' : ''}" data-action="chars-sort" data-sort="name">По имени</button><button class="chip sm${state.charsSort === 'recent' ? ' active' : ''}" data-action="chars-sort" data-sort="recent">Недавние</button></div>`
      : '';
    let list = state.characters.filter(c => cardMatches(c, state.charsQuery));
    const byLabel = (a, b) => cardLabel(a).localeCompare(cardLabel(b), 'ru');
    if (state.charsSort === 'recent') {
      const lastOf = (c) => {
        const t = chatActivityTime(chatsOfCharacter(c.id)[0]);
        return t ? t.getTime() : 0;
      };
      list = list.slice().sort((a, b) => lastOf(b) - lastOf(a) || byLabel(a, b));
    } else {
      list = list.slice().sort(byLabel);
    }
    host.innerHTML = list.length
      ? `<div class="char-grid">${list.map(c => {
        const n = chatsOfCharacter(c.id).length;
        // A card of several characters lists them; one of a single character shows its description.
        const cast = c.card ? cardCast(c) : [];
        const desc = (cast.length > 1 ? cast.map(m => m.name).join(', ') + ' · ' : '')
          + (stripMarkdownPreview(c.description_preview || (c.card ? '' : c.fileContent) || '') || (cast.length > 1 ? '' : 'Без описания'));
        return `<div class="char-card" role="button" tabindex="0" data-action="open-character" data-id="${c.id}">
          <div class="char-portrait"><img src="${escapeHtml(resolveAvatarUrl(c.avatar_url, cardLabel(c)))}" alt="" /><div class="char-portrait-name">${escapeHtml(cardLabel(c))}</div></div>
          <div class="char-card-body"><div class="char-card-desc">${escapeHtml(desc)}</div><div class="char-card-meta">${ic('chat')}${n ? `${n} ${pluralRu(n, 'чат', 'чата', 'чатов')}` : 'Нет чатов'}</div></div>
        </div>`;
      }).join('')}</div>`
      : emptyHtml('search', 'Ничего не найдено', '');
  }

  function openCharacterPage(charId) {
    const id = Number(charId);
    if (!findChar(id)) return;
    // Long texts are folded; these are the open ones: 'greeting', 'world', 'desc' or a character's number.
    const open = new Set();

    const foldable = (key, text, html) => `<div class="card card-pad"><div class="prose${key === 'greeting' ? ' msg-text' : ''}${!open.has(key) && text.length > 420 ? ' clamp' : ''}">${html}</div>${text.length > 420 ? `<button class="btn btn-ghost btn-sm" style="margin-top:6px;padding:0" data-act="more" data-key="${key}">${open.has(key) ? 'Свернуть' : 'Показать полностью'}</button>` : ''}</div>`;

    const render = () => {
      const c = findChar(id);
      if (!c) return emptyHtml('mask', 'Персонаж удалён', '');
      const chats = chatsOfCharacter(id);
      const greeting = String(c.first_message || '').trim();
      const cast = cardCast(c);
      const names = cast.map(m => m.name).join(', ');
      let body;
      if (c.card) {
        // Structured: world settings, then each character with its macro.
        const world = String(c.card.world || '').trim();
        body = `${world ? `<div class="section"><div class="section-title">Настройки мира · &lt;world_settings&gt;</div>${foldable('world', world, escapeHtml(world))}</div>` : ''}
          <div class="section"><div class="section-title">Персонажи · ${cast.length}</div>
            ${cast.length ? cast.map(m => `<div class="cast-card"><div class="cast-card-head"><span class="cast-card-name">${escapeHtml(m.name)}</span><span class="cast-num">{{char${m.n}}}</span></div>
              ${m.text.trim() ? foldable(String(m.n), m.text.trim(), escapeHtml(m.text.trim())) : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Описание не заполнено.</div>'}</div>`).join('')
              : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Только мир — персонажи появятся по ходу истории.</div>'}
          </div>`;
      } else {
        const desc = String(c.fileContent || c.description_preview || '').trim();
        body = `<div class="section">
          <div class="section-title">Описание · попадает в &lt;character_persona&gt;</div>
          ${desc ? foldable('desc', desc, escapeHtml(desc))
            : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Описание не заполнено — модель почти ничего не знает о персонаже.</div>'}
        </div>`;
      }
      return `
        <div class="hero" data-act="view"><img src="${escapeHtml(resolveAvatarUrl(c.avatar_url, cardLabel(c)))}" alt="" /></div>
        <h1 class="hero-name">${escapeHtml(cardLabel(c))}</h1>
        <div class="hero-meta">${c.card && names && names !== cardLabel(c) ? escapeHtml(names) + ' · ' : ''}${chats.length ? `${chats.length} ${pluralRu(chats.length, 'чат', 'чата', 'чатов')}` : 'Ещё нет чатов'}</div>
        <div class="section">
          <div class="section-title">Приветствие</div>
          ${greeting ? foldable('greeting', greeting, formatRoleplayHtml(greeting, { dialogue: prefs.dialogue }))
            : '<div class="card card-pad muted" style="font-size:var(--fs-sm)">Нет приветствия — первым пишет игрок.</div>'}
        </div>
        ${body}
        ${chats.length ? `<div class="section"><div class="section-title">Чаты</div><div class="list">${chats.map(ch => `<button class="row" data-act="chat" data-id="${ch.id}"><span class="row-icon">${ic('chat')}</span><div class="row-body"><div class="row-title">${escapeHtml(isDefaultChatTitle(ch.title, c.name, c.title) ? (ch.persona_title || ch.persona_name || 'Чат') : ch.title)}</div><div class="row-sub">${escapeHtml(chatPreview(ch) || 'Без сообщений')}</div></div><span class="row-value">${escapeHtml(formatRelativeTime(chatActivityTime(ch)))}</span></button>`).join('')}</div></div>` : ''}
      `;
    };

    const c0 = findChar(id);
    const layer = openPage({
      title: cardLabel(c0),
      body: render(),
      actions: `<button class="icon-btn" data-act="edit" aria-label="Изменить">${ic('edit')}</button>`,
      footer: `<button class="btn btn-primary btn-block" data-act="start">${ic('chat-plus')}Начать новый чат</button>`,
    });
    layer.cardId = id;
    layer.cardKind = 'character';
    layer.refresh = () => {
      const c = findChar(id);
      if (c) layer.setTitle(escapeHtml(cardLabel(c)));
      const body = $('.page-body', layer.el);
      const scroll = body.scrollTop;
      layer.setBody(render());
      body.scrollTop = scroll;
    };
    bindActs(layer, {
      view: () => {
        const c = findChar(id);
        if (c) openImageViewer(resolveAvatarUrl(c.avatar_url, cardLabel(c)), cardLabel(c));
      },
      edit: () => openCharacterEditor(id),
      start: () => openNewChat(id),
      chat: (el) => {
        layer.close();
        closeLayersAbove(null);
        openChatRoom(Number(el.dataset.id));
      },
      more: (el) => {
        const key = el.dataset.key;
        if (open.has(key)) open.delete(key);
        else open.add(key);
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
   * A character card has a title only the user sees, world settings and
   * numbered characters ({{char1}}, {{char2}}…), sent as card; the engine turns
   * them into <world_settings> and <character name="…"> blocks. A free-text card
   * from before 1.9 opens as its character 1. A persona is a title, a name
   * ({{user}}) and a description saved verbatim (rawFileContent).
   */
  function openCardEditor(kind, id) {
    const isChar = kind === 'character';
    const item = id ? (isChar ? findChar(id) : findPersona(id)) : null;
    const legacy = Boolean(isChar && item && !item.card);
    const init = {
      title: item ? String(item.title || '') : '',
      name: item && !isChar ? item.name : '',
      description: item && !isChar ? String(item.fileContent ?? item.description_preview ?? '') : '',
      world: isChar && item && item.card ? String(item.card.world || '') : '',
      chars: isChar ? (item ? cardCast(item).map(c => ({ n: c.n, name: c.name, text: c.text })) : [{ n: 1, name: '', text: '' }]) : [],
      greeting: item && isChar ? (item.first_message || '') : '',
      avatarUrl: item ? (item.avatar_url || '') : '',
      filePath: item ? (item.file_path || '') : '',
    };
    const cur = JSON.parse(JSON.stringify(init));
    // The number the next added character gets. For a saved card the engine
    // also counts the characters its chats' replies introduced (GET below).
    let nextNum = Math.max(1, ...init.chars.map(c => c.n + 1), item && item.card ? Number(item.card.next) || 1 : (item ? 2 : 1));
    let numbersReady = !(isChar && item);
    let saving = false;
    const dirty = () => JSON.stringify(init) !== JSON.stringify(cur);
    const noun = isChar ? 'карточку' : 'персону';
    const chatsCount = item && isChar ? chatsOfCharacter(item.id).length : 0;
    const label = () => (isChar ? (cur.title.trim() || (cur.chars.find(c => c.name.trim()) || {}).name || '') : (cur.title.trim() || cur.name.trim()));

    const charBlockHtml = (c) => `<div class="char-block" data-n="${c.n}">
        <div class="char-block-head"><span class="cast-num">{{char${c.n}}}</span><span class="char-block-label">Персонаж</span>
          <button class="icon-btn sm" data-act="remove-char" data-n="${c.n}" aria-label="Удалить персонажа">${ic('trash', 'ic-sm')}</button></div>
        <label class="field"><span class="field-label">Имя</span>
          <input class="input" data-char-field="name" data-n="${c.n}" value="${escapeHtml(c.name)}" placeholder="Например, Кира" maxlength="80" autocomplete="off" /></label>
        <label class="field"><span class="field-label">Описание</span>
          <textarea class="textarea" data-char-field="text" data-n="${c.n}" data-macro-target="1" placeholder="Внешность, характер, манера речи, прошлое, отношения с {{user}} и другими персонажами…">${escapeHtml(c.text)}</textarea></label>
      </div>`;
    const macroNames = () => {
      const names = {};
      cur.chars.forEach(c => {
        names[c.n] = c.name.trim();
      });
      return { names };
    };

    const body = isChar ? `
      <div class="avatar-picker">
        <button class="avatar-picker-btn" data-act="avatar" aria-label="Изменить изображение">
          <img data-role="avatar" src="${escapeHtml(resolveAvatarUrl(cur.avatarUrl, label()))}" alt="" />
          <span class="avatar-picker-badge">${ic('camera')}</span>
        </button>
        <input type="file" accept="image/*" class="hidden" data-role="file" />
      </div>
      <label class="field"><span class="field-label">Название · видите только вы</span>
        <input class="input" data-field="title" value="${escapeHtml(cur.title)}" placeholder="Например, Таверна «Сломанный меч»" maxlength="120" autocomplete="off" />
        <span class="field-hint">Для списков и чатов, модели не отправляется. Пусто — будет имя первого персонажа.</span></label>
      ${legacy ? `<div class="inline-note">${ic('info', 'ic-xs')}<span>Карточка старого формата: весь её текст стал описанием персонажа {{char1}}. Если в нём несколько персонажей или мир, разнесите их по полям ниже.</span></div>` : ''}
      <label class="field"><span class="field-label">Настройки мира</span>
        <textarea class="textarea" data-field="world" data-macro-target="1" placeholder="Мир, место действия, эпоха, правила, общая обстановка. Можно оставить пустым.">${escapeHtml(cur.world)}</textarea>
        <span class="field-hint">Попадает к модели в &lt;world_settings&gt;.</span></label>
      <div class="section-title" style="margin-top:20px">Персонажи</div>
      <div data-role="chars">${cur.chars.map(charBlockHtml).join('')}</div>
      <button class="btn btn-secondary btn-block" data-act="add-char"${numbersReady ? '' : ' disabled'}>${ic('plus')}Добавить персонажа</button>
      <p class="section-hint">Каждый персонаж уходит к модели блоком &lt;character name="Имя"&gt;. В любом поле карточки пишите {{char1}}, {{char2}}… и {{user}} — подставятся имена, поэтому персонажа достаточно переименовать здесь. Номер навсегда закреплён за персонажем.</p>
      <label class="field"><span class="field-label">Приветствие</span>
        <textarea class="textarea" data-field="greeting" data-macro-target="1" placeholder="Первое сообщение в новом чате. Можно оставить пустым.">${escapeHtml(cur.greeting)}</textarea></label>
      ${item ? `<div class="danger-zone"><button class="btn btn-danger btn-block" data-act="delete">${ic('trash')}Удалить ${noun}</button>
        ${chatsCount ? `<p class="section-hint">${chatsCount} ${pluralRu(chatsCount, 'чат останется', 'чата останутся', 'чатов останутся')} без карточки.</p>` : ''}</div>` : ''}`
    : `
      <div class="avatar-picker">
        <button class="avatar-picker-btn round" data-act="avatar" aria-label="Изменить изображение">
          <img data-role="avatar" src="${escapeHtml(resolveAvatarUrl(cur.avatarUrl, label()))}" alt="" />
          <span class="avatar-picker-badge">${ic('camera')}</span>
        </button>
        <input type="file" accept="image/*" class="hidden" data-role="file" />
      </div>
      <label class="field"><span class="field-label">Название · видите только вы</span>
        <input class="input" data-field="title" value="${escapeHtml(cur.title)}" placeholder="Например, Кадзума — маг" maxlength="120" autocomplete="off" />
        <span class="field-hint">Чтобы не путать похожие персоны. Модели не отправляется.</span></label>
      <label class="field"><span class="field-label">Имя</span>
        <input class="input" data-field="name" value="${escapeHtml(cur.name)}" placeholder="Как вас зовут в истории" maxlength="80" autocomplete="off" />
        <span class="field-hint">Подставляется вместо {{user}}.</span></label>
      <label class="field"><span class="field-label">Описание персоны</span>
        <textarea class="textarea" data-field="description" placeholder="Кто вы: внешность, характер, навыки, цели…">${escapeHtml(cur.description)}</textarea>
        <span class="field-hint">Текст целиком попадает в системный промпт внутри &lt;user_persona&gt;. Макросы {{user}} и {{charN}} подставляются.</span></label>
      ${item ? `<div class="danger-zone"><button class="btn btn-danger btn-block" data-act="delete">${ic('trash')}Удалить ${noun}</button></div>` : ''}`;

    const title = item ? (isChar ? 'Изменить карточку' : 'Изменить персону') : (isChar ? 'Новая карточка' : 'Новая персона');
    const layer = openPage({
      title,
      backIcon: 'x',
      body,
      actions: `<button class="btn btn-ghost" data-act="save">Сохранить</button>`,
      footer: isChar ? `<div class="macro-bar" data-role="macros">${macroBarHtml(macroNames())}</div>` : '',
      onBack: () => {
        if (!dirty() || saving) return true;
        confirmDialog({ title: 'Выйти без сохранения?', message: 'Изменения будут потеряны.', confirmText: 'Выйти', cancelText: 'Остаться', danger: true })
          .then(ok => ok && layer.close());
        return false;
      },
    });

    const updateTitle = () => layer.setTitle(escapeHtml(title) + (dirty() ? '<span class="dirty-dot" title="Есть несохранённые изменения"></span>' : ''));
    const updateAvatar = () => {
      $('[data-role="avatar"]', layer.el).src = resolveAvatarUrl(cur.avatarUrl, label());
    };
    const updateMacros = () => {
      const bar = $('[data-role="macros"]', layer.el);
      if (bar) bar.innerHTML = macroBarHtml(macroNames());
    };
    $$('textarea', layer.el).forEach(t => autoGrow(t));
    layer.el.addEventListener('input', (e) => {
      const t = e.target;
      const f = t.dataset.field;
      const cf = t.dataset.charField;
      if (f) {
        cur[f] = t.value;
      } else if (cf) {
        const c = cur.chars.find(x => x.n === Number(t.dataset.n));
        if (!c) return;
        c[cf] = t.value;
        if (cf === 'name') updateMacros();
      } else {
        return;
      }
      if (t.tagName === 'TEXTAREA') autoGrow(t);
      if (!cur.avatarUrl && (f === 'title' || f === 'name' || cf === 'name')) updateAvatar();
      updateTitle();
    });
    const fileInput = $('[data-role="file"]', layer.el);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        cur.avatarUrl = await downscaleImage(file, 640);
        updateAvatar();
        updateTitle();
      } catch (e) {
        toast('Не удалось загрузить изображение: ' + e.message, { type: 'error' });
      }
    });
    if (isChar && item) {
      api(`/api/characters/${item.id}`).then((res) => {
        nextNum = Math.max(nextNum, Number(res.character && res.character.next_char_num) || 0);
      }).catch(() => {}).then(() => {
        numbersReady = true;
        const add = $('[data-act="add-char"]', layer.el);
        if (add) add.disabled = false;
      });
    }
    if (isChar) bindMacroBar(layer);

    bindActs(layer, {
      avatar: () => actionSheet({
        title: 'Изображение',
        items: [
          { icon: 'image', label: 'Выбрать с устройства', onSelect: () => fileInput.click() },
          { icon: 'eye', label: 'Посмотреть', hidden: !cur.avatarUrl, onSelect: () => openImageViewer(resolveAvatarUrl(cur.avatarUrl, label()), label()) },
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
      'add-char': () => {
        if (!numbersReady) return;
        const c = { n: nextNum++, name: '', text: '' };
        cur.chars.push(c);
        const host = $('[data-role="chars"]', layer.el);
        const el = htmlToElement(charBlockHtml(c));
        host.appendChild(el);
        autoGrow($('textarea', el));
        updateMacros();
        updateTitle();
        const input = $('input', el);
        input.focus();
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
      'remove-char': async (el) => {
        const n = Number(el.dataset.n);
        const c = cur.chars.find(x => x.n === n);
        if (!c) return;
        if (c.name.trim() || c.text.trim()) {
          const ok = await confirmDialog({
            title: `Удалить {{char${n}}}${c.name.trim() ? ` «${c.name.trim()}»` : ''}?`,
            message: `Описание персонажа удалится из карточки после сохранения. Номер {{char${n}}} больше никому не достанется — уберите его и из текстов.`,
            confirmText: 'Удалить',
            danger: true,
          });
          if (!ok) return;
        }
        cur.chars = cur.chars.filter(x => x.n !== n);
        const block = $(`.char-block[data-n="${n}"]`, layer.el);
        if (block) block.remove();
        updateMacros();
        updateAvatar();
        updateTitle();
      },
      save: async (btn) => {
        if (saving) return;
        let payload;
        if (isChar) {
          const unnamed = cur.chars.find(c => !c.name.trim() && c.text.trim());
          if (unnamed) {
            toast(`У персонажа {{char${unnamed.n}}} нет имени`);
            const input = $(`input[data-char-field="name"][data-n="${unnamed.n}"]`, layer.el);
            if (input) input.focus();
            return;
          }
          const chars = cur.chars.filter(c => c.name.trim() || c.text.trim()).map(c => ({ n: c.n, name: c.name.trim(), text: c.text }));
          if (!cur.title.trim() && !chars.length) {
            toast('Введите название карточки или имя хотя бы одного персонажа');
            $('[data-field="title"]', layer.el).focus();
            return;
          }
          payload = {
            title: cur.title.trim(),
            filePath: cur.filePath.trim(),
            avatarUrl: cur.avatarUrl,
            firstMessage: cur.greeting,
            // No "next": the engine keeps the saved card's one, so only numbers
            // that were saved stay retired (an unsaved empty block's does not).
            card: { world: cur.world, chars },
          };
        } else {
          const name = cur.name.trim();
          if (!name) {
            toast('Введите имя персоны');
            $('[data-field="name"]', layer.el).focus();
            return;
          }
          payload = {
            title: cur.title.trim(),
            name,
            filePath: cur.filePath.trim(),
            avatarUrl: cur.avatarUrl,
            description: cur.description,
            rawFileContent: cur.description,
          };
        }
        saving = true;
        btn.disabled = true;
        try {
          const base = isChar ? '/api/characters' : '/api/personas';
          await api(item ? `${base}/${item.id}` : base, { method: item ? 'PUT' : 'POST', body: payload });
          await loadCards();
          loadChats();
          if (state.room) {
            try {
              state.room.data = withCardImages(await api(`/api/chats/${state.room.chatId}`));
              renderRoomHeader();
              syncFeed({ scroll: 'keep' });
              refreshLayers();
            } catch (e) {
              // room refresh is best-effort
            }
          }
          layer.close();
          toast(isChar ? 'Карточка сохранена' : 'Персона сохранена', { type: 'success' });
        } catch (e) {
          saving = false;
          btn.disabled = false;
          toast(e.message, { type: 'error' });
        }
      },
      delete: async () => {
        const name = isChar ? cardLabel(item) : personaLabel(item);
        const ok = await confirmDialog({
          title: isChar ? `Удалить «${name}»?` : `Удалить персону «${name}»?`,
          message: isChar && chatsCount
            ? `Карточка и её файл будут удалены. ${chatsCount} ${pluralRu(chatsCount, 'чат останется', 'чата останутся', 'чатов останутся')} без карточки.`
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
          toast(isChar ? 'Карточка удалена' : 'Персона удалена');
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
            <img class="avatar avatar-48" src="${escapeHtml(resolveAvatarUrl(p.avatar_url, personaLabel(p)))}" alt="" />
            <div class="row-body"><div class="row-title">${escapeHtml(personaLabel(p))}${p.id === active ? ' <span class="pill accent" style="margin-left:6px">По умолчанию</span>' : ''}</div>
              <div class="row-sub wrap">${String(p.title || '').trim() ? `Имя: ${escapeHtml(p.name)} · ` : ''}${escapeHtml(stripMarkdownPreview(p.description_preview || p.fileContent) || 'Без описания')}</div></div>
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
      toast(`По умолчанию: ${p ? personaLabel(p) : 'персона'}`);
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
    const updAvailable = updateAction(upd) !== 'none';
    const pill = (st) => `<span class="pill ${st.ok ? 'ok' : 'warn'}">${st.ok ? 'Готово' : 'Настроить'}</span>`;
    const cloud = cloudSummary(state.cloud);
    pane.innerHTML = `<div class="tab-inner">
      <div class="appbar"><h1 class="appbar-title">Настройки</h1></div>
      <div class="section"><div class="section-title">Аккаунт</div><div class="list">
        ${settingsRow({ page: 'cloud', icon: 'shield', title: 'Облако и аккаунт', sub: escapeHtml(cloud.text), value: `<span class="pill ${cloud.tone}">${escapeHtml(cloud.label)}</span>` })}
      </div></div>
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
    else if (page === 'cloud') openCloudPage();
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
        try {
          applySettings(await api('/api/settings', { method: 'POST', body: { selectedModel: r.modelId, selectedEffort: r.effort } }));
          renderSettingsTab();
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
  <b>&lt;world_settings&gt;</b> настройки мира <b>&lt;/world_settings&gt;</b>
  <b>&lt;character name="Имя"&gt;</b> описание <b>&lt;/character&gt;</b>
  … по блоку на каждого персонажа карточки
  и на каждого, кто появился в истории
<b>&lt;/character_persona&gt;</b>
<b>&lt;user_persona name="Имя"&gt;</b>
  описание вашей персоны
<b>&lt;/user_persona&gt;</b>
<b>&lt;chat_memory&gt;</b> — если память чата заполнена</pre>
        </details>
        <textarea class="textarea tall" data-role="text" placeholder="Например: Ты — ведущий ролевой игры. Пиши от третьего лица, живо и образно. Отвечай за персонажей из &lt;character_persona&gt;, никогда не пиши действия и реплики {{user}}…">${escapeHtml(initial)}</textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <div class="macro-chips" style="margin:0"><button class="chip sm" data-act="macro" data-macro="{{user}}">{{user}}</button><button class="chip sm" data-act="macro" data-macro="{{char1}}">{{char1}}</button><button class="chip sm" data-act="macro" data-macro="{{char2}}">{{char2}}</button></div>
          <span class="char-count" data-role="count" style="margin-left:auto"></span>
        </div>
        <p class="section-hint">{{user}} — имя вашей персоны, {{char1}}, {{char2}}… — имена персонажей чата по номерам ({{char}} = {{char1}}). Чтобы модель вводила новых персонажей отдельными карточками, опишите здесь блок &lt;new_character name="Имя"&gt;…&lt;/new_character&gt;: приложение вынет его из ответа и добавит персонажа в чат.</p>`,
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
  // Google's own safety settings for Gemini. The request text is always sent as is.
  const SAFETY_OPTIONS = [
    { value: 'OFF', title: 'Фильтры выключены', sub: 'Настраиваемые фильтры Google отключены (OFF).' },
    { value: 'BLOCK_NONE', title: 'Не блокировать', sub: 'Google оценивает ответы, но не блокирует их (BLOCK_NONE).' },
    { value: 'BLOCK_ONLY_HIGH', title: 'Стандартный фильтр', sub: 'Блокируется только высокий риск (BLOCK_ONLY_HIGH).' },
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
    // Sign-in flow: idle -> starting -> waiting (CLI running; link shown when ready) -> idle
    const login = { phase: 'idle', error: '', submitting: false, codeDraft: '' };
    let selftestTimer = null;
    // The check also runs on when the page was closed and reopened meanwhile.
    const selftestRunning = () => Boolean((state.claudeSelftest && state.claudeSelftest.running) || state.settings.claudeSelftestRunning);
    // Signed in by THIS attempt: Claude Code has written new credentials (old ones do not count).
    const signedInNow = (s) => s.claudeAuthenticated && s.claudeCredentialsStamp !== s.claudeLoginBaseStamp;

    const outputBlock = (text) => `<div class="console" style="margin-top:10px;max-height:28vh">${escapeHtml(text)}</div>`;

    const loginBody = (s) => {
      // While signing in again the old sign-in still counts: show the new link.
      if (s.claudeAuthenticated && login.phase !== 'starting' && login.phase !== 'waiting') {
        return `<div class="step-text">Вход выполнен. Модели Claude Code готовы к работе.</div>
          <div class="btn-row"><button class="btn btn-secondary btn-sm" data-act="login">${ic('login')}Войти заново</button><button class="btn btn-danger btn-sm" data-act="logout">${ic('logout')}Выйти</button></div>`;
      }
      if (!s.claudeRuntimeReady) {
        return '<div class="step-text">Станет доступно после установки среды.</div>';
      }
      if (login.phase === 'starting') {
        return `<div class="install-progress"><span class="spinner"></span><span>Запускаю Claude Code…</span></div>`;
      }
      if (login.phase === 'waiting') {
        const url = s.claudeLoginUrl;
        const autoUrl = s.claudeLoginAutoUrl;
        const live = [s.claudeLoginOutput, s.claudeLoginDebug ? '--- debug ---\n' + s.claudeLoginDebug : ''].filter(Boolean).join('\n');
        const cancel = '<button class="btn btn-ghost btn-sm" style="margin-top:10px;padding:0" data-act="cancel-login">Отменить вход</button>';
        if (!url && !autoUrl) {
          const slow = s.claudeLoginElapsed >= 30;
          const limit = s.claudeLoginTimeout;
          const hint = `Дольше обычного. Если ссылка не появится за ${limit || 75} с, вход остановится и покажет, на чём завис Claude Code.`;
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
          ${login.error ? `<button class="btn btn-secondary btn-sm" data-act="selftest"${selftestRunning() ? ' disabled' : ''}>${ic('activity', 'ic-sm')}Проверить запуск</button>` : ''}
        </div>`;
    };

    const selftestView = () => {
      const st = state.claudeSelftest;
      const s = state.settings;
      if (selftestRunning()) {
        const stage = s.claudeSelftestProgress ? `: ${s.claudeSelftestProgress}` : '';
        return `<div class="install-progress" style="margin-top:10px"><span class="spinner"></span><span>Проверяю${escapeHtml(stage)}…</span></div>
          <p class="section-hint" style="margin:8px 0 0">Если Claude Code зависает, проверка пробует безопасный режим Bun и чистый профиль — это может занять несколько минут. Не закрывайте приложение.</p>`;
      }
      if (!st || !Array.isArray(st.stages)) return '';
      return `<div class="selftest">
        <div class="selftest-summary"><span class="pill ${st.ok ? 'ok' : 'err'}">${st.ok ? 'Claude Code запускается' : 'Claude Code не запускается'}</span>
          ${st.safeMode ? '<span class="faint">безопасный режим Bun</span>' : ''}</div>
        ${st.summary ? `<div class="step-text" style="margin-top:8px">${escapeHtml(st.summary)}</div>` : ''}
        ${st.ok ? '' : `<button class="btn btn-secondary btn-sm" style="margin-top:10px" data-act="copy-report">${ic('copy', 'ic-sm')}Скопировать отчёт</button>`}
        ${st.stages.length ? `<details class="disclosure"${st.ok ? '' : ' open'}><summary>Этапы проверки ${ic('chevron-down', 'ic-sm')}</summary>
          ${st.stages.map(stage => `<div class="selftest-stage">
            <div class="selftest-head">${ic(stage.ok ? 'check-circle' : 'alert', 'ic-sm')}<span>${escapeHtml(stage.name)}</span><span class="faint">${escapeHtml(stage.exit || '')} · ${escapeHtml(stage.seconds || '0')} с</span></div>
            ${stage.output ? outputBlock(stage.output) : (stage.ok ? '' : outputBlock('(пустой вывод)'))}
            ${stage.snapshot ? `<details class="disclosure"><summary>Процессы в момент зависания ${ic('chevron-down', 'ic-sm')}</summary>${outputBlock(stage.snapshot)}</details>` : ''}
          </div>`).join('')}
        </details>` : ''}
        ${st.ok ? `<button class="btn btn-ghost btn-sm" style="padding:0;margin-top:8px" data-act="copy-report">${ic('copy', 'ic-sm')}Скопировать отчёт</button>` : ''}
      </div>`;
    };

    const render = () => {
      const s = state.settings;
      const sizeMb = s.claudeDownloadMb || 128;
      const busy = installing || s.claudeInstalling;
      let runtimeText;
      if (s.claudeRuntimeReady) runtimeText = 'Установлена. Новые чаты с моделями Claude Code работают в ней автоматически.';
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
                    ${s.claudeRuntimeReady ? `<button class="btn btn-secondary btn-sm" data-act="selftest"${selftestRunning() ? ' disabled' : ''}>${ic('activity', 'ic-sm')}Проверить запуск</button>` : ''}
                    <button class="btn ${s.claudeRuntimeReady ? 'btn-secondary' : 'btn-primary'} btn-sm" data-act="install"${selftestRunning() ? ' disabled' : ''}>${s.claudeRuntimeReady ? `${ic('reroll')}Переустановить` : `${ic('download')}Скачать среду`}</button>
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
        if (signedInNow(s)) finishLogin(true);
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
      const s = state.settings;
      if (s.claudeLoginPending && !signedInNow(s)) {
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
          result = { ok: false, summary: e.message, stages: [], report: e.message };
        }
        clearInterval(selftestTimer);
        state.claudeSelftest = result;
        await refreshClaudeStatus();
        layer.refresh();
        if (result.ok) toast(result.summary || 'Claude Code запускается', { type: 'success' });
      },
      login: async () => {
        login.phase = 'starting';
        login.error = '';
        login.codeDraft = '';
        layer.refresh();
        try {
          await api('/api/claude/auth/start', { method: 'POST' });
          // Links, live output and the result arrive through /api/claude/status.
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
        if (st) copyText(st.report || st.summary || '');
      },
      'copy-error': () => {
        if (login.error) copyText(login.error);
      },
      'open-link': () => {
        const link = state.settings.claudeLoginUrl || state.settings.claudeLoginAutoUrl;
        if (link) openExternal(link);
      },
      'copy-link': () => {
        const link = state.settings.claudeLoginUrl || state.settings.claudeLoginAutoUrl;
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
          // Stops the attempt only; an existing sign-in stays.
          const res = await api('/api/claude/auth/cancel', { method: 'POST' });
          state.settings.claudeAuthenticated = Boolean(res.authenticated);
        } catch (e) {
          // the status refresh below shows the real state
        }
        login.phase = 'idle';
        login.error = '';
        login.codeDraft = '';
        await refreshClaudeStatus();
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
          <p class="step-text">Текущие персонажи, чаты и сообщения будут <b>полностью заменены</b> данными из копии.${state.cloud && state.cloud.linked ? ' Облако включено: данные в облаке тоже заменятся копией.' : ''}</p>
          <button class="btn btn-secondary btn-block" data-act="pick">${ic('upload')}Выбрать файл .json</button><input type="file" accept=".json,application/json" class="hidden" data-role="file" />
          <details class="disclosure" style="margin-top:6px"><summary>Вставить JSON вручную ${ic('chevron-down', 'ic-sm')}</summary><textarea class="textarea mono" data-role="paste" placeholder='{"backupFormat":1, …}'></textarea><button class="btn btn-secondary btn-block" style="margin-top:10px" data-act="paste">Восстановить из текста</button></details>
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
        message: `В копии: персонажей ${c.characters ?? '?'}, чатов ${c.chats ?? '?'}, сообщений ${c.messages ?? '?'}.\n\nТекущие данные будут полностью заменены${state.cloud && state.cloud.linked ? ' — и на телефоне, и в облаке' : ''}. Отменить это нельзя.`,
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

  // --- cloud: account, encryption, sync ----------------------------------------
  // The phone keeps the working copy; the engine (CloudSync) keeps an end-to-end
  // encrypted copy in the user's own Firebase project. A password typed here goes
  // to the engine once; the page forgets it when it closes.
  const CLOUD_GUIDE_URL = 'https://github.com/Kuka001/111/blob/main/firebase/README.md';

  function strengthHtml(pw, minChars) {
    const st = passwordStrength(pw, minChars);
    return `<div class="strength s${st.score}" data-role="meter"><span></span><span></span><span></span><span></span>
      <em>${escapeHtml([st.label, st.hint].filter(Boolean).join(' · '))}</em></div>`;
  }

  function cloudPasswordInput(role, opts) {
    const o = opts || {};
    return `<input class="input${o.mono ? ' mono' : ''}" data-role="${role}" type="${o.text ? 'text' : 'password'}"
      autocomplete="${o.autocomplete || 'off'}" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(o.placeholder || '')}" />`;
  }

  function openCloudPage() {
    // Typed values survive the re-rendering on status updates; cleared on close.
    const draft = { config: '', code: '', pw1: '', pw2: '', unlockPw: '', recovery: '' };
    const ui = { mode: 'merge', useCode: false, show: false, busy: '' };
    let timer = null;
    let lastHtml = '';
    let lastPoll = 0;
    const minChars = () => (state.cloud && state.cloud.minPasswordChars) || 10;

    const busyBtn = (act, label, busyLabel, cls) =>
      `<button class="btn ${cls}" data-act="${act}"${ui.busy ? ' disabled' : ''}>${ui.busy === act ? `<span class="spinner"></span>${busyLabel}` : label}</button>`;
    const errorCard = (text) => `<div class="error-card" style="margin-top:12px"><div class="error-head">${ic('alert')}<div>${escapeHtml(text)}</div></div></div>`;
    const signOutLink = () => `<div class="btn-row" style="margin-top:4px"><button class="btn btn-ghost btn-sm" data-act="signout">${ic('logout', 'ic-sm')}Выйти из аккаунта</button></div>`;
    const keyHint = (c) => c.certSha1 ? `<details class="disclosure section"><summary>Ограничить ключ API этим приложением (необязательно) ${ic('chevron-down', 'ic-sm')}</summary>
        <div class="step-text">Google Cloud → APIs &amp; Services → Credentials → ваш ключ API. Application restrictions: <b>Android apps</b>, пакет <b>com.agy.roleplay</b> и этот отпечаток SHA-1. API restrictions: Identity Toolkit API и Token Service API.</div>
        <div class="link-box">${escapeHtml(c.certSha1)}</div>
        <button class="btn btn-ghost btn-sm" style="padding:0;margin-top:6px" data-act="copy-sha">${ic('copy', 'ic-sm')}Скопировать SHA-1</button>
      </details>` : '';

    const configView = (c) => `
      <div class="card">
        <div class="step"><span class="step-num">1</span><div class="step-body"><div class="step-title">Проект Firebase</div>
          <div class="step-text">Облако — ваш собственный бесплатный проект Firebase (тариф Spark, без банковской карты). Создайте его по инструкции и вставьте сюда четыре значения: <b>projectId</b>, <b>apiKey</b>, <b>clientId</b> и <b>clientSecret</b> — как JSON или прямо фрагментами из консоли.</div>
          <button class="btn btn-secondary btn-sm" data-act="guide">${ic('external', 'ic-sm')}Открыть инструкцию</button>
          <textarea class="textarea mono" data-role="config" style="margin-top:12px" autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder='{"projectId": "…", "apiKey": "AIza…", "clientId": "….apps.googleusercontent.com", "clientSecret": "GOCSPX-…"}'></textarea>
          <div class="btn-row" style="margin-top:10px">${busyBtn('save-config', 'Сохранить', 'Проверяю…', 'btn-primary btn-sm')}</div>
        </div></div>
        <div class="step"><span class="step-num">2</span><div class="step-body"><div class="step-title">Вход через Google</div>
          <div class="step-text">Данные привяжутся к вашему аккаунту Google.</div></div></div>
        <div class="step"><span class="step-num">3</span><div class="step-body"><div class="step-title">Пароль шифрования</div>
          <div class="step-text">Его знаете только вы: им данные шифруются ещё на телефоне.</div></div></div>
      </div>
      ${keyHint(c)}`;

    const signInView = (c) => `
      <div class="card status-card">
        <span class="status-card-icon warn">${ic('login')}</span>
        <div class="row-body"><div class="status-card-title">${c.linked ? 'Войдите снова' : 'Войдите через Google'}</div>
          <div class="status-card-sub">${c.linked
            ? `Вход в облако истёк. Войдите тем же аккаунтом${c.email ? ' (' + escapeHtml(c.email) + ')' : ''} — синхронизация продолжится.`
            : 'Данные будут привязаны к этому аккаунту Google.'}</div></div>
      </div>
      ${c.loginError ? errorCard(c.loginError) : ''}
      <div class="btn-row" style="margin-top:12px">
        ${c.loginCaptured
          ? '<div class="install-progress" style="flex:1"><span class="spinner"></span><span>Завершаю вход…</span></div>'
          : c.loginPending
            ? '<div class="install-progress" style="flex:1"><span class="spinner"></span><span>Жду возврата из браузера…</span></div>'
            : busyBtn('login', `${ic('login')}Войти через Google`, 'Открываю…', 'btn-primary')}
      </div>
      <details class="disclosure section"><summary>Браузер не вернул в приложение? ${ic('chevron-down', 'ic-sm')}</summary>
        <label class="field"><span class="field-label">Адрес из строки браузера (http://127.0.0.1:…)</span>
          <input class="input mono" data-role="code" placeholder="http://127.0.0.1:…/cloud-callback?state=…&amp;code=…" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
        <div style="margin-top:10px">${busyBtn('exchange', 'Подтвердить', 'Проверяю…', 'btn-secondary btn-block')}</div>
      </details>
      <p class="section-hint">Проект Firebase: ${escapeHtml(c.projectId)}${c.linked ? '' : ' · <button class="link" data-act="edit-config">сменить</button>'}</p>
      ${keyHint(c)}`;

    const createView = (c) => `
      ${c.errorKind === 'vault' && c.lastError ? errorCard(c.lastError) : ''}
      <div class="card card-pad">
        <div class="status-card-title">Пароль шифрования</div>
        <p class="step-text">Им шифруются все данные перед отправкой в облако. Его не знает никто, кроме вас — ни Google, ни разработчик, — поэтому забытый пароль восстановить нельзя: только кодом восстановления, который появится на следующем шаге. Вводить пароль понадобится только на новом телефоне.</p>
        <label class="field"><span class="field-label">Пароль</span>${cloudPasswordInput('pw1', { text: ui.show, autocomplete: 'new-password', placeholder: 'Например, фраза из 4–5 слов' })}</label>
        ${strengthHtml(draft.pw1, minChars())}
        <label class="field" style="margin-top:12px"><span class="field-label">Повторите пароль</span>${cloudPasswordInput('pw2', { text: ui.show, autocomplete: 'new-password' })}</label>
        <button class="btn btn-ghost btn-sm" style="padding:0;margin-top:8px" data-act="toggle-show">${ic('eye', 'ic-sm')}${ui.show ? 'Скрыть пароль' : 'Показать пароль'}</button>
        <div style="margin-top:14px">${busyBtn('create', `${ic('shield')}Создать хранилище`, 'Шифрую…', 'btn-primary btn-block')}</div>
      </div>
      <p class="section-hint">Аккаунт: ${escapeHtml(c.email)}. ${c.hasLocalData ? 'Всё, что есть на телефоне, зашифруется и загрузится в облако.' : 'На телефоне пока нет данных.'}</p>
      ${signOutLink()}`;

    const unlockView = (c) => {
      const choose = c.hasLocalData && !c.linked;
      const modes = [
        { value: 'merge', title: 'Объединить', sub: 'Данные телефона и облака сольются; где они расходятся, останется версия с телефона.' },
        { value: 'replace', title: 'Заменить данными из облака', sub: 'Данные на этом телефоне будут стёрты и заменены облачными.' },
      ];
      return `
      ${c.lastError ? errorCard(c.lastError) : ''}
      <div class="card card-pad">
        <div class="status-card-title">${ui.useCode ? 'Код восстановления' : 'Пароль шифрования'}</div>
        <p class="step-text">${ui.useCode
          ? 'Код, который вы сохранили при создании хранилища: 32 буквы и цифры, дефисы и регистр не важны.'
          : 'В облаке уже есть ваши зашифрованные данные. Введите пароль, которым они защищены.'}</p>
        ${ui.useCode
          ? cloudPasswordInput('recovery', { text: true, mono: true, placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' })
          : cloudPasswordInput('unlockPw', { text: ui.show, autocomplete: 'current-password', placeholder: 'Пароль шифрования' })}
        <button class="btn btn-ghost btn-sm" style="padding:0;margin-top:8px" data-act="use-code">${ui.useCode ? 'Ввести пароль' : 'Забыли пароль? Ввести код восстановления'}</button>
      </div>
      ${choose ? `<div class="section"><div class="section-title">На телефоне уже есть данные</div><div class="list">
        ${modes.map(o => `<button class="row" data-act="mode" data-value="${o.value}"><span class="radio${ui.mode === o.value ? ' on' : ''}"></span><div class="row-body"><div class="row-title">${o.title}</div><div class="row-sub wrap">${o.sub}</div></div></button>`).join('')}
      </div>
      ${ui.mode === 'replace' ? `<button class="btn btn-secondary btn-sm" style="margin-top:10px" data-act="backup">${ic('download', 'ic-sm')}Сначала сохранить копию</button>` : ''}
      </div>` : ''}
      <div style="margin-top:14px">${busyBtn('unlock', `${ic('shield')}Открыть хранилище`, 'Проверяю…', 'btn-primary btn-block')}</div>
      <p class="section-hint">Аккаунт: ${escapeHtml(c.email)}</p>
      ${signOutLink()}`;
    };

    const readyView = (c) => {
      const sum = cloudSummary(c);
      const u = c.usage || {};
      const lim = u.limits || {};
      const progress = c.busy && c.total ? Math.min(100, Math.round((c.done / c.total) * 100)) : -1;
      const title = c.busy ? 'Синхронизация…' : (sum.tone === 'ok' ? 'Данные в облаке' : (sum.tone === 'err' ? 'Ошибка синхронизации' : 'Синхронизация на паузе'));
      return `
      <div class="card status-card">
        <span class="status-card-icon ${sum.tone}">${c.busy ? '<span class="spinner"></span>' : ic(sum.tone === 'ok' ? 'check-circle' : 'alert')}</span>
        <div class="row-body"><div class="status-card-title">${title}</div><div class="status-card-sub">${escapeHtml(sum.text)}</div></div>
      </div>
      ${progress >= 0 ? `<div class="progress" style="margin-top:12px"><span style="width:${progress}%"></span></div>` : ''}
      ${c.keystoreUnavailable ? errorCard('Хранилище ключей Android недоступно: ключ шифрования хранится только в памяти, после перезапуска приложения понадобится пароль.') : ''}
      <div class="card card-pad section">
        <div class="kv"><span>Последняя синхронизация</span><b>${c.lastSyncAt ? escapeHtml(agoText(c.lastSyncAt)) : 'ещё не было'}</b></div>
        <div class="kv"><span>Ждут отправки</span><b>${formatCount(c.pending)}</b></div>
        <div class="kv"><span>В облаке</span><b>${formatCount(c.cloudRecords)} ${pluralRu(c.cloudRecords, 'запись', 'записи', 'записей')} · ${formatBytes(c.cloudBytes)}</b></div>
        <div class="kv"><span>Сегодня из бесплатного лимита</span><b>чтений ${formatCount(u.reads)} из ${formatCount(lim.reads)}, записей ${formatCount(u.writes)} из ${formatCount(lim.writes)}</b></div>
        ${c.parked ? `<div class="kv"><span>Ждут своего чата</span><b>${formatCount(c.parked)}</b></div>` : ''}
        <div style="margin-top:12px">${busyBtn('sync', `${ic('reroll')}Синхронизировать сейчас`, 'Запускаю…', 'btn-secondary btn-block')}</div>
      </div>
      <div class="section"><div class="section-title">Шифрование</div><div class="list">
        <button class="row" data-act="password"><span class="row-icon">${ic('lock')}</span><div class="row-body"><div class="row-title">Сменить пароль</div><div class="row-sub">Нужен текущий пароль или код восстановления</div></div>${ic('chevron-right', 'row-chevron')}</button>
        <button class="row" data-act="recovery"><span class="row-icon">${ic('key')}</span><div class="row-body"><div class="row-title">Новый код восстановления</div><div class="row-sub">Старый перестанет действовать</div></div>${ic('chevron-right', 'row-chevron')}</button>
      </div></div>
      <div class="section"><div class="section-title">Аккаунт</div><div class="list">
        <button class="row" data-act="signout"><span class="row-icon">${ic('logout')}</span><div class="row-body"><div class="row-title">Выйти из облака</div><div class="row-sub">Данные в облаке останутся</div></div>${ic('chevron-right', 'row-chevron')}</button>
        <button class="row danger" data-act="wipe"><span class="row-icon">${ic('trash')}</span><div class="row-body"><div class="row-title">Удалить данные из облака</div><div class="row-sub">На этом телефоне всё останется</div></div>${ic('chevron-right', 'row-chevron')}</button>
      </div></div>
      <p class="section-hint">Проект Firebase: ${escapeHtml(c.projectId)}. Каждая запись шифруется на телефоне (AES-256-GCM) ключом, который есть только на ваших устройствах; в облаке он лежит лишь обёрнутым вашим паролем (PBKDF2, 600 000 итераций) и кодом восстановления.</p>`;
    };

    const render = () => {
      const c = state.cloud;
      if (!c) return '<div class="install-progress"><span class="spinner"></span><span>Загрузка…</span></div>';
      if (c.vault === 'ready' && c.signedIn) return readyView(c);
      const intro = '<p class="section-hint" style="margin:0 4px 14px">Данные шифруются на телефоне вашим паролем: в облако уходит только шифротекст. Без облака приложение работает как раньше — только на этом телефоне.</p>';
      if (!c.configured) return intro + configView(c);
      if (!c.signedIn) return intro + signInView(c);
      if (c.vault === 'none') return intro + createView(c);
      if (c.vault === 'locked') return intro + unlockView(c);
      return intro + '<div class="install-progress"><span class="spinner"></span><span>Проверяю хранилище в облаке…</span></div>'
        + (c.lastError ? errorCard(c.lastError) : '') + signOutLink();
    };

    const layer = openPage({
      title: 'Облако и аккаунт',
      body: '',
      onClose: () => {
        clearInterval(timer);
        Object.keys(draft).forEach((k) => { draft[k] = ''; });
      },
    });
    layer.isCloudPage = true;
    const fillInputs = () => {
      $$('[data-role]', layer.el).forEach((el) => {
        const role = el.dataset.role;
        if (Object.prototype.hasOwnProperty.call(draft, role) && 'value' in el) el.value = draft[role];
      });
    };
    layer.refresh = () => {
      const active = document.activeElement;
      if (active && layer.el.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      const html = render();
      if (html === lastHtml) return;
      lastHtml = html;
      const body = $('.page-body', layer.el);
      const scroll = body.scrollTop;
      const openDetails = $$('details.disclosure', body).map(d => d.open);
      layer.setBody(html);
      $$('details.disclosure', body).forEach((d, i) => { if (openDetails[i]) d.open = true; });
      fillInputs();
      body.scrollTop = scroll;
    };
    const rerender = () => {
      lastHtml = '';
      layer.refresh();
    };
    rerender();
    layer.el.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (!Object.prototype.hasOwnProperty.call(draft, role)) return;
      draft[role] = e.target.value;
      if (role === 'pw1') {
        const meter = $('[data-role="meter"]', layer.el);
        if (meter) meter.outerHTML = strengthHtml(draft.pw1, minChars());
      }
    });

    refreshCloudStatus();
    timer = setInterval(() => {
      const c = state.cloud;
      // Often while something runs, otherwise every 10 s.
      const watching = !c || c.busy || c.loginPending || (c.signedIn && c.vault === 'unknown');
      if (watching || Date.now() - lastPoll > 10000) {
        lastPoll = Date.now();
        refreshCloudStatus();
      }
    }, 1500);

    const run = async (act, fn) => {
      if (ui.busy) return;
      ui.busy = act;
      rerender();
      try {
        await fn();
      } catch (e) {
        toast(e.message || 'Ошибка', { type: 'error', duration: 8000 });
      } finally {
        ui.busy = '';
        await refreshCloudStatus();
        rerender();
      }
    };

    bindActs(layer, {
      guide: () => openExternal(CLOUD_GUIDE_URL),
      'copy-sha': () => copyText((state.cloud && state.cloud.certSha1) || ''),
      'save-config': () => run('save-config', async () => {
        if (!draft.config.trim()) throw new Error('Вставьте конфигурацию проекта');
        await api('/api/cloud/config', { method: 'POST', body: { config: draft.config } });
        draft.config = '';
        toast('Проект Firebase сохранён', { type: 'success' });
      }),
      'edit-config': async () => {
        const ok = await confirmDialog({ title: 'Сменить проект Firebase?', message: 'Текущая конфигурация будет удалена — затем вставьте новую.', confirmText: 'Сменить' });
        if (ok) run('edit-config', () => api('/api/cloud/config', { method: 'POST', body: { clear: true } }));
      },
      login: () => run('login', async () => {
        const res = await api('/api/cloud/auth/start', { method: 'POST' });
        if (res.authUrl && !hasBridge) window.open(res.authUrl, '_blank');
        toast('Завершите вход в браузере');
      }),
      exchange: () => run('exchange', async () => {
        if (!draft.code.trim()) throw new Error('Вставьте адрес из строки браузера');
        await api('/api/cloud/auth/exchange', { method: 'POST', body: { codeOrUrl: draft.code.trim() } });
        draft.code = '';
        toast('Вход выполнен', { type: 'success' });
      }),
      'toggle-show': () => {
        ui.show = !ui.show;
        rerender();
      },
      create: async () => {
        const st = passwordStrength(draft.pw1, minChars());
        if (!st.ok) {
          toast(st.hint || 'Пароль слишком простой', { type: 'error' });
          return;
        }
        if (draft.pw1 !== draft.pw2) {
          toast('Пароли не совпадают', { type: 'error' });
          return;
        }
        const ok = await confirmDialog({
          title: 'Запомнили пароль?',
          message: 'Без пароля и без кода восстановления данные в облаке не расшифровать — никому, даже разработчику. На следующем шаге сохраните код восстановления.',
          confirmText: 'Создать',
        });
        if (!ok) return;
        run('create', async () => {
          const res = await api('/api/cloud/vault/create', { method: 'POST', body: { password: draft.pw1 } });
          draft.pw1 = '';
          draft.pw2 = '';
          if (res.recoveryCode) showRecoveryCode(res.recoveryCode);
        });
      },
      'use-code': () => {
        ui.useCode = !ui.useCode;
        rerender();
      },
      mode: (el) => {
        ui.mode = el.dataset.value === 'replace' ? 'replace' : 'merge';
        rerender();
      },
      backup: () => openBackupPage(),
      unlock: async () => {
        const c = state.cloud || {};
        const body = ui.useCode ? { recoveryCode: draft.recovery.trim() } : { password: draft.unlockPw };
        if (!body.recoveryCode && !body.password) {
          toast(ui.useCode ? 'Введите код восстановления' : 'Введите пароль', { type: 'error' });
          return;
        }
        if (c.hasLocalData && !c.linked) {
          body.mode = ui.mode;
          if (ui.mode === 'replace') {
            const ok = await confirmDialog({
              title: 'Заменить данные на телефоне?',
              message: 'Все персонажи, персоны, чаты и системный промпт на этом телефоне будут стёрты и заменены данными из облака. Отменить это нельзя.',
              confirmText: 'Заменить',
              danger: true,
            });
            if (!ok) return;
          }
        }
        run('unlock', async () => {
          await api('/api/cloud/vault/unlock', { method: 'POST', body });
          draft.unlockPw = '';
          draft.recovery = '';
          if (body.mode === 'replace') {
            closeChatRoom();
            state.systemPromptText = null;
            await loadAll();
          }
          toast('Хранилище открыто — идёт синхронизация', { type: 'success' });
        });
      },
      sync: () => run('sync', () => api('/api/cloud/sync', { method: 'POST' })),
      password: () => openCloudPasswordSheet(),
      recovery: () => openCloudRecoverySheet(),
      signout: () => openCloudSignOutSheet(),
      wipe: () => openCloudWipeSheet(),
    });
  }

  /** A new recovery code, shown once: the dialog stays until the user confirms it is saved. */
  function showRecoveryCode(code) {
    let saved = false;
    const layer = openLayer({
      kind: 'dialog',
      dismissible: false,
      onBack: () => saved,
      html: `<div class="dialog" role="alertdialog">
        <h2 class="dialog-title">Код восстановления</h2>
        <p class="dialog-text">Если забудете пароль, данные в облаке откроет только этот код. Сохраните его в менеджере паролей или запишите на бумаге — отдельно от пароля. Больше он показан не будет.</p>
        <div class="recovery-code">${escapeHtml(code)}</div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-secondary btn-sm" data-act="copy">${ic('copy', 'ic-sm')}Скопировать</button>
          <button class="btn btn-secondary btn-sm" data-act="save">${ic('download', 'ic-sm')}Сохранить файлом</button>
        </div>
        <button class="row" data-act="saved" style="margin-top:8px;padding-left:0;padding-right:0"><span class="switch" data-role="saved"></span><div class="row-body"><div class="row-title">Я сохранил код</div></div></button>
        <div class="dialog-actions"><button class="btn btn-primary" data-act="done" disabled>Готово</button></div>
      </div>`,
    });
    bindActs(layer, {
      copy: () => copyText(code),
      save: () => saveFile('agy-recovery-code.txt',
        'AGY Roleplay — код восстановления облачного хранилища\n\n' + code + '\n\nХраните отдельно от пароля шифрования.\n', 'text/plain'),
      saved: () => {
        saved = !saved;
        $('[data-role="saved"]', layer.el).classList.toggle('on', saved);
        $('[data-act="done"]', layer.el).disabled = !saved;
      },
      done: () => {
        if (saved) layer.close();
      },
    });
  }

  function openCloudPasswordSheet() {
    const d = { current: '', pw1: '', pw2: '' };
    let useCode = false;
    let busy = false;
    const min = (state.cloud && state.cloud.minPasswordChars) || 10;
    const layer = openSheet({
      title: 'Сменить пароль',
      body: `
        <label class="field"><span class="field-label" data-role="current-label">Текущий пароль</span>${cloudPasswordInput('current', { autocomplete: 'current-password' })}</label>
        <button class="btn btn-ghost btn-sm" style="padding:0;margin-top:6px" data-act="use-code">Не помню — ввести код восстановления</button>
        <label class="field" style="margin-top:12px"><span class="field-label">Новый пароль</span>${cloudPasswordInput('pw1', { autocomplete: 'new-password' })}</label>
        ${strengthHtml('', min)}
        <label class="field" style="margin-top:12px"><span class="field-label">Повторите новый пароль</span>${cloudPasswordInput('pw2', { autocomplete: 'new-password' })}</label>
        <p class="section-hint">Данные заново шифровать не нужно: меняется только обёртка ключа в облаке. На других телефонах, где облако уже открыто, ничего вводить не придётся.</p>`,
      footer: '<button class="btn btn-primary btn-block" data-act="save">Сменить пароль</button>',
      onClose: () => {
        d.current = '';
        d.pw1 = '';
        d.pw2 = '';
      },
    });
    layer.el.addEventListener('input', (e) => {
      const role = e.target.dataset.role;
      if (!Object.prototype.hasOwnProperty.call(d, role)) return;
      d[role] = e.target.value;
      if (role === 'pw1') {
        const meter = $('[data-role="meter"]', layer.el);
        if (meter) meter.outerHTML = strengthHtml(d.pw1, min);
      }
    });
    bindActs(layer, {
      'use-code': (btn) => {
        useCode = !useCode;
        const input = $('[data-role="current"]', layer.el);
        input.type = useCode ? 'text' : 'password';
        input.classList.toggle('mono', useCode);
        input.placeholder = useCode ? 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' : '';
        input.value = '';
        d.current = '';
        $('[data-role="current-label"]', layer.el).textContent = useCode ? 'Код восстановления' : 'Текущий пароль';
        btn.textContent = useCode ? 'Ввести текущий пароль' : 'Не помню — ввести код восстановления';
      },
      save: async (btn) => {
        if (busy) return;
        const st = passwordStrength(d.pw1, min);
        if (!d.current.trim()) {
          toast(useCode ? 'Введите код восстановления' : 'Введите текущий пароль', { type: 'error' });
          return;
        }
        if (!st.ok) {
          toast(st.hint || 'Пароль слишком простой', { type: 'error' });
          return;
        }
        if (d.pw1 !== d.pw2) {
          toast('Пароли не совпадают', { type: 'error' });
          return;
        }
        busy = true;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Шифрую…';
        try {
          await api('/api/cloud/vault/password', {
            method: 'POST',
            body: useCode ? { recoveryCode: d.current.trim(), newPassword: d.pw1 } : { password: d.current, newPassword: d.pw1 },
          });
          layer.close();
          toast('Пароль изменён', { type: 'success' });
        } catch (e) {
          toast(e.message, { type: 'error', duration: 8000 });
          busy = false;
          btn.disabled = false;
          btn.textContent = 'Сменить пароль';
        }
      },
    });
  }

  function openCloudRecoverySheet() {
    let pw = '';
    let busy = false;
    const layer = openSheet({
      title: 'Новый код восстановления',
      body: `<p class="step-text">Старый код перестанет действовать. Подтвердите паролем шифрования.</p>
        ${cloudPasswordInput('pw', { autocomplete: 'current-password', placeholder: 'Пароль шифрования' })}`,
      footer: '<button class="btn btn-primary btn-block" data-act="make">Создать новый код</button>',
      onClose: () => { pw = ''; },
    });
    layer.el.addEventListener('input', (e) => {
      if (e.target.dataset.role === 'pw') pw = e.target.value;
    });
    bindActs(layer, {
      make: async (btn) => {
        if (busy) return;
        if (!pw) {
          toast('Введите пароль', { type: 'error' });
          return;
        }
        busy = true;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Проверяю…';
        try {
          const res = await api('/api/cloud/vault/recovery', { method: 'POST', body: { password: pw } });
          layer.close();
          if (res.recoveryCode) showRecoveryCode(res.recoveryCode);
        } catch (e) {
          toast(e.message, { type: 'error', duration: 8000 });
          busy = false;
          btn.disabled = false;
          btn.textContent = 'Создать новый код';
        }
      },
    });
  }

  function openCloudSignOutSheet() {
    const c = state.cloud || {};
    const pending = Number(c.pending) || 0;
    const unsent = pending
      ? ` <b>${formatCount(pending)} ${pluralRu(pending, 'изменение ещё не отправлено', 'изменения ещё не отправлены', 'изменений ещё не отправлено')}</b> — оно останется только на этом телефоне.`
      : '';
    const layer = openSheet({
      title: 'Выйти из облака',
      body: `<p class="step-text">Данные в облаке останутся: их можно открыть на любом телефоне, войдя тем же аккаунтом и введя пароль шифрования.${unsent}</p>
        <div class="list">
          <button class="row" data-act="keep"><span class="row-icon">${ic('logout')}</span><div class="row-body"><div class="row-title">Выйти, данные оставить</div><div class="row-sub">Всё останется и на этом телефоне</div></div></button>
          <button class="row danger" data-act="wipe"><span class="row-icon">${ic('trash')}</span><div class="row-body"><div class="row-title">Выйти и стереть данные с телефона</div><div class="row-sub">Например, перед тем как отдать телефон</div></div></button>
        </div>`,
    });
    const go = async (wipeLocal) => {
      if (wipeLocal) {
        const ok = await confirmDialog({
          title: 'Стереть данные с телефона?',
          message: 'Персонажи, персоны, чаты и системный промпт будут удалены с этого телефона.'
            + (pending ? ` Неотправленные изменения (${pending}) пропадут.` : ' В облаке они останутся.'),
          confirmText: 'Стереть',
          danger: true,
        });
        if (!ok) return;
      }
      layer.close();
      try {
        await api('/api/cloud/signout', { method: 'POST', body: { wipeLocal } });
        if (wipeLocal) {
          closeChatRoom();
          state.systemPromptText = null;
          await loadAll();
        }
        await refreshCloudStatus();
        toast(wipeLocal ? 'Вы вышли, данные с телефона стёрты' : 'Вы вышли из облака', { type: 'success' });
      } catch (e) {
        toast(e.message, { type: 'error', duration: 8000 });
      }
    };
    bindActs(layer, { keep: () => go(false), wipe: () => go(true) });
  }

  function openCloudWipeSheet() {
    let deleteAccount = false;
    let busy = false;
    const layer = openSheet({
      title: 'Удалить данные из облака',
      body: `<p class="step-text">Все зашифрованные данные и хранилище ключа будут удалены из вашего проекта Firebase, облако отключится. На этом телефоне всё останется. Другие телефоны тоже потеряют облачную копию.</p>
        <button class="row" data-act="account" style="padding-left:0;padding-right:0"><span class="switch" data-role="account"></span><div class="row-body"><div class="row-title">Удалить и аккаунт в Firebase</div><div class="row-sub">Запись о вашем входе в этом проекте</div></div></button>
        <label class="field" style="margin-top:12px"><span class="field-label">Для подтверждения введите УДАЛИТЬ</span>
          <input class="input" data-role="confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" /></label>`,
      footer: '<button class="btn btn-danger btn-block" data-act="go" disabled>Удалить из облака</button>',
    });
    layer.el.addEventListener('input', (e) => {
      if (e.target.dataset.role !== 'confirm') return;
      $('[data-act="go"]', layer.el).disabled = e.target.value.trim().toUpperCase() !== 'УДАЛИТЬ';
    });
    bindActs(layer, {
      account: () => {
        deleteAccount = !deleteAccount;
        $('[data-role="account"]', layer.el).classList.toggle('on', deleteAccount);
      },
      go: async (btn) => {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Удаляю…';
        try {
          await api('/api/cloud/wipe', { method: 'POST', body: { confirm: 'УДАЛИТЬ', deleteAccount } });
          layer.close();
          await refreshCloudStatus();
          toast('Данные удалены из облака', { type: 'success' });
        } catch (e) {
          toast(e.message, { type: 'error', duration: 8000 });
          busy = false;
          btn.disabled = false;
          btn.textContent = 'Удалить из облака';
        }
      },
    });
  }

  // --- updates --------------------------------------------------------------
  /**
   * What the update check offers: a newer build needs a new APK ('apk'); a
   * newer version for the installed build is a signed web update ('ota').
   */
  function updateAction(d) {
    if (!d || !d.remoteReachable) return 'none';
    if (d.nativeUpdateRequired) return 'apk';
    if (d.otaAvailable) return 'ota';
    return 'none';
  }

  async function checkForUpdates(manual) {
    try {
      const data = await api('/api/updates/check');
      state.updateInfo = data;
      const action = updateAction(data);
      const badge = $('#navSettingsBadge');
      if (badge) badge.classList.toggle('hidden', action === 'none');
      if (state.tab === 'settings') renderSettingsTab();
      refreshLayers();
      if (action !== 'none' && !manual && !state.updateToastShown) {
        state.updateToastShown = true;
        toast(action === 'apk' ? `Вышла версия ${data.latestVersion} — нужен новый APK` : `Доступна версия ${data.latestVersion}`, {
          action: { label: 'Подробнее', fn: () => openUpdatesPage() },
          duration: 8000,
        });
      }
      if (manual) {
        if (!data.remoteReachable) {
          toast('Репозиторий недоступен: ' + (data.remoteError || ''), { type: 'error' });
        } else {
          toast(action === 'none' ? 'Установлена последняя версия' : `Доступна версия ${data.latestVersion}`,
            { type: action === 'none' ? 'success' : 'info' });
        }
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
      toast('Ошибка обновления: ' + e.message, { type: 'error', duration: 8000 });
    }
  }

  function openUpdatesPage() {
    let checking = false;
    const render = () => {
      const d = state.updateInfo;
      if (!d) return '<div class="empty"><span class="spinner"></span></div>';
      const action = updateAction(d);
      let status;
      if (!d.remoteReachable) status = `<span class="pill warn">${ic('alert', 'ic-xs')}Репозиторий недоступен</span>`;
      else if (action === 'apk') status = '<span class="pill warn">Нужен новый APK</span>';
      else if (action === 'ota') status = '<span class="pill accent">Доступно обновление</span>';
      else status = `<span class="pill ok">${ic('check', 'ic-xs')}Актуальная версия</span>`;
      const releases = d.releases || [];
      const commits = d.commits || [];
      const primary = action === 'apk'
        ? `<button class="btn btn-primary btn-block" data-act="apk">${ic('package')}Скачать APK v${escapeHtml(d.latestVersion)}</button>
           <p class="section-hint">Загрузка откроется в браузере. Установите файл поверх приложения — чаты и настройки сохранятся.</p>`
        : `<button class="btn btn-primary btn-block" data-act="apply"${action === 'ota' ? '' : ' disabled'}>${ic('update')}${action === 'ota' ? `Обновить до v${escapeHtml(d.latestVersion)}` : 'Обновлений нет'}</button>`;
      return `
        <div class="version-hero">
          <div class="version-box"><div class="version-label">Установлена</div><div class="version-value">v${escapeHtml(d.currentVersion || state.webVersion || '—')}</div><div class="version-sub">build ${escapeHtml(d.currentBuild || '—')} · ${d.otaActive ? 'OTA' : 'APK'}</div></div>
          <div class="version-box highlight"><div class="version-label">В репозитории</div><div class="version-value">v${escapeHtml(d.latestVersion || '—')}</div><div class="version-sub">build ${escapeHtml(d.latestBuild || '—')}${d.latestCommit ? ' · ' + escapeHtml(d.latestCommit) : ''}</div></div>
        </div>
        <div style="margin:12px 0">${status}${d.remoteError && !d.remoteReachable ? `<p class="section-hint">${escapeHtml(d.remoteError)}</p>` : ''}</div>
        ${primary}
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-secondary" data-act="check"${checking ? ' disabled' : ''}>${checking ? '<span class="spinner"></span>' : ic('reroll')}Проверить</button>
          ${d.otaActive ? `<button class="btn btn-secondary" data-act="reset">${ic('undo')}Сброс к APK</button>` : `<button class="btn btn-secondary" data-act="apk">${ic('package')}APK</button>`}
        </div>
        ${releases.length ? `<div class="section"><div class="section-title">Что нового</div><div class="card">${releases.slice(0, 6).map(r => `<div class="release">
            <div class="release-head"><span class="release-ver">v${escapeHtml(r.version)}</span>${r.version === d.currentVersion ? '<span class="pill ok">Установлена</span>' : ''}<span class="release-date">${escapeHtml(r.date || '')}</span></div>
            ${r.title ? `<div class="release-title">${escapeHtml(r.title)}</div>` : ''}
            ${(r.changelog || []).length ? `<ul>${r.changelog.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
          </div>`).join('')}</div></div>` : ''}
        <details class="disclosure section"><summary>${ic('code', 'ic-sm')}Для разработчиков ${ic('chevron-down', 'ic-sm')}</summary>
          <label class="field"><span class="field-label">Ветка</span><input class="input mono" data-role="branch" value="${escapeHtml(d.gitBranch || 'main')}" autocomplete="off" />
            <span class="field-hint">Репозиторий ${escapeHtml(d.gitRepo || '')} зафиксирован в подписанном APK. Установить можно только интерфейс для этого же build APK.</span></label>
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
      body: `<p class="section-hint" style="margin:0 4px 12px">Важные факты, договорённости и события, которые модель должна помнить. Текст попадает в системный промпт внутри &lt;chat_memory&gt;; макросы {{user}} и {{charN}} подставляются.</p>
        <textarea class="textarea tall" data-role="text" placeholder="Например: {{user}} обещал вернуться к рассвету. {{char1}} не доверяет гильдии.">${escapeHtml(initial)}</textarea>`,
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
    'chat-cast': () => openCastSheet(),
    'story-character': (el) => openStoryCharacter(Number(el.dataset.msg), Number(el.dataset.n)),
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
      const isPersona = el.dataset.who === 'persona';
      const who = isPersona ? state.room.data.persona : state.room.data.character;
      const name = isPersona ? personaLabel(who) : cardLabel(who);
      if (who) openImageViewer(resolveAvatarUrl(who.avatar_url, name), name);
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
        // Changes from other devices (the engine checks at most once a minute).
        api('/api/cloud/sync', { method: 'POST', body: { reason: 'resume' } }).catch(() => {});
        if (layerStack.some(l => l.isCloudPage)) refreshCloudStatus();
      }
    });
  }

  function showLoadError(err) {
    state.loadError = (err && err.message) || 'Встроенный сервер не отвечает';
    renderAllTabs();
  }

  function init() {
    applyTheme();
    initEvents();
    initGestures();
    renderAllTabs();
    loadAll()
      .then(() => {
        refreshCloudStatus();
        setTimeout(() => checkForUpdates(false), 800);
      })
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
    cardLabel,
    personaLabel,
    cardCast,
    storyCast,
    castMacros,
    applyMacros,
    splitLiveText,
    castLossNote,
    updateAction,
    deliveryNote,
    passwordStrength,
    cloudSummary,
    formatBytes,
    agoText,
  };
})();
