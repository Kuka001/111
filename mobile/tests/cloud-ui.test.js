// Tests for the cloud page's pure helpers: the encryption-password meter and
// the one-line status shown in Settings (from /api/cloud/status).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadAppInternals } = require('./harness');

const { passwordStrength, cloudSummary, formatBytes, agoText } = loadAppInternals();

test('a password shorter than the minimum is never accepted', () => {
  const st = passwordStrength('Qw3!xZ9#', 10);
  assert.strictEqual(st.ok, false);
  assert.match(st.hint, /Ещё 2 символа/);
  assert.strictEqual(passwordStrength('', 10).ok, false);
});

test('obvious and repetitive passwords are weak however long', () => {
  for (const pw of ['aaaaaaaaaaaaaaaa', '1234567890123', 'qwertyuiopasdf', 'пароль12345678', 'Password12345']) {
    const st = passwordStrength(pw, 10);
    assert.strictEqual(st.score, 1, pw);
    assert.strictEqual(st.ok, false, pw);
  }
});

test('a passphrase of several words is strong, also in Cyrillic', () => {
  for (const pw of ['correct horse battery staple', 'мой кот любит зимний чай']) {
    const st = passwordStrength(pw, 10);
    assert.strictEqual(st.score, 4, pw);
    assert.strictEqual(st.ok, true, pw);
    assert.strictEqual(st.label, 'Сильный');
  }
});

test('length counts characters, not UTF-16 units', () => {
  assert.strictEqual(passwordStrength('😀😀😀😀😀😀😀😀😀', 10).hint, 'Ещё 1 символ');
});

test('cloudSummary walks the set-up steps in order', () => {
  assert.strictEqual(cloudSummary(null).label, 'Настроить');
  assert.match(cloudSummary({ configured: false }).text, /только на этом телефоне/);
  assert.strictEqual(cloudSummary({ configured: true, signedIn: false }).label, 'Войти');
  assert.match(cloudSummary({ configured: true, signedIn: false, linked: true }).text, /истёк/);
  assert.match(cloudSummary({ configured: true, signedIn: true, vault: 'none' }).text, /пароль шифрования/);
  assert.strictEqual(cloudSummary({ configured: true, signedIn: true, vault: 'locked' }).label, 'Пароль');
  assert.strictEqual(cloudSummary({ configured: true, signedIn: true, vault: 'unknown' }).tone, '');
});

test('cloudSummary when ready: progress, quota, errors, last sync and queue', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0);
  const base = { configured: true, signedIn: true, vault: 'ready', email: 'me@gmail.com' };
  const busy = cloudSummary(Object.assign({ busy: true, phase: 'upload', done: 120, total: 3400 }, base), now);
  // formatCount groups thousands with a narrow no-break space.
  assert.strictEqual(busy.text, 'me@gmail.com · загрузка в облако 120 из 3 400…');
  assert.strictEqual(cloudSummary(Object.assign({ quotaUntil: 1 }, base), now).label, 'Лимит');
  const err = cloudSummary(Object.assign({ lastError: 'Firestore отказал в доступе', errorKind: 'permission' }, base), now);
  assert.deepStrictEqual([err.tone, err.text], ['err', 'Firestore отказал в доступе']);
  const skipped = cloudSummary(Object.assign({ lastError: '2 зап.', errorKind: 'skipped', lastSyncAt: now.getTime() - 5 * 60000 }, base), now);
  assert.strictEqual(skipped.tone, 'ok', 'unreadable records are reported on the page, not as an error');
  assert.strictEqual(skipped.text, 'me@gmail.com · синхронизировано 5 мин назад');
  assert.strictEqual(cloudSummary(Object.assign({ pending: 3 }, base), now).text, 'me@gmail.com · ещё не синхронизировано · в очереди 3');
});

test('sizes and times read naturally', () => {
  assert.strictEqual(formatBytes(512), '512 Б');
  assert.strictEqual(formatBytes(20 * 1024), '20 КБ');
  assert.strictEqual(formatBytes(18.4 * 1024 * 1024), '18,4 МБ');
  const now = new Date(2026, 9, 26, 12, 0, 0);
  assert.strictEqual(agoText(now.getTime() - 10000, now), 'только что');
  assert.strictEqual(agoText(now.getTime() - 3 * 60000, now), '3 мин назад');
  assert.strictEqual(agoText(new Date(2026, 9, 26, 9, 5).getTime(), now), '09:05');
  assert.strictEqual(agoText(0, now), '');
});
