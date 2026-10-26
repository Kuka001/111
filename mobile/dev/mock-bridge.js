// Development-only stand-in for the native AndroidServer bridge.
//
// Loaded by mobile/dev/serve.js BEFORE app.js so the real UI runs in a desktop
// browser against an in-memory backend that follows the LocalBackendServer.java
// contract (routes, payloads, status codes, generation progress polling).
// Never shipped: it lives outside mobile/www, which is all the APK/OTA bundles.
//
// URL switches:
//   ?empty=1      start without characters, personas and chats
//   ?long=1       add a 300-message chat for scroll/perf testing
//   ?delay=ms     base latency of every request (default 120)
//   ?update=ota   the repository has a web-only update for this build
//   ?update=apk   the repository has a newer build (new APK needed)
//   ?loginhang=1  Claude Code never prints a sign-in link (the watchdog gives up)
//   ?loginfail=1  Claude Code sign-in and self-test fail at once
//   ?hang=1       self-test: plain start hangs, the safe Bun mode works
//   ?hang=2       self-test: every mode hangs
//   ?engine=N     report another native engine build (older ones get a warning)
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const ENGINE = Number(params.get('engine') || 25);
  const LOGIN_HANG = params.get('loginhang') === '1';
  const DELAY = Number(params.get('delay') || 120);
  const APP_VERSION = '1.7.0';
  const MOCK_SNAPSHOT = ['pid 4242 ld-musl-agy.so.1 · S (sleeping) · потоков 9 · tracer 0',
    '  $ …/ld-musl-agy.so.1 …/claude --debug-to-stderr auth login --claudeai',
    '  · 4242 [claude] S ждёт · ep_poll · epoll_pwait(0x5, 0x7ffd, 0x400)',
    '  · 4243 [Bun Pool 0] S ждёт · futex_wait_queue_me · futex(0x7f8a, 0x80, 0x0)',
    '  fd: 0→pipe:[81234], 1→pipe:[81235], 2→pipe:[81236], 5→anon_inode:[eventpoll], 9→socket:[81240]',
    '  tcp6 [0:0:0:0:0:ffff:c0a8:5]:41394 → [2607:6bc0:0:0:0:0:0:10]:443 · SYN_SENT (соединение не устанавливается)'].join('\n');

  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString().replace('T', ' ').slice(0, 19);

  // A stand-in for a picked photo: a real data:image URI, as the card editor produces.
  function photoAvatar(letter, bg, fg) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#0c0e12"/></linearGradient></defs><rect width="120" height="160" fill="url(#g)"/><text x="60" y="96" font-size="56" text-anchor="middle" fill="${fg}" font-family="sans-serif">${letter}</text></svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
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
      claudeRuntimeReady: false,
      claudeAuthenticated: false,
    },
    files: {
      'GEMINI.md': 'Ты — ведущий ролевой игры. Пиши от третьего лица, живо и образно.\nОтвечай за {{char}}, никогда не пиши за {{user}}.',
      'memories/chat_1.md': '# Память чата #1\n\n- {{user}} обещал вернуться к рассвету.',
      'memories/chat_2.md': '# Память чата #2\n\n',
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
      { id: 1, name: 'Кира', file_path: 'characters/kira.md', avatar_url: photoAvatar('К', '#5b4bd6', '#e9e6ff'),
        first_message: '*Кира отрывается от карты и медленно поднимает взгляд.* «Ты опоздал. Опять.»' },
      { id: 2, name: 'Елена', file_path: 'characters/elena.md', avatar_url: photoAvatar('Е', '#1f8a78', '#dcfff8'),
        first_message: '*Архив пахнет пылью и воском.* «Тише. Здесь даже книги умеют слушать.»' },
      { id: 3, name: 'Ворон', file_path: 'characters/voron.md', avatar_url: '', first_message: '' }
    );
    db.files['characters/kira.md'] = 'Кира — наёмница двадцати шести лет, бывший картограф гильдии.\nХарактер: язвительная, верная, ненавидит опоздания.\nМанера речи: короткие фразы, сухой юмор.';
    db.files['characters/elena.md'] = '# Имя: Елена\n\n### Описание и Характер\nХранительница архива. Говорит тихо, видит больше, чем говорит.\n\n### Начальное сообщение\n*Архив пахнет пылью и воском.* «Тише. Здесь даже книги умеют слушать.»\n';
    db.files['characters/voron.md'] = 'Ворон — говорящая птица-проводник.';
    db.personas.push(
      { id: 1, name: 'Кадзума', file_path: 'personas/kazuma.md', avatar_url: photoAvatar('К', '#3b4a6b', '#dbe4ff'), is_default: 1 },
      { id: 2, name: 'Странник', file_path: 'personas/wanderer.md', avatar_url: '', is_default: 0 }
    );
    db.files['personas/kazuma.md'] = 'Кадзума — путешественник между мирами, носит потёртый плащ.';
    db.files['personas/wanderer.md'] = 'Безымянный странник без прошлого.';

    db.chats.push(
      { id: 1, title: 'Чат: Кира', character_id: 1, persona_id: 1, model_id: 'gemini-4-argon', effort: 'high',
        memory_file_path: 'memories/chat_1.md', provider: '', created_at: minutesAgo(600), updated_at: minutesAgo(5) },
      { id: 2, title: 'Чат: Елена', character_id: 2, persona_id: 2, model_id: 'claude-code-opus', effort: 'xhigh',
        memory_file_path: 'memories/chat_2.md', provider: 'claude-cli', created_at: minutesAgo(3000), updated_at: minutesAgo(2900) }
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
        memory_file_path: 'memories/chat_3.md', provider: '', created_at: minutesAgo(9000), updated_at: minutesAgo(9000) });
      for (let i = 0; i < 300; i++) {
        add(3, i % 2 ? 'user' : 'assistant', (i % 2 ? '«Реплика игрока №' + i + '.»' : '*Кира отвечает (' + i + ').* «Длинный ответ персонажа с описанием сцены, погоды и настроения, чтобы проверить перенос строк и производительность прокрутки.»'),
          { created_at: minutesAgo(9000 - i) });
      }
    }
  }

  // Mirrors VERTEX_MODELS / CLAUDE_CLI_MODELS in LocalBackendServer.java.
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
  ].map(([id, name, provider, badge, efforts, legacy]) => ({ id, name, provider, badge, efforts: efforts ? efforts.split(',') : [], legacy: !!legacy }));

  // ---------------------------------------------------------------------------
  const err = (status, msg, extra) => Object.assign({ __status: status, error: msg }, extra || {});
  const ok = (extra) => Object.assign({ ok: true }, extra || {});
  const fileContent = (p) => (p && db.files[p] !== undefined ? db.files[p] : '');
  const preview = (t) => String(t || '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const safety = (v) => (['BLOCK_NONE', 'BLOCK_ONLY_HIGH'].includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : 'OFF');

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
    delete c.updated_at;
    // Like the engine: card images are not repeated in chat details.
    delete character.avatar_url;
    delete persona.avatar_url;
    return { chat: c, character, persona, messages: chatMessages(chatId) };
  }

  function chatList() {
    const rows = db.chats.map(c => {
      const msgs = db.messages.filter(m => m.chat_id === c.id);
      const last = msgs.sort((a, b) => b.id - a.id)[0];
      const ch = db.characters.find(x => x.id === c.character_id);
      const p = db.personas.find(x => x.id === c.persona_id);
      const lastActivity = [c.updated_at || c.created_at, last ? last.created_at : ''].sort().pop();
      return {
        id: c.id, title: c.title, character_id: c.character_id, persona_id: c.persona_id, model_id: c.model_id,
        effort: c.effort, character_name: ch ? ch.name : 'Персонаж', persona_name: p ? p.name : 'Игрок',
        last_message: last ? last.content.slice(0, 300) : '', message_count: msgs.length,
        last_activity: lastActivity, created_at: c.created_at,
      };
    });
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
    return JSON.parse(JSON.stringify(out));
  }

  const REPLIES = [
    '*{{char}} задумчиво постукивает пальцами по столу.* «Ладно. Слушай внимательно, повторять не стану.»\n\n*Она разворачивает карту и проводит ногтем по извилистой линии.* «Вот здесь караван пропал три дня назад. Ни следов, ни тел. Только **вороньи перья** на снегу.»',
    '*Свеча мигает.* «Ты задаёшь правильные вопросы. Это опасно.»\n\n*Пауза.* «Но, возможно, именно это нам и нужно.»',
    '«Хм.» *{{char}} прищуривается.* «А теперь честно — что ты на самом деле видел у старого моста?»',
  ];

  async function runGeneration(chatId, history) {
    const chat = db.chats.find(c => c.id === chatId);
    if (db.generations[chatId]) throw err(409, 'В этом чате уже идёт генерация.');
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
        const e = new Error('Вход в Google истёк или недействителен (HTTP 401). Войдите заново: «Настройки» → «Google Vertex».');
        e.auth = true;
        throw e;
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
      throw err(cancelled ? 409 : (e.auth ? 401 : 502), e.message, { cancelled, generation: snapshot(g) });
    } finally {
      delete db.generations[chatId];
    }
  }

  // ---------------------------------------------------------------------------
  async function route(method, endpoint, body) {
    const [path, query = ''] = endpoint.split('?');
    const q = new URLSearchParams(query);

    if (path === '/api/health') return ok({ engineBuild: ENGINE, appVersion: APP_VERSION });

    if (path === '/api/settings') {
      if (method === 'POST') {
        for (const k of ['projectId', 'selectedModel', 'selectedEffort', 'activePersonaId']) {
          if (body[k] !== undefined) db.settings[k] = body[k];
        }
        if (body.safetyThreshold !== undefined) db.settings.safetyThreshold = safety(body.safetyThreshold);
      }
      return Object.assign({}, db.settings, { engineBuild: ENGINE, appVersion: APP_VERSION });
    }
    if (path === '/api/models') return { models: MODELS };

    if (path === '/api/files/content' && method === 'GET') {
      const rel = q.get('path') || '';
      if (db.files[rel] === undefined) return err(404, 'Файл не найден: ' + rel);
      return { path: rel, content: db.files[rel] };
    }
    if (path === '/api/files/file' && method === 'POST') {
      const rel = body.filePath || body.path || '';
      if (rel !== 'GEMINI.md' && !/^memories\/[^/]+\.md$/.test(rel)) return err(400, 'Этот файл нельзя изменить: ' + rel);
      db.files[rel] = body.content || '';
      return ok({ path: rel });
    }

    if (path === '/api/characters' && method === 'GET') return { characters: db.characters.map(charJson) };
    if (path === '/api/personas' && method === 'GET') return { personas: db.personas.map(personaJson), activePersonaId: db.settings.activePersonaId };

    const saveCard = (table, prefix, editId) => {
      if (!String(body.name || '').trim()) return err(400, table === 'characters' ? 'Введите имя персонажа' : 'Введите имя персоны');
      const list = db[table];
      let name = String(body.filePath || '').split('/').pop() || (body.name.toLowerCase().replace(/[^a-zа-яё0-9_-]+/gi, '_') + '.md');
      if (!/\.(md|txt)$/.test(name)) name += '.md';
      let fp = prefix + '/' + name;
      let n = 2;
      const base = fp.replace(/\.(md|txt)$/, '');
      while (list.some(x => x.file_path === fp && x.id !== editId)) fp = base + '_' + (n++) + '.md';
      const text = body.rawFileContent !== undefined ? body.rawFileContent : ('# Имя: ' + body.name + '\n\n' + (body.description || ''));
      db.files[fp] = text;
      const avatar = String(body.avatarUrl || '').startsWith('data:image/') ? body.avatarUrl : '';
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
      return table === 'characters' ? ok({ character: charJson(row) }) : ok({ persona: personaJson(row) });
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
        return ok();
      }
    }
    if ((m = path.match(/^\/api\/personas\/(\d+)\/activate$/))) {
      db.settings.activePersonaId = Number(m[1]);
      return ok({ activePersonaId: Number(m[1]) });
    }
    if ((m = path.match(/^\/api\/personas\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'PUT') return saveCard('personas', 'personas', id);
      if (method === 'DELETE') {
        const p = db.personas.find(x => x.id === id);
        if (p) delete db.files[p.file_path];
        db.personas = db.personas.filter(x => x.id !== id);
        if (db.settings.activePersonaId === id) db.settings.activePersonaId = db.personas.length ? db.personas[0].id : 0;
        return ok();
      }
    }

    if (path === '/api/chats' && method === 'GET') return { chats: chatList() };
    if (path === '/api/chats' && method === 'POST') {
      const character = db.characters.find(c => c.id === Number(body.characterId));
      if (!character) return err(404, 'Персонаж не найден. Сначала создайте персонажа.');
      const persona = db.personas.find(p => p.id === Number(body.personaId)) || db.personas[0] || { id: 0, name: 'Игрок' };
      const id = nextId();
      db.chats.push({ id, title: 'Чат: ' + character.name, character_id: character.id, persona_id: persona.id,
        model_id: body.modelId || db.settings.selectedModel, effort: body.effort || db.settings.selectedEffort,
        memory_file_path: 'memories/chat_' + id + '.md', provider: body.provider || '', created_at: now(), updated_at: now() });
      db.files['memories/chat_' + id + '.md'] = '# Память чата #' + id + '\n\n';
      const greet = (character.first_message || '').split('{{char}}').join(character.name).split('{{user}}').join(persona.name);
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
          if (body.title !== undefined) chat.title = String(body.title).trim();
          return chatDetails(chatId);
        }
        if (method === 'DELETE') {
          const g = db.generations[chatId];
          if (g) g.cancelled = true;
          if (chat) delete db.files[chat.memory_file_path];
          db.chats = db.chats.filter(c => c.id !== chatId);
          db.messages = db.messages.filter(x => x.chat_id !== chatId);
          delete db.lastGenerations[chatId];
          return ok();
        }
      }
      if (sub === 'generation' && method === 'GET') {
        const g = db.generations[chatId];
        const last = db.lastGenerations[chatId];
        if (g) return { active: true, generation: snapshot(g) };
        return last ? { active: false, generation: snapshot(last), lastGeneration: snapshot(last) } : { active: false };
      }
      if (sub === 'generation/cancel' && method === 'POST') {
        const g = db.generations[chatId];
        if (g) { g.cancelled = true; log(g, '⏹ Остановка по запросу пользователя'); }
        return ok({ wasActive: !!g });
      }
      if (sub === 'system-prompt' && method === 'GET') {
        const d = chatDetails(chatId);
        if (d.__status) return d;
        const sp = buildSystemPrompt(d.character, d.persona, d.chat.memory_file_path);
        return { systemPrompt: sp, chars: sp.length };
      }
      if (sub === 'messages' && method === 'DELETE') {
        if (db.generations[chatId]) return err(409, 'Сначала остановите генерацию.');
        const after = Number(q.get('after') || 0);
        if (!after) return err(400, 'Не указано, после какого сообщения удалять.');
        const before = db.messages.length;
        db.messages = db.messages.filter(x => !(x.chat_id === chatId && x.id > after));
        return ok({ removed: before - db.messages.length });
      }
      if (sub === 'messages' && method === 'POST') {
        const content = String(body.content || '').trim();
        if (!content) return err(400, 'Пустое сообщение');
        if (!chat) return err(404, 'Чат не найден');
        if (db.generations[chatId]) return err(409, 'В этом чате уже идёт генерация.');
        const userMsg = { id: nextId(), chat_id: chatId, role: 'user', content, thoughts: '', swipes: [content], thought_swipes: [''], swipe_index: 0, created_at: now() };
        db.messages.push(userMsg);
        try {
          const r = await runGeneration(chatId, chatMessages(chatId));
          if (!db.chats.some(c => c.id === chatId)) return err(502, 'Чат удалён во время генерации');
          const ai = { id: nextId(), chat_id: chatId, role: 'assistant', content: r.reply, thoughts: r.thoughts, swipes: [r.reply], thought_swipes: [r.thoughts], swipe_index: 0, created_at: now() };
          db.messages.push(ai);
          chat.updated_at = now();
          return { userMessage: JSON.parse(JSON.stringify(userMsg)), assistantMessage: JSON.parse(JSON.stringify(ai)), generation: snapshot(db.lastGenerations[chatId]) };
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
          if (!db.messages.includes(msg)) return err(502, 'Сообщение удалено во время генерации');
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
        return ok({ message: JSON.parse(JSON.stringify(msg)) });
      }
      if (method === 'DELETE') {
        db.messages = db.messages.filter(x => x.id !== id);
        return ok();
      }
    }

    if (path === '/api/agy/auth/status') return { authenticated: db.settings.agyAuthenticated, email: db.settings.agyUserEmail, projectId: db.settings.projectId };
    if (path === '/api/agy/auth/start') { setTimeout(() => { db.settings.agyAuthenticated = true; window.__onAgyOAuthSuccess && window.__onAgyOAuthSuccess(); }, 1500); return ok({ authUrl: '' }); }
    if (path === '/api/agy/auth/exchange') { db.settings.agyAuthenticated = true; return { authenticated: true, email: db.settings.agyUserEmail, projectId: db.settings.projectId }; }
    if (path === '/api/agy/auth/logout') { db.settings.agyAuthenticated = false; return ok({ authenticated: false }); }

    if (path === '/api/claude/status') {
      const linkReady = !LOGIN_HANG && db.claudeLoginStarted && Date.now() - db.claudeLoginStarted > 3000;
      return { runtimeReady: db.settings.claudeRuntimeReady, authenticated: db.settings.claudeAuthenticated, runtimeVersion: 'mock',
        downloadMb: 128, installing: !!db.claudeInstalling, installProgress: db.claudeInstallProgress || '',
        loginPending: !!db.claudeLoginPending, loginError: db.claudeLoginError || '', loginTimeout: 75,
        credentialsStamp: db.credentialsStamp || 0, loginBaseStamp: db.loginBaseStamp || 0,
        selftestRunning: !!db.claudeSelftestRunning, selftestProgress: db.claudeSelftestProgress || '', safeMode: !!db.claudeSafeMode,
        loginUrl: linkReady ? 'https://claude.ai/oauth/authorize?code=true&client_id=mock&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=mockstate' : '',
        loginAutoUrl: linkReady ? 'https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback' : '',
        loginElapsed: db.claudeLoginStarted ? Math.round((Date.now() - db.claudeLoginStarted) / 1000) : 0,
        loginOutput: db.claudeLoginPending ? (LOGIN_HANG ? '' : 'Opening browser to sign in…') : '',
        loginDebug: db.claudeLoginPending ? '[DEBUG] OAuth callback listener on port 54545 (mock)' : '' };
    }
    if (path === '/api/claude/runtime/install') {
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
      return ok({ runtimeReady: true, authenticated: db.settings.claudeAuthenticated });
    }
    if (path === '/api/claude/auth/start') {
      await sleep(1500);
      if (params.get('loginfail') === '1') {
        db.claudeLoginError = 'Не удалось запустить среду: Cannot run program (mock)';
        return err(500, db.claudeLoginError);
      }
      db.claudeLoginPending = true;
      db.claudeLoginError = '';
      db.claudeLoginStarted = Date.now();
      db.loginBaseStamp = db.credentialsStamp || 0;
      // Simulate the browser redirecting back to the CLI's localhost listener.
      if (params.get('autologin') === '1') setTimeout(() => { if (db.claudeLoginPending) { db.claudeLoginPending = false; db.settings.claudeAuthenticated = true; db.credentialsStamp = Date.now(); } }, 9000);
      // ?loginhang=1: Claude Code never prints a link; the watchdog gives up (8 s here, 75 s on the phone).
      if (LOGIN_HANG) {
        setTimeout(() => {
          if (!db.claudeLoginPending) return;
          db.claudeLoginPending = false;
          db.claudeLoginError = 'Claude Code не ответил за 75 с: завис при запуске, ещё до ссылки для входа. Нажмите «Проверить запуск».\n\n(Claude Code ничего не вывел)\n--- процессы ---\n' + MOCK_SNAPSHOT;
        }, 8000);
      }
      return ok({ pending: true });
    }
    if (path === '/api/claude/auth/exchange') {
      if (!String(body.code || '').includes('#')) return err(400, 'Скопируйте код целиком — вместе с частью после «#».');
      db.claudeLoginPending = false; db.settings.claudeAuthenticated = true; db.credentialsStamp = Date.now(); return ok({ authenticated: true });
    }
    if (path === '/api/claude/auth/logout') { db.claudeLoginPending = false; db.settings.claudeAuthenticated = false; db.credentialsStamp = 0; return ok({ authenticated: false }); }
    if (path === '/api/claude/auth/cancel') { db.claudeLoginPending = false; return ok({ authenticated: db.settings.claudeAuthenticated }); }
    if (path === '/api/claude/selftest') {
      // ?hang=1: the plain start hangs, the safe Bun mode works. ?hang=2: every mode hangs.
      const hang = Number(params.get('hang') || 0);
      const stages = [];
      db.claudeSelftestRunning = true;
      const stage = async (s, ms) => { db.claudeSelftestProgress = s.name; await sleep(ms); stages.push(s); };
      try {
        if (params.get('loginfail') === '1') {
          await stage({ name: 'Claude Code · версия', ok: false, exit: 'код 159 (SIGSYS — системный вызов запрещён Android (seccomp))', seconds: '0.2', output: '' }, 500);
          const summary = 'Claude Code не запускается на этом телефоне (код 159). Скопируйте отчёт и пришлите его.';
          return { ok: false, summary, safeMode: false, stages, report: 'AGY Claude Code self-test (mock)\nИтог: ' + summary };
        }
        await stage({ name: 'Claude Code · версия', ok: true, exit: 'код 0', seconds: '0.4', output: '2.1.310 (Claude Code)' }, 500);
        const probeOut = (safe) => ['[probe +0.0s] bun 1.4.4 · linux/arm64 · ядро 4.14.357-perf · pid 4242',
          '[probe +0.0s] флаги Bun: ' + (safe ? 'BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2, …' : 'нет') + ' · stdin TTY: false',
          '[probe +0.0s] ok микрозадачи · 0 мс · да', '[probe +0.0s] … таймер 0 мс',
          ...(hang && !safe ? [] : ['[probe +0.1s] ok таймер 0 мс · 3 мс', '[probe +0.4s] ok таймер 300 мс · 305 мс · 305 мс', '[probe +2.2s] done · всё в порядке'])].join('\n');
        await stage(hang
          ? { name: 'проверка рантайма Bun', ok: false, exit: 'нет ответа за 45 с', seconds: '45.0', output: probeOut(false), snapshot: MOCK_SNAPSHOT }
          : { name: 'проверка рантайма Bun', ok: true, exit: 'код 0', seconds: '2.3', output: probeOut(false) }, 900);
        const trace = '[agy +0.0s] trace · pid 4250 · bun 1.4.4\n2026-10-26T10:00:00.120Z [DEBUG] Loading settings';
        let summary;
        let okAll = true;
        if (!hang) {
          await stage({ name: 'полный запуск', ok: true, exit: 'код 1', seconds: '1.9', output: trace + '\n{"loggedIn": false}' }, 900);
          summary = 'Claude Code запускается.';
          db.claudeSafeMode = false;
        } else {
          await stage({ name: 'полный запуск', ok: false, exit: 'нет ответа за 40 с', seconds: '50.2', output: trace, snapshot: MOCK_SNAPSHOT }, 900);
          if (hang === 1) {
            await stage({ name: 'полный запуск (безопасный режим Bun)', ok: true, exit: 'код 1', seconds: '2.5', output: trace + '\n{"loggedIn": false}' }, 900);
            summary = 'Claude Code запускается только в безопасном режиме Bun — он включён для входа и ответов.';
            db.claudeSafeMode = true;
          } else {
            await stage({ name: 'полный запуск (безопасный режим Bun)', ok: false, exit: 'нет ответа за 40 с', seconds: '50.0', output: trace, snapshot: MOCK_SNAPSHOT }, 700);
            await stage({ name: 'полный запуск (чистый профиль)', ok: false, exit: 'нет ответа за 40 с', seconds: '50.0', output: trace, snapshot: MOCK_SNAPSHOT }, 700);
            summary = 'Claude Code зависает при запуске во всех режимах. Скопируйте отчёт и пришлите его: в нём видно, на чём именно.';
            okAll = false;
          }
        }
        const report = 'AGY Claude Code self-test (mock)\nИтог: ' + summary + '\n' + stages.map(s => '[' + (s.ok ? 'OK' : 'FAIL') + '] ' + s.name + ' · ' + s.exit).join('\n');
        return { ok: okAll, summary, safeMode: !!db.claudeSafeMode, stages, report };
      } finally {
        db.claudeSelftestRunning = false;
        db.claudeSelftestProgress = '';
      }
    }

    if (path === '/api/updates/check') {
      const upd = params.get('update');
      const latestBuild = upd === 'apk' ? ENGINE + 1 : ENGINE;
      const latestVersion = upd === 'apk' ? '1.8.0' : (upd === 'ota' ? '1.7.1' : APP_VERSION);
      return {
        currentVersion: APP_VERSION, currentBuild: ENGINE, bundledVersion: APP_VERSION, bundledBuild: ENGINE, otaActive: false,
        nativeUpdateRequired: upd === 'apk', otaAvailable: upd === 'ota', updateAvailable: upd === 'apk' || upd === 'ota',
        installedCommit: 'abc1234', latestVersion, latestBuild, latestCommit: 'def5678',
        latestCommitMessage: 'Fix typos', latestReleaseTitle: 'Мелкие исправления',
        gitRepo: 'Kuka001/111', gitBranch: 'main', apkDownloadUrl: '', repoWebUrl: 'https://github.com/Kuka001/111', remoteReachable: true,
        releases: [
          { version: latestVersion, build: latestBuild, date: '2026-10-27', title: 'Мелкие исправления', changelog: ['Исправлены опечатки'] },
          { version: '1.7.0', build: 25, date: '2026-10-26', title: 'Оптимизация', changelog: ['Быстрее список чатов', 'Gemini без скрытых добавок'] },
        ],
        commits: [
          { sha: 'def5678aaaa', shortSha: 'def5678', message: 'Fix typos', author: 'Kuka001', date: '2026-10-27T10:00:00Z' },
          { sha: 'abc1234bbbb', shortSha: 'abc1234', message: 'v1.7.0', author: 'Kuka001', date: '2026-10-26T10:00:00Z' },
        ],
      };
    }
    if (path === '/api/updates/apply') { await sleep(800); return ok({ message: 'Версия 1.7.1 установлена (mock)' }); }
    if (path === '/api/updates/reset') return ok();
    if (path === '/api/updates/config') return ok({ gitRepo: 'Kuka001/111', gitBranch: body.gitBranch || 'main' });

    if (path === '/api/backup/export') {
      return { backupFormat: 1, appVersion: APP_VERSION, exportedAt: now(), tables: { characters: db.characters, personas: db.personas, chats: db.chats, messages: db.messages },
        settings: {}, workspaceFiles: db.files,
        counts: { characters: db.characters.length, personas: db.personas.length, chats: db.chats.length, messages: db.messages.length, workspaceFiles: Object.keys(db.files).length } };
    }
    if (path === '/api/backup/import') { await sleep(400); return ok({ restoredRows: 0, restoredFiles: 0, message: 'Данные восстановлены (mock)' }); }

    return err(404, 'Неизвестный маршрут APK-сервера: ' + method + ' ' + path);
  }

  window.AndroidServer = {
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
        window.__onAndroidServerResponse(reqId, status, JSON.stringify(res || {}));
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
    setSystemBars(bg, nav, light) {
      console.info('[mock] setSystemBars', bg, nav, light);
      document.documentElement.style.setProperty('--mock-statusbar', bg);
    },
  };
  window.__mockDb = db;
  console.info('[mock-bridge] engine build', ENGINE);
})();
