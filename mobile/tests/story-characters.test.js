// Characters a reply introduces, mirroring extractNewCharacters() and
// numberNewCharacters() in LocalBackendServer.java ("CARDS, CAST & MACROS"),
// plus the web layer's own helpers (macros, the live reply, labels).
//
// Contract:
//   1. The user's system prompt asks the model to describe a new main
//      character in a <new_character name="…">…</new_character> block. The
//      engine takes every such block out of the reply (anywhere in it; one left
//      open runs to the end) and keeps it with that reply variant; the rest of
//      the reply stays as written, only tidied where blocks were taken out.
//   2. Without a name attribute, a first line "Имя: …" names the character;
//      with neither, it is "Без имени".
//   3. Numbers continue after the card's (its "next") and after every number
//      used in the chat, all variants included. A name the cast already has is
//      skipped: a character is described once.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadAppInternals } = require('./harness');

const UNNAMED = 'Без имени';
const cleanCastName = (raw) => String(raw || '').replace(/[\x00-\x1f\x7f"<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();

/** Mirror of extractNewCharacters(). */
function extractNewCharacters(reply) {
  const src = String(reply || '');
  const blocks = [];
  const re = /<\s*new_character\b([^>]*)>([\s\S]*?)(?:<\s*\/\s*new_character\s*>|$)/gi;
  let rest = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    rest += src.slice(last, m.index) + '\n\n';
    last = m.index + m[0].length;
    const nm = m[1].match(/name\s*=\s*(?:"([^"]*)"|'([^']*)'|«([^»]*)»|“([^”]*)”|([^\s>]+))/i);
    let name = nm ? (nm[1] ?? nm[2] ?? nm[3] ?? nm[4] ?? nm[5] ?? '') : '';
    let body = m[2].trim();
    if (!cleanCastName(name)) {
      const nl = body.indexOf('\n');
      const line = (nl >= 0 ? body.slice(0, nl) : body).match(/^\s*(?:Имя|Name)\s*:\s*(.+)$/i);
      if (line) {
        name = line[1];
        body = nl >= 0 ? body.slice(nl + 1).trim() : '';
      }
    }
    name = cleanCastName(name);
    blocks.push({ name: name || UNNAMED, text: body.slice(0, 200000) });
    if (m[0].length === 0) re.lastIndex++;
  }
  if (!blocks.length) return { text: src, blocks };
  rest += src.slice(last);
  return { text: rest.replace(/```[\w-]*\s*```/g, '').replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').trim(), blocks };
}

/** Mirror of numberNewCharacters(): cardNames + storyNames are the cast's, usedNums every number in the chat. */
function numberNewCharacters({ cardNext, usedNums, castNames }, blocks) {
  const taken = new Set(castNames.map(n => n.trim().toLowerCase()));
  let next = Math.max(cardNext, Math.max(0, ...usedNums) + 1);
  const out = [];
  for (const b of blocks) {
    if (out.length >= 20) break;
    const key = b.name.toLowerCase();
    if (b.name !== UNNAMED && taken.has(key)) continue;
    taken.add(key);
    out.push({ n: next++, name: b.name, text: b.text });
  }
  return out;
}

test('a block at the end is taken out; the reply keeps the short introduction', () => {
  const reply = '*Дверь хлопает. На пороге высокая эльфийка.*\n\nЛира: Комнаты есть?\n\n<new_character name="Лира">\nЭльфийка-следопыт, 28 лет.\nИщет брата.\n</new_character>';
  const out = extractNewCharacters(reply);
  assert.strictEqual(out.text, '*Дверь хлопает. На пороге высокая эльфийка.*\n\nЛира: Комнаты есть?');
  assert.deepStrictEqual(out.blocks, [{ name: 'Лира', text: 'Эльфийка-следопыт, 28 лет.\nИщет брата.' }]);
});

test('a reply without blocks stays exactly as the model wrote it', () => {
  const reply = '*Тишина.*\n\n\n\nКира: Ну?  ';
  assert.deepStrictEqual(extractNewCharacters(reply), { text: reply, blocks: [] });
});

test('blocks anywhere, several at once, odd quotes, an unclosed one at the end, a code fence around one', () => {
  const reply = 'Начало.\n\n```xml\n<New_Character name=Мира>Танцовщица.</new_character>\n```\n\nСередина.\n\n<new_character name=«Тамар»>\nКузнец.\n</new_character>\n\nКонец.\n\n<new_character name="Велена">\nОборвано на полусло';
  const out = extractNewCharacters(reply);
  assert.strictEqual(out.text, 'Начало.\n\nСередина.\n\nКонец.');
  assert.deepStrictEqual(out.blocks.map(b => b.name), ['Мира', 'Тамар', 'Велена']);
  assert.strictEqual(out.blocks[2].text, 'Оборвано на полусло');
});

test('a name comes from "Имя:" when the tag has none; otherwise it is "Без имени"; quotes and brackets go', () => {
  assert.deepStrictEqual(extractNewCharacters('<new_character>\nИмя: Дан\nСтражник.\n</new_character>').blocks, [{ name: 'Дан', text: 'Стражник.' }]);
  assert.deepStrictEqual(extractNewCharacters('<new_character>\nСтражник.\n</new_character>').blocks, [{ name: UNNAMED, text: 'Стражник.' }]);
  assert.strictEqual(extractNewCharacters('<new_character name=“Ли Тень”>x</new_character>').blocks[0].name, 'Ли Тень');
  assert.strictEqual(extractNewCharacters('<new_character>\nИмя: Ли <Тень> "Ночь"\nx</new_character>').blocks[0].name, 'Ли Тень Ночь');
});

test('numbers continue after the card and every number in the chat; known names are skipped', () => {
  const blocks = [{ name: 'Лира', text: 'a' }, { name: 'юки', text: 'b' }, { name: 'Мира', text: 'c' }, { name: 'Мира', text: 'd' }];
  // Card: Юки (1), Хана (2), next 3; the chat already used 3 and 5 (another variant).
  const out = numberNewCharacters({ cardNext: 3, usedNums: [3, 5], castNames: ['Юки', 'Хана'] }, blocks);
  assert.deepStrictEqual(out, [{ n: 6, name: 'Лира', text: 'a' }, { n: 7, name: 'Мира', text: 'c' }]);
  // A free-text card is character 1 (next 2) and the first reply's character becomes {{char2}}.
  assert.deepStrictEqual(numberNewCharacters({ cardNext: 2, usedNums: [], castNames: ['Кира'] }, [{ name: 'Лира', text: '' }])[0].n, 2);
});

// ---------------------------------------------------------------------------
// The web layer (app.js)
const app = loadAppInternals();
// Arrays and objects made inside app.js belong to its sandbox: compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const tavern = {
  name: 'Юки',
  title: 'Таверна',
  card: { v: 2, world: '', chars: [{ n: 1, name: 'Юки', text: '' }, { n: 2, name: 'Хана', text: '' }], next: 3 },
};
const history = [
  { id: 1, role: 'assistant', content: '{{char1}} машет {{user}}.', cast: [] },
  { id: 2, role: 'user', content: 'Привет, {{char2}}!', cast: [] },
  { id: 3, role: 'assistant', content: 'Входит Лира.', cast: [{ n: 3, name: 'Лира', text: 'Эльфийка.' }], cast_swipes: [[], [{ n: 3, name: 'Лира', text: 'Эльфийка.' }]] },
];

test('the chat fills in names the way the engine does: card, then the replies, unknown ones stay', () => {
  const macros = app.castMacros(tavern, { name: 'Кадзума' }, history);
  assert.strictEqual(app.applyMacros('{{char}}, {{CHAR2}}, {{char3}}, {{char4}} и {{User}}', macros), 'Юки, Хана, Лира, {{char4}} и Кадзума');
  // Without a persona (a card on its own) {{user}} stays.
  assert.strictEqual(app.applyMacros('{{user}} и {{char1}}', app.castMacros(tavern, null, [])), '{{user}} и Юки');
  // A free-text card is character 1.
  assert.strictEqual(app.applyMacros('{{char}}={{char1}}', app.castMacros({ name: 'Кира', card: null, fileContent: '…' }, null, [])), 'Кира=Кира');
  assert.deepStrictEqual(plain(app.storyCast(history).map(c => [c.n, c.name, c.msgId])), [[3, 'Лира', 3]]);
});

test('a live reply hides its <new_character> blocks, also while the tag is still arriving', () => {
  const split = (t) => plain(app.splitLiveText(t));
  assert.deepStrictEqual(split('Текст.\n\n<new_character name="Лира">\nЭльф'), { text: 'Текст.', names: ['Лира'] });
  assert.deepStrictEqual(split('Текст.\n\n<new_character na'), { text: 'Текст.', names: [''] });
  assert.deepStrictEqual(split('Текст. <new_'), { text: 'Текст. ', names: [] });
  assert.deepStrictEqual(split('А <new_character name="Лира">x</new_character>\n\n\n\nБ'), { text: 'А \n\nБ', names: ['Лира'] });
  assert.deepStrictEqual(split('Просто текст < 5'), { text: 'Просто текст < 5', names: [] });
});

test('labels: a card is shown by its title, else its name; a persona likewise', () => {
  assert.strictEqual(app.cardLabel(tavern), 'Таверна');
  assert.strictEqual(app.cardLabel({ name: 'Кира', title: '  ' }), 'Кира');
  assert.strictEqual(app.personaLabel({ name: 'Кадзума', title: 'Кадзума — маг' }), 'Кадзума — маг');
  assert.strictEqual(app.personaLabel({ name: 'Странник', title: '' }), 'Странник');
});

test('deleting replies warns about the characters any of their variants introduced', () => {
  assert.strictEqual(app.castLossNote([history[2]]), ' Вместе с ним удалятся персонажи из ответов: Лира.');
  assert.strictEqual(app.castLossNote([history[0], history[1]]), '');
});
