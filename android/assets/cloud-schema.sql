-- Cloud sync: the local bookkeeping tables and the triggers that notice changes.
--
-- Run at every start by LocalBackendServer.initCloudSchema(), after the sync
-- columns are added, one statement at a time: statements are separated by lines
-- holding only "--;;". mobile/tests/cloud-schema.test.js runs this same file on
-- Node's SQLite, so change both together. A native asset: a change needs a new APK.
--
-- Every synced row has a random sync_id, the same on every device. The triggers
-- write cloud_outbox on every insert, relevant update and delete, unless tracking
-- is off (no account linked) or applying is on (the change came from the cloud).
-- queued_at is the time of the change in ms: the record's version.
--;;
UPDATE characters SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL OR sync_id = ''
--;;
UPDATE personas SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL OR sync_id = ''
--;;
UPDATE chats SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL OR sync_id = ''
--;;
UPDATE messages SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL OR sync_id = ''
--;;
CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_sync_id ON characters(sync_id)
--;;
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_sync_id ON personas(sync_id)
--;;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_sync_id ON chats(sync_id)
--;;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sync_id ON messages(sync_id)
--;;
-- Messages from before 1.8 keep their order: new ones get millisecond keys, far above any id.
UPDATE messages SET sort_key = id WHERE sort_key IS NULL
--;;
CREATE INDEX IF NOT EXISTS idx_messages_chat_sort ON messages(chat_id, sort_key, id)
--;;
CREATE TABLE IF NOT EXISTS cloud_ctl (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tracking INTEGER NOT NULL DEFAULT 0,
  applying INTEGER NOT NULL DEFAULT 0)
--;;
INSERT OR IGNORE INTO cloud_ctl (id, tracking, applying) VALUES (1, 0, 0)
--;;
-- applying is only ever set inside a transaction; never let it outlive one.
UPDATE cloud_ctl SET applying = 0
--;;
-- Records waiting for upload.
CREATE TABLE IF NOT EXISTS cloud_outbox (
  kind TEXT NOT NULL,
  sid TEXT NOT NULL,
  parent TEXT NOT NULL DEFAULT '',
  queued_at INTEGER NOT NULL,
  PRIMARY KEY (kind, sid))
--;;
-- What this device knows to be in the cloud: document, version, deleted, parts, size.
CREATE TABLE IF NOT EXISTS cloud_records (
  doc_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sid TEXT NOT NULL,
  mt INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  parts INTEGER NOT NULL DEFAULT 1,
  bytes INTEGER NOT NULL DEFAULT 0)
--;;
-- Downloaded messages and memories whose chat has not arrived yet.
CREATE TABLE IF NOT EXISTS cloud_parked (
  doc_id TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  mt INTEGER NOT NULL,
  payload TEXT NOT NULL,
  parked_at INTEGER NOT NULL)
--;;
-- Triggers are dropped and created again, so a newer build can change them.
-- Delete-then-insert rather than INSERT OR REPLACE: inside a trigger, the
-- conflict policy of the statement that fired it would win.
DROP TRIGGER IF EXISTS cloud_characters_ins
--;;
CREATE TRIGGER cloud_characters_ins AFTER INSERT ON characters BEGIN
  UPDATE characters SET sync_id = lower(hex(randomblob(16)))
    WHERE id = NEW.id AND COALESCE(NEW.sync_id, '') = '';
  DELETE FROM cloud_outbox WHERE kind = 'character' AND sid = (SELECT sync_id FROM characters WHERE id = NEW.id)
    AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    SELECT 'character', sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)
    FROM characters WHERE id = NEW.id AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
END
--;;
DROP TRIGGER IF EXISTS cloud_characters_upd
--;;
CREATE TRIGGER cloud_characters_upd AFTER UPDATE OF name, file_path, avatar_url, first_message, description_preview
ON characters WHEN NEW.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'character' AND sid = NEW.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('character', NEW.sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_characters_del
--;;
CREATE TRIGGER cloud_characters_del AFTER DELETE ON characters
WHEN OLD.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'character' AND sid = OLD.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('character', OLD.sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_personas_ins
--;;
CREATE TRIGGER cloud_personas_ins AFTER INSERT ON personas BEGIN
  UPDATE personas SET sync_id = lower(hex(randomblob(16)))
    WHERE id = NEW.id AND COALESCE(NEW.sync_id, '') = '';
  DELETE FROM cloud_outbox WHERE kind = 'persona' AND sid = (SELECT sync_id FROM personas WHERE id = NEW.id)
    AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    SELECT 'persona', sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)
    FROM personas WHERE id = NEW.id AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
END
--;;
DROP TRIGGER IF EXISTS cloud_personas_upd
--;;
CREATE TRIGGER cloud_personas_upd AFTER UPDATE OF name, file_path, avatar_url, description_preview, is_default
ON personas WHEN NEW.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'persona' AND sid = NEW.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('persona', NEW.sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_personas_del
--;;
CREATE TRIGGER cloud_personas_del AFTER DELETE ON personas
WHEN OLD.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'persona' AND sid = OLD.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('persona', OLD.sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_chats_ins
--;;
CREATE TRIGGER cloud_chats_ins AFTER INSERT ON chats BEGIN
  UPDATE chats SET sync_id = lower(hex(randomblob(16)))
    WHERE id = NEW.id AND COALESCE(NEW.sync_id, '') = '';
  DELETE FROM cloud_outbox WHERE kind = 'chat' AND sid = (SELECT sync_id FROM chats WHERE id = NEW.id)
    AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    SELECT 'chat', sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)
    FROM chats WHERE id = NEW.id AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
END
--;;
DROP TRIGGER IF EXISTS cloud_chats_upd
--;;
-- Not updated_at: a reply bumps it every time (touchChat), and the list order follows the messages anyway.
CREATE TRIGGER cloud_chats_upd AFTER UPDATE OF title, character_id, persona_id, model_id, effort, provider
ON chats WHEN NEW.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'chat' AND sid = NEW.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('chat', NEW.sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_chats_del
--;;
-- A chat's memory goes with it.
CREATE TRIGGER cloud_chats_del AFTER DELETE ON chats
WHEN OLD.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind IN ('chat', 'memory') AND sid = OLD.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('chat', OLD.sync_id, '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('memory', OLD.sync_id, OLD.sync_id, CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_messages_ins
--;;
-- A new message gets a sync_id and, unless it brings one (from the cloud or a
-- backup), a sort_key after every other message of its chat.
CREATE TRIGGER cloud_messages_ins AFTER INSERT ON messages BEGIN
  UPDATE messages SET
    sync_id = COALESCE(NULLIF(sync_id, ''), lower(hex(randomblob(16)))),
    sort_key = COALESCE(sort_key, max(CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER),
      COALESCE((SELECT MAX(sort_key) FROM messages WHERE chat_id = NEW.chat_id), 0) + 1))
    WHERE id = NEW.id AND (COALESCE(NEW.sync_id, '') = '' OR NEW.sort_key IS NULL);
  DELETE FROM cloud_outbox WHERE kind = 'message' AND sid = (SELECT sync_id FROM messages WHERE id = NEW.id)
    AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    SELECT 'message', m.sync_id, COALESCE((SELECT c.sync_id FROM chats c WHERE c.id = m.chat_id), ''),
      CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)
    FROM messages m WHERE m.id = NEW.id AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1);
END
--;;
DROP TRIGGER IF EXISTS cloud_messages_upd
--;;
CREATE TRIGGER cloud_messages_upd AFTER UPDATE OF role, content, thoughts, swipes_json, swipe_index, thought_swipes_json
ON messages WHEN NEW.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'message' AND sid = NEW.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('message', NEW.sync_id, COALESCE((SELECT c.sync_id FROM chats c WHERE c.id = NEW.chat_id), ''),
      CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_messages_del
--;;
-- parent: when the chat is deleted too, the message's document is removed outright.
CREATE TRIGGER cloud_messages_del AFTER DELETE ON messages
WHEN OLD.sync_id IS NOT NULL AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'message' AND sid = OLD.sync_id;
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('message', OLD.sync_id, COALESCE((SELECT c.sync_id FROM chats c WHERE c.id = OLD.chat_id), ''),
      CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_settings_insert
--;;
-- Only the settings that belong to the account; the rest are device state or secrets.
CREATE TRIGGER cloud_settings_insert AFTER INSERT ON settings
WHEN NEW.key IN ('selected_model', 'selected_effort', 'safety_threshold', 'project_id', 'active_persona_id')
  AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'settings' AND sid = 'settings';
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('settings', 'settings', '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
--;;
DROP TRIGGER IF EXISTS cloud_settings_update
--;;
CREATE TRIGGER cloud_settings_update AFTER UPDATE ON settings
WHEN NEW.key IN ('selected_model', 'selected_effort', 'safety_threshold', 'project_id', 'active_persona_id')
  AND (SELECT tracking = 1 AND applying = 0 FROM cloud_ctl WHERE id = 1) BEGIN
  DELETE FROM cloud_outbox WHERE kind = 'settings' AND sid = 'settings';
  INSERT INTO cloud_outbox (kind, sid, parent, queued_at)
    VALUES ('settings', 'settings', '', CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER));
END
