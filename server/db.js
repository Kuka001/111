const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DATA_DIR = path.join(__dirname, 'data');
const WORKSPACE_DIR = path.join(__dirname, 'workspace');
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'avatars');

for (const dir of [
  DATA_DIR,
  WORKSPACE_DIR,
  path.join(WORKSPACE_DIR, 'characters'),
  path.join(WORKSPACE_DIR, 'personas'),
  path.join(WORKSPACE_DIR, 'lore'),
  path.join(WORKSPACE_DIR, 'memories'),
  UPLOADS_DIR,
]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const dbPath = path.join(DATA_DIR, 'rp_app.db');
const db = new DatabaseSync(dbPath);

// Enable WAL and Foreign Keys
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    file_path TEXT NOT NULL UNIQUE,
    first_message TEXT NOT NULL DEFAULT '',
    description_preview TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS personas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    file_path TEXT NOT NULL UNIQUE,
    description_preview TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    persona_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    model_id TEXT NOT NULL DEFAULT 'gemini-3.8-flash-high',
    effort TEXT NOT NULL DEFAULT 'medium',
    memory_file_path TEXT DEFAULT '',
    lore_folder_path TEXT DEFAULT 'lore',
    agy_conversation_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    swipes TEXT NOT NULL DEFAULT '[]',
    swipe_index INTEGER NOT NULL DEFAULT 0,
    thoughts TEXT DEFAULT '',
    model_used TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
`);

/**
 * Detect default Project ID from ~/.gemini/antigravity-cli/settings.json if available
 */
function detectDefaultProjectId() {
  try {
    const agySettingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    if (fs.existsSync(agySettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(agySettingsPath, 'utf8'));
      if (parsed && parsed.gcp && parsed.gcp.project) {
        return parsed.gcp.project;
      }
    }
  } catch (e) {
    // ignore
  }
  return 'project-4c7a8e8a-764a-42bc-bdf';
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ''));
}

// Initialize default settings if missing and normalize model IDs (strip -low/-medium/-high/-max)
if (!getSetting('project_id')) {
  setSetting('project_id', detectDefaultProjectId());
}
const rawModelSetting = getSetting('selected_model');
if (!rawModelSetting) {
  setSetting('selected_model', 'gemini-4-argon');
} else if (/-(low|medium|high|max)$/i.test(rawModelSetting)) {
  setSetting('selected_model', rawModelSetting.replace(/-(low|medium|high|max)$/i, ''));
}
if (!getSetting('selected_effort')) {
  setSetting('selected_effort', 'high');
}
if (!getSetting('context_messages_limit')) {
  setSetting('context_messages_limit', '30');
}
db.exec(`
  UPDATE chats
  SET model_id = REPLACE(REPLACE(REPLACE(REPLACE(model_id, '-high', ''), '-medium', ''), '-low', ''), '-max', '')
  WHERE model_id LIKE '%-high' OR model_id LIKE '%-medium' OR model_id LIKE '%-low' OR model_id LIKE '%-max';
`);

/**
 * Parse a markdown/text character or persona file to extract Name, Greeting (Начальное сообщение), and Description preview
 */
function parseRoleplayMarkdown(rawText, fallbackName) {
  const text = (rawText || '').replace(/\r\n/g, '\n');
  let name = fallbackName;

  // Check "## Имя" or "## Name" section
  const nameSectionMatch = text.match(/^##\s*(?:Имя|Name)\s*\n+([^\n#]+)/im);
  if (nameSectionMatch && nameSectionMatch[1].trim()) {
    name = nameSectionMatch[1].trim();
  } else {
    // Or top-level "# Title"
    const h1Match = text.match(/^#\s+([^\n(]+)/m);
    if (h1Match && h1Match[1].trim()) {
      name = h1Match[1].trim();
    }
  }

  // Extract "## Начальное сообщение" or "## Приветствие" or "## First Message" or "## Greeting"
  let firstMessage = '';
  const greetingMatch = text.match(/^##\s*(?:Начальное сообщение|Приветствие|First Message|Greeting)\s*\n+([\s\S]*?)(?=\n##\s+|\n#\s+|$)/im);
  if (greetingMatch && greetingMatch[1].trim()) {
    firstMessage = greetingMatch[1].trim();
  }

  // Extract description preview
  const cleanPreview = text
    .replace(/^#.*$/gm, '')
    .replace(/\n{2,}/g, ' ')
    .trim()
    .slice(0, 220);

  return {
    name,
    firstMessage,
    descriptionPreview: cleanPreview || 'Текстовый файл описания в рабочей папке',
  };
}

/**
 * Format a character or persona markdown file when created/edited from UI
 * (If the user already wrote custom markdown, we can either preserve or update sections)
 */
function buildCharacterMarkdown({ name, firstMessage, description }) {
  return `# ${name}\n\n## Имя\n${name}\n\n## Начальное сообщение\n${firstMessage || `*${name} внимательно смотрит на {{user}}.*\n\n— Привет, {{user}}.`}\n\n## Характер и Личность\n${description || ''}\n`;
}

function buildPersonaMarkdown({ name, description }) {
  return `# ${name}\n\n## Имя\n${name}\n\n## Описание персоны\n${description || ''}\n`;
}

/**
 * Two-way synchronization between workspace/characters & workspace/personas folders and SQLite
 */
function syncWorkspaceWithDb() {
  // 1. Scan workspace/characters
  const charsDir = path.join(WORKSPACE_DIR, 'characters');
  if (fs.existsSync(charsDir)) {
    const files = fs.readdirSync(charsDir).filter(f => /\.(md|txt)$/i.test(f));
    for (const file of files) {
      const relPath = `characters/${file}`;
      const fullPath = path.join(charsDir, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const baseName = path.basename(file, path.extname(file));
      const parsed = parseRoleplayMarkdown(raw, baseName);

      const existing = db.prepare('SELECT * FROM characters WHERE file_path = ?').get(relPath);
      if (!existing) {
        let defaultAvatar = '';
        if (baseName.toLowerCase() === 'elena') defaultAvatar = '/uploads/avatars/elena.svg';
        if (baseName.toLowerCase() === 'kira') defaultAvatar = '/uploads/avatars/kira.svg';

        const greeting = parsed.firstMessage || `*${parsed.name} поворачивается к {{user}}.*\n\n— Здравствуй, {{user}}!`;
        db.prepare(`
          INSERT INTO characters (name, avatar_url, file_path, first_message, description_preview)
          VALUES (?, ?, ?, ?, ?)
        `).run(parsed.name, defaultAvatar, relPath, greeting, parsed.descriptionPreview);
      } else {
        // Update preview and if first_message was empty, populate it from file
        const updatedGreeting = existing.first_message || parsed.firstMessage || `*${existing.name} смотрит на {{user}}.*`;
        db.prepare(`
          UPDATE characters
          SET description_preview = ?, first_message = ?
          WHERE id = ?
        `).run(parsed.descriptionPreview, updatedGreeting, existing.id);
      }
    }
  }

  // 2. Scan workspace/personas
  const personasDir = path.join(WORKSPACE_DIR, 'personas');
  if (fs.existsSync(personasDir)) {
    const files = fs.readdirSync(personasDir).filter(f => /\.(md|txt)$/i.test(f));
    for (const file of files) {
      const relPath = `personas/${file}`;
      const fullPath = path.join(personasDir, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const baseName = path.basename(file, path.extname(file));
      const parsed = parseRoleplayMarkdown(raw, baseName);

      const existing = db.prepare('SELECT * FROM personas WHERE file_path = ?').get(relPath);
      if (!existing) {
        let defaultAvatar = '';
        if (baseName.toLowerCase() === 'kazuma') defaultAvatar = '/uploads/avatars/kazuma.svg';
        const countRow = db.prepare('SELECT COUNT(*) as cnt FROM personas').get();
        const isDefault = countRow.cnt === 0 ? 1 : 0;

        const info = db.prepare(`
          INSERT INTO personas (name, avatar_url, file_path, description_preview, is_default)
          VALUES (?, ?, ?, ?, ?)
        `).run(parsed.name, defaultAvatar, relPath, parsed.descriptionPreview, isDefault);

        if (isDefault) {
          setSetting('active_persona_id', String(info.lastInsertRowid));
        }
      } else {
        db.prepare(`
          UPDATE personas SET description_preview = ? WHERE id = ?
        `).run(parsed.descriptionPreview, existing.id);
      }
    }
  }

  // Ensure active_persona_id points to a valid persona
  const activePersonaId = getSetting('active_persona_id');
  const firstPersona = db.prepare('SELECT id FROM personas ORDER BY is_default DESC, id ASC LIMIT 1').get();
  if (firstPersona && (!activePersonaId || !db.prepare('SELECT id FROM personas WHERE id = ?').get(Number(activePersonaId)))) {
    setSetting('active_persona_id', String(firstPersona.id));
  }
}

syncWorkspaceWithDb();

module.exports = {
  db,
  DATA_DIR,
  WORKSPACE_DIR,
  UPLOADS_DIR,
  getSetting,
  setSetting,
  syncWorkspaceWithDb,
  parseRoleplayMarkdown,
  buildCharacterMarkdown,
  buildPersonaMarkdown,
};
