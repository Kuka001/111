// Documents what Gemini (and Claude on Vertex) receive besides the system
// prompt, mirroring generateRoleplayReply() in LocalBackendServer.java:
//
//   1. The whole chat history goes as alternating user/model turns, every
//      message text exactly as stored: nothing is added, removed or rewritten.
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

/** Mirror of the contents loop in generateRoleplayReply(). */
function buildContents(history) {
  const contents = [];
  for (const m of history) {
    const role = m.role === 'user' ? 'user' : 'model';
    const text = String(m.content || '').trim();
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
  assert.match(deliveryNote('claude-opus-5-5'), /без изменений/);
  assert.match(deliveryNote('claude-code-opus'), /Продолжи ролевую игру одной следующей репликой/);
});
