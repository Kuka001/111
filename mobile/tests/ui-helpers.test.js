// Tests for the pure UI helpers behind the chat list, timestamps, avatars,
// provider-aware effort options and dialogue highlighting.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadAppInternals } = require('./harness');

const {
  escapeHtml,
  formatRoleplayHtml,
  highlightDialogue,
  providerOf,
  effortOptionsFor,
  effectiveEffort,
  parseServerTime,
  formatRelativeTime,
  formatMessageTime,
  pluralRu,
  initialsOf,
  hueFromString,
  sortChats,
  filterChats,
  isDefaultChatTitle,
} = loadAppInternals();

test('escapeHtml also neutralizes single quotes', () => {
  // Names like O'Neil used to break inline onclick handlers.
  assert.strictEqual(escapeHtml("O'Neil"), 'O&#39;Neil');
});

test('parseServerTime treats SQLite CURRENT_TIMESTAMP as UTC', () => {
  const d = parseServerTime('2026-10-25 12:30:05');
  assert.strictEqual(d.toISOString(), '2026-10-25T12:30:05.000Z');
  assert.strictEqual(parseServerTime('2026-10-25T12:30:05Z').toISOString(), '2026-10-25T12:30:05.000Z');
  assert.strictEqual(parseServerTime(''), null);
  assert.strictEqual(parseServerTime('not a date'), null);
});

test('formatRelativeTime produces compact list labels', () => {
  const now = new Date(2026, 9, 25, 18, 0, 0); // Sun 25 Oct 2026, local time
  assert.strictEqual(formatRelativeTime(new Date(2026, 9, 25, 17, 59, 30), now), 'только что');
  assert.strictEqual(formatRelativeTime(new Date(2026, 9, 25, 17, 55, 0), now), '5 мин');
  assert.strictEqual(formatRelativeTime(new Date(2026, 9, 25, 9, 7, 0), now), '09:07');
  assert.strictEqual(formatRelativeTime(new Date(2026, 9, 24, 23, 0, 0), now), 'вчера');
  assert.strictEqual(formatRelativeTime(new Date(2026, 9, 21, 12, 0, 0), now), 'ср');
  assert.strictEqual(formatRelativeTime(new Date(2026, 8, 3, 12, 0, 0), now), '3 сен');
  assert.strictEqual(formatRelativeTime(new Date(2025, 8, 3, 12, 0, 0), now), '03.09.25');
  assert.strictEqual(formatRelativeTime(null, now), '');
});

test('formatMessageTime shows the date only for older messages', () => {
  const now = new Date(2026, 9, 25, 18, 0, 0);
  assert.strictEqual(formatMessageTime(new Date(2026, 9, 25, 7, 5, 0), now), '07:05');
  assert.strictEqual(formatMessageTime(new Date(2026, 9, 12, 21, 4, 0), now), '12 окт, 21:04');
  assert.strictEqual(formatMessageTime(new Date(2025, 0, 2, 8, 0, 0), now), '2 янв 2025, 08:00');
});

test('pluralRu follows Russian plural rules', () => {
  const p = (n) => pluralRu(n, 'чат', 'чата', 'чатов');
  assert.deepStrictEqual([1, 2, 5, 11, 21, 22, 25, 111, 0].map(p), ['чат', 'чата', 'чатов', 'чатов', 'чат', 'чата', 'чатов', 'чатов', 'чатов']);
});

test('initialsOf and hueFromString are stable', () => {
  assert.strictEqual(initialsOf('Кира'), 'К');
  assert.strictEqual(initialsOf('анна мария'), 'АМ');
  assert.strictEqual(initialsOf('  '), '?');
  assert.strictEqual(hueFromString('Кира'), hueFromString('Кира'));
  assert.ok(hueFromString('Кира') >= 0 && hueFromString('Кира') < 360);
});

test('providerOf routes model ids like the native engine', () => {
  assert.strictEqual(providerOf('claude-code-opus'), 'cli');
  assert.strictEqual(providerOf('claude-sonnet-5-5'), 'vertex-claude');
  assert.strictEqual(providerOf('gemini-4-argon'), 'gemini');
  assert.strictEqual(providerOf(undefined), 'gemini');
});

test('effort options reflect what each provider really honours', () => {
  // Array.from: the helpers run in a separate vm realm.
  assert.deepStrictEqual(Array.from(effortOptionsFor('gemini-4-argon')), ['low', 'medium', 'high']);
  assert.deepStrictEqual(Array.from(effortOptionsFor('claude-code-sonnet')), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(Array.from(effortOptionsFor('claude-opus-5-5')), []);
  // Gemini sends MAX as HIGH, so the UI shows it as High.
  assert.strictEqual(effectiveEffort('gemini-4-argon', 'max'), 'high');
  assert.strictEqual(effectiveEffort('claude-code-opus', 'xhigh'), 'xhigh');
  assert.strictEqual(effectiveEffort('claude-opus-5-5', 'high'), '');
});

test('sortChats orders by last activity and falls back to id', () => {
  const chats = [
    { id: 1, last_activity: '2026-10-20 10:00:00' },
    { id: 2, last_activity: '2026-10-25 10:00:00' },
    { id: 3 },
    { id: 4 },
  ];
  assert.deepStrictEqual(sortChats(chats).map(c => c.id), [2, 1, 4, 3]);
  assert.deepStrictEqual(chats.map(c => c.id), [1, 2, 3, 4], 'input must not be mutated');
});

test('filterChats matches character, persona, title and preview text', () => {
  const chats = [
    { id: 1, character_id: 1, character_name: 'Кира', persona_name: 'Кадзума', title: 'Чат: Кира', last_message: '*кивает* Привет' },
    { id: 2, character_id: 2, character_name: 'Елена', persona_name: 'Странник', title: 'Архив', last_message: 'Тише' },
  ];
  assert.deepStrictEqual(filterChats(chats, { query: 'кир' }).map(c => c.id), [1]);
  assert.deepStrictEqual(filterChats(chats, { query: 'странник' }).map(c => c.id), [2]);
  assert.deepStrictEqual(filterChats(chats, { query: 'кивает' }).map(c => c.id), [1]);
  assert.deepStrictEqual(filterChats(chats, { characterId: 2 }).map(c => c.id), [2]);
  assert.deepStrictEqual(filterChats(chats, {}).map(c => c.id), [1, 2]);
});

test('isDefaultChatTitle recognises the auto-generated title', () => {
  assert.strictEqual(isDefaultChatTitle('Чат: Кира', 'Кира'), true);
  assert.strictEqual(isDefaultChatTitle('', 'Кира'), true);
  assert.strictEqual(isDefaultChatTitle('Ночной рейд', 'Кира'), false);
});

test('dialogue highlighting wraps quoted speech and stays escaped', () => {
  const out = formatRoleplayHtml('*кивает* «Привет.» И "ещё"', { dialogue: true });
  assert.ok(out.includes('<span class="rp-dialogue">«Привет.»</span>'));
  assert.ok(out.includes('<span class="rp-dialogue">&quot;ещё&quot;</span>'));
  assert.ok(out.includes('<em class="rp-italic">кивает</em>'));
  // Off by default: the attribute-quote test in markdown.test.js relies on it.
  assert.ok(!formatRoleplayHtml('«Привет.»').includes('rp-dialogue'));
  const evil = formatRoleplayHtml('«<img src=x onerror=alert(1)>»', { dialogue: true });
  assert.ok(!evil.includes('<img'));
  assert.strictEqual(highlightDialogue('без кавычек'), 'без кавычек');
});
