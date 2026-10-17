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
        entry.reject(new Error(data.error || `Ошибка встроенного сервера (${status})`));
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
    selectedModel: 'gemini-4-argon',
    selectedEffort: 'high',
    contextMessagesLimit: 30,
    activePersonaId: 1,
    models: [],
    characters: [],
    personas: [],
    chats: [],
    currentChatId: null,
    currentChatData: null,
    currentFilesPath: '',
    pollTimer: null,
    isSending: false,
  };

  const FALLBACK_AVATAR =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="#1e1b4b"/><circle cx="60" cy="46" r="22" fill="#a78bfa"/><path d="M22 110 C26 76, 94 76, 98 110 Z" fill="#7c3aed"/></svg>'
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
      throw new Error(data.error || `Ошибка сервера (${res.status})`);
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

  /**
   * Format Roleplay text: highlight *actions in italics* and preserve paragraphs
   */
  function formatRoleplayHtml(rawText) {
    const escaped = escapeHtml(rawText || '');
    const withActions = escaped.replace(/\*([^*]+)\*/g, '<span class="rp-action">*$1*</span>');
    const paragraphs = withActions
      .split(/\n{2,}/)
      .map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
      .join('');
    return paragraphs || `<p>${withActions}</p>`;
  }

  function getShortModelName(modelId) {
    const cleanId = String(modelId || 'gemini-4-argon').replace(/-(low|medium|high|max)$/i, '');
    const found = state.models.find(m => m.id === cleanId || m.id === modelId);
    if (found) return found.name;
    return cleanId || 'Gemini 4 Argon';
  }

  function updateHeaderIndicators(online = true) {
    const dot = document.getElementById('connStatusDot');
    const projBadge = document.getElementById('headerProjectBadge');
    const modelLabel = document.getElementById('headerModelBtn')
      ? document.getElementById('headerModelLabel')
      : null;

    if (dot) {
      dot.classList.toggle('offline', !online);
    }
    if (projBadge) {
      projBadge.textContent = online ? `ID: ${state.projectId}` : 'Автономный режим APK';
    }
    if (modelLabel) {
      const activeChatModel = state.currentChatData && state.currentChatData.chat
        ? state.currentChatData.chat.model_id
        : state.selectedModel;
      const activeEffort = state.currentChatData && state.currentChatData.chat
        ? state.currentChatData.chat.effort
        : state.selectedEffort;
      modelLabel.textContent = `${getShortModelName(activeChatModel)} • ${String(activeEffort).toUpperCase()}`;
    }

    const activePersona = state.personas.find(p => p.id === Number(state.activePersonaId)) || state.personas[0];
    const banner = document.getElementById('activePersonaBanner');
    if (banner && activePersona) {
      banner.textContent = `👤 Активная персона: ${activePersona.name} (${activePersona.file_path})`;
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
      state.selectedModel = settingsData.selectedModel || state.selectedModel;
      state.selectedEffort = settingsData.selectedEffort || state.selectedEffort;
      state.activePersonaId = settingsData.activePersonaId || state.activePersonaId;
      state.contextMessagesLimit = settingsData.contextMessagesLimit || 30;

      state.models = modelsData.models || [];
      state.characters = charsData.characters || [];
      state.personas = personasData.personas || [];
      state.chats = chatsData.chats || [];

      document.getElementById('inputProjectId').value = state.projectId;
      document.getElementById('inputContextLimit').value = state.contextMessagesLimit;
      const cloudKeyEl = document.getElementById('inputCloudKey');
      if (cloudKeyEl) {
        cloudKeyEl.value = settingsData.geminiApiKey || settingsData.googleAuthToken || '';
      }

      const connBadge = document.getElementById('serverConnectionStatus');
      if (connBadge) {
        const isEmbedded = typeof window.AndroidServer !== 'undefined' || settingsData.embeddedServer;
        connBadge.textContent = isEmbedded
          ? `✅ Встроенный сервер внутри APK активен на смартфоне • БД SQLite + workspace/ • Моделей: ${state.models.length}`
          : `✅ Локальный сервер активен • Моделей: ${state.models.length}`;
        connBadge.style.color = '#34d399';
      }

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
        connBadge.style.color = '#f87171';
      }
    }
  }

  // ==========================================================================
  // CHATS LIST & ACTIVE CHAT ROOM
  // ==========================================================================
  async function loadChatsList() {
    const data = await apiFetch('/api/chats');
    state.chats = data.chats || [];
    renderChatsList();
  }

  function renderChatsList() {
    const container = document.getElementById('chatsListContainer');
    if (!container) return;

    if (!state.chats.length) {
      container.innerHTML = `
        <div class="settings-card" style="text-align:center;padding:24px 16px;">
          <div style="font-size:34px;margin-bottom:8px;">🎭</div>
          <div class="card-title">Пока нет активных ролевых чатов</div>
          <p class="card-hint">Выберите персонажа и свою персону, чтобы начать приключение с участием ИИ AGY.</p>
          <button class="btn-primary" onclick="window.appUI.openNewChatModal()">+ Начать первый чат</button>
        </div>
      `;
      return;
    }

    container.innerHTML = state.chats
      .map(c => {
        const preview = (c.last_message || '').replace(/\n+/g, ' ').slice(0, 95);
        const effLabel = String(c.effort || 'high').toUpperCase();
        return `
          <div class="chat-card" onclick="window.appUI.openChatRoom(${c.id})">
            <img class="chat-card-avatar" src="${escapeHtml(resolveAvatarUrl(c.character_avatar))}" alt="" />
            <div class="chat-card-body">
              <div class="chat-card-title">
                <span>${escapeHtml(c.character_name)}</span>
                <button class="toolbar-btn" onclick="event.stopPropagation(); window.appUI.deleteChat(${c.id})" title="Удалить чат">🗑</button>
              </div>
              <div class="chat-card-preview">${escapeHtml(preview || 'Начало истории...')}</div>
              <div class="chat-card-meta">
                <span>👤 ${escapeHtml(c.persona_name)}</span>
                <span>•</span>
                <span>🤖 ${escapeHtml(getShortModelName(c.model_id))} (${escapeHtml(effLabel)})</span>
                <span>•</span>
                <span>💬 ${c.message_count || 1}</span>
              </div>
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

      document.getElementById('chatsListView').classList.add('hidden');
      document.getElementById('chatRoomView').classList.remove('hidden');

      renderActiveChatRoom();
      updateHeaderIndicators(true);
    } catch (err) {
      showToast(err.message);
    }
  }

  function closeChatRoom() {
    stopGenerationPolling();
    state.currentChatId = null;
    state.currentChatData = null;
    document.getElementById('chatRoomView').classList.add('hidden');
    document.getElementById('chatsListView').classList.remove('hidden');
    updateHeaderIndicators(true);
    loadChatsList();
  }

  function renderActiveChatRoom() {
    if (!state.currentChatData) return;
    const { chat, character, persona, messages } = state.currentChatData;

    document.getElementById('chatHeaderAvatar').src = resolveAvatarUrl(character.avatar_url);
    document.getElementById('chatHeaderCharName').textContent = character.name;
    document.getElementById('chatHeaderSub').textContent = `Файл: ${character.file_path} • ${getShortModelName(chat.model_id)} (${String(chat.effort || 'high').toUpperCase()})`;
    document.getElementById('chatPersonaChip').textContent = `👤 ${persona.name}`;

    const msgContainer = document.getElementById('chatMessagesContainer');
    msgContainer.innerHTML = (messages || [])
      .map((m, idx) => {
        const isUser = m.role === 'user';
        const senderName = isUser ? persona.name : character.name;
        const avatar = resolveAvatarUrl(isUser ? persona.avatar_url : character.avatar_url);
        const swipesCount = Array.isArray(m.swipes) ? m.swipes.length : 1;
        const curSwipe = (m.swipe_index || 0) + 1;

        const thoughtsBlock = m.thoughts
          ? `<details class="msg-thoughts-details">
               <summary>💭 Показать мысли персонажа</summary>
               <div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(m.thoughts)}</div>
             </details>`
          : '';

        const swipeControls = !isUser
          ? `<div class="swipe-controls">
               ${
                 swipesCount > 1
                   ? `<button class="toolbar-btn" onclick="window.appUI.swipeMessage(${m.id}, ${(m.swipe_index || 0) - 1})" ${m.swipe_index <= 0 ? 'disabled' : ''}>◀</button>
                      <span>${curSwipe} / ${swipesCount}</span>
                      <button class="toolbar-btn" onclick="window.appUI.swipeMessage(${m.id}, ${(m.swipe_index || 0) + 1})" ${m.swipe_index >= swipesCount - 1 ? 'disabled' : ''}>▶</button>`
                   : `<span>${ idx === 0 ? 'Приветствие' : 'Ответ ИИ' }</span>`
               }
               ${
                 idx > 0
                   ? `<button class="toolbar-btn" onclick="window.appUI.regenerateMessage(${m.id})" title="Сгенерировать новый вариант ответа">🔄 Реролл</button>`
                   : ''
               }
             </div>`
          : `<div><span>Реплика игрока</span></div>`;

        return `
          <div class="msg-row ${isUser ? 'user' : 'assistant'}">
            <img class="msg-avatar" src="${escapeHtml(avatar)}" alt="" />
            <div class="msg-bubble">
              <div class="msg-sender">
                <span>${escapeHtml(senderName)}</span>
              </div>
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

    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function startGenerationPolling(chatId) {
    stopGenerationPolling();
    const box = document.getElementById('chatStreamingBox');
    const statusText = document.getElementById('streamingStatusText');
    const thoughtsBox = document.getElementById('streamingThoughtsPreview');
    const textBox = document.getElementById('streamingTextPreview');

    box.classList.remove('hidden');
    statusText.textContent = '🚀 Запуск AGY под капотом...';
    thoughtsBox.classList.add('hidden');
    thoughtsBox.textContent = '';
    textBox.textContent = '';

    state.pollTimer = setInterval(async () => {
      try {
        const data = await apiFetch(`/api/chats/${chatId}/generation`);
        if (data.active && data.generation) {
          const g = data.generation;
          statusText.textContent = g.statusText || 'Персонаж обдумывает ответ...';
          if (g.thoughts) {
            thoughtsBox.classList.remove('hidden');
            thoughtsBox.textContent = '💭 ' + g.thoughts.slice(-260);
          }
          if (g.text) {
            textBox.textContent = g.text;
          }
        }
      } catch (e) {}
    }, 650);
  }

  function stopGenerationPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const box = document.getElementById('chatStreamingBox');
    if (box) box.classList.add('hidden');
  }

  async function sendMessage() {
    if (state.isSending || !state.currentChatId) return;
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    state.isSending = true;
    document.getElementById('sendMsgBtn').disabled = true;
    input.value = '';

    // Optimistically append user message to UI
    if (state.currentChatData && Array.isArray(state.currentChatData.messages)) {
      state.currentChatData.messages.push({
        id: Date.now(),
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
      stopGenerationPolling();
      if (state.currentChatData && state.currentChatId === chatId) {
        state.currentChatData.messages = res.messages;
        renderActiveChatRoom();
      }
    } catch (err) {
      stopGenerationPolling();
      showToast('Ошибка генерации AGY: ' + err.message);
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
      stopGenerationPolling();
      if (state.currentChatData) {
        const idx = state.currentChatData.messages.findIndex(m => m.id === msgId);
        if (idx !== -1) {
          state.currentChatData.messages[idx] = res.message;
          renderActiveChatRoom();
        }
      }
      showToast('✨ Сгенерирован новый вариант ответа!');
    } catch (err) {
      stopGenerationPolling();
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
      showToast('Сначала создайте хотя бы одного персонажа');
      openTab('characters');
      return;
    }

    const charSel = document.getElementById('newChatCharSelect');
    charSel.innerHTML = state.characters
      .map(c => `<option value="${c.id}" ${c.id === preselectedCharId ? 'selected' : ''}>🎭 ${escapeHtml(c.name)} (${escapeHtml(c.file_path)})</option>`)
      .join('');

    const personaSel = document.getElementById('newChatPersonaSelect');
    personaSel.innerHTML = state.personas
      .map(p => `<option value="${p.id}" ${p.id === Number(state.activePersonaId) ? 'selected' : ''}>👤 ${escapeHtml(p.name)} (${escapeHtml(p.file_path)})</option>`)
      .join('');

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
    if (char) {
      document.getElementById('newChatGreetingInput').value = char.first_message || '';
    }
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
      charGrid.innerHTML = state.characters
        .map(c => `
          <div class="char-card">
            <img class="char-card-img" src="${escapeHtml(resolveAvatarUrl(c.avatar_url))}" alt="${escapeHtml(c.name)}" />
            <div class="char-card-body">
              <div class="char-card-name">${escapeHtml(c.name)}</div>
              <div class="char-card-file">📄 ${escapeHtml(c.file_path)}</div>
              <div class="char-card-greeting">${escapeHtml(c.first_message || c.description_preview)}</div>
              <div class="char-card-actions">
                <button class="btn-primary btn-sm" style="flex:1;" onclick="window.appUI.openNewChatModal(${c.id})">💬 Чат</button>
                <button class="btn-secondary btn-sm" onclick="window.appUI.openCharacterEditor(${c.id})">✏️</button>
              </div>
            </div>
          </div>
        `)
        .join('');
    }

    const personasList = document.getElementById('personasList');
    if (personasList) {
      personasList.innerHTML = state.personas
        .map(p => {
          const isActive = p.id === Number(state.activePersonaId);
          return `
            <div class="chat-card" style="${isActive ? 'border-color:#a78bfa;' : ''}">
              <img class="chat-card-avatar" src="${escapeHtml(resolveAvatarUrl(p.avatar_url))}" alt="" />
              <div class="chat-card-body">
                <div class="chat-card-title">
                  <span>${escapeHtml(p.name)} ${isActive ? '✅' : ''}</span>
                  <div class="row-gap-sm">
                    ${
                      !isActive
                        ? `<button class="btn-primary btn-sm" onclick="window.appUI.activatePersona(${p.id})">Выбрать</button>`
                        : `<span class="model-badge">Активна</span>`
                    }
                    <button class="btn-secondary btn-sm" onclick="window.appUI.openPersonaEditor(${p.id})">✏️</button>
                  </div>
                </div>
                <div class="chat-card-preview">${escapeHtml(p.description_preview)}</div>
                <div class="chat-card-meta">📄 Файл: ${escapeHtml(p.file_path)}</div>
              </div>
            </div>
          `;
        })
        .join('');
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
    document.getElementById('charFirstMessageInput').value = char
      ? (char.first_message || '')
      : `*Смотрит на {{user}} с лёгким интересом.*\n\n— Здравствуй, {{user}}!`;
    document.getElementById('charFileContentInput').value = char
      ? (char.fileContent || char.description_preview || '')
      : '';
    document.getElementById('charDeleteBtn').classList.toggle('hidden', !char);
    document.getElementById('characterModal').classList.remove('hidden');
  }

  function editCurrentChatCharacter() {
    if (state.currentChatData && state.currentChatData.character) {
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
    document.getElementById('personaDeleteBtn').classList.toggle('hidden', !p || state.personas.length <= 1);
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
      updateHeaderIndicators(true);
      closeModal('modelPickerModal');
      showToast(`Выбрана модель: ${getShortModelName(modelId)}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function setEffort(effort) {
    try {
      state.selectedEffort = effort;
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
        }
      }

      updateEffortButtons();
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

  async function saveSettings() {
    const projectId = document.getElementById('inputProjectId').value.trim();
    const contextMessagesLimit = Number(document.getElementById('inputContextLimit').value || 30);
    const cloudKeyEl = document.getElementById('inputCloudKey');
    const cloudVal = cloudKeyEl ? cloudKeyEl.value.trim() : '';
    if (!projectId) return showToast('Введите Project ID');

    const payload = {
      projectId,
      contextMessagesLimit,
      geminiApiKey: cloudVal.startsWith('AIza') ? cloudVal : '',
      googleAuthToken: !cloudVal.startsWith('AIza') ? cloudVal : '',
    };

    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.projectId = res.projectId;
      state.contextMessagesLimit = res.contextMessagesLimit;
      updateHeaderIndicators(true);
      showToast(`✅ Настройки сохранены в БД APK! Project ID: ${state.projectId}`);
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

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  function openTab(tabName) {
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    });
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    if (tabName === 'updates') {
      checkForUpdates(false);
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

      if (data.updateAvailable) {
        if (navBadge) navBadge.classList.remove('hidden');
        if (banner && !updateBannerDismissed) {
          const titleEl = document.getElementById('updateBannerTitle');
          const subEl = document.getElementById('updateBannerSub');
          if (titleEl) {
            titleEl.textContent = `🚀 Доступна новая версия в Git: v${data.latestVersion}${data.latestCommit ? ' (' + data.latestCommit + ')' : ''}`;
          }
          if (subEl) {
            subEl.textContent = data.latestReleaseTitle || data.latestCommitMessage || `Текущая: v${data.currentVersion} → Новая: v${data.latestVersion}`;
          }
          banner.classList.remove('hidden');
        }
        if (manualTrigger) {
          showToast(`🚀 Найдено обновление в Git: v${data.latestVersion}!`);
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

    if (curVerEl) curVerEl.textContent = `v${data.currentVersion || '1.2.0'}`;
    if (curMetaEl) {
      const modeStr = data.otaActive ? '⚡ OTA из Git' : '📦 Базовая APK';
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
      } else if (data.updateAvailable) {
        statusBadge.textContent = `🚀 В Git доступна новая версия v${data.latestVersion}${data.latestCommit ? ' (' + data.latestCommit + ')' : ''}! Нажмите кнопку ниже для обновления.`;
        statusBadge.style.color = '#34d399';
      } else {
        statusBadge.textContent = `✅ Приложение обновлено до последней версии из Git (${data.gitRepo}@${data.gitBranch})`;
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

  // Handle Enter key in chat textarea (Ctrl+Enter or Enter on desktop)
  document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 700) {
          e.preventDefault();
          sendMessage();
        }
      });
    }
    initApp();
  });

  // Expose public UI methods
  window.appUI = {
    openTab,
    openModelModal,
    closeModal,
    openNewChatModal,
    onNewChatCharacterChange,
    confirmCreateChat,
    openChatRoom,
    closeChatRoom,
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
