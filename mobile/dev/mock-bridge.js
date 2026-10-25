// Development-only stand-in for the native AndroidServer bridge.
//
// Loaded by mobile/dev/serve.js BEFORE app.js so the real UI runs in a desktop
// browser against an in-memory backend that follows the LocalBackendServer.java
// contract (routes, payloads, status codes, generation progress polling).
// Never shipped: it lives outside mobile/www, which is all the APK/OTA bundles.
//
// URL switches:
//   ?engine=17   emulate the old native engine (no cancel, no prompt preview,
//                no engineBuild, no setSystemBars, no last_activity)
//   ?engine=18   engine without the pinned Claude runtime installer
//   ?empty=1     start without characters, personas and chats
//   ?long=1      add a 300-message chat for scroll/perf testing
//   ?delay=ms    base latency of every request (default 120)
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const ENGINE = Number(params.get('engine') || 19);
  const LEGACY = ENGINE < 18;
  const DELAY = Number(params.get('delay') || 120);

  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString().replace('T', ' ').slice(0, 19);

  function svgAvatar(letter, bg, fg) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#0c0e12"/></linearGradient></defs><rect width="120" height="160" fill="url(#g)"/><text x="60" y="96" font-size="56" text-anchor="middle" fill="${fg}" font-family="sans-serif">${letter}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  const db = {
    seq: 100,
    settings: {
      projectId: 'project-4c7a8e8a-764a-42bc-bdf',
      selectedModel: 'gemini-4-argon',
      selectedEffort: 'high',
      activePersonaId: 1,
      safetyThreshold: 'OFF',
      agyAuthenticated: true,
      agyUserEmail: 'player@example.com',
      claudeProjectPath: '',
      claudeRuntimeReady: false,
      claudeAuthenticated: false,
    },
    files: {
      'GEMINI.md': 'Ты — ведущий ролевой игры. Пиши от третьего лица, живо и образно.\nОтвечай за {{char}}, никогда не пиши за {{user}}.',
      'memories/chat_1.md': '# Память чата #1\n\n- {{user}} обещал вернуться к рассвету.',
      'memories/chat_2.md': '# Память чата #2\n\n',
      'exports/.keep': '',
    },
    characters: [],
    personas: [],
    chats: [],
    messages: [],
    generations: {},
    lastGenerations: {},
  };
  const nextId = () => ++db.seq;

  if (params.get('empty') !== '1') {
    db.characters.push(
      { id: 1, name: 'Кира', file_path: 'characters/kira.md', avatar_url: svgAvatar('К', '#5b4bd6', '#e9e6ff'),
        first_message: '*Кира отрывается от карты и медленно поднимает взгляд.* «Ты опоздал. Опять.»' },
      { id: 2, name: 'Елена', file_path: 'characters/elena.md', avatar_url: svgAvatar('Е', '#1f8a78', '#dcfff8'),
        first_message: '*Архив пахнет пылью и воском.* «Тише. Здесь даже книги умеют слушать.»' },
      { id: 3, name: 'Ворон', file_path: 'characters/voron.md', avatar_url: '',
        first_message: '' }
    );
    db.files['characters/kira.md'] = 'Кира — наёмница двадцати шести лет, бывший картограф гильдии.\nХарактер: язвительная, верная, ненавидит опоздания.\nМанера речи: короткие фразы, сухой юмор.';
    db.files['characters/elena.md'] = '# Имя: Елена\n\n### Описание и Характер\nХранительница архива. Говорит тихо, видит больше, чем говорит.\n\n### Начальное сообщение\n*Архив пахнет пылью и воском.* «Тише. Здесь даже книги умеют слушать.»\n';
    db.files['characters/voron.md'] = 'Ворон — говорящая птица-проводник.';
    db.personas.push(
      { id: 1, name: 'Кадзума', file_path: 'personas/kazuma.md', avatar_url: svgAvatar('К', '#3b4a6b', '#dbe4ff'), is_default: 1 },
      { id: 2, name: 'Странник', file_path: 'personas/wanderer.md', avatar_url: '', is_default: 0 }
    );
    db.files['personas/kazuma.md'] = 'Кадзума — путешественник между мирами, носит потёртый плащ.';
    db.files['personas/wanderer.md'] = 'Безымянный странник без прошлого.';

    db.chats.push(
      { id: 1, title: 'Чат: Кира', character_id: 1, persona_id: 1, model_id: 'gemini-4-argon', effort: 'high',
        memory_file_path: 'memories/chat_1.md', provider: '', system_prompt_path: '', first_message_path: '', project_path: '',
        created_at: minutesAgo(600), updated_at: minutesAgo(5) },
      { id: 2, title: 'Чат: Елена', character_id: 2, persona_id: 2, model_id: 'claude-code-opus', effort: 'xhigh',
        memory_file_path: 'memories/chat_2.md', provider: 'claude-cli', system_prompt_path: '', first_message_path: '', project_path: '',
        created_at: minutesAgo(3000), updated_at: minutesAgo(2900) }
    );
    const add = (chatId, role, content, extra) => {
      const m = Object.assign({ id: nextId(), chat_id: chatId, role, content, thoughts: '', swipes: [content],
        thought_swipes: [''], swipe_index: 0, created_at: now() }, extra || {});
      db.messages.push(m);
      return m;
    };
    add(1, 'assistant', db.characters[0].first_message, { created_at: minutesAgo(600) });
    add(1, 'user', '*Стряхиваю снег с плеч.* «Пробки на перевале. Ты же знаешь.»', { created_at: minutesAgo(30) });
    add(1, 'assistant', '*Кира фыркает и сворачивает карту.* «Пробки. На перевале. Где за день проходит одна телега.»\n\n*Она кивает на стул напротив.* «Садись. У нас есть **проблема**.»', {
      created_at: minutesAgo(29),
      thoughts: 'Он явно врёт, но Кире это даже нравится. Нужно перейти к делу: заказ на перевале.',
      swipes: [
        '*Кира молча указывает на стул.* «Садись.»',
        '*Кира фыркает и сворачивает карту.* «Пробки. На перевале. Где за день проходит одна телега.»\n\n*Она кивает на стул напротив.* «Садись. У нас есть **проблема**.»',
      ],
      thought_swipes: ['Коротко и холодно.', 'Он явно врёт, но Кире это даже нравится. Нужно перейти к делу: заказ на перевале.'],
      swipe_index: 1,
    });
    add(2, 'assistant', db.characters[1].first_message, { created_at: minutesAgo(3000) });
    add(2, 'user', '«Я ищу книгу без названия.»', { created_at: minutesAgo(2950) });
    add(2, 'assistant', '*Елена замирает, не оборачиваясь.* «Такие книги не ищут. Они находят сами.»', { created_at: minutesAgo(2949) });

    if (params.get('long') === '1') {
      db.chats.push({ id: 3, title: 'Долгая кампания', character_id: 1, persona_id: 1, model_id: 'gemini-3.8-flash', effort: 'medium',
        memory_file_path: 'memories/chat_3.md', provider: '', system_prompt_path: '', first_message_path: '', project_path: '',
        created_at: minutesAgo(9000), updated_at: minutesAgo(9000) });
      for (let i = 0; i < 300; i++) {
        add(3, i % 2 ? 'user' : 'assistant', (i % 2 ? '«Реплика игрока №' + i + '.»' : '*Кира отвечает (' + i + ').* «Длинный ответ персонажа с описанием сцены, погоды и настроения, чтобы проверить перенос строк и производительность прокрутки.»'),
          { created_at: minutesAgo(9000 - i) });
      }
    }
  }

  // Mirrors VERTEX_MODELS / CLAUDE_CLI_MODELS in LocalBackendServer.java (engine 19).
  const ALL = 'low,medium,high,xhigh,max';
  const BASIC = 'low,medium,high';
  const CLI = 'Claude Code · на устройстве';
  const MODELS = [
    ['gemini-4-argon', 'Gemini 4 Argon', 'Google DeepMind', 'Флагман RP', BASIC],
    ['claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic (AGY)', 'Литературный', ''],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Anthropic (AGY)', 'Креативный', ''],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash', 'Google DeepMind', 'Быстрый RP', BASIC],
    ['gemini-3.7-flash', 'Gemini 3.7 Flash', 'Google DeepMind', 'Баланс', BASIC],
    ['gemini-3.6-flash', 'Gemini 3.6 Flash', 'Google DeepMind', 'Скоростной', BASIC],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'Google DeepMind', 'Лёгкий', BASIC],
    ['gemini-3.1-pro', 'Gemini 3.1 Pro', 'Google DeepMind', 'Глубокий', BASIC],
    ['claude-code-opus', 'Claude Opus (новейшая)', CLI, 'Всегда последняя Opus', ALL],
    ['claude-code-sonnet', 'Claude Sonnet (новейшая)', CLI, 'Всегда последняя Sonnet', ALL],
    ['claude-code-haiku', 'Claude Haiku (новейшая)', CLI, 'Всегда последняя Haiku', ALL],
    ['claude-code-fable-5-1', 'Claude Fable 5.1', CLI, 'Самая мощная', ALL],
    ['claude-code-opus-5-5', 'Claude Opus 5.5', CLI, 'Opus', ALL],
    ['claude-code-sonnet-5-5', 'Claude Sonnet 5.5', CLI, 'Sonnet', ALL],
    ['claude-code-haiku-5-5', 'Claude Haiku 5.5', CLI, 'Haiku · быстрая', ALL],
    ['claude-code-fable-5', 'Claude Fable 5', CLI, 'Предыдущая Fable', ALL, true],
    ['claude-code-opus-5', 'Claude Opus 5', CLI, 'Предыдущая Opus', ALL, true],
    ['claude-code-opus-4-8', 'Claude Opus 4.8', CLI, 'Opus 4', ALL, true],
    ['claude-code-opus-4-7', 'Claude Opus 4.7', CLI, 'Opus 4', ALL, true],
    ['claude-code-opus-4-6', 'Claude Opus 4.6', CLI, 'Opus 4', 'low,medium,high,max', true],
    ['claude-code-opus-4-5', 'Claude Opus 4.5', CLI, 'Opus 4', BASIC, true],
    ['claude-code-sonnet-5', 'Claude Sonnet 5', CLI, 'Предыдущая Sonnet', ALL, true],
    ['claude-code-sonnet-4-6', 'Claude Sonnet 4.6', CLI, 'Sonnet 4', 'low,medium,high,max', true],
    ['claude-code-sonnet-4-5', 'Claude Sonnet 4.5', CLI, 'Снимается 30.11.2026', '', true],
    ['claude-code-haiku-4-5', 'Claude Haiku 4.5', CLI, 'Haiku 4', '', true],
  ].map(([id, name, provider, badge, efforts, legacy]) => {
    const m = { id, name, provider, badge };
    if (ENGINE >= 19) {
      m.efforts = efforts ? efforts.split(',') : [];
      m.legacy = !!legacy;
      return m;
    }
    // Older engines only knew two CLI models and no per-model effort lists.
    return (!id.startsWith('claude-code-') || id === 'claude-code-opus' || id === 'claude-code-sonnet') ? m : null;
  }).filter(Boolean);

  // ---------------------------------------------------------------------------
  const err = (status, msg, extra) => Object.assign({ __status: status, error: msg }, extra || {});
  const fileContent = (p) => (p && db.files[p] !== undefined ? db.files[p] : '');
  const preview = (t) => String(t || '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160);

  function charJson(c) {
    if (!c) return null;
    const text = fileContent(c.file_path);
    return Object.assign({}, c, { description_preview: preview(text), fileContent: text });
  }
  function personaJson(p) {
    if (!p) return null;
    const text = fileContent(p.file_path);
    return Object.assign({}, p, { description_preview: preview(text), fileContent: text });
  }
  const chatMessages = (chatId) => db.messages.filter(m => m.chat_id === chatId).sort((a, b) => a.id - b.id).map(m => JSON.parse(JSON.stringify(m)));

  function chatDetails(chatId) {
    const chat = db.chats.find(c => c.id === chatId);
    if (!chat) return err(404, 'Чат не найден');
    const character = charJson(db.characters.find(c => c.id === chat.character_id)) ||
      { id: 0, name: 'Персонаж', file_path: '', avatar_url: '', first_message: '', description_preview: '', fileContent: '' };
    const persona = personaJson(db.personas.find(p => p.id === chat.persona_id)) || personaJson(db.personas[0]) ||
      { id: 0, name: 'Игрок', file_path: '', avatar_url: '', description_preview: '', fileContent: '' };
    const c = Object.assign({}, chat);
    if (LEGACY) delete c.created_at;
    delete c.updated_at;
    return { chat: c, character, persona, messages: chatMessages(chatId) };
  }

  function chatList() {
    const rows = db.chats.map(c => {
      const msgs = db.messages.filter(m => m.chat_id === c.id);
      const last = msgs.sort((a, b) => b.id - a.id)[0];
      const ch = db.characters.find(x => x.id === c.character_id);
      const p = db.personas.find(x => x.id === c.persona_id);
      const lastActivity = [c.updated_at || c.created_at, last ? last.created_at : ''].sort().pop();
      const row = {
        id: c.id, title: c.title, character_id: c.character_id, persona_id: c.persona_id, model_id: c.model_id,
        effort: c.effort, memory_file_path: c.memory_file_path,
        character_name: ch ? ch.name : 'Персонаж', character_avatar: ch ? ch.avatar_url : '', character_file: ch ? ch.file_path : '',
        persona_name: p ? p.name : 'Игрок', last_message: last ? last.content : '', message_count: msgs.length,
      };
      if (!LEGACY) { row.last_activity = lastActivity; row.created_at = c.created_at; }
      return row;
    });
    if (LEGACY) return rows.sort((a, b) => b.id - a.id);
    return rows.sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || '') || b.id - a.id);
  }

  function buildSystemPrompt(character, persona, memPath) {
    const sub = (t) => t.split('{{char}}').join(character.name).split('{{user}}').join(persona.name);
    let rules = fileContent('GEMINI.md').trim();
    if (rules === '# GEMINI.md') rules = '';
    let mem = fileContent(memPath).trim();
    if (mem.startsWith('# Память чата')) mem = mem.includes('\n') ? mem.slice(mem.indexOf('\n') + 1).trim() : '';
    const parts = [];
    if (rules) parts.push(sub(rules));
    if (character.fileContent.trim()) parts.push('<character_persona>\n' + sub(character.fileContent.trim()) + '\n</character_persona>');
    if (persona.fileContent.trim()) parts.push('<user_persona>\n' + sub(persona.fileContent.trim()) + '\n</user_persona>');
    if (mem) parts.push('<chat_memory>\n' + sub(mem) + '\n</chat_memory>');
    return parts.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Generation simulation (live progress readable via GET .../generation)
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function newProgress(chat) {
    return {
      status: 'running', phase: 'context', statusText: '📋 Сборка контекста...', thoughts: '', text: '',
      modelId: chat.model_id, vertexModel: chat.model_id, effort: chat.effort, thinkingConfigSummary: 'thinkingLevel=HIGH',
      projectId: db.settings.projectId, endpoint: 'mock://vertex', httpStatus: 0, chunksCount: 0, thoughtsChars: 0, textChars: 0,
      contextMessagesCount: 0, promptChars: 0, finishReason: '', error: '', cancelled: false,
      elapsedMs: 0, elapsedSec: '0.0', logs: [], _start: Date.now(),
    };
  }
  function log(g, msg) {
    const e = Date.now() - g._start;
    const s = Math.floor(e / 1000);
    g.logs.push(`[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${Math.floor((e % 1000) / 100)}] ${msg}`);
  }
  function snapshot(g) {
    const out = Object.assign({}, g);
    delete out._start;
    out.elapsedMs = Date.now() - g._start;
    out.elapsedSec = (out.elapsedMs / 1000).toFixed(1);
    if (LEGACY) delete out.cancelled;
    return JSON.parse(JSON.stringify(out));
  }

  const REPLIES = [
    '*{{char}} задумчиво постукивает пальцами по столу.* «Ладно. Слушай внимательно, повторять не стану.»\n\n*Она разворачивает карту и проводит ногтем по извилистой линии.* «Вот здесь караван пропал три дня назад. Ни следов, ни тел. Только **вороньи перья** на снегу.»',
    '*Свеча мигает.* «Ты задаёшь правильные вопросы. Это опасно.»\n\n*Пауза.* «Но, возможно, именно это нам и нужно.»',
    '«Хм.» *{{char}} прищуривается.* «А теперь честно — что ты на самом деле видел у старого моста?»',
  ];

  async function runGeneration(chatId, history) {
    const chat = db.chats.find(c => c.id === chatId);
    const g = newProgress(chat);
    db.generations[chatId] = g;
    db.lastGenerations[chatId] = g;
    const ch = db.characters.find(c => c.id === chat.character_id) || { name: 'Персонаж' };
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    const userText = lastUser ? lastUser.content : '';
    log(g, 'Старт запроса: ' + chat.model_id + ' • Effort: ' + String(chat.effort).toUpperCase());
    g.contextMessagesCount = history.length;
    g.promptChars = 1800 + history.reduce((n, m) => n + m.content.length, 0);

    const stepWait = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (g.cancelled) throw new Error('Генерация остановлена');
        await sleep(60);
      }
    };
    try {
      await stepWait(350);
      g.phase = chat.model_id.startsWith('claude-code-') ? 'auth' : 'connecting';
      g.statusText = '🔌 Подключение...';
      log(g, 'Подключение к ' + (chat.model_id.startsWith('claude-code-') ? 'Claude Code CLI' : 'Vertex AI (SSE)'));
      await stepWait(500);
      if (/\/auth/.test(userText)) {
        throw new Error('Сессия AGY истекла или токен недействителен (HTTP 401). Перезайдите через кнопку «Войти через Google (AGY)» в Настройках.');
      }
      if (/\/error/.test(userText)) {
        g.httpStatus = 500;
        throw new Error('Ошибка модели ' + chat.model_id + ' (HTTP 500): Internal error (mock)');
      }
      g.httpStatus = 200;
      g.phase = 'thinking';
      g.statusText = '💭 Персонаж размышляет...';
      const thoughts = 'Нужно сохранить характер ' + ch.name + ': коротко, с иронией. Игрок явно что-то скрывает — подыграть, но подтолкнуть сюжет вперёд. Добавить деталь о перьях, чтобы связать с прошлой сценой.';
      for (let i = 0; i < thoughts.length; i += 9) {
        g.thoughts = thoughts.slice(0, i + 9);
        g.thoughtsChars = g.thoughts.length;
        g.chunksCount++;
        await stepWait(45);
      }
      g.phase = 'generating';
      g.statusText = '✍️ Печатает ответ...';
      const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)].split('{{char}}').join(ch.name);
      for (let i = 0; i < reply.length; i += 6) {
        g.text = reply.slice(0, i + 6);
        g.textChars = g.text.length;
        g.chunksCount++;
        await stepWait(35);
      }
      g.text = reply;
      g.textChars = reply.length;
      g.status = 'completed';
      g.phase = 'completed';
      g.finishReason = 'STOP';
      g.statusText = '✅ Ответ получен';
      log(g, '✅ Генерация завершена');
      return { reply, thoughts };
    } catch (e) {
      const cancelled = g.cancelled;
      g.status = cancelled ? 'cancelled' : 'error';
      g.phase = cancelled ? 'cancelled' : 'error';
      g.error = e.message;
      g.statusText = (cancelled ? '⏹ ' : '❌ ') + e.message;
      log(g, (cancelled ? '⏹ ' : '❌ ') + e.message);
      const failure = err(cancelled ? 409 : 401, e.message, { generation: snapshot(g) });
      if (!LEGACY) failure.cancelled = cancelled;
      throw failure;
    } finally {
      delete db.generations[chatId];
    }
  }

  // ---------------------------------------------------------------------------
  async function route(method, endpoint, body) {
    const [path, query = ''] = endpoint.split('?');
    const q = new URLSearchParams(query);

    if (path === '/api/health') return { ok: true, embeddedServer: true, ...(LEGACY ? {} : { engineBuild: ENGINE }) };

    if (path === '/api/settings') {
      if (method === 'POST') {
        for (const k of ['projectId', 'claudeProjectPath', 'selectedModel', 'selectedEffort', 'activePersonaId', 'safetyThreshold']) {
          if (body[k] !== undefined) db.settings[k] = body[k];
        }
        if (LEGACY && body.selectedModel) db.chats.forEach(c => { c.model_id = body.selectedModel; });
        if (LEGACY && body.selectedEffort) db.chats.forEach(c => { c.effort = body.selectedEffort; });
      }
      const s = Object.assign({ embeddedServer: true, workspaceDir: '/data/workspace', agyDiscoveredProject: '', manualTokenPresent: false }, db.settings,
        { claudeRuntimeReady: db.settings.claudeRuntimeReady, claudeAuthenticated: db.settings.claudeAuthenticated });
      if (!LEGACY) s.engineBuild = ENGINE;
      return s;
    }
    if (path === '/api/models') return { models: MODELS, efforts: ['low', 'medium', 'high', 'max'] };
    if (path === '/api/upload-avatar') return { ok: true, avatarUrl: body.base64Data };

    if (path === '/api/files' && method === 'GET') {
      const rel = (q.get('path') || '').replace(/^\/+|\/+$/g, '');
      const prefix = rel ? rel + '/' : '';
      const items = new Map();
      Object.keys(db.files).forEach(fp => {
        if (!fp.startsWith(prefix)) return;
        const rest = fp.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (!seg || seg.startsWith('.')) return;
        const isDir = rest.includes('/');
        items.set(seg, { name: seg, path: prefix + seg, isDirectory: isDir, size: isDir ? 0 : new Blob([db.files[fp]]).size });
      });
      const list = [...items.values()].sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
      return { currentPath: rel, items: list };
    }
    if (path === '/api/files' && method === 'DELETE') {
      const rel = q.get('path') || '';
      Object.keys(db.files).forEach(fp => { if (fp === rel || fp.startsWith(rel + '/')) delete db.files[fp]; });
      db.characters = db.characters.filter(c => c.file_path !== rel);
      db.personas = db.personas.filter(p => p.file_path !== rel);
      return { ok: true };
    }
    if ((path === '/api/files/content' || path === '/api/files/file') && method === 'GET') {
      const rel = q.get('path') || '';
      if (db.files[rel] === undefined) return err(404, 'Файл не найден');
      return { path: rel, name: rel.split('/').pop(), content: db.files[rel] };
    }
    if (path === '/api/files/folder') {
      const rel = body.folderPath || body.path;
      db.files[rel.replace(/\/+$/, '') + '/.keep'] = '';
      return { ok: true, path: rel };
    }
    if (path === '/api/files/file' && method === 'POST') {
      const rel = body.filePath || body.path;
      if (!rel) return err(400, 'Укажите путь');
      db.files[rel] = body.content || '';
      return { ok: true, path: rel };
    }

    if (path === '/api/characters' && method === 'GET') return { characters: db.characters.map(charJson) };
    if (path === '/api/personas' && method === 'GET') return { personas: db.personas.map(personaJson), activePersonaId: db.settings.activePersonaId };

    const saveCard = (table, prefix, editId) => {
      if (!String(body.name || '').trim()) return err(400, 'Введите имя');
      const list = db[table];
      let fp = body.filePath || (prefix + '/' + body.name.toLowerCase().replace(/[^a-zа-яё0-9_-]+/gi, '_') + '.md');
      if (!fp.includes('/')) fp = prefix + '/' + fp;
      if (!/\.(md|txt)$/.test(fp)) fp += '.md';
      let n = 2;
      const base = fp.replace(/\.(md|txt)$/, '');
      while (!LEGACY && list.some(x => x.file_path === fp && x.id !== editId)) fp = base + '_' + (n++) + '.md';
      const text = body.rawFileContent !== undefined ? body.rawFileContent : ('# Имя: ' + body.name + '\n\n' + (body.description || ''));
      db.files[fp] = text;
      const avatar = body.avatarUrl || svgAvatar(body.name[0].toUpperCase(), '#2a3040', '#c9d2ea');
      let row;
      if (editId) {
        row = list.find(x => x.id === editId);
        if (!row) return err(404, 'Не найдено');
        if (row.file_path !== fp) delete db.files[row.file_path];
        Object.assign(row, { name: body.name, file_path: fp, avatar_url: avatar });
      } else {
        row = { id: nextId(), name: body.name, file_path: fp, avatar_url: avatar };
        list.push(row);
      }
      if (table === 'characters') row.first_message = body.firstMessage || '';
      return table === 'characters' ? { ok: true, character: charJson(row) } : { ok: true, persona: personaJson(row) };
    };
    if (path === '/api/characters' && method === 'POST') return saveCard('characters', 'characters', null);
    if (path === '/api/personas' && method === 'POST') return saveCard('personas', 'personas', null);
    let m;
    if ((m = path.match(/^\/api\/characters\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') return saveCard('characters', 'characters', id);
      if (method === 'DELETE') {
        const c = db.characters.find(x => x.id === id);
        if (c) delete db.files[c.file_path];
        db.characters = db.characters.filter(x => x.id !== id);
        return { ok: true };
      }
    }
    if ((m = path.match(/^\/api\/personas\/(\d+)\/activate$/))) {
      db.settings.activePersonaId = Number(m[1]);
      return { ok: true, activePersonaId: Number(m[1]) };
    }
    if ((m = path.match(/^\/api\/personas\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') return saveCard('personas', 'personas', id);
      if (method === 'DELETE') {
        const p = db.personas.find(x => x.id === id);
        if (p) delete db.files[p.file_path];
        db.personas = db.personas.filter(x => x.id !== id);
        return { ok: true };
      }
    }

    if (path === '/api/chats' && method === 'GET') return { chats: chatList() };
    if (path === '/api/chats' && method === 'POST') {
      const character = db.characters.find(c => c.id === Number(body.characterId));
      if (!character) return err(404, 'Персонаж не найден');
      const persona = db.personas.find(p => p.id === Number(body.personaId)) || db.personas[0] || { id: 0, name: 'Игрок' };
      const id = nextId();
      db.chats.push({ id, title: 'Чат: ' + character.name, character_id: character.id, persona_id: persona.id,
        model_id: body.modelId || db.settings.selectedModel, effort: body.effort || db.settings.selectedEffort,
        memory_file_path: 'memories/chat_' + id + '.md', provider: body.provider || '', system_prompt_path: '', first_message_path: '',
        project_path: '', created_at: now(), updated_at: now() });
      db.files['memories/chat_' + id + '.md'] = '# Память чата #' + id + '\n\n';
      const greet = (body.customFirstMessage || character.first_message || '').split('{{char}}').join(character.name).split('{{user}}').join(persona.name);
      if (greet) db.messages.push({ id: nextId(), chat_id: id, role: 'assistant', content: greet, thoughts: '', swipes: [greet], thought_swipes: [''], swipe_index: 0, created_at: now() });
      return chatDetails(id);
    }
    if ((m = path.match(/^\/api\/chats\/(\d+)(?:\/(.*))?$/))) {
      const chatId = Number(m[1]);
      const sub = m[2] || '';
      const chat = db.chats.find(c => c.id === chatId);
      if (!sub) {
        if (method === 'GET') return chatDetails(chatId);
        if (method === 'PATCH') {
          if (!chat) return err(404, 'Чат не найден');
          if (body.modelId) chat.model_id = body.modelId;
          if (body.effort) chat.effort = body.effort;
          if (body.personaId !== undefined) chat.persona_id = Number(body.personaId);
          if (!LEGACY && body.title !== undefined) chat.title = String(body.title).trim();
          if (LEGACY && body.modelId) db.settings.selectedModel = body.modelId;
          return chatDetails(chatId);
        }
        if (method === 'DELETE') {
          db.chats = db.chats.filter(c => c.id !== chatId);
          db.messages = db.messages.filter(x => x.chat_id !== chatId);
          return { ok: true };
        }
      }
      if (sub === 'generation' && method === 'GET') {
        const g = db.generations[chatId];
        const last = db.lastGenerations[chatId];
        if (g) return { active: true, generation: snapshot(g) };
        return last ? { active: false, generation: snapshot(last), lastGeneration: snapshot(last) } : { active: false };
      }
      if (sub === 'generation/cancel' && method === 'POST' && !LEGACY) {
        const g = db.generations[chatId];
        if (g) { g.cancelled = true; log(g, '⏹ Остановка по запросу пользователя'); }
        return { ok: true, wasActive: !!g };
      }
      if (sub === 'system-prompt' && method === 'GET' && !LEGACY) {
        const d = chatDetails(chatId);
        if (d.__status) return d;
        const sp = buildSystemPrompt(d.character, d.persona, d.chat.memory_file_path);
        return { systemPrompt: sp, chars: sp.length };
      }
      if (sub === 'messages' && method === 'POST') {
        const content = String(body.content || '').trim();
        if (!content) return err(400, 'Пустое сообщение');
        const userMsg = { id: nextId(), chat_id: chatId, role: 'user', content, thoughts: '', swipes: [content], thought_swipes: [''], swipe_index: 0, created_at: now() };
        db.messages.push(userMsg);
        try {
          const r = await runGeneration(chatId, chatMessages(chatId));
          const ai = { id: nextId(), chat_id: chatId, role: 'assistant', content: r.reply, thoughts: r.thoughts, swipes: [r.reply], thought_swipes: [r.thoughts], swipe_index: 0, created_at: now() };
          db.messages.push(ai);
          chat.updated_at = now();
          return { assistantMessage: ai, messages: chatMessages(chatId), generation: snapshot(db.lastGenerations[chatId]) };
        } catch (failure) {
          db.messages = db.messages.filter(x => x.id !== userMsg.id);
          return failure;
        }
      }
    }

    if ((m = path.match(/^\/api\/messages\/(\d+)\/swipe$/))) {
      const msg = db.messages.find(x => x.id === Number(m[1]));
      if (!msg) return err(404, 'Сообщение не найдено');
      if ((body.action || 'select') === 'select') {
        const i = Math.max(0, Math.min(Number(body.index) || 0, msg.swipes.length - 1));
        msg.swipe_index = i;
        msg.content = msg.swipes[i];
        msg.thoughts = (msg.thought_swipes || [])[i] || '';
        return { message: JSON.parse(JSON.stringify(msg)) };
      }
      if (body.action === 'regenerate') {
        const history = chatMessages(msg.chat_id).filter(x => x.id < msg.id);
        try {
          const r = await runGeneration(msg.chat_id, history);
          msg.swipes.push(r.reply);
          msg.thought_swipes = (msg.thought_swipes || []).concat([r.thoughts]);
          msg.swipe_index = msg.swipes.length - 1;
          msg.content = r.reply;
          msg.thoughts = r.thoughts;
          return { message: JSON.parse(JSON.stringify(msg)), generation: snapshot(db.lastGenerations[msg.chat_id]) };
        } catch (failure) {
          return failure;
        }
      }
      return err(400, 'Unknown swipe action');
    }
    if ((m = path.match(/^\/api\/messages\/(\d+)$/))) {
      const id = Number(m[1]);
      const msg = db.messages.find(x => x.id === id);
      if (method === 'PUT') {
        if (!msg) return err(404, 'Сообщение не найдено');
        msg.content = body.content;
        msg.swipes[msg.swipe_index] = body.content;
        return { ok: true, message: JSON.parse(JSON.stringify(msg)) };
      }
      if (method === 'DELETE') {
        db.messages = db.messages.filter(x => x.id !== id);
        return { ok: true };
      }
    }

    if (path === '/api/agy/auth/status') return { authenticated: db.settings.agyAuthenticated, email: db.settings.agyUserEmail, projectId: db.settings.projectId };
    if (path === '/api/agy/auth/start') { setTimeout(() => { db.settings.agyAuthenticated = true; window.__onAgyOAuthSuccess && window.__onAgyOAuthSuccess(); }, 1500); return { ok: true, authUrl: '' }; }
    if (path === '/api/agy/auth/exchange') { db.settings.agyAuthenticated = true; return { authenticated: true, email: db.settings.agyUserEmail, projectId: db.settings.projectId }; }
    if (path === '/api/agy/auth/logout') { db.settings.agyAuthenticated = false; return { ok: true, authenticated: false }; }

    if (path === '/api/claude/status') {
      return { runtimeReady: db.settings.claudeRuntimeReady, authenticated: db.settings.claudeAuthenticated, runtimeVersion: 'mock',
        runtimeUrlConfigured: ENGINE >= 19, downloadMb: 128, installing: !!db.claudeInstalling, installProgress: db.claudeInstallProgress || '' };
    }
    if (path === '/api/claude/runtime/install') {
      if (ENGINE < 19) return err(503, 'SHA-256 среды Claude не задан в version.json (claudeRuntimeSha256). Установка отключена из соображений безопасности.');
      db.claudeInstalling = true;
      for (let pct = 0; pct <= 100; pct += 10) {
        db.claudeInstallProgress = 'Скачивание: ' + pct + '% (' + Math.round(128 * pct / 100) + ' из 128 МБ)';
        await sleep(250);
      }
      db.claudeInstallProgress = 'Распаковка: Claude Code 2.1.310…';
      await sleep(600);
      db.claudeInstalling = false;
      db.claudeInstallProgress = '';
      db.settings.claudeRuntimeReady = true;
      return { ok: true, runtimeReady: true, authenticated: db.settings.claudeAuthenticated };
    }
    if (path === '/api/claude/auth/start') return { ok: true, authUrl: 'https://claude.ai/oauth/mock' };
    if (path === '/api/claude/auth/exchange') { db.settings.claudeAuthenticated = true; return { ok: true, authenticated: true }; }
    if (path === '/api/claude/auth/logout') { db.settings.claudeAuthenticated = false; return { ok: true }; }

    if (path === '/api/updates/check') {
      return {
        currentVersion: '1.6.0', currentBuild: 18, bundledVersion: '1.6.0', bundledBuild: LEGACY ? 17 : 18, otaActive: LEGACY,
        nativeUpdateRequired: false, installedCommit: 'abc1234', latestVersion: '1.6.1', latestBuild: 18, latestCommit: 'def5678',
        latestCommitMessage: 'Fix typos', latestReleaseTitle: 'Мелкие исправления', updateAvailable: params.get('update') === '1',
        gitRepo: 'Kuka001/111', gitBranch: 'main', apkDownloadUrl: '', repoWebUrl: 'https://github.com/Kuka001/111', remoteReachable: true,
        releases: [
          { version: '1.6.1', build: 18, date: '2026-10-26', title: 'Мелкие исправления', ref: 'main', changelog: ['Исправлены опечатки'] },
          { version: '1.6.0', build: 18, date: '2026-10-25', title: 'Новый интерфейс', ref: 'main', changelog: ['Книжная лента', 'Единый системный промпт', 'Темы и настройки чтения'] },
        ],
        commits: [
          { sha: 'def5678aaaa', shortSha: 'def5678', message: 'Fix typos', author: 'Kuka001', date: '2026-10-26T10:00:00Z' },
          { sha: 'abc1234bbbb', shortSha: 'abc1234', message: 'v1.6.0', author: 'Kuka001', date: '2026-10-25T10:00:00Z' },
        ],
      };
    }
    if (path === '/api/updates/apply') { await sleep(800); return { ok: true, message: 'Обновление установлено (mock)' }; }
    if (path === '/api/updates/reset') return { ok: true };
    if (path === '/api/updates/config') return { ok: true, gitRepo: 'Kuka001/111', gitBranch: body.gitBranch || 'main' };

    if (path === '/api/backup/export') {
      return { backupFormat: 1, appVersion: '1.6.0', exportedAt: now(), tables: { characters: db.characters, personas: db.personas, chats: db.chats, messages: db.messages },
        settings: {}, workspaceFiles: db.files,
        counts: { characters: db.characters.length, personas: db.personas.length, chats: db.chats.length, messages: db.messages.length, workspaceFiles: Object.keys(db.files).length } };
    }
    if (path === '/api/backup/import') { await sleep(400); return { ok: true, restoredRows: 0, restoredFiles: 0, message: 'Данные восстановлены (mock)' }; }

    return err(404, 'Неизвестный маршрут APK-сервера: ' + method + ' ' + path);
  }

  function toB64(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  const bridge = {
    requestAsync(reqId, method, endpoint, bodyStr) {
      let body = {};
      try { body = bodyStr ? JSON.parse(bodyStr) : {}; } catch (e) { body = {}; }
      setTimeout(async () => {
        let res;
        try {
          res = await route(method, endpoint, body);
        } catch (e) {
          res = e && e.__status ? e : { __status: 500, error: String(e && e.message || e) };
        }
        const status = res && res.__status ? res.__status : 200;
        if (res && res.__status) delete res.__status;
        window.__onAndroidServerResponse(reqId, status, toB64(res || {}));
      }, DELAY * (0.5 + Math.random()));
    },
    reloadWebView() { location.reload(); },
    openExternalUrl(url) { console.info('[mock] openExternalUrl', url); window.open(url, '_blank'); },
    shareExportText(name, text) { console.info('[mock] share', name, text.length); },
    saveExportFile(name, text, mime) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime }));
      a.download = name;
      a.click();
      setTimeout(() => window.__onNativeFileSaved && window.__onNativeFileSaved(true), 300);
    },
    isEmbeddedServer() { return true; },
    getWorkspacePath() { return '/data/workspace'; },
  };
  if (!LEGACY) {
    bridge.setSystemBars = function (bg, nav, light) {
      console.info('[mock] setSystemBars', bg, nav, light);
      document.documentElement.style.setProperty('--mock-statusbar', bg);
    };
  }
  window.AndroidServer = bridge;
  window.__mockDb = db;
  console.info('[mock-bridge] engine build', ENGINE, LEGACY ? '(legacy)' : '');
})();
