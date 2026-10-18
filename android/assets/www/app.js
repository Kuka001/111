(function () {
  // Android 16 native WindowInsets hook called by MainActivity.java
  window.__setAndroidInsets = function (topPx, bottomPx) {
    document.documentElement.style.setProperty('--safe-top', topPx + 'px');
    document.documentElement.style.setProperty('--safe-bottom', bottomPx + 'px');
  };

  const DEFAULT_LAN_URL = 'http://127.0.0.1:3001';
  const isFileProtocol = window.location.protocol === 'file:';
  const hasEmbeddedApkServer = typeof window.AndroidServer !== 'undefined';

  // Pending promises for embedded AndroidServer.requestAsync calls
  const pendingAndroidRequests = new Map();
  let androidReqCounter = 1;

  function decodeBase64Utf8(b64) {
    const binString = window.atob(b64);
    const bytes = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
      bytes[i] = binString.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  window.__onAndroidServerResponse = function (reqId, status, b64Json) {
    const entry = pendingAndroidRequests.get(reqId);
    if (!entry) return;
    pendingAndroidRequests.delete(reqId);
    try {
      const jsonStr = decodeBase64Utf8(b64Json);
      const data = JSON.parse(jsonStr || '{}');
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
    if (!isFileProtocol && window.location.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    return DEFAULT_LAN_URL;
  }

  const state = {
    serverUrl: getServerBaseUrl(),
    projectId: 'project-4c7a8e8a-764a-42bc-bdf',
    agyAuthenticated: false,
    agyEmail: '',
    selectedModel: 'gemini-4-argon',
    selectedEffort: 'high',
    safetyThreshold: 'OFF',
    contextMessagesLimit: 30,
    activePersonaId: 1,
    models: [],
    characters: [],
    personas: [],
    chats: [],
    collapsedChatGroups: {},
    currentChatId: null,
    currentChatData: null,
    currentFilesPath: '',
    pollTimer: null,
    elapsedTimer: null,
    generationStartMs: 0,
    streamingExpanded: false,
    lastGeneration: null,
    isSending: false,
    isKeyboardOpen: false,
    ignoreScrollEvents: false,
  };

  let navTransitionUntil = 0;

  function setBottomNavHidden(hidden) {
    const nav = document.getElementById('bottomNav');
    if (!nav) return;
    const isCurrentlyHidden = nav.classList.contains('nav-hidden');
    if (isCurrentlyHidden === Boolean(hidden)) return;
    navTransitionUntil = Date.now() + 260;
    nav.classList.toggle('nav-hidden', Boolean(hidden));
  }

  function autoResizeChatInput() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    input.style.height = 'auto';
    const maxH = 125; // 5 visible lines (5 * 21px + 20px vertical padding/border)
    const scrollH = input.scrollHeight;
    const nextH = Math.min(Math.max(scrollH, 41), maxH);
    input.style.height = nextH + 'px';
    input.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';
  }

  // Callback invoked by Android LocalBackendServer when OAuth callback completes in background
  window.__onAgyOAuthSuccess = function (b64Json) {
    try {
      const jsonStr = decodeBase64Utf8(b64Json);
      const data = JSON.parse(jsonStr || '{}');
      state.agyAuthenticated = Boolean(data.authenticated);
      state.agyEmail = data.email || state.agyEmail;
      if (data.projectId) {
        state.projectId = data.projectId;
        const projInput = document.getElementById('inputProjectId');
        if (projInput) projInput.value = state.projectId;
      }
      renderAgyAuthStatus();
      updateHeaderIndicators(true);
      showToast(`✅ Вы вошли в Google Antigravity${state.agyEmail ? ' (' + state.agyEmail + ')' : ''}!`);
    } catch (e) {}
  };

  const FALLBACK_AVATAR =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="#1b1f27"/><circle cx="60" cy="46" r="22" fill="#7c90c9"/><path d="M22 110 C26 76, 94 76, 98 110 Z" fill="#465685"/></svg>'
    );

  function resolveAvatarUrl(url) {
    if (!url) return FALLBACK_AVATAR;
    if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:')) {
      return url;
    }
    if (hasEmbeddedApkServer) {
      return FALLBACK_AVATAR;
    }
    return state.serverUrl + (url.startsWith('/') ? url : '/' + url);
  }

  function showToast(msg) {
    const box = document.getElementById('toastBox');
    if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.classList.add('hidden'), 2800);
  }

  async function apiFetch(endpoint, options = {}) {
    if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.requestAsync === 'function') {
      const method = (options.method || 'GET').toUpperCase();
      const bodyStr = typeof options.body === 'string' ? options.body : (options.body ? JSON.stringify(options.body) : '');
      const reqId = 'req_' + (androidReqCounter++) + '_' + Date.now();
      return new Promise((resolve, reject) => {
        pendingAndroidRequests.set(reqId, { resolve, reject });
        window.AndroidServer.requestAsync(reqId, method, endpoint, bodyStr);
      });
    }

    const url = state.serverUrl + endpoint;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const res = await fetch(url, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка сервера (${res.status})`);
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function formatInlineMarkdown(escapedText, inlineCodes) {
    let s = escapedText;
    // Extract inline code `...`
    s = s.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code class="md-inline-code">${code}</code>`);
      return `\u0000INLINECODE_${idx}\u0000`;
    });

    // Bold + Italic ***text*** or ___text___
    s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em class="rp-italic">$1</em></strong>');
    s = s.replace(/___([\s\S]+?)___/g, '<strong><em class="rp-italic">$1</em></strong>');

    // Bold **text** or __text__
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');

    // Italic *text* (renders clean italic without asterisks, colored muted gray via CSS)
    s = s.replace(/\*([^*]+?)\*/g, '<em class="rp-italic">$1</em>');
    // Italic _text_ (word-bounded so snake_case identifiers remain untouched)
    s = s.replace(/(^|[\s(>«"'])_([^_\n]+?)_(?=$|[\s.,!?:;)<»"'])/g, '$1<em class="rp-italic">$2</em>');

    // Strikethrough ~~text~~
    s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

    // Restore inline code
    s = s.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_, idx) => inlineCodes[Number(idx)] || '');
    return s;
  }

  /**
   * Full Markdown renderer for Roleplay messages:
   * - *action* -> gray italic <em> without asterisks so dialogue stands out
   * - **bold**, ***bold-italic***, ~~strikethrough~~, `inline code`, ```code blocks```
   * - Headings, blockquotes, lists, horizontal rules, and clean paragraphs
   */
  function formatRoleplayHtml(rawText) {
    if (!rawText) return '<p></p>';
    const normalized = String(rawText).replace(/\r\n/g, '\n');
    const escaped = escapeHtml(normalized);

    const codeBlocks = [];
    const inlineCodes = [];

    // 1. Extract fenced code blocks ```lang ... ```
    const withoutCodeBlocks = escaped.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const langBadge = lang ? `<div class="md-code-lang">${lang}</div>` : '';
      codeBlocks.push(`<pre class="md-code-block">${langBadge}<code>${code.replace(/\n$/, '')}</code></pre>`);
      return `\n\n\u0000CODEBLOCK_${idx}\u0000\n\n`;
    });

    // 2. Split into blocks by blank lines
    const rawBlocks = withoutCodeBlocks.split(/\n{2,}/);
    const htmlBlocks = [];

    for (let block of rawBlocks) {
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

      // Blockquote (lines starting with >)
      if (lines.every(l => /^\s*&gt;\s?/.test(l))) {
        const quoteInner = lines.map(l => l.replace(/^\s*&gt;\s?/, '')).join('\n');
        htmlBlocks.push(
          `<blockquote class="md-quote">${formatInlineMarkdown(quoteInner, inlineCodes).replace(/\n/g, '<br/>')}</blockquote>`
        );
        continue;
      }

      // Unordered list (- item or • item)
      if (lines.every(l => /^\s*[-•]\s+/.test(l))) {
        const itemsHtml = lines
          .map(l => `<li>${formatInlineMarkdown(l.replace(/^\s*[-•]\s+/, ''), inlineCodes)}</li>`)
          .join('');
        htmlBlocks.push(`<ul class="md-list">${itemsHtml}</ul>`);
        continue;
      }

      // Ordered list (1. item)
      if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
        const itemsHtml = lines
          .map(l => `<li>${formatInlineMarkdown(l.replace(/^\s*\d+[.)]\s+/, ''), inlineCodes)}</li>`)
          .join('');
        htmlBlocks.push(`<ol class="md-list">${itemsHtml}</ol>`);
        continue;
      }

      // Single-line heading (# .. ####)
      if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0])) {
        const hMatch = lines[0].match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
          const level = hMatch[1].length;
          htmlBlocks.push(`<div class="md-heading md-h${level}">${formatInlineMarkdown(hMatch[2], inlineCodes)}</div>`);
          continue;
        }
      }

      const formattedPara = formatInlineMarkdown(trimmed, inlineCodes)
        .split('\n')
        .map(line => {
          const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
          if (hMatch) {
            return `<span class="md-heading-inline md-h${hMatch[1].length}">${hMatch[2]}</span>`;
          }
          return line;
        })
        .join('<br/>');

      const withRestoredCode = formattedPara.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_, idx) => codeBlocks[Number(idx)] || '');
      htmlBlocks.push(`<p>${withRestoredCode}</p>`);
    }

    return htmlBlocks.join('') || '<p></p>';
  }

  function getShortModelName(modelId) {
    const cleanId = String(modelId || 'gemini-4-argon').replace(/-(low|medium|high|max)$/i, '');
    const found = state.models.find(m => m.id === cleanId || m.id === modelId);
    if (found) return found.name;
    return cleanId || 'Gemini 4 Argon';
  }

  function getCompactModelLabel(modelId, effort) {
    const full = getShortModelName(modelId);
    const shortName = full
      .replace(/^Claude\s+/i, '')
      .replace(/\s*\(Thinking\)/i, '')
      .replace(/\s*\(Medium\)/i, '')
      .trim();
    const eff = String(effort || 'high').toUpperCase();
    return `${shortName} · ${eff}`;
  }

  function renderAgyAuthStatus() {
    const badge = document.getElementById('agyAuthStatusBadge');
    const loginBtn = document.getElementById('agyOAuthLoginBtn');
    const logoutBtn = document.getElementById('agyOAuthLogoutBtn');

    if (badge) {
      if (state.agyAuthenticated) {
        badge.textContent = `✅ Авторизован в Google Antigravity${state.agyEmail ? ' (' + state.agyEmail + ')' : ''} • Project ID: ${state.projectId}`;
        badge.style.color = 'var(--success)';
      } else {
        badge.textContent = '⚠️ Вход в Google Antigravity не выполнен. Нажмите кнопку ниже, чтобы войти через аккаунт Google (без API ключа).';
        badge.style.color = 'var(--warning)';
      }
    }

    if (loginBtn) {
      loginBtn.textContent = state.agyAuthenticated
        ? '🔄 Переподключить аккаунт Google (AGY)'
        : '🔑 Войти через Google (AGY — без API ключа)';
    }
    if (logoutBtn) {
      logoutBtn.classList.toggle('hidden', !state.agyAuthenticated);
    }
  }

  async function checkAgyAuthStatus() {
    try {
      const data = await apiFetch('/api/agy/auth/status');
      state.agyAuthenticated = Boolean(data.authenticated);
      state.agyEmail = data.email || '';
      if (data.projectId) {
        state.projectId = data.projectId;
        const projInput = document.getElementById('inputProjectId');
        if (projInput) projInput.value = state.projectId;
      }
      renderAgyAuthStatus();
      updateHeaderIndicators(true);
    } catch (e) {}
  }

  function updateHeaderIndicators(online = true) {
    const isOnlineAndAuth = Boolean(online && state.agyAuthenticated);
    document.querySelectorAll('.js-conn-dot').forEach(dot => {
      dot.classList.toggle('offline', !isOnlineAndAuth);
    });

    const activeChatModel = state.currentChatData && state.currentChatData.chat
      ? state.currentChatData.chat.model_id
      : state.selectedModel;
    const activeEffort = state.currentChatData && state.currentChatData.chat
      ? state.currentChatData.chat.effort
      : state.selectedEffort;
    const compactLabel = getCompactModelLabel(activeChatModel, activeEffort);

    document.querySelectorAll('.js-model-label').forEach(lbl => {
      lbl.textContent = compactLabel;
    });

    const activePersona = state.personas.find(p => p.id === Number(state.activePersonaId)) || state.personas[0];
    const banner = document.getElementById('activePersonaBanner');
    if (banner) {
      banner.textContent = activePersona
        ? `Персона: ${activePersona.name}`
        : 'Персона не выбрана';
    }
  }

  // ==========================================================================
  // INITIALIZATION & DATA LOADING
  // ==========================================================================
  async function initApp() {
    try {
      const [settingsData, modelsData, charsData, personasData, chatsData] = await Promise.all([
        apiFetch('/api/settings'),
        apiFetch('/api/models'),
        apiFetch('/api/characters'),
        apiFetch('/api/personas'),
        apiFetch('/api/chats'),
      ]);

      state.projectId = settingsData.projectId || state.projectId;
      state.agyAuthenticated = Boolean(settingsData.agyAuthenticated);
      state.agyEmail = settingsData.agyEmail || '';
      state.selectedModel = settingsData.selectedModel || state.selectedModel;
      state.selectedEffort = settingsData.selectedEffort || state.selectedEffort;
      state.safetyThreshold = settingsData.safetyThreshold || 'OFF';
      state.activePersonaId = settingsData.activePersonaId || state.activePersonaId;
      state.contextMessagesLimit = settingsData.contextMessagesLimit || 30;

      state.models = modelsData.models || [];
      state.characters = charsData.characters || [];
      state.personas = personasData.personas || [];
      state.chats = chatsData.chats || [];

      document.getElementById('inputProjectId').value = state.projectId;
      document.getElementById('inputContextLimit').value = state.contextMessagesLimit;
      const safetySelect = document.getElementById('inputSafetyThreshold');
      if (safetySelect) safetySelect.value = state.safetyThreshold;

      const connBadge = document.getElementById('serverConnectionStatus');
      if (connBadge) {
        const isEmbedded = typeof window.AndroidServer !== 'undefined' || settingsData.embeddedServer;
        connBadge.textContent = isEmbedded
          ? `✅ Встроенный сервер внутри APK активен • БД SQLite + чистый GEMINI.md • Моделей: ${state.models.length}`
          : `✅ Локальный сервер активен • Моделей: ${state.models.length}`;
        connBadge.style.color = 'var(--success)';
      }

      renderAgyAuthStatus();
      updateHeaderIndicators(true);
      renderChatsList();
      renderCharactersAndPersonas();
      renderModelsLists();
      updateEffortButtons();
      loadFiles(state.currentFilesPath);

      // Automatically check for new versions in Git on app startup
      setTimeout(() => {
        checkForUpdates(false);
      }, 300);
    } catch (err) {
      updateHeaderIndicators(false);
      const connBadge = document.getElementById('serverConnectionStatus');
      if (connBadge) {
        connBadge.textContent = `❌ Ошибка инициализации: ${err.message}`;
        connBadge.style.color = 'var(--danger)';
      }
    }
  }

  // ==========================================================================
  // CHATS LIST (GROUPED BY CHARACTER) & ACTIVE CHAT ROOM
  // ==========================================================================
  async function loadChatsList() {
    const data = await apiFetch('/api/chats');
    state.chats = data.chats || [];
    renderChatsList();
  }

  function formatChatCountLabel(count) {
    const n = Math.abs(Number(count) || 0);
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n} чат`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} чата`;
    return `${n} чатов`;
  }

  function toggleChatGroup(groupKey) {
    if (!groupKey) return;
    state.collapsedChatGroups[groupKey] = !state.collapsedChatGroups[groupKey];
    renderChatsList();
  }

  function renderChatsList() {
    const container = document.getElementById('chatsListContainer');
    if (!container) return;

    if (!state.chats.length) {
      const hasChars = state.characters.length > 0;
      container.innerHTML = `
        <div class="settings-card empty-state-card">
          <div class="empty-state-icon">🎭</div>
          <div class="card-title">Пока нет активных чатов</div>
          <p class="card-hint">${
            hasChars
              ? 'Выберите своего персонажа и персону, чтобы начать новый диалог.'
              : 'Сначала добавьте своего персонажа во вкладке «Персонажи», чтобы начать общение.'
          }</p>
          <button class="btn-primary" onclick="${
            hasChars
              ? 'window.appUI.openNewChatModal()'
              : "window.appUI.openTab('characters'); window.appUI.openCharacterEditor(null);"
          }">${hasChars ? '+ Начать новый чат' : '+ Создать персонажа'}</button>
        </div>
      `;
      return;
    }

    // Group chats by character so all chats with the same character are united
    const groupsMap = new Map();
    for (const c of state.chats) {
      const charId = Number(c.character_id) || 0;
      const charName = (c.character_name || 'Персонаж').trim();
      const key = charId > 0 ? `char_${charId}` : `name_${charName.toLowerCase()}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          key,
          characterId: charId,
          characterName: charName,
          characterAvatar: c.character_avatar || '',
          chats: [],
          totalMessages: 0,
        });
      }
      const g = groupsMap.get(key);
      g.chats.push(c);
      g.totalMessages += Number(c.message_count || 0);
      if (!g.characterAvatar && c.character_avatar) {
        g.characterAvatar = c.character_avatar;
      }
    }

    const groups = Array.from(groupsMap.values());
    container.innerHTML = groups
      .map(group => {
        const isCollapsed = Boolean(state.collapsedChatGroups[group.key]);
        const avatarSrc = resolveAvatarUrl(group.characterAvatar);
        const countBadge = formatChatCountLabel(group.chats.length);

        const itemsHtml = group.chats
          .map((c, idx) => {
            const preview = stripMarkdownPreview(c.last_message || '').slice(0, 110);
            const effLabel = String(c.effort || 'high').toUpperCase();
            const sessionLabel = group.chats.length > 1
              ? `Диалог #${group.chats.length - idx} (ID ${c.id})`
              : `Диалог #${c.id}`;
            return `
              <div class="chat-group-item" onclick="window.appUI.openChatRoom(${c.id})">
                <div class="chat-group-item-top">
                  <span class="chat-group-item-title">${escapeHtml(sessionLabel)} • 👤 ${escapeHtml(c.persona_name || 'Игрок')}</span>
                  <div class="chat-card-actions">
                    <button class="toolbar-btn" onclick="event.stopPropagation(); window.appUI.openExportChatModal(${c.id})" title="Экспортировать чат">📤</button>
                    <button class="toolbar-btn" onclick="event.stopPropagation(); window.appUI.deleteChat(${c.id})" title="Удалить чат">🗑</button>
                  </div>
                </div>
                <div class="chat-group-item-preview">${escapeHtml(preview || 'Нет сообщений — нажмите, чтобы написать первым')}</div>
                <div class="chat-group-item-meta">
                  <span>${escapeHtml(getShortModelName(c.model_id))} (${escapeHtml(effLabel)})</span>
                  <span>•</span>
                  <span>💬 ${c.message_count || 0} сообщ.</span>
                </div>
              </div>
            `;
          })
          .join('');

        return `
          <div class="chat-group-card ${isCollapsed ? 'collapsed' : ''}">
            <div class="chat-group-header" onclick="window.appUI.toggleChatGroup('${escapeHtml(group.key)}')">
              <img
                class="chat-group-avatar"
                src="${escapeHtml(avatarSrc)}"
                alt="${escapeHtml(group.characterName)}"
                onclick="event.stopPropagation(); window.appUI.openAvatarViewer(this.src, '${escapeHtml(group.characterName)}')"
                title="Нажмите, чтобы открыть изображение персонажа"
              />
              <div class="chat-group-info">
                <div class="chat-group-title-row">
                  <span class="chat-group-name">${escapeHtml(group.characterName)}</span>
                  <span class="chat-group-badge">${escapeHtml(countBadge)}</span>
                </div>
                <div class="chat-group-sub">Всего сообщений: ${group.totalMessages} • Нажмите для сворачивания</div>
              </div>
              <div class="chat-group-actions">
                ${
                  group.characterId > 0
                    ? `<button class="toolbar-btn" onclick="event.stopPropagation(); window.appUI.openNewChatModal(${group.characterId})" title="Новый чат с этим персонажем">+ Чат</button>`
                    : ''
                }
                <span class="chat-group-chevron">▾</span>
              </div>
            </div>
            <div class="chat-group-items">
              ${itemsHtml}
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function openChatRoom(chatId) {
    try {
      const data = await apiFetch(`/api/chats/${chatId}`);
      state.currentChatId = chatId;
      state.currentChatData = data;
      if (data.chat && data.chat.model_id) {
        state.selectedModel = data.chat.model_id;
      }
      if (data.chat && data.chat.effort) {
        state.selectedEffort = data.chat.effort;
      }

      document.getElementById('chatsListView').classList.add('hidden');
      document.getElementById('chatRoomView').classList.remove('hidden');

      renderActiveChatRoom();
      autoResizeChatInput();
      renderModelsLists();
      updateEffortButtons();
      updateHeaderIndicators(true);
    } catch (err) {
      showToast(err.message);
    }
  }

  function closeChatRoom() {
    stopGenerationPolling(true);
    state.currentChatId = null;
    state.currentChatData = null;
    document.getElementById('chatRoomView').classList.add('hidden');
    document.getElementById('chatsListView').classList.remove('hidden');
    setBottomNavHidden(false);
    updateHeaderIndicators(true);
    loadChatsList();
  }

  function renderActiveChatRoom() {
    if (!state.currentChatData) return;
    const character = state.currentChatData.character || { name: 'Персонаж', avatar_url: '', file_path: '' };
    const persona = state.currentChatData.persona || { name: 'Игрок', avatar_url: '', file_path: '' };
    const messages = state.currentChatData.messages || [];

    const headerAvatar = document.getElementById('chatHeaderAvatar');
    if (headerAvatar) {
      headerAvatar.src = resolveAvatarUrl(character.avatar_url);
    }
    document.getElementById('chatHeaderCharName').textContent = character.name || 'Персонаж';
    document.getElementById('chatHeaderSub').textContent = `👤 ${persona.name || 'Игрок'}${character.file_path ? ' • ' + character.file_path : ''}`;
    const personaChip = document.getElementById('chatPersonaChip');
    if (personaChip) {
      personaChip.title = `Активная персона: ${persona.name || 'Игрок'}`;
    }

    const msgContainer = document.getElementById('chatMessagesContainer');
    if (!messages.length) {
      msgContainer.innerHTML = `
        <div class="card-hint" style="text-align:center; padding: 28px 16px;">
          Начальное сообщение не задано. Напишите первую реплику ниже, чтобы начать диалог с <b>${escapeHtml(character.name || 'персонажем')}</b>.
        </div>
      `;
      return;
    }

    msgContainer.innerHTML = messages
      .map((m, idx) => {
        const isUser = m.role === 'user';
        const senderName = isUser ? (persona.name || 'Игрок') : (character.name || 'Персонаж');
        const avatar = resolveAvatarUrl(isUser ? persona.avatar_url : character.avatar_url);
        const swipesCount = Array.isArray(m.swipes) ? m.swipes.length : 1;
        const curSwipe = (m.swipe_index || 0) + 1;

        const thoughtsBlock = m.thoughts
          ? `<details class="msg-thoughts-details">
               <summary>💭 Мысли персонажа</summary>
               <div class="msg-thoughts-body">${escapeHtml(m.thoughts)}</div>
             </details>`
          : '';

        const swipeControls = !isUser
          ? `<div class="swipe-controls">
               ${
                 swipesCount > 1
                   ? `<button class="toolbar-btn" onclick="window.appUI.swipeMessage(${m.id}, ${(m.swipe_index || 0) - 1})" ${m.swipe_index <= 0 ? 'disabled' : ''}>◀</button>
                      <span class="swipe-counter">${curSwipe} / ${swipesCount}</span>
                      <button class="toolbar-btn" onclick="window.appUI.swipeMessage(${m.id}, ${(m.swipe_index || 0) + 1})" ${m.swipe_index >= swipesCount - 1 ? 'disabled' : ''}>▶</button>`
                   : `<span class="msg-meta-label">${idx === 0 ? 'Приветствие' : 'Ответ'}</span>`
               }
               ${
                 idx > 0
                   ? `<button class="toolbar-btn" onclick="window.appUI.regenerateMessage(${m.id})" title="Сгенерировать новый вариант ответа">🔄 Реролл</button>`
                   : ''
               }
             </div>`
          : `<div class="swipe-controls"><span class="msg-meta-label">Вы</span></div>`;

        return `
          <div class="msg-row ${isUser ? 'user' : 'assistant'}">
            <div class="msg-head">
              <img
                class="msg-avatar"
                src="${escapeHtml(avatar)}"
                alt="${escapeHtml(senderName)}"
                onclick="event.stopPropagation(); window.appUI.openAvatarViewer(this.src, '${escapeHtml(senderName)}')"
                title="Нажмите, чтобы открыть и увеличить аватар"
              />
              <span class="msg-sender-name">${escapeHtml(senderName)}</span>
            </div>
            <div class="msg-bubble">
              ${thoughtsBlock}
              <div class="msg-text">${formatRoleplayHtml(m.content)}</div>
              <div class="msg-toolbar">
                ${swipeControls}
                <div class="swipe-controls">
                  <button class="toolbar-btn" onclick="window.appUI.openEditMessageModal(${m.id})" title="Редактировать сообщение">✏️</button>
                  ${
                    idx > 0
                      ? `<button class="toolbar-btn" onclick="window.appUI.deleteMessage(${m.id})" title="Удалить сообщение">🗑</button>`
                      : ''
                  }
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    state.ignoreScrollEvents = true;
    msgContainer.scrollTop = msgContainer.scrollHeight;
    setTimeout(() => {
      state.ignoreScrollEvents = false;
    }, 120);
  }

  const PHASE_LABELS = {
    init: '1/6 • Инициализация запроса',
    context: '2/6 • Сборка контекста и промтов',
    oauth_check: '3/6 • Проверка Google OAuth сессии',
    oauth_refresh: '3/6 • Обновление токена доступа OAuth',
    connecting: '4/6 • Подключение к Vertex AI (SSE)',
    waiting_first_token: '5/6 • Ожидание первого токена от модели',
    thinking: '5/6 • Глубокое размышление (Thinking)',
    streaming_text: '6/6 • Потоковая генерация текста (SSE)',
    completed: '✅ Завершено успешно',
    error: '❌ Остановлено из-за ошибки',
  };

  function toggleStreamingDetails() {
    state.streamingExpanded = !state.streamingExpanded;
    const box = document.getElementById('chatStreamingBox');
    const panel = document.getElementById('streamingDetailsPanel');
    const expandBtn = document.getElementById('streamingExpandBtn');
    if (box) box.classList.toggle('expanded', state.streamingExpanded);
    if (panel) panel.classList.toggle('hidden', !state.streamingExpanded);
    if (expandBtn) {
      expandBtn.textContent = state.streamingExpanded ? '⤡ Свернуть' : '⤢ Подробнее';
    }
    if (state.streamingExpanded && state.lastGeneration) {
      renderGenerationProgress(state.lastGeneration);
    }
  }

  function closeStreamingBox() {
    stopGenerationPolling(true);
  }

  function renderGenerationProgress(g) {
    if (!g) return;
    state.lastGeneration = g;

    const box = document.getElementById('chatStreamingBox');
    const spinner = document.getElementById('streamingSpinner');
    const statusText = document.getElementById('streamingStatusText');
    const elapsedBadge = document.getElementById('streamingElapsedBadge');
    const closeBtn = document.getElementById('streamingCloseBtn');
    const thoughtsPreview = document.getElementById('streamingThoughtsPreview');
    const textPreview = document.getElementById('streamingTextPreview');

    const isError = g.phase === 'error' || Boolean(g.error);
    if (box) {
      box.classList.remove('hidden');
      box.classList.toggle('error-state', isError);
      box.classList.toggle('expanded', state.streamingExpanded);
    }
    if (spinner) {
      spinner.classList.toggle('hidden', isError || g.phase === 'completed');
    }
    if (closeBtn) {
      closeBtn.classList.toggle('hidden', !isError && g.phase !== 'completed');
    }
    if (statusText) {
      statusText.textContent = g.statusText || (isError ? `❌ ${g.error}` : 'Выполнение запроса...');
    }
    if (elapsedBadge && typeof g.elapsedMs === 'number') {
      elapsedBadge.textContent = (g.elapsedMs / 1000).toFixed(1) + 'с';
    }

    // Compact previews
    if (thoughtsPreview) {
      if (g.thoughts) {
        thoughtsPreview.classList.remove('hidden');
        thoughtsPreview.textContent = `💭 [${g.thoughtsChars || g.thoughts.length} симв.] ` + g.thoughts.slice(-260);
      } else {
        thoughtsPreview.classList.add('hidden');
        thoughtsPreview.textContent = '';
      }
    }
    if (textPreview) {
      if (isError && g.error) {
        textPreview.textContent = g.error;
      } else if (g.text) {
        textPreview.textContent = g.text.slice(-340);
      } else {
        textPreview.textContent = '';
      }
    }

    // Detailed Expanded Panel
    const metaModel = document.getElementById('streamMetaModel');
    const metaPhase = document.getElementById('streamMetaPhase');
    const metaHttp = document.getElementById('streamMetaHttp');
    const metaContext = document.getElementById('streamMetaContext');
    const metaConfig = document.getElementById('streamMetaConfig');
    const metaEndpoint = document.getElementById('streamMetaEndpoint');
    const logsBadge = document.getElementById('streamLogsCountBadge');
    const logsList = document.getElementById('streamingLogsList');
    const thoughtsFullWrap = document.getElementById('streamingThoughtsFullWrap');
    const thoughtsFull = document.getElementById('streamingThoughtsFull');
    const thoughtsCounter = document.getElementById('streamThoughtsCounter');
    const textFullWrap = document.getElementById('streamingTextFullWrap');
    const textFull = document.getElementById('streamingTextFull');
    const textCounter = document.getElementById('streamTextCounter');

    const modelName = getShortModelName(g.model);
    const vertexSuffix = g.vertexModel && g.vertexModel !== g.model ? ` → Vertex: ${g.vertexModel}` : '';
    if (metaModel) {
      metaModel.textContent = `${modelName} (${g.model || '—'}) • ${String(g.effort || 'high').toUpperCase()}${vertexSuffix}`;
    }
    if (metaPhase) {
      const basePhase = PHASE_LABELS[g.phase] || g.phase || '—';
      metaPhase.textContent = g.finishReason ? `${basePhase} (finishReason: ${g.finishReason})` : basePhase;
    }
    if (metaHttp) {
      const httpStr = g.httpStatus ? `HTTP ${g.httpStatus}` : 'Ожидание ответа...';
      metaHttp.textContent = `${httpStr} • SSE чанков: ${g.chunksCount || 0} • Мысли: ${g.thoughtsChars || 0} симв. • Текст: ${g.textChars || 0} симв.`;
    }
    if (metaContext) {
      metaContext.textContent = `Сообщений в контексте: ${g.contextMessagesCount || 0} • Размер промта: ${g.promptChars || 0} симв.`;
    }
    if (metaConfig) {
      metaConfig.textContent = `Без автосмены модели • ${g.thinkingConfig || '—'}`;
    }
    if (metaEndpoint) {
      metaEndpoint.textContent = g.endpoint || `Project: ${g.projectId || state.projectId} (ожидание соединения...)`;
    }

    const logs = Array.isArray(g.logs) ? g.logs : [];
    if (logsBadge) {
      logsBadge.textContent = `${logs.length} ${logs.length === 1 ? 'шаг' : (logs.length >= 2 && logs.length <= 4 ? 'шага' : 'шагов')}`;
    }
    if (logsList) {
      logsList.innerHTML = logs
        .map(line => {
          const isErrLine = line.includes('❌') || line.includes('ОШИБКА') || line.includes('ошибк');
          const isOkLine = line.includes('✅');
          const cls = isErrLine ? 'stream-log-line log-error' : (isOkLine ? 'stream-log-line log-ok' : 'stream-log-line');
          return `<div class="${cls}">${escapeHtml(line)}</div>`;
        })
        .join('');
      logsList.scrollTop = logsList.scrollHeight;
    }

    if (thoughtsFullWrap && thoughtsFull && thoughtsCounter) {
      if (g.thoughts) {
        thoughtsFullWrap.classList.remove('hidden');
        thoughtsCounter.textContent = `${g.thoughtsChars || g.thoughts.length} симв.`;
        thoughtsFull.textContent = g.thoughts;
        thoughtsFull.scrollTop = thoughtsFull.scrollHeight;
      } else {
        thoughtsFullWrap.classList.add('hidden');
        thoughtsFull.textContent = '';
      }
    }

    if (textFullWrap && textFull && textCounter) {
      if (g.text || (isError && g.error)) {
        textFullWrap.classList.remove('hidden');
        const contentToShow = g.text || g.error || '';
        textCounter.textContent = `${g.textChars || contentToShow.length} симв.`;
        textFull.textContent = contentToShow;
        textFull.scrollTop = textFull.scrollHeight;
      } else {
        textFullWrap.classList.add('hidden');
        textFull.textContent = '';
      }
    }
  }

  function startGenerationPolling(chatId) {
    stopGenerationPolling(false);
    state.generationStartMs = Date.now();
    const activeModel = state.currentChatData && state.currentChatData.chat
      ? state.currentChatData.chat.model_id
      : state.selectedModel;
    const activeEffort = state.currentChatData && state.currentChatData.chat
      ? state.currentChatData.chat.effort
      : state.selectedEffort;

    const initialProg = {
      phase: 'init',
      statusText: `🚀 Отправка запроса строго к ${getShortModelName(activeModel)} (${String(activeEffort).toUpperCase()})...`,
      model: activeModel,
      vertexModel: '',
      effort: activeEffort,
      thinkingConfig: 'Подготовка параметров...',
      projectId: state.projectId,
      endpoint: 'Подготовка соединения с Google Cloud AI Companion...',
      httpStatus: 0,
      chunksCount: 0,
      thoughtsChars: 0,
      textChars: 0,
      contextMessagesCount: (state.currentChatData && Array.isArray(state.currentChatData.messages)) ? state.currentChatData.messages.length : 0,
      promptChars: 0,
      finishReason: '',
      error: '',
      elapsedMs: 0,
      thoughts: '',
      text: '',
      logs: [`[00:00.0] 🚀 Инициализация запроса к модели ${activeModel} (effort=${activeEffort})...`],
    };
    renderGenerationProgress(initialProg);

    const detailsPanel = document.getElementById('streamingDetailsPanel');
    const expandBtn = document.getElementById('streamingExpandBtn');
    if (detailsPanel) detailsPanel.classList.toggle('hidden', !state.streamingExpanded);
    if (expandBtn) expandBtn.textContent = state.streamingExpanded ? '⤡ Свернуть' : '⤢ Подробнее';

    // Smooth local elapsed timer (ticks every 200ms even while waiting on network chunk)
    state.elapsedTimer = setInterval(() => {
      const elapsedBadge = document.getElementById('streamingElapsedBadge');
      if (elapsedBadge && state.generationStartMs > 0) {
        const sec = (Date.now() - state.generationStartMs) / 1000;
        elapsedBadge.textContent = sec.toFixed(1) + 'с';
      }
    }, 200);

    state.pollTimer = setInterval(async () => {
      try {
        const data = await apiFetch(`/api/chats/${chatId}/generation`);
        if (data.generation) {
          renderGenerationProgress(data.generation);
        }
      } catch (e) {}
    }, 400);
  }

  function stopGenerationPolling(hideBox = true) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
    state.generationStartMs = 0;
    if (hideBox) {
      const box = document.getElementById('chatStreamingBox');
      if (box) {
        box.classList.add('hidden');
        box.classList.remove('error-state');
      }
    }
  }

  async function handleGenerationFailure(chatId, err) {
    stopGenerationPolling(false);
    if (err && err.data && err.data.generation) {
      renderGenerationProgress(err.data.generation);
      return;
    }
    try {
      const genData = await apiFetch(`/api/chats/${chatId}/generation`);
      if (genData && genData.lastGeneration) {
        renderGenerationProgress(genData.lastGeneration);
        return;
      }
    } catch (e) {}

    // Fallback error progress if server didn't attach generation object
    const fallbackErr = Object.assign({}, state.lastGeneration || {}, {
      phase: 'error',
      error: err ? err.message : 'Неизвестная ошибка',
      statusText: '❌ Ошибка: ' + (err ? err.message : 'Неизвестная ошибка'),
      logs: ((state.lastGeneration && state.lastGeneration.logs) || []).concat([
        `[ошибка] ❌ ${err ? err.message : 'Сбой запроса'}`
      ]),
    });
    renderGenerationProgress(fallbackErr);
  }

  async function sendMessage() {
    if (state.isSending || !state.currentChatId) return;
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    state.isSending = true;
    document.getElementById('sendMsgBtn').disabled = true;
    input.value = '';
    autoResizeChatInput();

    const tempMsgId = Date.now();
    // Optimistically append user message to UI
    if (state.currentChatData && Array.isArray(state.currentChatData.messages)) {
      state.currentChatData.messages.push({
        id: tempMsgId,
        role: 'user',
        content: text,
        swipes: [text],
        swipe_index: 0,
      });
      renderActiveChatRoom();
    }

    const chatId = state.currentChatId;
    startGenerationPolling(chatId);

    try {
      const res = await apiFetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      });
      if (res && res.generation) {
        state.lastGeneration = res.generation;
      }
      stopGenerationPolling(true);
      if (state.currentChatData && state.currentChatId === chatId) {
        state.currentChatData.messages = res.messages;
        renderActiveChatRoom();
      }
    } catch (err) {
      await handleGenerationFailure(chatId, err);
      // Remove optimistic message and restore user input so nothing is lost or polluted
      if (state.currentChatData && Array.isArray(state.currentChatData.messages)) {
        state.currentChatData.messages = state.currentChatData.messages.filter(m => m.id !== tempMsgId);
        renderActiveChatRoom();
      }
      input.value = text;
      autoResizeChatInput();
      showToast(err.message);
      if (!state.agyAuthenticated) {
        openTab('settings');
      }
    } finally {
      state.isSending = false;
      document.getElementById('sendMsgBtn').disabled = false;
    }
  }

  async function swipeMessage(msgId, newIndex) {
    try {
      const res = await apiFetch(`/api/messages/${msgId}/swipe`, {
        method: 'POST',
        body: JSON.stringify({ action: 'select', index: newIndex }),
      });
      if (state.currentChatData) {
        const idx = state.currentChatData.messages.findIndex(m => m.id === msgId);
        if (idx !== -1) {
          state.currentChatData.messages[idx] = res.message;
          renderActiveChatRoom();
        }
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  async function regenerateMessage(msgId) {
    if (state.isSending || !state.currentChatId) return;
    state.isSending = true;
    const chatId = state.currentChatId;
    startGenerationPolling(chatId);
    try {
      const res = await apiFetch(`/api/messages/${msgId}/swipe`, {
        method: 'POST',
        body: JSON.stringify({ action: 'regenerate' }),
      });
      if (res && res.generation) {
        state.lastGeneration = res.generation;
      }
      stopGenerationPolling(true);
      if (state.currentChatData) {
        const idx = state.currentChatData.messages.findIndex(m => m.id === msgId);
        if (idx !== -1) {
          state.currentChatData.messages[idx] = res.message;
          renderActiveChatRoom();
        }
      }
      showToast('✨ Сгенерирован новый вариант ответа!');
    } catch (err) {
      await handleGenerationFailure(chatId, err);
      showToast('Ошибка реролла: ' + err.message);
    } finally {
      state.isSending = false;
    }
  }

  function openEditMessageModal(msgId) {
    if (!state.currentChatData) return;
    const msg = state.currentChatData.messages.find(m => m.id === msgId);
    if (!msg) return;
    document.getElementById('editMsgIdInput').value = String(msgId);
    document.getElementById('editMsgContentInput').value = msg.content;
    document.getElementById('editMessageModal').classList.remove('hidden');
  }

  async function saveEditedMessage() {
    const msgId = Number(document.getElementById('editMsgIdInput').value);
    const content = document.getElementById('editMsgContentInput').value;
    try {
      const res = await apiFetch(`/api/messages/${msgId}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      if (state.currentChatData) {
        const idx = state.currentChatData.messages.findIndex(m => m.id === msgId);
        if (idx !== -1) state.currentChatData.messages[idx] = res.message;
        renderActiveChatRoom();
      }
      closeModal('editMessageModal');
      showToast('Сообщение обновлено');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function deleteMessage(msgId) {
    try {
      await apiFetch(`/api/messages/${msgId}`, { method: 'DELETE' });
      if (state.currentChatData) {
        state.currentChatData.messages = state.currentChatData.messages.filter(m => m.id !== msgId);
        renderActiveChatRoom();
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  async function deleteChat(chatId) {
    try {
      await apiFetch(`/api/chats/${chatId}`, { method: 'DELETE' });
      await loadChatsList();
      showToast('Чат удалён');
    } catch (err) {
      showToast(err.message);
    }
  }

  function insertAsterisks() {
    const input = document.getElementById('chatInput');
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const val = input.value;
    const selected = val.slice(start, end);
    const replacement = `*${selected || 'действие'}* `;
    input.value = val.slice(0, start) + replacement + val.slice(end);
    input.focus();
  }

  // ==========================================================================
  // NEW CHAT MODAL
  // ==========================================================================
  function openNewChatModal(preselectedCharId) {
    if (!state.characters.length) {
      showToast('Сначала создайте персонажа во вкладке «Персонажи»');
      openTab('characters');
      switchCharSubtab('characters');
      return;
    }

    const charSel = document.getElementById('newChatCharSelect');
    charSel.innerHTML = state.characters
      .map(c => `<option value="${c.id}" ${c.id === preselectedCharId ? 'selected' : ''}>🎭 ${escapeHtml(c.name)} (${escapeHtml(c.file_path)})</option>`)
      .join('');

    const personaSel = document.getElementById('newChatPersonaSelect');
    if (state.personas.length) {
      personaSel.innerHTML = state.personas
        .map(p => `<option value="${p.id}" ${p.id === Number(state.activePersonaId) ? 'selected' : ''}>👤 ${escapeHtml(p.name)} (${escapeHtml(p.file_path)})</option>`)
        .join('');
    } else {
      personaSel.innerHTML = `<option value="0" selected>👤 Игрок (без карточки персоны)</option>`;
    }

    const modelSel = document.getElementById('newChatModelSelect');
    modelSel.innerHTML = state.models
      .map(m => `<option value="${escapeHtml(m.id)}" ${m.id === state.selectedModel ? 'selected' : ''}>${escapeHtml(m.name)}${m.badge ? ' — ' + escapeHtml(m.badge) : ''}</option>`)
      .join('');

    const effortSel = document.getElementById('newChatEffortSelect');
    if (effortSel) {
      effortSel.value = state.selectedEffort || 'high';
    }

    onNewChatCharacterChange();
    document.getElementById('newChatModal').classList.remove('hidden');
  }

  function onNewChatCharacterChange() {
    const charId = Number(document.getElementById('newChatCharSelect').value);
    const char = state.characters.find(c => c.id === charId) || state.characters[0];
    document.getElementById('newChatGreetingInput').value = char ? (char.first_message || '') : '';
  }

  async function confirmCreateChat() {
    const characterId = Number(document.getElementById('newChatCharSelect').value);
    const personaId = Number(document.getElementById('newChatPersonaSelect').value);
    const modelId = document.getElementById('newChatModelSelect').value;
    const effortSel = document.getElementById('newChatEffortSelect');
    const effort = effortSel ? effortSel.value : state.selectedEffort;
    const customFirstMessage = document.getElementById('newChatGreetingInput').value;

    try {
      const res = await apiFetch('/api/chats', {
        method: 'POST',
        body: JSON.stringify({
          characterId,
          personaId,
          modelId,
          effort,
          customFirstMessage,
        }),
      });
      closeModal('newChatModal');
      await loadChatsList();
      openTab('chats');
      openChatRoom(res.chat.id);
    } catch (err) {
      showToast(err.message);
    }
  }

  // ==========================================================================
  // CHARACTERS & PERSONAS MANAGEMENT
  // ==========================================================================
  async function reloadCharactersAndPersonas() {
    const [charsData, personasData] = await Promise.all([
      apiFetch('/api/characters'),
      apiFetch('/api/personas'),
    ]);
    state.characters = charsData.characters || [];
    state.personas = personasData.personas || [];
    state.activePersonaId = personasData.activePersonaId || state.activePersonaId;
    renderCharactersAndPersonas();
    renderChatsList();
    updateHeaderIndicators(true);
  }

  function switchCharSubtab(sub) {
    const isChars = sub === 'characters';
    document.getElementById('segCharsBtn').classList.toggle('active', isChars);
    document.getElementById('segPersonasBtn').classList.toggle('active', !isChars);
    document.getElementById('subtabCharacters').classList.toggle('hidden', !isChars);
    document.getElementById('subtabPersonas').classList.toggle('hidden', isChars);
  }

  function renderCharactersAndPersonas() {
    const charGrid = document.getElementById('charactersGrid');
    if (charGrid) {
      if (!state.characters.length) {
        charGrid.innerHTML = `
          <div class="settings-card empty-state-card" style="grid-column: 1 / -1;">
            <div class="empty-state-icon">🎭</div>
            <div class="card-title">Список персонажей пуст</div>
            <p class="card-hint">Стоковые персонажи отключены. Создайте собственного персонажа или добавьте .md файл в папку <code>characters/</code>.</p>
            <button class="btn-primary" onclick="window.appUI.openCharacterEditor(null)">+ Добавить персонажа</button>
          </div>
        `;
      } else {
        charGrid.innerHTML = state.characters
          .map(c => `
            <div class="char-card">
              <img
                class="char-card-img"
                src="${escapeHtml(resolveAvatarUrl(c.avatar_url))}"
                alt="${escapeHtml(c.name)}"
                style="cursor:zoom-in;"
                onclick="event.stopPropagation(); window.appUI.openAvatarViewer(this.src, '${escapeHtml(c.name)}')"
                title="Нажмите, чтобы увеличить изображение"
              />
              <div class="char-card-body">
                <div class="char-card-name">${escapeHtml(c.name)}</div>
                <div class="char-card-file">📄 ${escapeHtml(c.file_path)}</div>
                <div class="char-card-greeting">${escapeHtml(stripMarkdownPreview(c.first_message || c.description_preview || 'Нет описания'))}</div>
                <div class="char-card-actions">
                  <button class="btn-primary btn-sm" style="flex:1;" onclick="window.appUI.openNewChatModal(${c.id})">💬 Чат</button>
                  <button class="btn-secondary btn-sm" onclick="window.appUI.openCharacterEditor(${c.id})">✏️</button>
                </div>
              </div>
            </div>
          `)
          .join('');
      }
    }

    const personasList = document.getElementById('personasList');
    if (personasList) {
      if (!state.personas.length) {
        personasList.innerHTML = `
          <div class="settings-card empty-state-card">
            <div class="empty-state-icon">👤</div>
            <div class="card-title">Список персон пуст</div>
            <p class="card-hint">Добавьте свою персону (описание вашего персонажа/игрока), чтобы ИИ знал, с кем ведёт диалог.</p>
            <button class="btn-primary" onclick="window.appUI.openPersonaEditor(null)">+ Добавить персону</button>
          </div>
        `;
      } else {
        personasList.innerHTML = state.personas
          .map(p => {
            const isActive = p.id === Number(state.activePersonaId);
            return `
              <div class="chat-card ${isActive ? 'active-persona-card' : ''}">
                <img
                  class="chat-card-avatar"
                  src="${escapeHtml(resolveAvatarUrl(p.avatar_url))}"
                  alt="${escapeHtml(p.name)}"
                  style="cursor:zoom-in;"
                  onclick="event.stopPropagation(); window.appUI.openAvatarViewer(this.src, '${escapeHtml(p.name)}')"
                  title="Нажмите, чтобы увеличить аватар"
                />
                <div class="chat-card-body">
                  <div class="chat-card-title">
                    <span>${escapeHtml(p.name)}</span>
                    <div class="row-gap-sm">
                      ${
                        !isActive
                          ? `<button class="btn-primary btn-sm" onclick="window.appUI.activatePersona(${p.id})">Выбрать</button>`
                          : `<span class="model-badge">Активна</span>`
                      }
                      <button class="btn-secondary btn-sm" onclick="window.appUI.openPersonaEditor(${p.id})">✏️</button>
                    </div>
                  </div>
                  <div class="chat-card-preview">${escapeHtml(stripMarkdownPreview(p.description_preview || 'Нет описания'))}</div>
                  <div class="chat-card-meta">📄 Файл: ${escapeHtml(p.file_path)}</div>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  function openCharacterEditor(charId) {
    const char = state.characters.find(c => c.id === charId) || null;
    document.getElementById('charEditId').value = char ? String(char.id) : '';
    document.getElementById('charModalTitle').textContent = char ? `Персонаж: ${char.name}` : 'Новый персонаж';
    document.getElementById('charNameInput').value = char ? char.name : '';
    document.getElementById('charFilePathInput').value = char ? char.file_path : '';
    document.getElementById('charAvatarUrlInput').value = char ? (char.avatar_url || '') : '';
    document.getElementById('charAvatarPreview').src = resolveAvatarUrl(char ? char.avatar_url : '');
    document.getElementById('charFirstMessageInput').value = char ? (char.first_message || '') : '';
    document.getElementById('charFileContentInput').value = char
      ? (char.fileContent || char.description_preview || '')
      : '';
    document.getElementById('charDeleteBtn').classList.toggle('hidden', !char);
    document.getElementById('characterModal').classList.remove('hidden');
  }

  function editCurrentChatCharacter() {
    if (state.currentChatData && state.currentChatData.character && state.currentChatData.character.id) {
      openCharacterEditor(state.currentChatData.character.id);
    }
  }

  async function handleAvatarUpload(event, targetType) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (e) {
      const base64Data = e.target.result;
      try {
        const res = await apiFetch('/api/upload-avatar', {
          method: 'POST',
          body: JSON.stringify({ base64Data, filename: file.name }),
        });
        if (targetType === 'character') {
          document.getElementById('charAvatarUrlInput').value = res.avatarUrl;
          document.getElementById('charAvatarPreview').src = resolveAvatarUrl(res.avatarUrl);
        } else {
          document.getElementById('personaAvatarUrlInput').value = res.avatarUrl;
          document.getElementById('personaAvatarPreview').src = resolveAvatarUrl(res.avatarUrl);
        }
        showToast('Изображение загружено!');
      } catch (err) {
        showToast('Ошибка загрузки фото: ' + err.message);
      }
    };
    reader.readAsDataURL(file);
  }

  function updateAvatarPreview(targetType) {
    if (targetType === 'character') {
      const url = document.getElementById('charAvatarUrlInput').value.trim();
      document.getElementById('charAvatarPreview').src = resolveAvatarUrl(url);
    } else {
      const url = document.getElementById('personaAvatarUrlInput').value.trim();
      document.getElementById('personaAvatarPreview').src = resolveAvatarUrl(url);
    }
  }

  async function saveCharacterFromModal() {
    const editId = document.getElementById('charEditId').value;
    const name = document.getElementById('charNameInput').value.trim();
    const filePath = document.getElementById('charFilePathInput').value.trim();
    const avatarUrl = document.getElementById('charAvatarUrlInput').value.trim();
    const firstMessage = document.getElementById('charFirstMessageInput').value;
    const rawFileContent = document.getElementById('charFileContentInput').value;

    if (!name) {
      return showToast('Введите имя персонажа');
    }

    try {
      const payload = {
        name,
        filePath,
        avatarUrl,
        firstMessage,
        description: rawFileContent,
        rawFileContent: rawFileContent.includes('#') ? rawFileContent : undefined,
      };
      if (editId) {
        await apiFetch(`/api/characters/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/characters', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeModal('characterModal');
      await reloadCharactersAndPersonas();
      loadFiles(state.currentFilesPath);
      if (state.currentChatId) openChatRoom(state.currentChatId);
      showToast('Персонаж и его файл сохранены!');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function deleteCharacterFromModal() {
    const editId = document.getElementById('charEditId').value;
    if (!editId) return;
    try {
      await apiFetch(`/api/characters/${editId}?deleteFile=1`, { method: 'DELETE' });
      closeModal('characterModal');
      await reloadCharactersAndPersonas();
      loadFiles(state.currentFilesPath);
      showToast('Персонаж удалён');
    } catch (err) {
      showToast(err.message);
    }
  }

  function openPersonaEditor(personaId) {
    const p = state.personas.find(x => x.id === personaId) || null;
    document.getElementById('personaEditId').value = p ? String(p.id) : '';
    document.getElementById('personaModalTitle').textContent = p ? `Персона: ${p.name}` : 'Новая Персона игрока';
    document.getElementById('personaNameInput').value = p ? p.name : '';
    document.getElementById('personaFilePathInput').value = p ? p.file_path : '';
    document.getElementById('personaAvatarUrlInput').value = p ? (p.avatar_url || '') : '';
    document.getElementById('personaAvatarPreview').src = resolveAvatarUrl(p ? p.avatar_url : '');
    document.getElementById('personaFileContentInput').value = p ? (p.fileContent || p.description_preview || '') : '';
    document.getElementById('personaDeleteBtn').classList.toggle('hidden', !p);
    document.getElementById('personaModal').classList.remove('hidden');
  }

  async function savePersonaFromModal() {
    const editId = document.getElementById('personaEditId').value;
    const name = document.getElementById('personaNameInput').value.trim();
    const filePath = document.getElementById('personaFilePathInput').value.trim();
    const avatarUrl = document.getElementById('personaAvatarUrlInput').value.trim();
    const content = document.getElementById('personaFileContentInput').value;

    if (!name) return showToast('Введите имя вашей персоны');

    try {
      const payload = {
        name,
        filePath,
        avatarUrl,
        description: content,
        rawFileContent: content.includes('#') ? content : undefined,
      };
      if (editId) {
        await apiFetch(`/api/personas/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await apiFetch('/api/personas', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeModal('personaModal');
      await reloadCharactersAndPersonas();
      loadFiles(state.currentFilesPath);
      showToast('Персона сохранена!');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function deletePersonaFromModal() {
    const editId = document.getElementById('personaEditId').value;
    if (!editId) return;
    try {
      await apiFetch(`/api/personas/${editId}`, { method: 'DELETE' });
      closeModal('personaModal');
      await reloadCharactersAndPersonas();
      loadFiles(state.currentFilesPath);
      showToast('Персона удалена');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function activatePersona(personaId) {
    try {
      await apiFetch(`/api/personas/${personaId}/activate`, { method: 'POST' });
      state.activePersonaId = personaId;
      if (state.currentChatId) {
        const res = await apiFetch(`/api/chats/${state.currentChatId}`, {
          method: 'PATCH',
          body: JSON.stringify({ personaId }),
        });
        if (state.currentChatData) {
          state.currentChatData.chat = res.chat;
          state.currentChatData.persona = res.persona;
          renderActiveChatRoom();
        }
      }
      renderCharactersAndPersonas();
      updateHeaderIndicators(true);
      showToast('Активная персона изменена!');
    } catch (err) {
      showToast(err.message);
    }
  }

  function openPersonaQuickModal() {
    openTab('characters');
    switchCharSubtab('personas');
  }

  // ==========================================================================
  // FILES & FOLDERS MANAGER
  // ==========================================================================
  async function loadFiles(relPath = '') {
    try {
      state.currentFilesPath = relPath;
      const data = await apiFetch(`/api/files?path=${encodeURIComponent(relPath)}`);
      document.getElementById('filesBreadcrumb').textContent = `workspace / ${data.currentPath || ''}`;

      const list = document.getElementById('filesListContainer');
      const items = data.items || [];
      let html = '';

      if (relPath) {
        const parentPath = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
        html += `
          <div class="file-item" onclick="window.appUI.loadFiles('${escapeHtml(parentPath)}')">
            <div class="file-item-left">
              <span class="file-icon">↩️</span>
              <div>
                <div class="file-name">.. (На уровень выше)</div>
              </div>
            </div>
          </div>
        `;
      }

      html += items
        .map(item => {
          if (item.isDirectory) {
            return `
              <div class="file-item" onclick="window.appUI.loadFiles('${escapeHtml(item.path)}')">
                <div class="file-item-left">
                  <span class="file-icon">📁</span>
                  <div>
                    <div class="file-name">${escapeHtml(item.name)}/</div>
                    <div class="file-sub">Папка • ${escapeHtml(item.path)}</div>
                  </div>
                </div>
                <button class="toolbar-btn" onclick="event.stopPropagation(); window.appUI.deleteWorkspaceItem('${escapeHtml(item.path)}')">🗑</button>
              </div>
            `;
          }
          return `
            <div class="file-item" onclick="window.appUI.openFileEditor('${escapeHtml(item.path)}')">
              <div class="file-item-left">
                <span class="file-icon">📄</span>
                <div>
                  <div class="file-name">${escapeHtml(item.name)}</div>
                  <div class="file-sub">${item.size} байт • ${escapeHtml(item.path)}</div>
                </div>
              </div>
              <span style="color:var(--primary-light);font-size:12px;">Открыть ✏️</span>
            </div>
          `;
        })
        .join('');

      list.innerHTML = html || '<div class="card-hint">Папка пуста. Создайте файл или подпапку.</div>';
    } catch (err) {
      showToast(err.message);
    }
  }

  async function promptCreateFolder() {
    const base = state.currentFilesPath ? state.currentFilesPath + '/' : '';
    const folderName = window.prompt('Введите путь или имя новой папки в workspace:', base + 'new_folder');
    if (!folderName || !folderName.trim()) return;
    try {
      await apiFetch('/api/files/folder', {
        method: 'POST',
        body: JSON.stringify({ folderPath: folderName.trim() }),
      });
      loadFiles(state.currentFilesPath);
      showToast('Папка создана!');
    } catch (err) {
      showToast(err.message);
    }
  }

  function promptCreateFile() {
    const base = state.currentFilesPath ? state.currentFilesPath + '/' : 'characters/';
    document.getElementById('fileEditorTitle').textContent = 'Создание нового файла';
    document.getElementById('fileEditorPathInput').value = base + 'new_file.md';
    document.getElementById('fileEditorContentInput').value = '# Заголовок\n\nТекст файла...';
    document.getElementById('fileEditorDeleteBtn').classList.add('hidden');
    document.getElementById('fileEditorModal').classList.remove('hidden');
  }

  async function openFileEditor(relPath) {
    try {
      const data = await apiFetch(`/api/files/content?path=${encodeURIComponent(relPath)}`);
      document.getElementById('fileEditorTitle').textContent = `Файл: ${data.name}`;
      document.getElementById('fileEditorPathInput').value = data.path;
      document.getElementById('fileEditorContentInput').value = data.content;
      document.getElementById('fileEditorDeleteBtn').classList.remove('hidden');
      document.getElementById('fileEditorModal').classList.remove('hidden');
    } catch (err) {
      showToast(err.message);
    }
  }

  function openChatMemoryFile() {
    if (!state.currentChatData || !state.currentChatData.chat) return;
    const memPath = state.currentChatData.chat.memory_file_path || `memories/chat_${state.currentChatData.chat.id}.md`;
    openFileEditor(memPath);
  }

  async function saveFileFromModal() {
    const filePath = document.getElementById('fileEditorPathInput').value.trim();
    const content = document.getElementById('fileEditorContentInput').value;
    if (!filePath) return showToast('Укажите путь к файлу');
    try {
      await apiFetch('/api/files/file', {
        method: 'POST',
        body: JSON.stringify({ filePath, content }),
      });
      closeModal('fileEditorModal');
      loadFiles(state.currentFilesPath);
      await reloadCharactersAndPersonas();
      showToast('Файл сохранён и синхронизирован!');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function deleteFileFromModal() {
    const filePath = document.getElementById('fileEditorPathInput').value.trim();
    if (!filePath) return;
    await deleteWorkspaceItem(filePath);
    closeModal('fileEditorModal');
  }

  async function deleteWorkspaceItem(relPath) {
    try {
      await apiFetch(`/api/files?path=${encodeURIComponent(relPath)}`, { method: 'DELETE' });
      loadFiles(state.currentFilesPath);
      await reloadCharactersAndPersonas();
      showToast('Удалено: ' + relPath);
    } catch (err) {
      showToast(err.message);
    }
  }

  // ==========================================================================
  // PROJECT ID, MODELS & EFFORT SELECTION
  // ==========================================================================
  function renderModelsLists() {
    const activeModel = state.currentChatData && state.currentChatData.chat
      ? state.currentChatData.chat.model_id
      : state.selectedModel;

    const html = state.models
      .map(m => {
        const isSel = m.id === activeModel;
        return `
          <div class="model-item ${isSel ? 'selected' : ''}" onclick="window.appUI.selectModel('${escapeHtml(m.id)}')">
            <div>
              <div style="font-weight:700;font-size:13.5px;">${escapeHtml(m.name)}</div>
              <div style="font-size:11px;color:var(--text-secondary);">ID: ${escapeHtml(m.id)}</div>
            </div>
            <div class="row-gap-sm">
              ${m.badge ? `<span class="model-badge">${escapeHtml(m.badge)}</span>` : ''}
              ${isSel ? '<span>✅</span>' : ''}
            </div>
          </div>
        `;
      })
      .join('');

    const settingsList = document.getElementById('settingsModelsList');
    if (settingsList) settingsList.innerHTML = html;

    const modalList = document.getElementById('modalModelsList');
    if (modalList) modalList.innerHTML = html;
  }

  function updateEffortButtons() {
    const activeEffort = state.currentChatData && state.currentChatData.chat
      ? state.currentChatData.chat.effort
      : state.selectedEffort;

    document.querySelectorAll('.effort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-effort') === activeEffort);
    });
  }

  async function selectModel(modelId) {
    try {
      state.selectedModel = modelId;
      if (Array.isArray(state.chats)) {
        state.chats.forEach(c => {
          c.model_id = modelId;
        });
      }
      if (state.currentChatData && state.currentChatData.chat) {
        state.currentChatData.chat.model_id = modelId;
      }

      await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ selectedModel: modelId }),
      });

      if (state.currentChatId) {
        const res = await apiFetch(`/api/chats/${state.currentChatId}`, {
          method: 'PATCH',
          body: JSON.stringify({ modelId }),
        });
        if (state.currentChatData) {
          state.currentChatData.chat = res.chat;
          renderActiveChatRoom();
        }
      }

      renderModelsLists();
      renderChatsList();
      updateHeaderIndicators(true);
      closeModal('modelPickerModal');
      showToast(`Фиксирована модель: ${getShortModelName(modelId)}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function setEffort(effort) {
    try {
      state.selectedEffort = effort;
      if (Array.isArray(state.chats)) {
        state.chats.forEach(c => {
          c.effort = effort;
        });
      }
      if (state.currentChatData && state.currentChatData.chat) {
        state.currentChatData.chat.effort = effort;
      }

      await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ selectedEffort: effort }),
      });

      if (state.currentChatId) {
        const res = await apiFetch(`/api/chats/${state.currentChatId}`, {
          method: 'PATCH',
          body: JSON.stringify({ effort }),
        });
        if (state.currentChatData) {
          state.currentChatData.chat = res.chat;
          renderActiveChatRoom();
        }
      }

      updateEffortButtons();
      renderChatsList();
      updateHeaderIndicators(true);
      showToast(`Уровень рассуждений (Effort): ${effort.toUpperCase()}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function refreshModels() {
    try {
      showToast('Запрос моделей из agy models...');
      const data = await apiFetch('/api/models?refresh=1');
      state.models = data.models || [];
      renderModelsLists();
      showToast(`Загружено моделей: ${state.models.length}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function startAgyOAuth() {
    try {
      showToast('🔑 Запуск авторизации Google Antigravity...');
      const res = await apiFetch('/api/agy/auth/start', { method: 'POST' });
      if (res.authUrl && typeof window.AndroidServer === 'undefined') {
        window.open(res.authUrl, '_blank');
      }
      // Poll status briefly while user completes sign-in in browser
      let checks = 0;
      const authPoll = setInterval(async () => {
        checks++;
        if (checks > 90 || state.agyAuthenticated) {
          clearInterval(authPoll);
          return;
        }
        await checkAgyAuthStatus();
      }, 2000);
    } catch (err) {
      showToast('Ошибка запуска авторизации: ' + err.message);
    }
  }

  async function exchangeAgyOAuthCode() {
    const inputEl = document.getElementById('inputOAuthCode');
    const codeOrUrl = inputEl ? inputEl.value.trim() : '';
    if (!codeOrUrl) {
      return showToast('Вставьте ссылку редиректа или код авторизации');
    }
    try {
      showToast('⏳ Проверка кода авторизации...');
      const res = await apiFetch('/api/agy/auth/exchange', {
        method: 'POST',
        body: JSON.stringify({ codeOrUrl }),
      });
      state.agyAuthenticated = Boolean(res.authenticated);
      state.agyEmail = res.email || '';
      if (res.projectId) {
        state.projectId = res.projectId;
        const projInput = document.getElementById('inputProjectId');
        if (projInput) projInput.value = state.projectId;
      }
      if (inputEl) inputEl.value = '';
      renderAgyAuthStatus();
      updateHeaderIndicators(true);
      showToast(`✅ Авторизация успешна${state.agyEmail ? ' (' + state.agyEmail + ')' : ''}!`);
    } catch (err) {
      showToast('Ошибка авторизации: ' + err.message);
    }
  }

  async function logoutAgyOAuth() {
    try {
      await apiFetch('/api/agy/auth/logout', { method: 'POST' });
      state.agyAuthenticated = false;
      state.agyEmail = '';
      renderAgyAuthStatus();
      updateHeaderIndicators(true);
      showToast('Вы вышли из аккаунта Google Antigravity');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function saveSettings() {
    const projectId = document.getElementById('inputProjectId').value.trim();
    const contextMessagesLimit = Number(document.getElementById('inputContextLimit').value || 30);
    const safetySelect = document.getElementById('inputSafetyThreshold');
    const safetyThreshold = safetySelect ? safetySelect.value : (state.safetyThreshold || 'OFF');
    if (!projectId) return showToast('Введите Project ID');

    const payload = {
      projectId,
      contextMessagesLimit,
      safetyThreshold,
    };

    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.projectId = res.projectId;
      state.contextMessagesLimit = res.contextMessagesLimit;
      state.safetyThreshold = res.safetyThreshold || safetyThreshold;
      renderAgyAuthStatus();
      updateHeaderIndicators(true);
      showToast(`✅ Настройки сохранены! Safety: ${state.safetyThreshold}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  function applyServerUrl() {
    const raw = document.getElementById('inputServerUrl').value.trim().replace(/\/+$/, '');
    if (!raw) return;
    localStorage.setItem('agy_server_url', raw);
    state.serverUrl = raw;
    showToast('Подключение к ' + raw + '...');
    initApp();
  }

  function openModelModal() {
    renderModelsLists();
    updateEffortButtons();
    document.getElementById('modelPickerModal').classList.remove('hidden');
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  function openTab(tabName) {
    setBottomNavHidden(false);
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    });
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    if (tabName === 'updates') {
      checkForUpdates(false);
    } else if (tabName === 'settings') {
      checkAgyAuthStatus();
    }
  }

  // ==========================================================================
  // GIT AUTO-UPDATE & VERSION MANAGER (OTA + APK + COMMIT HISTORY)
  // ==========================================================================
  let updateBannerDismissed = false;

  async function checkForUpdates(manualTrigger = false) {
    const checkBtn = document.getElementById('checkUpdatesBtn');
    if (checkBtn && manualTrigger) {
      checkBtn.textContent = '⏳ Проверка...';
      checkBtn.disabled = true;
    }

    try {
      const data = await apiFetch('/api/updates/check');
      state.updateInfo = data;
      renderUpdatesTab(data);

      // Update top notification banner & bottom nav badge
      const banner = document.getElementById('updateBanner');
      const navBadge = document.getElementById('navUpdateBadge');
      const bannerBtn = document.getElementById('updateBannerApplyBtn');
      const nativeUpdateRequired = Boolean(
        data.nativeUpdateRequired ||
          (data.remoteReachable && Number(data.latestBuild || 0) > Number(data.bundledBuild || 0))
      );

      if (data.updateAvailable || nativeUpdateRequired) {
        if (navBadge) navBadge.classList.remove('hidden');
        if (banner && !updateBannerDismissed) {
          const titleEl = document.getElementById('updateBannerTitle');
          const subEl = document.getElementById('updateBannerSub');
          const onlyApkOutdated =
            nativeUpdateRequired &&
            data.otaActive &&
            Number(data.currentBuild || 0) >= Number(data.latestBuild || 0);

          if (onlyApkOutdated) {
            if (titleEl) {
              titleEl.textContent = `📦 Требуется обновление APK-движка до v${data.latestVersion} (Build #${data.latestBuild})`;
            }
            if (subEl) {
              subEl.textContent = `Веб-UI обновлён (OTA), но Java-движок APK устарел (Build #${data.bundledBuild || '?'}). Скачайте свежий APK.`;
            }
            if (bannerBtn) {
              bannerBtn.textContent = '📦 Скачать APK';
              bannerBtn.onclick = () => downloadLatestApkFromGit();
            }
          } else {
            if (titleEl) {
              titleEl.textContent = `🚀 Доступна новая версия в Git: v${data.latestVersion}${data.latestCommit ? ' (' + data.latestCommit + ')' : ''}`;
            }
            if (subEl) {
              subEl.textContent = data.latestReleaseTitle || data.latestCommitMessage || `Текущая: v${data.currentVersion} → Новая: v${data.latestVersion}`;
            }
            if (bannerBtn) {
              bannerBtn.textContent = '⚡ Обновить';
              bannerBtn.onclick = () => applyGitUpdate();
            }
          }
          banner.classList.remove('hidden');
        }
        if (manualTrigger) {
          showToast(
            nativeUpdateRequired
              ? `📦 Доступен новый APK-движок v${data.latestVersion} (Build #${data.latestBuild})!`
              : `🚀 Найдено обновление в Git: v${data.latestVersion}!`
          );
        }
      } else {
        if (navBadge) navBadge.classList.add('hidden');
        if (banner) banner.classList.add('hidden');
        if (manualTrigger) {
          showToast(
            data.remoteReachable
              ? `✅ У вас установлена актуальная версия v${data.currentVersion}`
              : `ℹ️ Локальная версия v${data.currentVersion} (${data.remoteError || 'Git недоступен'})`
          );
        }
      }
    } catch (err) {
      if (manualTrigger) {
        showToast('Ошибка проверки обновлений: ' + err.message);
      }
    } finally {
      if (checkBtn && manualTrigger) {
        checkBtn.textContent = '🔍 Проверить';
        checkBtn.disabled = false;
      }
    }
  }

  function renderUpdatesTab(data) {
    if (!data) return;

    const repoInput = document.getElementById('inputGitRepo');
    const branchInput = document.getElementById('inputGitBranch');
    if (repoInput && data.gitRepo) repoInput.value = data.gitRepo;
    if (branchInput && data.gitBranch) branchInput.value = data.gitBranch;

    const curVerEl = document.getElementById('updCurrentVersion');
    const curMetaEl = document.getElementById('updCurrentMeta');
    const latVerEl = document.getElementById('updLatestVersion');
    const latMetaEl = document.getElementById('updLatestMeta');
    const statusBadge = document.getElementById('updStatusBadge');
    const resetBtn = document.getElementById('resetOtaBtn');
    const applyBtn = document.getElementById('applyOtaUpdateBtn');

    const nativeUpdateRequired = Boolean(
      data.nativeUpdateRequired ||
        (data.remoteReachable && Number(data.latestBuild || 0) > Number(data.bundledBuild || 0))
    );

    if (curVerEl) curVerEl.textContent = `v${data.currentVersion || '1.2.0'}`;
    if (curMetaEl) {
      const modeStr = data.otaActive
        ? `⚡ OTA (APK движок: Build #${data.bundledBuild || '?'})`
        : '📦 Базовая APK';
      const commitPart = data.installedCommit ? ` • ${data.installedCommit}` : '';
      curMetaEl.textContent = `Build #${data.currentBuild || 3} • ${modeStr}${commitPart}`;
    }

    if (latVerEl) latVerEl.textContent = `v${data.latestVersion || data.currentVersion || '1.2.0'}`;
    if (latMetaEl) {
      latMetaEl.textContent = data.remoteReachable
        ? `Build #${data.latestBuild || 3}${data.latestCommit ? ' • Коммит ' + data.latestCommit : ''} (${data.gitBranch})`
        : `Репозиторий: ${data.gitRepo}`;
    }

    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !data.otaActive);
    }

    if (statusBadge) {
      if (!data.remoteReachable) {
        statusBadge.textContent = `⚠️ Git (${data.gitRepo}): ${data.remoteError || 'ожидание публикации репозитория'}`;
        statusBadge.style.color = '#fbbf24';
      } else if (nativeUpdateRequired && data.otaActive && Number(data.currentBuild || 0) >= Number(data.latestBuild || 0)) {
        statusBadge.textContent = `⚠️ Внимание: Веб-интерфейс обновлён через OTA, но Java-движок APK устарел (Build #${data.bundledBuild} < Build #${data.latestBuild}). Нажмите «📦 Скачать и установить свежий APK» ниже!`;
        statusBadge.style.color = '#fbbf24';
      } else if (data.updateAvailable) {
        statusBadge.textContent = `🚀 В Git доступна новая версия v${data.latestVersion}${data.latestCommit ? ' (' + data.latestCommit + ')' : ''}! Нажмите кнопку ниже для обновления.`;
        statusBadge.style.color = '#34d399';
      } else {
        statusBadge.textContent = `✅ Приложение и APK-движок обновлены до последней версии из Git (${data.gitRepo}@${data.gitBranch})`;
        statusBadge.style.color = '#34d399';
      }
    }

    if (applyBtn) {
      applyBtn.textContent = data.updateAvailable
        ? `⚡ Обновить сейчас до v${data.latestVersion}${data.latestCommit ? ' (' + data.latestCommit + ')' : ''}`
        : `🔄 Переустановить / синхронизировать с Git (${data.gitBranch})`;
    }

    // Render Releases List
    const releasesContainer = document.getElementById('updatesReleasesList');
    if (releasesContainer) {
      const releases = data.releases || [];
      if (!releases.length) {
        releasesContainer.innerHTML = '<div class="card-hint">Список версий пуст.</div>';
      } else {
        releasesContainer.innerHTML = releases
          .map(rel => {
            const isCurrent = rel.version === data.currentVersion;
            const changelogItems = (rel.changelog || [])
              .map(line => `<li>${escapeHtml(line)}</li>`)
              .join('');
            const targetRef = rel.ref || data.gitBranch || 'main';
            return `
              <div class="release-item ${isCurrent ? 'current' : ''}">
                <div class="release-header">
                  <div>
                    <span class="release-ver-tag">v${escapeHtml(rel.version)}</span>
                    ${isCurrent ? '<span class="model-badge" style="margin-left:6px;background:rgba(16,185,129,0.2);color:#34d399;">Установлена</span>' : ''}
                  </div>
                  <span class="release-date">${escapeHtml(rel.date || '')} • Build #${rel.build || 1}</span>
                </div>
                <div class="release-title">${escapeHtml(rel.title || '')}</div>
                <ul class="release-changelog">${changelogItems}</ul>
                <div class="row-between">
                  <span style="font-size:11px;color:var(--text-secondary);">Ветка/тег: <code>${escapeHtml(targetRef)}</code></span>
                  <button class="btn-secondary btn-sm" onclick="window.appUI.applyGitUpdate('${escapeHtml(targetRef)}', '${escapeHtml(rel.version)}', '')">
                    ${isCurrent ? '🔄 Обновить файлы этой версии' : `⚡ Переключиться на v${escapeHtml(rel.version)}`}
                  </button>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    // Render Live Git Commits List
    const commitsContainer = document.getElementById('updatesCommitsList');
    if (commitsContainer) {
      const commits = data.commits || [];
      if (!commits.length) {
        commitsContainer.innerHTML = `
          <div class="card-hint">
            Коммиты из <code>${escapeHtml(data.gitRepo)}</code> пока не загружены или репозиторий пуст.
          </div>
        `;
      } else {
        commitsContainer.innerHTML = commits
          .map(c => {
            const isInstalledCommit = data.installedCommit && c.shortSha === data.installedCommit;
            const dateFormatted = c.date ? c.date.replace('T', ' ').replace('Z', '').slice(0, 16) : '';
            return `
              <div class="commit-item">
                <div class="commit-top">
                  <span class="commit-sha">${escapeHtml(c.shortSha)}</span>
                  <span class="release-date">${escapeHtml(dateFormatted)}</span>
                </div>
                <div class="commit-msg">${escapeHtml(c.message)}</div>
                <div class="commit-meta">
                  <span>👤 ${escapeHtml(c.author || 'Git')}</span>
                  <button class="btn-secondary btn-sm" onclick="window.appUI.applyGitUpdate('${escapeHtml(c.sha)}', '', '${escapeHtml(c.shortSha)}')">
                    ${isInstalledCommit ? '✅ Активный коммит' : '⚡ Установить этот коммит'}
                  </button>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  async function applyGitUpdate(targetRef = '', targetVersion = '', commitSha = '') {
    const applyBtn = document.getElementById('applyOtaUpdateBtn');
    const bannerBtn = document.getElementById('updateBannerApplyBtn');
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = '⏳ Загрузка файлов новой версии из Git...';
    }
    if (bannerBtn) {
      bannerBtn.disabled = true;
      bannerBtn.textContent = '⏳...';
    }

    showToast('⏳ Скачивание обновления из Git...');
    try {
      const gitRepo = (document.getElementById('inputGitRepo')?.value || state.updateInfo?.gitRepo || 'Kuka001/111').trim();
      const gitBranch = (document.getElementById('inputGitBranch')?.value || state.updateInfo?.gitBranch || 'main').trim();

      const res = await apiFetch('/api/updates/apply', {
        method: 'POST',
        body: JSON.stringify({
          gitRepo,
          gitBranch,
          ref: targetRef || gitBranch,
          version: targetVersion || '',
          commitSha: commitSha || '',
        }),
      });

      showToast(`✅ ${res.message || 'Обновление установлено!'} Перезапуск...`);
      setTimeout(() => {
        if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.reloadWebView === 'function') {
          window.AndroidServer.reloadWebView();
        } else {
          window.location.reload();
        }
      }, 650);
    } catch (err) {
      showToast('❌ Ошибка обновления из Git: ' + err.message);
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.textContent = '⚡ Обновить приложение из Git (OTA в 1 клик)';
      }
      if (bannerBtn) {
        bannerBtn.disabled = false;
        bannerBtn.textContent = '⚡ Обновить';
      }
    }
  }

  function downloadLatestApkFromGit() {
    const apkUrl =
      (state.updateInfo && state.updateInfo.apkDownloadUrl) ||
      'https://raw.githubusercontent.com/Kuka001/111/main/agy-roleplay-android16.apk';
    showToast('📦 Открытие скачивания свежего APK из Git...');
    if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.openExternalUrl === 'function') {
      window.AndroidServer.openExternalUrl(apkUrl);
    } else {
      window.open(apkUrl, '_blank');
    }
  }

  async function resetOtaUpdate() {
    try {
      await apiFetch('/api/updates/reset', { method: 'POST' });
      showToast('↩ Возврат к заводской версии APK...');
      setTimeout(() => {
        if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.reloadWebView === 'function') {
          window.AndroidServer.reloadWebView();
        } else {
          window.location.reload();
        }
      }, 500);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function saveGitRepoConfig() {
    const gitRepo = (document.getElementById('inputGitRepo')?.value || '').trim();
    const gitBranch = (document.getElementById('inputGitBranch')?.value || 'main').trim();
    if (!gitRepo) return showToast('Укажите Git-репозиторий (например, Kuka001/111)');
    try {
      await apiFetch('/api/updates/config', {
        method: 'POST',
        body: JSON.stringify({ gitRepo, gitBranch }),
      });
      updateBannerDismissed = false;
      showToast('💾 Репозиторий сохранён! Проверяем обновления...');
      await checkForUpdates(true);
    } catch (err) {
      showToast(err.message);
    }
  }

  function openGitRepoExternal() {
    const repoUrl =
      (state.updateInfo && state.updateInfo.repoWebUrl) ||
      'https://github.com/' + ((document.getElementById('inputGitRepo')?.value || 'Kuka001/111').trim());
    if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.openExternalUrl === 'function') {
      window.AndroidServer.openExternalUrl(repoUrl);
    } else {
      window.open(repoUrl, '_blank');
    }
  }

  function dismissUpdateBanner() {
    updateBannerDismissed = true;
    const banner = document.getElementById('updateBanner');
    if (banner) banner.classList.add('hidden');
  }

  // ==================== CHAT EXPORT (MARKDOWN & JSON) ====================
  const exportChatState = {
    chatId: null,
    format: 'markdown',
    chatData: null,
    geminiMd: '',
    characterMd: '',
    personaMd: '',
    memoryMd: '',
    lastGeneration: null,
    filename: 'chat_export.md',
  };

  window.__onNativeFileSaved = function (success) {
    if (success) {
      showToast('✅ Файл экспорта успешно сохранён на устройство!');
    }
  };

  function sanitizeFilenamePart(str) {
    return String(str || 'chat')
      .trim()
      .replace(/[^\w\u0400-\u04FF-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'chat';
  }

  async function fetchFileContentSafe(relPath) {
    if (!relPath) return '';
    try {
      const res = await apiFetch(`/api/files/content?path=${encodeURIComponent(relPath)}`);
      if (res && typeof res.content === 'string') return res.content;
    } catch {
      // Fallback below
    }
    try {
      const res2 = await apiFetch(`/api/files/file?path=${encodeURIComponent(relPath)}`);
      return (res2 && typeof res2.content === 'string') ? res2.content : '';
    } catch {
      return '';
    }
  }

  async function openExportChatModal(chatId = null) {
    const targetId = chatId || state.currentChatId;
    if (!targetId) {
      return showToast('Сначала откройте или выберите чат для экспорта');
    }

    exportChatState.chatId = targetId;
    const modalEl = document.getElementById('exportChatModal');
    if (modalEl) {
      modalEl.classList.remove('hidden');
    }

    const previewInput = document.getElementById('exportChatContentInput');
    const fileLabel = document.getElementById('exportFileNameLabel');
    const sizeBadge = document.getElementById('exportSizeBadge');

    updateExportFormatButtons();

    // Immediately show preview if we already have the active chat in memory
    if (Number(targetId) === Number(state.currentChatId) && state.currentChatData && state.currentChatData.chat) {
      exportChatState.chatData = state.currentChatData;
      exportChatState.lastGeneration = state.lastGeneration || null;
      rebuildExportPreview();
    } else {
      if (previewInput) previewInput.value = '⏳ Сборка истории чата, промтов и диагностики...';
      if (fileLabel) fileLabel.textContent = `chat_${targetId}...`;
      if (sizeBadge) sizeBadge.textContent = '...';
    }

    try {
      const chatData = await apiFetch(`/api/chats/${targetId}`);
      exportChatState.chatData = chatData;

      let genData = null;
      try {
        const genRes = await apiFetch(`/api/chats/${targetId}/generation`);
        if (genRes && genRes.generation) {
          genData = genRes.generation;
        }
      } catch {
        // ignore if endpoint not available on older runtime
      }
      if (!genData && Number(targetId) === Number(state.currentChatId) && state.lastGeneration) {
        genData = state.lastGeneration;
      }
      exportChatState.lastGeneration = genData;

      const charPath = chatData.character?.file_path || '';
      const personaPath = chatData.persona?.file_path || '';
      const memoryPath = chatData.memoryPath || `chats/chat_${targetId}/memory.md`;

      const [geminiMd, characterMd, personaMd, memoryMd] = await Promise.all([
        fetchFileContentSafe('GEMINI.md'),
        fetchFileContentSafe(charPath),
        fetchFileContentSafe(personaPath),
        fetchFileContentSafe(memoryPath),
      ]);

      exportChatState.geminiMd = geminiMd;
      exportChatState.characterMd = characterMd;
      exportChatState.personaMd = personaMd;
      exportChatState.memoryMd = memoryMd;

      rebuildExportPreview();
    } catch (err) {
      if (!exportChatState.chatData && previewInput) {
        previewInput.value = `❌ Ошибка загрузки чата #${targetId} для экспорта: ${err.message}`;
      }
      showToast('Ошибка подготовки экспорта: ' + err.message);
    }
  }

  function updateExportFormatButtons() {
    document.querySelectorAll('#exportFormatGroup .effort-btn').forEach(btn => {
      const fmt = btn.getAttribute('data-format');
      if (fmt) {
        btn.classList.toggle('active', fmt === exportChatState.format);
      }
    });
    const mdBtn = document.getElementById('exportFmtMdBtn');
    const jsonBtn = document.getElementById('exportFmtJsonBtn');
    if (mdBtn) mdBtn.classList.toggle('active', exportChatState.format === 'markdown');
    if (jsonBtn) jsonBtn.classList.toggle('active', exportChatState.format === 'json');
  }

  function setExportFormat(fmt) {
    exportChatState.format = fmt === 'json' ? 'json' : 'markdown';
    updateExportFormatButtons();
    rebuildExportPreview();
  }

  function rebuildExportPreview() {
    const data = exportChatState.chatData;
    if (!data || !data.chat) return;

    const includeThoughts = !!document.getElementById('exportOptThoughts')?.checked;
    const includePrompts = !!document.getElementById('exportOptPrompts')?.checked;
    const includeDiagnostics = !!document.getElementById('exportOptDiagnostics')?.checked;

    const { chat, character, persona, messages = [] } = data;
    const safeChar = sanitizeFilenamePart(character?.name || 'character');
    const ext = exportChatState.format === 'json' ? 'json' : 'md';
    const filename = `chat_${chat.id}_${safeChar}.${ext}`;
    exportChatState.filename = filename;

    let output = '';

    if (exportChatState.format === 'json') {
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: state.updateInfo?.currentVersion || '1.3.4',
        chat: {
          id: chat.id,
          title: chat.title,
          model_id: chat.model_id,
          model_label: getShortModelName(chat.model_id),
          effort: chat.effort || 'high',
          created_at: chat.created_at,
          updated_at: chat.updated_at,
        },
        character: {
          id: character?.id,
          name: character?.name,
          file_path: character?.file_path,
          description: character?.description,
          greeting: character?.greeting,
          scenario: character?.scenario,
        },
        persona: {
          id: persona?.id,
          name: persona?.name,
          file_path: persona?.file_path,
          description: persona?.description,
        },
      };

      if (includePrompts) {
        payload.systemPrompts = {
          'GEMINI.md': exportChatState.geminiMd || '',
          characterCardMarkdown: exportChatState.characterMd || '',
          personaCardMarkdown: exportChatState.personaMd || '',
          chatMemoryMarkdown: exportChatState.memoryMd || '',
        };
      }

      payload.messages = messages.map((m, idx) => {
        const swipes = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content || ''];
        const swipeIdx = Math.min(Math.max(0, m.swipe_index || 0), swipes.length - 1);
        const thoughtSwipes = Array.isArray(m.thought_swipes) ? m.thought_swipes : [];
        const activeThought = thoughtSwipes[swipeIdx] || m.thoughts || '';

        const msgObj = {
          index: idx + 1,
          id: m.id,
          role: m.role,
          author: m.role === 'user' ? (persona?.name || 'User') : (character?.name || 'Assistant'),
          created_at: m.created_at,
          content: swipes[swipeIdx] || m.content || '',
        };

        if (includeThoughts && activeThought) {
          msgObj.thoughts = activeThought;
        }
        if (includeDiagnostics && swipes.length > 1) {
          msgObj.swipe_index = swipeIdx;
          msgObj.swipes = swipes;
          if (includeThoughts && thoughtSwipes.length) {
            msgObj.thought_swipes = thoughtSwipes;
          }
        }
        return msgObj;
      });

      if (includeDiagnostics && exportChatState.lastGeneration) {
        payload.lastGenerationDiagnostics = exportChatState.lastGeneration;
      }

      output = JSON.stringify(payload, null, 2);
    } else {
      const lines = [];
      const nowStr = new Date().toLocaleString('ru-RU');
      lines.push(`# 🎭 Экспорт чата #${chat.id}: ${character?.name || 'Персонаж'} & ${persona?.name || 'Игрок'}`);
      lines.push('');
      lines.push(`- **Дата экспорта:** ${nowStr}`);
      lines.push(`- **Персонаж:** ${character?.name || '—'} (\`${character?.file_path || ''}\`)`);
      lines.push(`- **Персона игрока:** ${persona?.name || '—'} (\`${persona?.file_path || ''}\`)`);
      lines.push(`- **Модель AGY:** \`${chat.model_id}\` (${getShortModelName(chat.model_id)})`);
      lines.push(`- **Reasoning Effort:** \`${String(chat.effort || 'high').toUpperCase()}\``);
      lines.push(`- **Сообщений в чате:** ${messages.length}`);
      lines.push('');

      if (includePrompts) {
        lines.push('---');
        lines.push('## 📋 Системные промты и файлы контекста');
        lines.push('');
        lines.push('<details>');
        lines.push('<summary><b>1. GEMINI.md (Глобальные инструкции)</b></summary>');
        lines.push('');
        lines.push('```markdown');
        lines.push((exportChatState.geminiMd || '(пусто)').trim());
        lines.push('```');
        lines.push('</details>');
        lines.push('');

        lines.push('<details>');
        lines.push(`<summary><b>2. Карточка персонажа: ${character?.name || ''} (${character?.file_path || ''})</b></summary>`);
        lines.push('');
        lines.push('```markdown');
        lines.push((exportChatState.characterMd || character?.fileContent || character?.description || '(пусто)').trim());
        lines.push('```');
        lines.push('</details>');
        lines.push('');

        lines.push('<details>');
        lines.push(`<summary><b>3. Персона игрока: ${persona?.name || ''} (${persona?.file_path || ''})</b></summary>`);
        lines.push('');
        lines.push('```markdown');
        lines.push((exportChatState.personaMd || persona?.fileContent || persona?.description || '(пусто)').trim());
        lines.push('```');
        lines.push('</details>');
        lines.push('');

        if ((exportChatState.memoryMd || '').trim()) {
          lines.push('<details>');
          lines.push(`<summary><b>4. Память чата (${data.memoryPath || `chats/chat_${chat.id}/memory.md`})</b></summary>`);
          lines.push('');
          lines.push('```markdown');
          lines.push(exportChatState.memoryMd.trim());
          lines.push('```');
          lines.push('</details>');
          lines.push('');
        }
      }

      lines.push('---');
      lines.push(`## 💬 История диалога (${messages.length} сообщ.)`);
      lines.push('');

      messages.forEach((m, idx) => {
        const isUser = m.role === 'user';
        const authorLabel = isUser
          ? `👤 ${persona?.name || 'User'} (Игрок)`
          : `🎭 ${character?.name || 'Character'} (ИИ)`;
        const swipes = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.content || ''];
        const swipeIdx = Math.min(Math.max(0, m.swipe_index || 0), swipes.length - 1);
        const activeText = swipes[swipeIdx] || m.content || '';
        const thoughtSwipes = Array.isArray(m.thought_swipes) ? m.thought_swipes : [];
        const activeThought = (thoughtSwipes[swipeIdx] || m.thoughts || '').trim();

        lines.push(`### [#${idx + 1}] ${authorLabel}`);
        if (m.created_at) {
          lines.push(`*Время: ${m.created_at}${swipes.length > 1 ? ` • Выбран вариант ${swipeIdx + 1}/${swipes.length}` : ''}*`);
        }
        lines.push('');

        if (includeThoughts && activeThought) {
          lines.push('<details>');
          lines.push(`<summary>💭 Мысли модели (${activeThought.length} симв.)</summary>`);
          lines.push('');
          lines.push('```text');
          lines.push(activeThought);
          lines.push('```');
          lines.push('</details>');
          lines.push('');
        }

        lines.push(activeText || '*(пустое сообщение)*');
        lines.push('');

        if (includeDiagnostics && swipes.length > 1) {
          lines.push('<details>');
          lines.push(`<summary>🔄 Все варианты ответа (Swipes: ${swipes.length})</summary>`);
          lines.push('');
          swipes.forEach((swText, sIdx) => {
            lines.push(`#### Вариант ${sIdx + 1}/${swipes.length}${sIdx === swipeIdx ? ' (Активный)' : ''}`);
            const swThought = (thoughtSwipes[sIdx] || '').trim();
            if (includeThoughts && swThought) {
              lines.push(`> 💭 Мысли варианта ${sIdx + 1}: ${swThought.replace(/\n+/g, ' ')}`);
              lines.push('');
            }
            lines.push(swText || '*(пусто)*');
            lines.push('');
          });
          lines.push('</details>');
          lines.push('');
        }
      });

      if (includeDiagnostics && exportChatState.lastGeneration) {
        const gen = exportChatState.lastGeneration;
        lines.push('---');
        lines.push('## 📡 Диагностика последней генерации AGY');
        lines.push('');
        lines.push(`- **Статус:** \`${gen.status || 'unknown'}\``);
        lines.push(`- **Модель:** \`${gen.modelId || chat.model_id}\` (${gen.modelLabel || ''})`);
        lines.push(`- **Effort:** \`${gen.effort || chat.effort || 'high'}\``);
        lines.push(`- **HTTP статус:** \`${gen.httpStatus || 0}\``);
        const elapsedSecVal = gen.elapsedSec || (gen.elapsedMs ? (gen.elapsedMs / 1000).toFixed(1) : 0);
        lines.push(`- **Длительность:** ${elapsedSecVal} сек.`);
        if (gen.error) {
          lines.push(`- **Ошибка:** \`${gen.error}\``);
        }
        lines.push('');
        if (Array.isArray(gen.logs) && gen.logs.length) {
          lines.push('### Журнал выполнения по шагам:');
          lines.push('```text');
          gen.logs.forEach(l => {
            if (typeof l === 'string') {
              lines.push(l);
            } else {
              lines.push(`[+${l.t || '0.0'}s] [${l.level || 'info'}] ${l.text || l.message || ''}`);
            }
          });
          lines.push('```');
          lines.push('');
        }
      }

      output = lines.join('\n');
    }

    const previewInput = document.getElementById('exportChatContentInput');
    const fileLabel = document.getElementById('exportFileNameLabel');
    const sizeBadge = document.getElementById('exportSizeBadge');

    if (previewInput) previewInput.value = output;
    if (fileLabel) fileLabel.textContent = `exports/${filename}`;
    if (sizeBadge) {
      const kb = (new Blob([output]).size / 1024).toFixed(1);
      const lineCount = output.split('\n').length;
      sizeBadge.textContent = `${kb} KB • ${lineCount} строк`;
    }
  }

  async function saveExportToWorkspaceSilently(filename, content) {
    try {
      await apiFetch('/api/files/file', {
        method: 'POST',
        body: JSON.stringify({
          path: `exports/${filename}`,
          content,
        }),
      });
      loadFiles(state.currentFilesPath);
      return `exports/${filename}`;
    } catch {
      return null;
    }
  }

  async function copyExportedChat() {
    const previewInput = document.getElementById('exportChatContentInput');
    const text = previewInput ? previewInput.value : '';
    if (!text) return showToast('Нет данных для копирования');

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        showToast('📋 Экспорт чата скопирован в буфер обмена!');
        return;
      }
    } catch {
      // Fallback below
    }

    try {
      if (previewInput) {
        previewInput.focus();
        previewInput.select();
        document.execCommand('copy');
        showToast('📋 Экспорт чата скопирован в буфер обмена!');
      }
    } catch (err) {
      showToast('Не удалось скопировать: ' + err.message);
    }
  }

  async function shareExportedChat() {
    const previewInput = document.getElementById('exportChatContentInput');
    const text = previewInput ? previewInput.value : '';
    const filename = exportChatState.filename || 'chat_export.md';
    if (!text) return showToast('Нет данных для отправки');

    await saveExportToWorkspaceSilently(filename, text);

    if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.shareExportText === 'function') {
      window.AndroidServer.shareExportText(filename, text);
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: filename,
          text,
        });
        return;
      } catch {
        // User cancelled or share failed
      }
    }

    await copyExportedChat();
  }

  async function downloadExportedChat() {
    const previewInput = document.getElementById('exportChatContentInput');
    const text = previewInput ? previewInput.value : '';
    const filename = exportChatState.filename || 'chat_export.md';
    if (!text) return showToast('Нет данных для сохранения');

    const savedWorkspacePath = await saveExportToWorkspaceSilently(filename, text);
    const mimeType = exportChatState.format === 'json' ? 'application/json' : 'text/markdown';

    if (typeof window.AndroidServer !== 'undefined' && typeof window.AndroidServer.saveExportFile === 'function') {
      window.AndroidServer.saveExportFile(filename, text, mimeType);
      if (savedWorkspacePath) {
        showToast(`💾 Также сохранено в 📁 Файлы → ${savedWorkspacePath}`);
      }
      return;
    }

    try {
      const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 300);
    } catch {
      // ignore if WebView blocks blob download
    }

    await copyExportedChat();
    if (savedWorkspacePath) {
      showToast(`✅ Сохранено в 📁 Файлы → ${savedWorkspacePath} (и скопировано в буфер!)`);
    } else {
      showToast('💾 Экспорт скопирован в буфер обмена!');
    }
  }

  // ==================== POPUP IMAGE VIEWER (2-FINGER PINCH-TO-ZOOM & PAN) ====================
  const viewerState = {
    scale: 1,
    tx: 0,
    ty: 0,
    mode: null,
    startDist: 0,
    startScale: 1,
    startMidX: 0,
    startMidY: 0,
    startTx: 0,
    startTy: 0,
    panStartX: 0,
    panStartY: 0,
    lastTapTime: 0,
    moved: false,
  };

  function applyViewerTransform(animate = false) {
    const img = document.getElementById('imageViewerImg');
    const badge = document.getElementById('imageViewerZoomBadge');
    if (img) {
      img.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
      img.style.transform = `translate3d(${viewerState.tx}px, ${viewerState.ty}px, 0) scale(${viewerState.scale})`;
    }
    if (badge) {
      badge.textContent = `${Math.round(viewerState.scale * 100)}%`;
    }
  }

  function resetAvatarZoom(animate = true) {
    viewerState.scale = 1;
    viewerState.tx = 0;
    viewerState.ty = 0;
    viewerState.mode = null;
    applyViewerTransform(animate);
  }

  function openAvatarViewer(src, title = 'Изображение персонажа') {
    const modal = document.getElementById('imageViewerModal');
    const img = document.getElementById('imageViewerImg');
    const titleEl = document.getElementById('imageViewerTitle');
    if (!modal || !img) return;

    const resolvedSrc = src ? resolveAvatarUrl(src) : FALLBACK_AVATAR;
    img.src = resolvedSrc;
    if (titleEl) {
      titleEl.textContent = title || 'Изображение';
    }
    resetAvatarZoom(false);
    modal.classList.remove('hidden');
  }

  function closeAvatarViewer() {
    const modal = document.getElementById('imageViewerModal');
    if (modal) {
      modal.classList.add('hidden');
    }
    resetAvatarZoom(false);
  }

  function initImageViewerGestures() {
    const stage = document.getElementById('imageViewerStage');
    const img = document.getElementById('imageViewerImg');
    if (!stage || !img) return;

    function getTouchDistance(t0, t1) {
      return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    }

    function getTouchMidpoint(t0, t1) {
      return {
        x: (t0.clientX + t1.clientX) / 2,
        y: (t0.clientY + t1.clientY) / 2,
      };
    }

    stage.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          viewerState.mode = 'pinch';
          viewerState.moved = true;
          viewerState.startDist = Math.max(getTouchDistance(e.touches[0], e.touches[1]), 10);
          viewerState.startScale = viewerState.scale;
          const mid = getTouchMidpoint(e.touches[0], e.touches[1]);
          viewerState.startMidX = mid.x;
          viewerState.startMidY = mid.y;
          viewerState.startTx = viewerState.tx;
          viewerState.startTy = viewerState.ty;
        } else if (e.touches.length === 1) {
          viewerState.mode = 'pan';
          viewerState.moved = false;
          viewerState.panStartX = e.touches[0].clientX;
          viewerState.panStartY = e.touches[0].clientY;
          viewerState.startTx = viewerState.tx;
          viewerState.startTy = viewerState.ty;
        }
      },
      { passive: false }
    );

    stage.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          if (viewerState.mode !== 'pinch') {
            viewerState.mode = 'pinch';
            viewerState.startDist = Math.max(getTouchDistance(e.touches[0], e.touches[1]), 10);
            viewerState.startScale = viewerState.scale;
            const midInit = getTouchMidpoint(e.touches[0], e.touches[1]);
            viewerState.startMidX = midInit.x;
            viewerState.startMidY = midInit.y;
            viewerState.startTx = viewerState.tx;
            viewerState.startTy = viewerState.ty;
          }
          const curDist = Math.max(getTouchDistance(e.touches[0], e.touches[1]), 10);
          const ratio = curDist / viewerState.startDist;
          const nextScale = Math.min(Math.max(viewerState.startScale * ratio, 0.5), 6);

          const rect = stage.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const mid = getTouchMidpoint(e.touches[0], e.touches[1]);

          const scaleRatio = nextScale / viewerState.startScale;
          const focalOffsetX = viewerState.startMidX - centerX;
          const focalOffsetY = viewerState.startMidY - centerY;
          const panDx = mid.x - viewerState.startMidX;
          const panDy = mid.y - viewerState.startMidY;

          viewerState.scale = nextScale;
          viewerState.tx = focalOffsetX - (focalOffsetX - viewerState.startTx) * scaleRatio + panDx;
          viewerState.ty = focalOffsetY - (focalOffsetY - viewerState.startTy) * scaleRatio + panDy;
          viewerState.moved = true;
          applyViewerTransform(false);
        } else if (e.touches.length === 1 && viewerState.mode === 'pan') {
          const dx = e.touches[0].clientX - viewerState.panStartX;
          const dy = e.touches[0].clientY - viewerState.panStartY;
          if (Math.hypot(dx, dy) > 6) {
            viewerState.moved = true;
          }
          if (viewerState.moved) {
            e.preventDefault();
            viewerState.tx = viewerState.startTx + dx;
            viewerState.ty = viewerState.startTy + dy;
            applyViewerTransform(false);
          }
        }
      },
      { passive: false }
    );

    stage.addEventListener(
      'touchend',
      (e) => {
        if (e.touches.length === 1) {
          // Smooth transition from 2-finger pinch to 1-finger drag without jump
          viewerState.mode = 'pan';
          viewerState.panStartX = e.touches[0].clientX;
          viewerState.panStartY = e.touches[0].clientY;
          viewerState.startTx = viewerState.tx;
          viewerState.startTy = viewerState.ty;
          return;
        }

        if (e.touches.length === 0) {
          const wasMoved = viewerState.moved;
          viewerState.mode = null;

          // Snap back gently if zoomed out below 1x and user released fingers
          if (viewerState.scale < 0.85) {
            resetAvatarZoom(true);
            return;
          }

          if (!wasMoved && e.changedTouches && e.changedTouches.length === 1) {
            const now = Date.now();
            const tapTouch = e.changedTouches[0];
            if (now - viewerState.lastTapTime < 280) {
              // Double-tap toggles 1x <-> 2.5x zoom around tap point
              viewerState.lastTapTime = 0;
              if (viewerState.scale > 1.2) {
                resetAvatarZoom(true);
              } else {
                const rect = stage.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const targetScale = 2.5;
                viewerState.tx = (cx - tapTouch.clientX) * (targetScale - 1) * 0.6;
                viewerState.ty = (cy - tapTouch.clientY) * (targetScale - 1) * 0.6;
                viewerState.scale = targetScale;
                applyViewerTransform(true);
              }
            } else {
              viewerState.lastTapTime = now;
              // Close if user tapped outside the image on dark backdrop while at 1x zoom
              if (e.target === stage && viewerState.scale <= 1.05) {
                setTimeout(() => {
                  if (viewerState.lastTapTime === now) {
                    closeAvatarViewer();
                  }
                }, 260);
              }
            }
          }
        }
      },
      { passive: false }
    );

    // Desktop / mouse wheel zoom support
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        const nextScale = Math.min(Math.max(viewerState.scale * factor, 0.5), 6);
        viewerState.scale = nextScale;
        if (nextScale <= 1.02) {
          viewerState.tx = 0;
          viewerState.ty = 0;
        }
        applyViewerTransform(false);
      },
      { passive: false }
    );
  }

  // Handle adaptive chat input, keyboard auto-hide, and scroll auto-hide on Chats tab
  document.addEventListener('DOMContentLoaded', () => {
    initImageViewerGestures();
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 700) {
          e.preventDefault();
          sendMessage();
        }
      });
      chatInput.addEventListener('input', () => {
        autoResizeChatInput();
        state.isKeyboardOpen = true;
        setBottomNavHidden(true);
      });
      chatInput.addEventListener('focus', () => {
        autoResizeChatInput();
        state.isKeyboardOpen = true;
        setBottomNavHidden(true);
      });
      chatInput.addEventListener('click', () => {
        state.isKeyboardOpen = true;
        setBottomNavHidden(true);
      });
      chatInput.addEventListener('blur', () => {
        setTimeout(() => {
          if (document.activeElement !== chatInput) {
            state.isKeyboardOpen = false;
            setBottomNavHidden(false);
          }
        }, 160);
      });
    }

    window.onAndroidKeyboardVisibilityChanged = (kbOpen) => {
      state.isKeyboardOpen = !!kbOpen;
      const isChatsTab = document.getElementById('tab-chats')?.classList.contains('active');
      if (isChatsTab) {
        setBottomNavHidden(!!kbOpen);
      }
    };

    if (window.visualViewport) {
      let baseHeight = window.visualViewport.height || window.innerHeight;
      window.visualViewport.addEventListener('resize', () => {
        const curH = window.visualViewport.height;
        if (curH > baseHeight) baseHeight = curH;
        const isChatsTab = document.getElementById('tab-chats')?.classList.contains('active');
        const kbActive = (baseHeight - curH) > 110;
        state.isKeyboardOpen = kbActive;
        if (isChatsTab) {
          setBottomNavHidden(kbActive);
        }
      });
    }

    function attachChatsScrollAutoHide(el) {
      if (!el) return;
      let lastScrollY = el.scrollTop || 0;
      let touchStartY = null;

      el.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length === 1) {
          touchStartY = e.touches[0].clientY;
        }
      }, { passive: true });

      el.addEventListener('touchmove', (e) => {
        if (touchStartY === null || !e.touches || e.touches.length !== 1) return;
        const isChatsTab = document.getElementById('tab-chats')?.classList.contains('active');
        if (!isChatsTab) return;
        const dy = touchStartY - e.touches[0].clientY; // dy > 0 means finger moves up -> scrolling down
        if (dy > 18) {
          setBottomNavHidden(true);
          touchStartY = e.touches[0].clientY;
        } else if (dy < -18 && !state.isKeyboardOpen) {
          setBottomNavHidden(false);
          touchStartY = e.touches[0].clientY;
        }
      }, { passive: true });

      el.addEventListener('scroll', () => {
        const isChatsTab = document.getElementById('tab-chats')?.classList.contains('active');
        if (!isChatsTab) return;
        const curY = el.scrollTop;
        if (state.ignoreScrollEvents || Date.now() < navTransitionUntil) {
          lastScrollY = curY;
          return;
        }
        const delta = curY - lastScrollY;
        if (curY <= 12 && !state.isKeyboardOpen) {
          setBottomNavHidden(false);
        } else if (delta > 8 && curY > 24) {
          setBottomNavHidden(true);
        } else if (delta < -8 && !state.isKeyboardOpen) {
          setBottomNavHidden(false);
        }
        lastScrollY = curY;
      }, { passive: true });
    }

    attachChatsScrollAutoHide(document.getElementById('chatMessagesContainer'));
    attachChatsScrollAutoHide(document.getElementById('chatsListView'));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkAgyAuthStatus();
      }
    });
    initApp();
  });

  // Expose public UI methods
  window.appUI = {
    openTab,
    openModelModal,
    openModal,
    closeModal,
    openNewChatModal,
    onNewChatCharacterChange,
    confirmCreateChat,
    toggleChatGroup,
    openChatRoom,
    closeChatRoom,
    openAvatarViewer,
    closeAvatarViewer,
    resetAvatarZoom,
    openExportChatModal,
    setExportFormat,
    rebuildExportPreview,
    copyExportedChat,
    shareExportedChat,
    downloadExportedChat,
    toggleStreamingDetails,
    closeStreamingBox,
    sendMessage,
    insertAsterisks,
    swipeMessage,
    regenerateMessage,
    openEditMessageModal,
    saveEditedMessage,
    deleteMessage,
    deleteChat,
    switchCharSubtab,
    openCharacterEditor,
    editCurrentChatCharacter,
    handleAvatarUpload,
    updateAvatarPreview,
    saveCharacterFromModal,
    deleteCharacterFromModal,
    openPersonaEditor,
    savePersonaFromModal,
    deletePersonaFromModal,
    activatePersona,
    openPersonaQuickModal,
    loadFiles,
    promptCreateFolder,
    promptCreateFile,
    openFileEditor,
    openChatMemoryFile,
    saveFileFromModal,
    deleteFileFromModal,
    deleteWorkspaceItem,
    selectModel,
    setEffort,
    refreshModels,
    startAgyOAuth,
    exchangeAgyOAuthCode,
    logoutAgyOAuth,
    saveSettings,
    applyServerUrl,
    checkForUpdates,
    applyGitUpdate,
    downloadLatestApkFromGit,
    resetOtaUpdate,
    saveGitRepoConfig,
    openGitRepoExternal,
    dismissUpdateBanner,
  };
})();

