// Documents the system prompt contract implemented by buildSystemPrompt() /
// readChatMemory() and the "CARDS, CAST & MACROS" section of
// LocalBackendServer.java. The JS mirror below must stay in sync with the Java
// code (same pattern as updates.test.js for OTA signing).
//
// Contract:
//   1. The user's "Системный промпт" (workspace GEMINI.md) comes first and is
//      the WHOLE instruction set — nothing hidden is prepended.
//   2. Below it, in this order and only when non-empty:
//        <character_persona>…</character_persona>
//            a free-text card: its file as it is;
//            a structured card: <world_settings>…</world_settings> and one
//            <character name="…">…</character> per character;
//            then one <character> block per character the replies introduced
//            (<new_character> blocks, kept with the variant each reply shows)
//        <user_persona name="…">…</user_persona>   (the chat's persona card)
//        <chat_memory>…</chat_memory>              (chat memory minus its heading)
//   3. Macros are filled in everywhere: {{user}} the persona's name, {{charN}}
//      character N (card first, then the replies'), {{char}} = {{char1}} or,
//      without one, the card's first character. An unknown one stays.
//   4. A card's or persona's title never reaches the model.
//   5. The legacy seed "# GEMINI.md" counts as empty. Lore is no longer used.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const MACRO = /\{\{(user|char(\d{0,5}))\}\}/gi;

function applyMacros(text, m) {
  return String(text == null ? '' : text).replace(MACRO, (all, word, digits) => {
    const v = word.toLowerCase() === 'user' ? m.user : (!digits ? m.alias : m.names.get(Number(digits)));
    return v == null ? all : v;
  });
}

const cardMembers = (card) => (card.chars || []).map(c => ({ n: c.n, name: c.name, text: c.text || '' }));

function cardCast(character) {
  if (character.card) return cardMembers(character.card);
  return [{ n: 1, name: character.name ?? 'Персонаж', text: character.fileContent ?? '' }];
}

function storyCast(history) {
  const out = [];
  for (const m of history || []) {
    if (m.role === 'user') continue;
    for (const c of m.cast || []) out.push({ n: c.n, name: c.name, text: c.text || '' });
  }
  return out;
}

/** Mirror of macrosFor(). */
function macrosFor(character, persona, history) {
  const card = cardCast(character);
  const names = new Map();
  for (const c of card.concat(storyCast(history))) if (!names.has(c.n)) names.set(c.n, c.name);
  return { names, alias: names.has(1) ? names.get(1) : (card.length ? card[0].name : null), user: persona.name ?? 'Игрок' };
}

const attrValue = (raw) => String(raw ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/"/g, "'").trim();

/** Mirror of renderCharacterBlocks(). */
function renderCharacterBlocks(members, macros) {
  return members.map(m => {
    const text = applyMacros(m.text, macros).trim();
    return `<character name="${attrValue(m.name)}">` + (text ? `\n${text}\n` : '') + '</character>';
  }).join('\n\n');
}

/** Mirror of renderCard(). */
function renderCard(card, macros) {
  const parts = [];
  const world = applyMacros(card.world || '', macros).trim();
  if (world) parts.push(`<world_settings>\n${world}\n</world_settings>`);
  const blocks = renderCharacterBlocks(cardMembers(card), macros);
  if (blocks) parts.push(blocks);
  return parts.join('\n\n');
}

/** Mirror of renderCardFile(): the card's own {{charN}} filled in, {{user}} and {{char}} kept. */
function renderCardFile(card) {
  const names = new Map();
  for (const c of cardMembers(card)) if (!names.has(c.n)) names.set(c.n, c.name);
  return renderCard(card, { names, alias: null, user: null });
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
function buildSystemPrompt({ rules, character, persona, memory, history }) {
  const macros = macrosFor(character, persona, history);
  let r = String(rules || '').trim();
  if (r === '# GEMINI.md') r = '';
  let charCard = character.card ? renderCard(character.card, macros) : applyMacros(String(character.fileContent || '').trim(), macros);
  const story = renderCharacterBlocks(storyCast(history), macros);
  if (story) charCard = charCard ? charCard + '\n\n' + story : story;
  const personaCard = String(persona.fileContent || '').trim();
  const mem = readChatMemory(memory);
  let sb = '';
  if (r) sb += applyMacros(r, macros) + '\n\n';
  if (charCard) sb += '<character_persona>\n' + charCard + '\n</character_persona>\n\n';
  if (personaCard) sb += `<user_persona name="${attrValue(persona.name ?? 'Игрок')}">\n` + applyMacros(personaCard, macros) + '\n</user_persona>\n\n';
  if (mem) sb += '<chat_memory>\n' + applyMacros(mem, macros) + '\n</chat_memory>\n\n';
  return sb.trim();
}

const base = {
  rules: 'Отвечай за {{char}}, не пиши за {{user}}.',
  character: { name: 'Кира', title: '', card: null, fileContent: 'Наёмница. Не любит {{user}}, когда тот опаздывает.' },
  persona: { name: 'Кадзума', title: 'Кадзума — маг', fileContent: 'Путешественник.' },
  memory: '# Память чата #1\n\n- обещал вернуться',
  history: [],
};

const tavern = {
  name: 'Юки',
  title: 'Таверна «Сломанный меч»',
  card: {
    v: 2,
    world: '{{char1}} и {{char2}} — сёстры, хозяйки таверны.',
    chars: [
      { n: 1, name: 'Юки', text: 'Младшая. Обожает {{user}}.' },
      { n: 2, name: 'Хана', text: 'Старшая. Ворчит на {{char}}.' },
    ],
    next: 3,
  },
  fileContent: '(файл для старых версий)',
};

test('user instructions come first, then the tagged cards and memory', () => {
  assert.strictEqual(buildSystemPrompt(base), [
    'Отвечай за Кира, не пиши за Кадзума.',
    '',
    '<character_persona>',
    'Наёмница. Не любит Кадзума, когда тот опаздывает.',
    '</character_persona>',
    '',
    '<user_persona name="Кадзума">',
    'Путешественник.',
    '</user_persona>',
    '',
    '<chat_memory>',
    '- обещал вернуться',
    '</chat_memory>',
  ].join('\n'));
});

test('empty parts are omitted entirely (no empty tags)', () => {
  const out = buildSystemPrompt({ ...base, rules: '', persona: { name: 'Кадзума', fileContent: '  ' }, memory: '# Память чата #7\n\n' });
  assert.ok(out.startsWith('<character_persona>'));
  assert.ok(!out.includes('<user_persona'));
  assert.ok(!out.includes('<chat_memory>'));
});

test('the legacy "# GEMINI.md" seed is not sent as an instruction', () => {
  const out = buildSystemPrompt({ ...base, rules: '# GEMINI.md\n\n' });
  assert.ok(!out.includes('GEMINI.md'));
  assert.ok(out.startsWith('<character_persona>'));
});

test('nothing at all yields an empty prompt', () => {
  assert.strictEqual(buildSystemPrompt({ character: { name: 'A', fileContent: '' }, persona: { name: 'B' }, history: [] }), '');
});

test('a structured card: world settings, a block per character, names for the macros, no title', () => {
  const out = buildSystemPrompt({ ...base, rules: 'Ты играешь {{char1}} и {{char2}}.', character: tavern, memory: '' });
  assert.strictEqual(out, [
    'Ты играешь Юки и Хана.',
    '',
    '<character_persona>',
    '<world_settings>',
    'Юки и Хана — сёстры, хозяйки таверны.',
    '</world_settings>',
    '',
    '<character name="Юки">',
    'Младшая. Обожает Кадзума.',
    '</character>',
    '',
    '<character name="Хана">',
    'Старшая. Ворчит на Юки.',
    '</character>',
    '</character_persona>',
    '',
    '<user_persona name="Кадзума">',
    'Путешественник.',
    '</user_persona>',
  ].join('\n'));
  assert.ok(!out.includes('Таверна'), 'the card title is not sent');
  assert.ok(!out.includes('Кадзума — маг'), 'the persona title is not sent');
  assert.ok(!out.includes('для старых версий'), 'a structured card is read from card_json, not its file');
});

test('characters the replies introduced follow the card, from the variant each reply shows', () => {
  const history = [
    { role: 'assistant', content: 'Привет', cast: [] },
    { role: 'user', content: '…', cast: [{ n: 9, name: 'Игнор', text: 'реплики игрока не вводят персонажей' }] },
    { role: 'assistant', content: 'На пороге Лира.', cast: [{ n: 3, name: 'Лира', text: 'Эльфийка. Знает {{char2}}.' }] },
  ];
  const out = buildSystemPrompt({ ...base, rules: 'Лира — это {{char3}}.', character: tavern, memory: '', history });
  assert.ok(out.startsWith('Лира — это Лира.'));
  assert.ok(out.includes('</character>\n\n<character name="Лира">\nЭльфийка. Знает Хана.\n</character>\n</character_persona>'));
  assert.ok(!out.includes('Игнор'));

  // A free-text card is followed by them too.
  const legacy = buildSystemPrompt({ ...base, rules: '', memory: '', history });
  assert.ok(legacy.startsWith('<character_persona>\nНаёмница. Не любит Кадзума, когда тот опаздывает.\n\n<character name="Лира">'));
});

test('a free-text card is character 1: {{char}} and {{char1}} are its name', () => {
  const out = buildSystemPrompt({ ...base, rules: '{{char}} / {{char1}} / {{Char}} / {{USER}}', memory: '', persona: { name: 'Кадзума' } });
  assert.ok(out.startsWith('Кира / Кира / Кира / Кадзума'));
});

test('an unknown number stays as written; {{char}} without a character 1 is the first one', () => {
  const card = { ...tavern, card: { ...tavern.card, chars: [{ n: 2, name: 'Хана', text: '' }] } };
  const out = buildSystemPrompt({ ...base, rules: '{{char}} {{char7}} {{charlie}}', character: card, memory: '' });
  assert.ok(out.startsWith('Хана {{char7}} {{charlie}}'));
  assert.ok(out.includes('<character name="Хана"></character>'), 'a character without a description is still named');
});

test('a world-only card sends the world; a quote in a name cannot break the tag', () => {
  const world = { name: 'Мир', title: 'Мир', card: { v: 2, world: 'Пустоши.', chars: [], next: 1 } };
  const out = buildSystemPrompt({ ...base, rules: '', character: world, memory: '', persona: { name: 'Ли "Тень"', fileContent: 'Я.' } });
  assert.strictEqual(out, '<character_persona>\n<world_settings>\nПустоши.\n</world_settings>\n</character_persona>\n\n<user_persona name="Ли \'Тень\'">\nЯ.\n</user_persona>');
});

test('the card file holds the same blocks with the card names, for older versions', () => {
  assert.strictEqual(renderCardFile(tavern.card), [
    '<world_settings>',
    'Юки и Хана — сёстры, хозяйки таверны.',
    '</world_settings>',
    '',
    '<character name="Юки">',
    'Младшая. Обожает {{user}}.',
    '</character>',
    '',
    '<character name="Хана">',
    'Старшая. Ворчит на {{char}}.',
    '</character>',
  ].join('\n'));
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
