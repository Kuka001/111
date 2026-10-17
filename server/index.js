const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const QRCode = require('qrcode');

const {
  db,
  WORKSPACE_DIR,
  UPLOADS_DIR,
  getSetting,
  setSetting,
  syncWorkspaceWithDb,
  parseRoleplayMarkdown,
  buildCharacterMarkdown,
  buildPersonaMarkdown,
} = require('./db');

const {
  fetchModelsFromAgy,
  syncAgyConfigFile,
  replaceMacros,
  runRoleplayTurn,
  getGenerationState,
} = require('./agyService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static( path.join(__dirname, 'uploads') ));

// Multer setup for avatar uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.png') || '.png';
    cb(null, `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const upload = multer({ storage });

// Helper: safely resolve a path inside WORKSPACE_DIR
function resolveWorkspacePath(relPath = '') {
  const cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE_DIR, cleaned);
  if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) {
    throw new Error('Недопустимый путь за пределами рабочей директории');
  }
  return { cleaned, resolved };
}

function slugifyFileName(name) {
  const translitMap = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'
  };
  const s = String(name || 'item')
    .toLowerCase()
    .split('')
    .map(ch => translitMap[ch] !== undefined ? translitMap[ch] : ch)
    .join('')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || `item_${Date.now()}`;
}

function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ interface: name, address: net.address });
      }
    }
  }
  return ips;
}

// ============================================================================
// 1. HEALTH, SETTINGS, PROJECT ID & MODELS API
// ============================================================================
app.get('/api/health', async (req, res) => {
  const ips = getLocalIpAddresses();
  const apkPath = path.join(__dirname, '..', 'agy-roleplay-android16.apk');
  res.json({
    ok: true,
    projectId: getSetting('project_id'),
    selectedModel: getSetting('selected_model'),
    selectedEffort: getSetting('selected_effort'),
    activePersonaId: Number(getSetting('active_persona_id') || 1),
    localIps: ips,
    port: PORT,
    apkAvailable: fs.existsSync(apkPath),
  });
});

app.get('/api/settings', async (req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] ? ips[0].address : '127.0.0.1';
  const serverUrl = `http://${primaryIp}:${PORT}`;
  const apkUrl = `${serverUrl}/download/agy-roleplay-android16.apk`;
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(apkUrl, { margin: 1, width: 220 });
  } catch (e) {}

  res.json({
    projectId: getSetting('project_id'),
    selectedModel: getSetting('selected_model'),
    selectedEffort: getSetting('selected_effort'),
    activePersonaId: Number(getSetting('active_persona_id') || 1),
    contextMessagesLimit: Number(getSetting('context_messages_limit') || 30),
    localIps: ips,
    serverUrl,
    apkUrl,
    qrDataUrl,
  });
});

app.post('/api/settings', (req, res) => {
  const { projectId, selectedModel, selectedEffort, activePersonaId, contextMessagesLimit } = req.body || {};
  if (projectId !== undefined && String(projectId).trim()) {
    const cleanProj = String(projectId).trim();
    setSetting('project_id', cleanProj);
    syncAgyConfigFile(cleanProj);
  }
  if (selectedModel !== undefined && String(selectedModel).trim()) {
    setSetting('selected_model', String(selectedModel).trim());
  }
  if (selectedEffort !== undefined && String(selectedEffort).trim()) {
    setSetting('selected_effort', String(selectedEffort).trim());
  }
  if (activePersonaId !== undefined) {
    setSetting('active_persona_id', String(activePersonaId));
  }
  if (contextMessagesLimit !== undefined) {
    setSetting('context_messages_limit', String(contextMessagesLimit));
  }

  res.json({
    ok: true,
    projectId: getSetting('project_id'),
    selectedModel: getSetting('selected_model'),
    selectedEffort: getSetting('selected_effort'),
    activePersonaId: Number(getSetting('active_persona_id') || 1),
    contextMessagesLimit: Number(getSetting('context_messages_limit') || 30),
  });
});

app.get('/api/models', async (req, res) => {
  const force = req.query.refresh === '1';
  const models = await fetchModelsFromAgy(force);
  res.json({
    models,
    selectedModel: getSetting('selected_model'),
    selectedEffort: getSetting('selected_effort'),
  });
});

// ============================================================================
// 2. AVATAR UPLOAD API (Supports both Base64 JSON and Multipart Form-Data)
// ============================================================================
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  try {
    if (req.file) {
      return res.json({ ok: true, avatarUrl: `/uploads/avatars/${req.file.filename}` });
    }
    const { base64Data, filename } = req.body || {};
    if (base64Data && typeof base64Data === 'string') {
      const matches = base64Data.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
      let ext = '.png';
      let rawBase64 = base64Data;
      if (matches) {
        ext = `.${matches[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
        rawBase64 = matches[2];
      } else if (filename) {
        ext = path.extname(filename) || '.png';
      }
      const outName = `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
      const outPath = path.join(UPLOADS_DIR, outName);
      fs.writeFileSync(outPath, Buffer.from(rawBase64, 'base64'));
      return res.json({ ok: true, avatarUrl: `/uploads/avatars/${outName}` });
    }
    res.status(400).json({ error: 'Изображение не передано' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 3. WORKSPACE FILE & FOLDER MANAGER API
// ============================================================================
app.get('/api/files', (req, res) => {
  try {
    const rel = req.query.path || '';
    const { cleaned, resolved } = resolveWorkspacePath(rel);
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'Папка не найдена' });
    }
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries
      .map(entry => {
        const itemRel = cleaned ? `${cleaned}/${entry.name}` : entry.name;
        const itemFull = path.join(resolved, entry.name);
        const stat = fs.statSync(itemFull);
        return {
          name: entry.name,
          path: itemRel,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? 0 : stat.size,
          updatedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, 'ru');
      });

    res.json({ currentPath: cleaned, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/files/content', (req, res) => {
  try {
    const { cleaned, resolved } = resolveWorkspacePath(req.query.path || '');
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: cleaned, name: path.basename(resolved), content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/files/folder', (req, res) => {
  try {
    const { folderPath } = req.body || {};
    if (!folderPath || !String(folderPath).trim()) {
      return res.status(400).json({ error: 'Укажите путь к новой папке' });
    }
    const { cleaned, resolved } = resolveWorkspacePath(folderPath);
    fs.mkdirSync(resolved, { recursive: true });
    res.json({ ok: true, path: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/files/file', (req, res) => {
  try {
    const { filePath, content } = req.body || {};
    if (!filePath || !String(filePath).trim()) {
      return res.status(400).json({ error: 'Укажите путь к файлу' });
    }
    const { cleaned, resolved } = resolveWorkspacePath(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, String(content ?? ''), 'utf8');

    // Sync with DB in case the file is inside characters/ or personas/
    syncWorkspaceWithDb();

    res.json({ ok: true, path: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/files', (req, res) => {
  try {
    const targetPath = req.query.path || (req.body && req.body.path) || '';
    if (!targetPath) {
      return res.status(400).json({ error: 'Не указан путь для удаления' });
    }
    const { cleaned, resolved } = resolveWorkspacePath(targetPath);
    if (!cleaned) {
      return res.status(400).json({ error: 'Нельзя удалить корневую папку workspace' });
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      // Also clean DB if it was a character or persona file
      db.prepare('DELETE FROM characters WHERE file_path = ?').run(cleaned);
      db.prepare('DELETE FROM personas WHERE file_path = ?').run(cleaned);
      syncWorkspaceWithDb();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// 4. CHARACTERS API
// ============================================================================
app.get('/api/characters', (req, res) => {
  syncWorkspaceWithDb();
  const chars = db.prepare('SELECT * FROM characters ORDER BY id DESC').all();
  const enriched = chars.map(c => {
    let fileContent = '';
    try {
      const fullPath = path.join(WORKSPACE_DIR, c.file_path);
      if (fs.existsSync(fullPath)) {
        fileContent = fs.readFileSync(fullPath, 'utf8');
      }
    } catch (e) {}
    return { ...c, fileContent };
  });
  res.json({ characters: enriched });
});

app.post('/api/characters', (req, res) => {
  try {
    const { name, avatarUrl, firstMessage, description, filePath, rawFileContent } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Введите имя персонажа' });
    }
    const cleanName = String(name).trim();
    const relPath = filePath && String(filePath).trim()
      ? String(filePath).trim().replace(/\\/g, '/').replace(/^\/+/, '')
      : `characters/${slugifyFileName(cleanName)}.md`;

    const { cleaned, resolved } = resolveWorkspacePath(relPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    const greeting = (firstMessage && String(firstMessage).trim())
      || `*${cleanName} внимательно смотрит на {{user}}.*\n\n— Здравствуй, {{user}}!`;

    const markdownToWrite = rawFileContent && String(rawFileContent).trim()
      ? String(rawFileContent)
      : buildCharacterMarkdown({ name: cleanName, firstMessage: greeting, description: description || '' });

    fs.writeFileSync(resolved, markdownToWrite, 'utf8');
    const parsed = parseRoleplayMarkdown(markdownToWrite, cleanName);

    const existing = db.prepare('SELECT id FROM characters WHERE file_path = ?').get(cleaned);
    let charId;
    if (existing) {
      db.prepare(`
        UPDATE characters
        SET name = ?, avatar_url = ?, first_message = ?, description_preview = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(cleanName, avatarUrl || '', greeting, parsed.descriptionPreview, existing.id);
      charId = existing.id;
    } else {
      const info = db.prepare(`
        INSERT INTO characters (name, avatar_url, file_path, first_message, description_preview)
        VALUES (?, ?, ?, ?, ?)
      `).run(cleanName, avatarUrl || '', cleaned, greeting, parsed.descriptionPreview);
      charId = info.lastInsertRowid;
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    res.json({ ok: true, character: { ...character, fileContent: markdownToWrite } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/characters/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Персонаж не найден' });
    }

    const { name, avatarUrl, firstMessage, description, filePath, rawFileContent } = req.body || {};
    const cleanName = (name && String(name).trim()) || existing.name;
    const cleanGreeting = firstMessage !== undefined ? String(firstMessage) : existing.first_message;
    const cleanAvatar = avatarUrl !== undefined ? String(avatarUrl) : existing.avatar_url;
    const targetRelPath = (filePath && String(filePath).trim()) || existing.file_path;

    const { cleaned, resolved } = resolveWorkspacePath(targetRelPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    let markdownToWrite = rawFileContent;
    if (markdownToWrite === undefined) {
      markdownToWrite = buildCharacterMarkdown({
        name: cleanName,
        firstMessage: cleanGreeting,
        description: description || existing.description_preview,
      });
    }
    fs.writeFileSync(resolved, String(markdownToWrite), 'utf8');
    const parsed = parseRoleplayMarkdown(markdownToWrite, cleanName);

    db.prepare(`
      UPDATE characters
      SET name = ?, avatar_url = ?, file_path = ?, first_message = ?, description_preview = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(cleanName, cleanAvatar, cleaned, cleanGreeting, parsed.descriptionPreview, id);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    res.json({ ok: true, character: { ...updated, fileContent: markdownToWrite } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/characters/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  if (existing && req.query.deleteFile === '1') {
    try {
      const { resolved } = resolveWorkspacePath(existing.file_path);
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    } catch (e) {}
  }
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ============================================================================
// 5. PERSONAS API
// ============================================================================
app.get('/api/personas', (req, res) => {
  syncWorkspaceWithDb();
  const personas = db.prepare('SELECT * FROM personas ORDER BY is_default DESC, id ASC').all();
  const activePersonaId = Number(getSetting('active_persona_id') || (personas[0] && personas[0].id) || 0);
  const enriched = personas.map(p => {
    let fileContent = '';
    try {
      const fullPath = path.join(WORKSPACE_DIR, p.file_path);
      if (fs.existsSync(fullPath)) fileContent = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {}
    return { ...p, fileContent, isActive: p.id === activePersonaId };
  });
  res.json({ personas: enriched, activePersonaId });
});

app.post('/api/personas', (req, res) => {
  try {
    const { name, avatarUrl, description, filePath, rawFileContent, setAsActive } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Введите имя персоны' });
    }
    const cleanName = String(name).trim();
    const relPath = filePath && String(filePath).trim()
      ? String(filePath).trim().replace(/\\/g, '/').replace(/^\/+/, '')
      : `personas/${slugifyFileName(cleanName)}.md`;

    const { cleaned, resolved } = resolveWorkspacePath(relPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    const markdownToWrite = rawFileContent && String(rawFileContent).trim()
      ? String(rawFileContent)
      : buildPersonaMarkdown({ name: cleanName, description: description || '' });

    fs.writeFileSync(resolved, markdownToWrite, 'utf8');
    const parsed = parseRoleplayMarkdown(markdownToWrite, cleanName);

    const existing = db.prepare('SELECT id FROM personas WHERE file_path = ?').get(cleaned);
    let personaId;
    if (existing) {
      db.prepare(`
        UPDATE personas
        SET name = ?, avatar_url = ?, description_preview = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(cleanName, avatarUrl || '', parsed.descriptionPreview, existing.id);
      personaId = existing.id;
    } else {
      const info = db.prepare(`
        INSERT INTO personas (name, avatar_url, file_path, description_preview)
        VALUES (?, ?, ?, ?)
      `).run(cleanName, avatarUrl || '', cleaned, parsed.descriptionPreview);
      personaId = info.lastInsertRowid;
    }

    if (setAsActive !== false) {
      setSetting('active_persona_id', String(personaId));
    }

    const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(personaId);
    res.json({ ok: true, persona: { ...persona, fileContent: markdownToWrite }, activePersonaId: Number(getSetting('active_persona_id')) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/personas/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Персона не найдена' });

    const { name, avatarUrl, description, filePath, rawFileContent } = req.body || {};
    const cleanName = (name && String(name).trim()) || existing.name;
    const cleanAvatar = avatarUrl !== undefined ? String(avatarUrl) : existing.avatar_url;
    const targetRelPath = (filePath && String(filePath).trim()) || existing.file_path;

    const { cleaned, resolved } = resolveWorkspacePath(targetRelPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    const markdownToWrite = rawFileContent !== undefined
      ? String(rawFileContent)
      : buildPersonaMarkdown({ name: cleanName, description: description || existing.description_preview });

    fs.writeFileSync(resolved, markdownToWrite, 'utf8');
    const parsed = parseRoleplayMarkdown(markdownToWrite, cleanName);

    db.prepare(`
      UPDATE personas
      SET name = ?, avatar_url = ?, file_path = ?, description_preview = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(cleanName, cleanAvatar, cleaned, parsed.descriptionPreview, id);

    const updated = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
    res.json({ ok: true, persona: { ...updated, fileContent: markdownToWrite } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/personas/:id/activate', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Персона не найдена' });
  setSetting('active_persona_id', String(id));
  res.json({ ok: true, activePersonaId: id });
});

app.delete('/api/personas/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  syncWorkspaceWithDb();
  res.json({ ok: true });
});

// ============================================================================
// 6. CHATS & MESSAGES API
// ============================================================================
function formatMessageRow(m) {
  let swipes = [];
  try {
    swipes = JSON.parse(m.swipes || '[]');
  } catch (e) {
    swipes = [m.content];
  }
  if (!Array.isArray(swipes) || swipes.length === 0) {
    swipes = [m.content];
  }
  return {
    ...m,
    swipes,
    swipe_index: Math.min(Math.max(0, m.swipe_index || 0), swipes.length - 1),
  };
}

app.get('/api/chats', (req, res) => {
  const rows = db.prepare(`
    SELECT
      c.*,
      ch.name AS character_name,
      ch.avatar_url AS character_avatar,
      ch.file_path AS character_file,
      p.name AS persona_name,
      p.avatar_url AS persona_avatar,
      (SELECT content FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) AS message_count
    FROM chats c
    JOIN characters ch ON ch.id = c.character_id
    JOIN personas p ON p.id = c.persona_id
    ORDER BY c.updated_at DESC, c.id DESC
  `).all();
  res.json({ chats: rows });
});

app.post('/api/chats', (req, res) => {
  try {
    const { characterId, personaId, modelId, effort, customFirstMessage, title } = req.body || {};
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(Number(characterId));
    if (!character) {
      return res.status(404).json({ error: 'Выберите персонажа для начала чата' });
    }

    const effectivePersonaId = Number(personaId || getSetting('active_persona_id') || 1);
    const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(effectivePersonaId)
      || db.prepare('SELECT * FROM personas ORDER BY id ASC LIMIT 1').get();

    const effectiveModel = modelId || getSetting('selected_model') || 'gemini-4-argon-high';
    const effectiveEffort = effort || getSetting('selected_effort') || 'high';
    const chatTitle = title || `Чат с ${character.name}`;

    const info = db.prepare(`
      INSERT INTO chats (character_id, persona_id, title, model_id, effort)
      VALUES (?, ?, ?, ?, ?)
    `).run(character.id, persona.id, chatTitle, effectiveModel, effectiveEffort);

    const chatId = Number(info.lastInsertRowid);
    const memoryRelPath = `memories/chat_${chatId}.md`;
    db.prepare('UPDATE chats SET memory_file_path = ? WHERE id = ?').run(memoryRelPath, chatId);

    // Create initial memory file for this chat
    const memoryFullPath = path.join(WORKSPACE_DIR, memoryRelPath);
    if (!fs.existsSync(memoryFullPath)) {
      fs.writeFileSync(
        memoryFullPath,
        `# Память чата #${chatId}: ${character.name} и ${persona.name}\n\n- Начало истории между ${character.name} и ${persona.name}.\n`,
        'utf8'
      );
    }

    // Insert customizable initial greeting message from character
    const rawGreeting = customFirstMessage !== undefined && String(customFirstMessage).trim()
      ? String(customFirstMessage).trim()
      : (character.first_message || `*${character.name} встречает взглядом {{user}}.*`);

    const resolvedGreeting = replaceMacros(rawGreeting, character.name, persona.name);
    db.prepare(`
      INSERT INTO messages (chat_id, role, content, swipes, swipe_index, model_used)
      VALUES (?, 'assistant', ?, ?, 0, 'greeting')
    `).run(chatId, resolvedGreeting, JSON.stringify([resolvedGreeting]));

    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId).map(formatMessageRow);

    res.json({ ok: true, chat, character, persona, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:id', (req, res) => {
  const chatId = Number(req.params.id);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(chat.character_id);
  const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(chat.persona_id);
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId).map(formatMessageRow);
  const generation = getGenerationState(chatId);

  res.json({ chat, character, persona, messages, generation });
});

app.patch('/api/chats/:id', (req, res) => {
  const chatId = Number(req.params.id);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });

  const { modelId, effort, personaId, title } = req.body || {};
  const nextModel = modelId || chat.model_id;
  const nextEffort = effort || chat.effort;
  const nextPersona = personaId ? Number(personaId) : chat.persona_id;
  const nextTitle = title || chat.title;

  db.prepare(`
    UPDATE chats
    SET model_id = ?, effort = ?, persona_id = ?, title = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextModel, nextEffort, nextPersona, nextTitle, chatId);

  if (modelId) setSetting('selected_model', modelId);
  if (effort) setSetting('selected_effort', effort);
  if (personaId) setSetting('active_persona_id', String(personaId));

  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(updated.persona_id);
  res.json({ ok: true, chat: updated, persona });
});

app.delete('/api/chats/:id', (req, res) => {
  const chatId = Number(req.params.id);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  res.json({ ok: true });
});

// Live generation status endpoint for real-time streaming UI updates
app.get('/api/chats/:id/generation', (req, res) => {
  const chatId = Number(req.params.id);
  const state = getGenerationState(chatId);
  res.json({ active: Boolean(state), generation: state });
});

// Send a user message and generate character response via AGY CLI
app.post('/api/chats/:id/messages', async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    const { content, modelId, effort, personaId } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    let chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });

    // Update model/effort/persona if passed
    if (modelId || effort || personaId) {
      db.prepare(`
        UPDATE chats
        SET model_id = COALESCE(?, model_id),
            effort = COALESCE(?, effort),
            persona_id = COALESCE(?, persona_id),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(modelId || null, effort || null, personaId ? Number(personaId) : null, chatId);
      chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(chat.character_id);
    const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(chat.persona_id);

    const userText = String(content).trim();
    db.prepare(`
      INSERT INTO messages (chat_id, role, content, swipes, swipe_index)
      VALUES (?, 'user', ?, ?, 0)
    `).run(chatId, userText, JSON.stringify([userText]));

    db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);

    const allMessages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId).map(formatMessageRow);

    const result = await runRoleplayTurn({
      chat,
      character,
      persona,
      messages: allMessages,
      projectId: getSetting('project_id'),
      modelId: chat.model_id,
      effort: chat.effort,
    });

    const swipesArr = [result.reply];
    db.prepare(`
      INSERT INTO messages (chat_id, role, content, swipes, swipe_index, thoughts, model_used)
      VALUES (?, 'assistant', ?, ?, 0, ?, ?)
    `).run(chatId, result.reply, JSON.stringify(swipesArr), result.thoughts || '', result.modelUsed || chat.model_id);

    db.prepare(`
      UPDATE chats SET agy_conversation_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(result.conversationId || chat.agy_conversation_id || '', chatId);

    const updatedMessages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId).map(formatMessageRow);
    res.json({ ok: true, messages: updatedMessages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit any message (including initial greeting message!)
app.put('/api/messages/:id', (req, res) => {
  const msgId = Number(req.params.id);
  const { content } = req.body || {};
  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  if (!existing) return res.status(404).json({ error: 'Сообщение не найдено' });

  const formatted = formatMessageRow(existing);
  const newText = String(content ?? '').trim();
  formatted.swipes[formatted.swipe_index] = newText;

  db.prepare(`
    UPDATE messages SET content = ?, swipes = ? WHERE id = ?
  `).run(newText, JSON.stringify(formatted.swipes), msgId);

  const updated = formatMessageRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
  res.json({ ok: true, message: updated });
});

app.delete('/api/messages/:id', (req, res) => {
  const msgId = Number(req.params.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
  res.json({ ok: true });
});

// Swipe between variants OR regenerate a new variant for an assistant message
app.post('/api/messages/:id/swipe', async (req, res) => {
  try {
    const msgId = Number(req.params.id);
    const { action, index } = req.body || {};
    const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!existing) return res.status(404).json({ error: 'Сообщение не найдено' });

    const formatted = formatMessageRow(existing);

    if (action === 'select' && typeof index === 'number') {
      const clamped = Math.max(0, Math.min(index, formatted.swipes.length - 1));
      const chosenText = formatted.swipes[clamped];
      db.prepare('UPDATE messages SET content = ?, swipe_index = ? WHERE id = ?').run(chosenText, clamped, msgId);
      const updated = formatMessageRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
      return res.json({ ok: true, message: updated });
    }

    // Otherwise action === 'regenerate': generate a new swipe variant via AGY CLI
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(existing.chat_id);
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(chat.character_id);
    const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(chat.persona_id);

    // Get history up to BEFORE this assistant message
    const priorMessages = db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id ASC')
      .all(chat.id, msgId)
      .map(formatMessageRow);

    const result = await runRoleplayTurn({
      chat,
      character,
      persona,
      messages: priorMessages,
      projectId: getSetting('project_id'),
      modelId: chat.model_id,
      effort: chat.effort,
    });

    formatted.swipes.push(result.reply);
    const newIndex = formatted.swipes.length - 1;

    db.prepare(`
      UPDATE messages
      SET content = ?, swipes = ?, swipe_index = ?, thoughts = ?, model_used = ?
      WHERE id = ?
    `).run(
      result.reply,
      JSON.stringify(formatted.swipes),
      newIndex,
      result.thoughts || existing.thoughts || '',
      result.modelUsed || chat.model_id,
      msgId
    );

    const updated = formatMessageRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
    res.json({ ok: true, message: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 7. GIT AUTO-UPDATE & VERSION MANAGER ENDPOINTS
// ============================================================================
app.get('/api/updates/check', async (req, res) => {
  try {
    const versionFilePath = path.join(__dirname, '..', 'version.json');
    const localManifest = fs.existsSync(versionFilePath)
      ? JSON.parse(fs.readFileSync(versionFilePath, 'utf8'))
      : { version: '1.2.0', build: 3, gitRepo: 'Kuka001/111', gitBranch: 'main', releases: [] };

    const gitRepo = (req.query.repo || getSetting('git_repo') || localManifest.gitRepo || 'Kuka001/111')
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+|\/+$/g, '');
    const gitBranch = (req.query.branch || getSetting('git_branch') || localManifest.gitBranch || 'main').trim();

    const currentVersion = getSetting('installed_version') || localManifest.version || '1.2.0';
    const currentBuild = Number(getSetting('installed_build') || localManifest.build || 3);
    const installedCommit = getSetting('installed_commit') || '';

    let latestVersion = currentVersion;
    let latestBuild = currentBuild;
    let latestReleaseTitle = '';
    let releases = localManifest.releases || [];
    let apkPath = localManifest.apkPath || 'agy-roleplay-android16.apk';
    let remoteReachable = false;
    let remoteError = '';

    try {
      const verRes = await fetch(`https://raw.githubusercontent.com/${gitRepo}/${gitBranch}/version.json?t=${Date.now()}`);
      if (verRes.ok) {
        const rem = await verRes.json();
        remoteReachable = true;
        latestVersion = rem.version || latestVersion;
        latestBuild = Number(rem.build || latestBuild);
        apkPath = rem.apkPath || apkPath;
        if (Array.isArray(rem.releases) && rem.releases.length > 0) {
          releases = rem.releases;
          latestReleaseTitle = rem.releases[0].title || '';
        }
      } else {
        remoteError = `HTTP ${verRes.status}`;
      }
    } catch (e) {
      remoteError = e.message;
    }

    const commits = [];
    let latestCommit = '';
    let latestCommitMessage = '';
    try {
      const comRes = await fetch(`https://api.github.com/repos/${gitRepo}/commits?sha=${gitBranch}&per_page=15`, {
        headers: { 'User-Agent': 'AGY-Roleplay-Updater/1.2' },
      });
      if (comRes.ok) {
        const rawCommits = await comRes.json();
        remoteReachable = true;
        for (let i = 0; i < rawCommits.length; i++) {
          const item = rawCommits[i];
          const sha = item.sha || '';
          const shortSha = sha.slice(0, 7);
          const message = (item.commit?.message || '').split('\n')[0];
          const author = item.commit?.author?.name || 'Git';
          const date = item.commit?.author?.date || '';
          commits.push({ sha, shortSha, message, author, date });
          if (i === 0) {
            latestCommit = shortSha;
            latestCommitMessage = message;
          }
        }
      }
    } catch (e) {
      if (!remoteError) remoteError = e.message;
    }

    const newerVersion = latestBuild > currentBuild || latestVersion !== currentVersion;
    const newerCommit = Boolean(latestCommit && installedCommit && latestCommit !== installedCommit);
    const updateAvailable = newerVersion || newerCommit;

    res.json({
      currentVersion,
      currentBuild,
      bundledVersion: localManifest.version || '1.2.0',
      bundledBuild: localManifest.build || 3,
      otaActive: getSetting('ota_active') === '1',
      installedCommit: installedCommit || latestCommit,
      latestVersion,
      latestBuild,
      latestCommit,
      latestCommitMessage,
      latestReleaseTitle,
      updateAvailable,
      newerVersion,
      newerCommit,
      gitRepo,
      gitBranch,
      apkDownloadUrl: `https://raw.githubusercontent.com/${gitRepo}/${gitBranch}/${apkPath}`,
      repoWebUrl: `https://github.com/${gitRepo}`,
      remoteReachable,
      remoteError,
      releases,
      commits,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/updates/apply', async (req, res) => {
  try {
    const { gitRepo = 'Kuka001/111', gitBranch = 'main', ref = 'main', version = '', commitSha = '' } = req.body || {};
    const cleanRepo = String(gitRepo).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').trim();
    const targetRef = (ref || gitBranch || 'main').trim();
    const baseUrl = `https://raw.githubusercontent.com/${cleanRepo}/${targetRef}`;

    const [indexRes, appRes, cssRes] = await Promise.all([
      fetch(`${baseUrl}/mobile/www/index.html?t=${Date.now()}`),
      fetch(`${baseUrl}/mobile/www/app.js?t=${Date.now()}`),
      fetch(`${baseUrl}/mobile/www/styles.css?t=${Date.now()}`),
    ]);

    if (!indexRes.ok || !appRes.ok || !cssRes.ok) {
      return res.status(500).json({ error: 'Не удалось скачать файлы интерфейса из указанной ветки/коммита Git' });
    }

    const wwwDir = path.join(__dirname, '..', 'mobile', 'www');
    fs.writeFileSync(path.join(wwwDir, 'index.html'), await indexRes.text(), 'utf8');
    fs.writeFileSync(path.join(wwwDir, 'app.js'), await appRes.text(), 'utf8');
    fs.writeFileSync(path.join(wwwDir, 'styles.css'), await cssRes.text(), 'utf8');

    const appliedVersion = version || '1.2.0';
    setSetting('installed_version', appliedVersion);
    if (commitSha) setSetting('installed_commit', commitSha.slice(0, 7));
    setSetting('ota_active', '1');

    res.json({
      ok: true,
      updatedVersion: appliedVersion,
      installedCommit: commitSha.slice(0, 7),
      otaActive: true,
      message: `Версия ${appliedVersion} успешно загружена из Git!`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/updates/reset', (req, res) => {
  setSetting('ota_active', '0');
  setSetting('installed_commit', '');
  res.json({ ok: true, otaActive: false });
});

app.post('/api/updates/config', (req, res) => {
  const { gitRepo = 'Kuka001/111', gitBranch = 'main' } = req.body || {};
  const cleanRepo = String(gitRepo).replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').trim();
  setSetting('git_repo', cleanRepo);
  setSetting('git_branch', String(gitBranch || 'main').trim());
  res.json({ ok: true, gitRepo: cleanRepo, gitBranch: String(gitBranch || 'main').trim() });
});

// ============================================================================
// 8. SERVE ANDROID 16 APK & MOBILE CLIENT
// ============================================================================
app.get('/download/agy-roleplay-android16.apk', (req, res) => {
  const apkPath = path.join(__dirname, '..', 'agy-roleplay-android16.apk');
  if (!fs.existsSync(apkPath)) {
    return res.status(404).send('APK файл ещё собирается');
  }
  res.download(apkPath, 'agy-roleplay-android16.apk');
});

const mobileDistDir = path.join(__dirname, '..', 'mobile', 'www');
if (fs.existsSync(mobileDistDir)) {
  app.use(express.static(mobileDistDir));
}

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log(`\n============================================================`);
  console.log(`🚀 AGY Roleplay Server запущен на порту ${PORT}`);
  console.log(`🔑 Текущий Project ID: ${getSetting('project_id')}`);
  console.log(`🤖 Текущая модель: ${getSetting('selected_model')} (${getSetting('selected_effort')})`);
  console.log(`📂 Рабочая папка: ${WORKSPACE_DIR}`);
  for (const ip of ips) {
    console.log(`📱 Адрес для смартфона (Wi-Fi): http://${ip.address}:${PORT}`);
    console.log(`📦 Скачать APK (Android 16):    http://${ip.address}:${PORT}/download/agy-roleplay-android16.apk`);
  }
  console.log(`============================================================\n`);
});
