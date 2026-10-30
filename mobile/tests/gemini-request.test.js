// Documents what Gemini (and Claude on Vertex) receive besides the system
// prompt, mirroring generateRoleplayReply() in LocalBackendServer.java:
//
//   1. The whole chat history goes as alternating user/model turns, every
//      message text as stored: nothing is added, removed or rewritten, except
//      that the macros ({{user}}, {{char}}, {{charN}}) are filled in with names.
//   2. Consecutive messages of one side are joined with a blank line.
//   3. The API wants the first turn from the user: when the chat opens with
//      the character's greeting, the neutral marker "[Начало ролевой игры]"
//      goes before it. That is the only text the engine adds, and the prompt
//      preview in the app says so (deliveryNote in app.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadAppInternals } = require('./harness');

const OPENER = '[Начало ролевой игры]';
const MACRO = /\{\{(user|char(\d{0,5}))\}\}/gi;
const applyMacros = (text, m) => String(text || '').replace(MACRO, (all, word, digits) => {
  const v = word.toLowerCase() === 'user' ? m.user : (!digits ? m.alias : m.names[Number(digits)]);
  return v == null ? all : v;
});
const NO_NAMES = { user: null, alias: null, names: {} };

/** Mirror of the contents loop in generateRoleplayReply(). */
function buildContents(history, macros) {
  const contents = [];
  for (const m of history) {
    const role = m.role === 'user' ? 'user' : 'model';
    const text = applyMacros(m.content, macros || NO_NAMES).trim();
    if (!text) continue;
    if (!contents.length && role === 'model') contents.push({ role: 'user', parts: [{ text: OPENER }] });
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts[0].text += '\n\n' + text;
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '...' }] });
  return contents;
}

test('history goes through verbatim, including words a filter might flag', () => {
  const history = [
    { role: 'user', content: 'Школьная форма, сопротивление, всё как в сцене.' },
    { role: 'assistant', content: '*Кира молчит.*' },
  ];
  const out = buildContents(history);
  assert.deepStrictEqual(out.map(t => t.parts[0].text), [history[0].content, history[1].content]);
  assert.deepStrictEqual(out.map(t => t.role), ['user', 'model']);
});

test('macros in the history are filled in: the greeting keeps them as stored', () => {
  const macros = { user: 'Кадзума', alias: 'Юки', names: { 1: 'Юки', 2: 'Хана' } };
  const out = buildContents([
    { role: 'assistant', content: '*{{char1}} машет {{user}}, {{char2}} хмурится.*' },
    { role: 'user', content: 'Привет, {{char}}! {{char9}}?' },
  ], macros);
  assert.strictEqual(out[1].parts[0].text, '*Юки машет Кадзума, Хана хмурится.*');
  assert.strictEqual(out[2].parts[0].text, 'Привет, Юки! {{char9}}?');
});

test('a chat that opens with the greeting gets only the neutral opener turn', () => {
  const out = buildContents([
    { role: 'assistant', content: '«Ты опоздал.»' },
    { role: 'user', content: '«Пробки.»' },
  ]);
  assert.strictEqual(out[0].role, 'user');
  assert.strictEqual(out[0].parts[0].text, OPENER);
  assert.strictEqual(out[1].parts[0].text, '«Ты опоздал.»');
  assert.strictEqual(out.length, 3);
});

test('consecutive messages of one side are joined, never dropped', () => {
  const out = buildContents([
    { role: 'user', content: 'один' },
    { role: 'user', content: 'два' },
    { role: 'assistant', content: 'три' },
  ]);
  assert.strictEqual(out[0].parts[0].text, 'один\n\nдва');
  assert.strictEqual(out.length, 2);
});

test('the prompt preview names exactly what is added per provider', () => {
  const { deliveryNote } = loadAppInternals();
  assert.match(deliveryNote('gemini-4-argon'), /\[Начало ролевой игры\]/);
  assert.match(deliveryNote('claude-opus-5-5'), /не переписывается/);
  assert.match(deliveryNote('gemini-4-argon'), /<new_character name="…">/);
  // Claude Code: the directive of buildClaudeTranscript(), which no longer asks
  // to leave out "service marks" (that would drop <new_character> blocks).
  const single = deliveryNote('claude-code-opus', { name: 'Кира', card: null, fileContent: '…' });
  assert.match(single, /Продолжи ролевую игру одной следующей репликой за персонажа «Кира»\. Выведи только сам ответ персонажа без имени в начале и мета-комментариев\./);
  assert.doesNotMatch(single, /служебных пометок/);
  const several = deliveryNote('claude-code-opus', { name: 'Юки', card: { chars: [{ n: 1, name: 'Юки' }, { n: 2, name: 'Хана' }] } });
  assert.match(several, /подписаны «Рассказчик»/);
  assert.match(several, /Продолжи ролевую игру одной следующей репликой\. Выведи только сам ответ без имени в начале и мета-комментариев\./);
});
