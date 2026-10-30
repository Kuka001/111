// Tests for android/assets/cloud-schema.sql: the cloud-sync bookkeeping tables
// and the SQLite triggers that queue every change in cloud_outbox.
//
// The app runs this same file at every start (LocalBackendServer.initCloudSchema,
// one statement per "--;;" section, whole-line comments removed); here it runs
// on Node's built-in SQLite against the app's tables. A write path the triggers
// miss would silently never reach the cloud, so their behaviour is pinned here.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_FILE = path.join(__dirname, '..', '..', 'android', 'assets', 'cloud-schema.sql');

/** Mirrors initCloudSchema(): sections split at "--;;" lines, whole-line comments dropped. */
function schemaStatements() {
  return fs.readFileSync(SCHEMA_FILE, 'utf8').replace(/\r\n/g, '\n').split('\n--;;\n')
    .map(section => section.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

/** The app's own tables, as initWorkspaceAndDatabase() leaves them (with the 1.8 sync and 1.9 card columns). */
function appDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE,
      avatar_url TEXT DEFAULT '', first_message TEXT DEFAULT '', description_preview TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, sync_id TEXT,
      title TEXT DEFAULT '', card_json TEXT DEFAULT '');
    CREATE TABLE personas (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE,
      avatar_url TEXT DEFAULT '', description_preview TEXT DEFAULT '', is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, sync_id TEXT, title TEXT DEFAULT '');
    CREATE TABLE chats (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, character_id INTEGER NOT NULL,
      persona_id INTEGER NOT NULL, model_id TEXT NOT NULL, effort TEXT DEFAULT 'high', memory_file_path TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, provider TEXT DEFAULT '',
      sync_id TEXT, character_sid TEXT DEFAULT '', persona_sid TEXT DEFAULT '');
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, thoughts TEXT DEFAULT '', swipes_json TEXT DEFAULT '[]', swipe_index INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, thought_swipes_json TEXT DEFAULT '[]', sync_id TEXT, sort_key INTEGER,
      cast_swipes_json TEXT DEFAULT '[]');
  `);
  return db;
}

function runSchema(db) {
  for (const statement of schemaStatements()) db.exec(statement);
}

function linkedDatabase() {
  const db = appDatabase();
  runSchema(db);
  db.exec('UPDATE cloud_ctl SET tracking = 1');
  return db;
}

// node:sqlite rows have a null prototype; plain objects compare with deepStrictEqual.
const plain = (rows) => rows.map(r => ({ ...r }));
const outbox = (db) => plain(db.prepare('SELECT kind, sid, parent, queued_at FROM cloud_outbox ORDER BY kind, sid').all());
const SID = /^[0-9a-f]{32}$/;

function addChat(db, title = 'Чат: Кира') {
  db.prepare("INSERT INTO characters (name, file_path) VALUES ('Кира', ?)").run('characters/' + title + '.md');
  db.prepare("INSERT INTO personas (name, file_path) VALUES ('Игрок', ?)").run('personas/' + title + '.md');
  const id = db.prepare("INSERT INTO chats (title, character_id, persona_id, model_id) VALUES (?, 1, 1, 'gemini-4-argon')").run(title).lastInsertRowid;
  return Number(id);
}

const addMessage = (db, chatId, content) =>
  Number(db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chatId, content).lastInsertRowid);

test('the schema runs at every start without errors', () => {
  const db = appDatabase();
  runSchema(db);
  runSchema(db);
  assert.deepStrictEqual({ ...db.prepare('SELECT tracking, applying FROM cloud_ctl').get() }, { tracking: 0, applying: 0 });
});

test('rows from before 1.8 get a sync_id; their messages keep their order', () => {
  const db = appDatabase();
  db.exec("INSERT INTO characters (name, file_path) VALUES ('A', 'characters/a.md'), ('B', 'characters/b.md')");
  db.exec("INSERT INTO chats (title, character_id, persona_id, model_id) VALUES ('Чат', 1, 0, 'm')");
  db.exec("INSERT INTO messages (chat_id, role, content) VALUES (1, 'assistant', 'one'), (1, 'user', 'two')");
  runSchema(db);
  const sids = db.prepare('SELECT sync_id FROM characters UNION ALL SELECT sync_id FROM chats UNION ALL SELECT sync_id FROM messages').all();
  assert.strictEqual(sids.length, 5);
  for (const { sync_id } of sids) assert.match(sync_id, SID);
  assert.strictEqual(new Set(sids.map(r => r.sync_id)).size, 5);
  assert.deepStrictEqual(plain(db.prepare('SELECT id, sort_key FROM messages ORDER BY id').all()), [{ id: 1, sort_key: 1 }, { id: 2, sort_key: 2 }]);
  assert.deepStrictEqual(outbox(db), [], 'nothing is queued before an account is linked');
});

test('with sync off, new rows still get a sync_id and an order, but nothing is queued', () => {
  const db = appDatabase();
  runSchema(db);
  const chatId = addChat(db);
  const msgId = addMessage(db, chatId, 'привет');
  const m = db.prepare('SELECT sync_id, sort_key FROM messages WHERE id = ?').get(msgId);
  assert.match(m.sync_id, SID);
  assert.ok(m.sort_key > 1_700_000_000_000, 'a millisecond key');
  assert.deepStrictEqual(outbox(db), []);
});

test('new cards, chats and messages are queued once, with their sync_id', () => {
  const db = linkedDatabase();
  const chatId = addChat(db);
  const msgId = addMessage(db, chatId, 'привет');
  const chatSid = db.prepare('SELECT sync_id FROM chats WHERE id = ?').get(chatId).sync_id;
  const msgSid = db.prepare('SELECT sync_id FROM messages WHERE id = ?').get(msgId).sync_id;
  const q = outbox(db);
  assert.deepStrictEqual(q.map(r => r.kind), ['character', 'chat', 'message', 'persona']);
  assert.strictEqual(q.find(r => r.kind === 'chat').sid, chatSid);
  assert.deepStrictEqual(q.filter(r => r.kind === 'message').map(r => [r.sid, r.parent]), [[msgSid, chatSid]]);
  for (const r of q) assert.ok(r.queued_at > 1_700_000_000_000);
});

test('edits queue the record again; a reply bumping updated_at does not', () => {
  const db = linkedDatabase();
  const chatId = addChat(db);
  db.exec('DELETE FROM cloud_outbox');
  db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chatId);
  db.prepare("UPDATE chats SET memory_file_path = 'memories/chat_1.md' WHERE id = ?").run(chatId);
  assert.deepStrictEqual(outbox(db), []);
  db.prepare("UPDATE chats SET title = 'Новое название' WHERE id = ?").run(chatId);
  db.exec("UPDATE characters SET avatar_url = 'data:image/png;base64,AA'");
  db.exec("UPDATE personas SET is_default = 1");
  assert.deepStrictEqual(outbox(db).map(r => r.kind), ['character', 'chat', 'persona']);
});

test('1.9 fields queue their record: card title and structure, persona title, characters of reply variants', () => {
  const db = linkedDatabase();
  const chatId = addChat(db);
  const msgId = addMessage(db, chatId, 'привет');
  db.exec('DELETE FROM cloud_outbox');
  db.exec("UPDATE characters SET card_json = '{\"v\":2,\"world\":\"\",\"chars\":[],\"next\":1}'");
  db.exec("UPDATE personas SET title = 'Кадзума — маг'");
  db.prepare("UPDATE messages SET cast_swipes_json = '[[{\"n\":2,\"name\":\"Лира\",\"text\":\"\"}]]' WHERE id = ?").run(msgId);
  assert.deepStrictEqual(outbox(db).map(r => r.kind), ['character', 'message', 'persona']);
  db.exec('DELETE FROM cloud_outbox');
  db.exec("UPDATE characters SET title = 'Таверна'");
  assert.deepStrictEqual(outbox(db).map(r => r.kind), ['character']);
});

test('a deleted message names its chat; deleting the chat queues the chat and its memory', () => {
  const db = linkedDatabase();
  const chatId = addChat(db);
  const msgId = addMessage(db, chatId, 'привет');
  const chatSid = db.prepare('SELECT sync_id FROM chats WHERE id = ?').get(chatId).sync_id;
  db.exec('DELETE FROM cloud_outbox');
  // As deleteChat() does it: messages first, then the chat.
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  const q = outbox(db);
  assert.deepStrictEqual(q.map(r => [r.kind, r.parent]), [['chat', ''], ['memory', chatSid], ['message', chatSid]]);
  assert.strictEqual(q.find(r => r.kind === 'memory').sid, chatSid);
  assert.ok(msgId > 0);
});

test('a new message sorts after every message of its chat, even one with a later key', () => {
  const db = linkedDatabase();
  const chatId = addChat(db);
  const future = Date.now() + 10 * 24 * 3600 * 1000;
  db.prepare("INSERT INTO messages (chat_id, role, content, sort_key, sync_id) VALUES (?, 'assistant', 'из облака', ?, ?)")
    .run(chatId, future, 'ab'.repeat(16));
  const id = addMessage(db, chatId, 'новое');
  assert.strictEqual(db.prepare('SELECT sort_key FROM messages WHERE id = ?').get(id).sort_key, future + 1);
  assert.strictEqual(db.prepare('SELECT sync_id FROM messages WHERE sort_key = ?').get(future).sync_id, 'ab'.repeat(16),
    'a message that brings its sync_id keeps it');
  const other = addChat(db, 'Другой чат');
  const first = addMessage(db, other, 'первое');
  assert.ok(db.prepare('SELECT sort_key FROM messages WHERE id = ?').get(first).sort_key < future, 'per chat');
});

test('only the account settings are queued, also through INSERT OR REPLACE', () => {
  const db = linkedDatabase();
  db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('installed_version', '1.8.0')");
  db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('cloud_watermark', 'x')");
  db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('agy_access_token', 'enc:v1:x')");
  assert.deepStrictEqual(outbox(db), []);
  db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('selected_model', 'gemini-4-argon')");
  db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('active_persona_id', '2')");
  db.exec("UPDATE settings SET value = 'max' WHERE key = 'selected_model'");
  assert.deepStrictEqual(outbox(db).map(r => [r.kind, r.sid]), [['settings', 'settings']]);
});

test('nothing is queued while changes from the cloud are applied', () => {
  const db = linkedDatabase();
  db.exec('BEGIN');
  db.exec('UPDATE cloud_ctl SET applying = 1');
  const chatId = addChat(db);
  addMessage(db, chatId, 'из облака');
  db.exec("UPDATE chats SET title = 'x'");
  db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('selected_effort', 'low')");
  db.exec('DELETE FROM messages');
  db.exec('UPDATE cloud_ctl SET applying = 0');
  db.exec('COMMIT');
  assert.deepStrictEqual(outbox(db), []);
  assert.match(db.prepare('SELECT sync_id FROM chats').get().sync_id, SID, 'ids are still assigned');
});

test('a backup restore (INSERT OR REPLACE with sync_ids) queues the restored rows', () => {
  const db = linkedDatabase();
  const sid = 'cd'.repeat(16);
  db.prepare("INSERT OR REPLACE INTO characters (id, name, file_path, sync_id) VALUES (7, 'Кира', 'characters/kira.md', ?)").run(sid);
  db.prepare("INSERT OR REPLACE INTO characters (id, name, file_path, sync_id) VALUES (7, 'Кира', 'characters/kira.md', ?)").run(sid);
  assert.deepStrictEqual(outbox(db).map(r => [r.kind, r.sid]), [['character', sid]]);
  assert.strictEqual(db.prepare('SELECT sync_id FROM characters WHERE id = 7').get().sync_id, sid);
});

test('a sync_id is unique: two rows cannot share one', () => {
  const db = linkedDatabase();
  const sid = 'ef'.repeat(16);
  db.prepare("INSERT INTO personas (name, file_path, sync_id) VALUES ('A', 'personas/a.md', ?)").run(sid);
  assert.throws(() => db.prepare("INSERT INTO personas (name, file_path, sync_id) VALUES ('B', 'personas/b.md', ?)").run(sid));
});
