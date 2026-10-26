// Documents the system prompt contract implemented by buildSystemPrompt() /
// readChatMemory() in LocalBackendServer.java. The JS mirror below must stay in
// sync with the Java code (same pattern as updates.test.js for OTA signing).
//
// Contract:
//   1. The user's "Системный промпт" (workspace GEMINI.md) comes first and is
//      the WHOLE instruction set — nothing hidden is prepended.
//   2. Below it, in this order and only when non-empty:
//        <character_persona>…</character_persona>  (character card file)
//        <user_persona>…</user_persona>            (the chat's persona card)
//        <chat_memory>…</chat_memory>              (chat memory minus its heading)
//   3. {{char}} / {{user}} are substituted everywhere.
//   4. The legacy seed "# GEMINI.md" counts as empty. Lore is no longer used.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

function applyMacros(text, charName, userName) {
  return text.split('{{char}}').join(charName).split('{{user}}').join(userName);
}

function readChatMemory(text) {
  let t = String(text || '').trim();
  if (t.startsWith('# Память чата')) {
    const nl = t.indexOf('\n');
    t = nl >= 0 ? t.slice(nl + 1).trim() : '';
  }
  return t;
}

/** Mirror of buildSystemPrompt() in LocalBackendServer.java. */
function buildSystemPrompt({ rules, charName, charCard, userName, personaCard, memory }) {
  let r = String(rules || '').trim();
  if (r === '# GEMINI.md') r = '';
  const mem = readChatMemory(memory);
  let sb = '';
  if (r) sb += applyMacros(r, charName, userName) + '\n\n';
  if (charCard && charCard.trim()) sb += '<character_persona>\n' + applyMacros(charCard.trim(), charName, userName) + '\n</character_persona>\n\n';
  if (personaCard && personaCard.trim()) sb += '<user_persona>\n' + applyMacros(personaCard.trim(), charName, userName) + '\n</user_persona>\n\n';
  if (mem) sb += '<chat_memory>\n' + applyMacros(mem, charName, userName) + '\n</chat_memory>\n\n';
  return sb.trim();
}

const base = {
  rules: 'Отвечай за {{char}}, не пиши за {{user}}.',
  charName: 'Кира',
  charCard: 'Наёмница. Не любит {{user}}, когда тот опаздывает.',
  userName: 'Кадзума',
  personaCard: 'Путешественник.',
  memory: '# Память чата #1\n\n- обещал вернуться',
};

test('user instructions come first, then the tagged cards and memory', () => {
  assert.strictEqual(buildSystemPrompt(base), [
    'Отвечай за Кира, не пиши за Кадзума.',
    '',
    '<character_persona>',
    'Наёмница. Не любит Кадзума, когда тот опаздывает.',
    '</character_persona>',
    '',
    '<user_persona>',
    'Путешественник.',
    '</user_persona>',
    '',
    '<chat_memory>',
    '- обещал вернуться',
    '</chat_memory>',
  ].join('\n'));
});

test('empty parts are omitted entirely (no empty tags)', () => {
  const out = buildSystemPrompt({ ...base, rules: '', personaCard: '  ', memory: '# Память чата #7\n\n' });
  assert.ok(out.startsWith('<character_persona>'));
  assert.ok(!out.includes('<user_persona>'));
  assert.ok(!out.includes('<chat_memory>'));
});

test('the legacy "# GEMINI.md" seed is not sent as an instruction', () => {
  const out = buildSystemPrompt({ ...base, rules: '# GEMINI.md\n\n' });
  assert.ok(!out.includes('GEMINI.md'));
  assert.ok(out.startsWith('<character_persona>'));
});

test('nothing at all yields an empty prompt', () => {
  assert.strictEqual(buildSystemPrompt({ charName: 'A', userName: 'B' }), '');
});

// Builds before 1.6 created every memory file from a template; tidyChatFiles()
// in LocalBackendServer.java rewrites such files to the plain heading, so the
// template never reaches the model as if it were the user's notes.
const LEGACY_MEMORY_TEMPLATE = /^# Память ролевого чата #\d+ \([^\n]*\)\s*(?:- Чат начат\.)?\s*$/;

test('the legacy auto-created memory template is recognised, real notes are not', () => {
  assert.ok(LEGACY_MEMORY_TEMPLATE.test('# Память ролевого чата #4 (Эльза и Юна & Казума)\n\n- Чат начат.'));
  assert.ok(LEGACY_MEMORY_TEMPLATE.test('# Память ролевого чата #8 (Ллиэн & Аня)'));
  assert.ok(!LEGACY_MEMORY_TEMPLATE.test('# Память ролевого чата #4 (Эльза & Казума)\n\n- Чат начат.\n- Кадзума обещал вернуться.'));
  assert.strictEqual(readChatMemory('# Память чата #4\n\n'), '');
});
