// Tests for the end-to-end encrypted cloud formats.
//
// A Node mirror of CloudCrypto.java (android/src/com/agy/roleplay/): key
// derivation, document ids, sealed records, wrapped vault keys and recovery
// codes. The fixed vectors are the same ones android/tests/CloudCryptoTest.java
// checks on the JVM, and BLOB3 was sealed by Java. A change on either side that
// alters these bytes would make every phone unable to read its cloud copy.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const seq = (start, n) => Buffer.from(Array.from({ length: n }, (_, i) => (start + i) & 255));
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const hex = (b) => Buffer.from(b).toString('hex');

/** Mirrors CloudCrypto: subkeys of the data key. */
const encKey = (dek) => hmac(dek, 'agy/enc/v1');
const idKey = (dek) => hmac(dek, 'agy/id/v1');
const keyId = (dek) => hex(hmac(dek, 'agy/kid/v1')).slice(0, 16);
const docId = (idKey, kind, sid) => hex(hmac(idKey, kind + '\n' + sid)).slice(0, 32);

const recordAad = (header, uid, docId) => Buffer.concat([header, Buffer.from('agy/rec/v1|' + uid + '|' + docId, 'utf8')]);

/** Mirrors CloudCrypto.seal(): [1][flags][IV 12][AES-256-GCM ciphertext + tag]. */
function seal(key, plain, uid, docId, iv, deflate) {
  let body = plain;
  let flags = 0;
  if (deflate) {
    const packed = zlib.deflateRawSync(plain);
    if (packed.length < plain.length) {
      body = packed;
      flags = 1;
    }
  }
  const header = Buffer.from([1, flags]);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(recordAad(header, uid, docId));
  return Buffer.concat([header, iv, c.update(body), c.final(), c.getAuthTag()]);
}

/** Mirrors CloudCrypto.open(). */
function open(key, blob, uid, docId) {
  if (blob.length < 2 + 12 + 16) throw new Error('record too short');
  if (blob[0] !== 1) throw new Error('unsupported record version');
  if (blob[1] & ~1) throw new Error('unknown record flags');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(2, 14));
  d.setAAD(recordAad(blob.subarray(0, 2), uid, docId));
  d.setAuthTag(blob.subarray(blob.length - 16));
  const body = Buffer.concat([d.update(blob.subarray(14, blob.length - 16)), d.final()]);
  return blob[1] & 1 ? zlib.inflateRawSync(body, { maxOutputLength: 32 * 1024 * 1024 }) : body;
}

/** Mirrors CloudCrypto.passwordKey(): PBKDF2-HMAC-SHA256 over the NFC UTF-8 password. */
const passwordKey = (password, salt, iterations) =>
  crypto.pbkdf2Sync(Buffer.from(password.normalize('NFC'), 'utf8'), salt, iterations, 32, 'sha256');

function wrapKey(key, dek, uid, slot, iv) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('agy/vault/v1|' + uid + '|' + slot, 'utf8'));
  return Buffer.concat([iv, c.update(dek), c.final(), c.getAuthTag()]);
}

function unwrapKey(key, wrapped, uid, slot) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12));
  d.setAAD(Buffer.from('agy/vault/v1|' + uid + '|' + slot, 'utf8'));
  d.setAuthTag(wrapped.subarray(wrapped.length - 16));
  return Buffer.concat([d.update(wrapped.subarray(12, wrapped.length - 16)), d.final()]);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Mirrors CloudCrypto.formatRecoveryCode(). */
function formatRecoveryCode(raw) {
  let bits = 0;
  let buf = 0;
  let out = '';
  for (const b of raw) {
    buf = ((buf << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{1,4}/g).join('-');
}

/** Mirrors CloudCrypto.parseRecoveryCode(): null when invalid. */
function parseRecoveryCode(code) {
  const clean = String(code).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 32 || [...clean].some(c => !CROCKFORD.includes(c))) return null;
  const out = [];
  let bits = 0;
  let buf = 0;
  for (const c of clean) {
    buf = ((buf << 5) | CROCKFORD.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const recoveryKey = (raw) => hmac(raw, 'agy/recovery/v1');

// ---- the shared vectors (android/tests/CloudCryptoTest.java) --------------------
const DEK = seq(0, 32);
const UID = 'uid-test-0001';
const SID = '0123456789abcdef0123456789abcdef';
const P1 = '{"k":"message","sid":"0123456789abcdef0123456789abcdef","mt":1761470000000,"content":"Привет, мир! *улыбается*"}';
const P2 = '{"k":"message","sid":"' + SID + '","mt":1761470000001,"content":"' + 'Длинная реплика. '.repeat(40) + '"}';
const V = {
  encKey: '04bfc0d4b0c67a0ce0f6907209ae873fb131c574afd7ddfa979061156154d108',
  idKey: '98f024947690274391ff22284f9e4cadc6a68ed8e71849af0b9a1f4d9916e41b',
  kid: 'c49b1c12fbdcbc0c',
  docId: '1dc645cc94c8526c3b1238e19f49d5de',
  blob1: '0100a0a1a2a3a4a5a6a7a8a9aaab7f241e46df4489c6b7b5205ac41e32adc025e0ecac1ef4389e92b011040802bd'
    + '519860efb94d00477b5e41fae979ad0239b06a21daab87d58c0ef7c9fd10219adde8ddda5e2224dca7f0a57c57d44ff67cc48e97ec2df44d'
    + '77289d9a034703be2e44b04f1029a439252a34aa242e63d6d455db9b8323ee9f13790b512012c218776964ea978666ce4b2cea539ddd4304878a',
  blob2: '0101b0b1b2b3b4b5b6b7b8b9babb35f5ea4b78bc03a184667e977aa5f5b0767ca3a037954a6f0149f94fe7e1a129e4'
    + 'cfd0e7350fdfef1e45fa10cfa075e4ffea3f296c9552c5ed3416b28a6850b8e18524bfefccf656cdb75aafded997d34d7aa5c4a0ba7c3b5ee'
    + 'f4fa1c9d2da95ece1e22a94f6825515a972347577a80432edf484ae05519b1ca38a2c12e53f03bd',
  blob3: '0101e0e1e2e3e4e5e6e7e8e9eaeb8f6af39e4cdfe4e2a2316cd4bc312d35742b2cc58a40651eda4759bec4929e0'
    + '14f2c97b7364c74c9b345b3509be5205747be207d3b0588f50c2ceb05fdb4c760874d7cfa0b3aa5e5e44b089ea186d80b69d6f67f4c1f431'
    + '7617743d84603c621f07f70be062e79de80c9880544ad9f1b232e66f3faaf5d4b70ed7683',
  kek: 'e0408ad3d4cf898a20faefd5f12f3f71f0688ac6348715b74974d12aee3dbe93',
  pwWrapped: 'c0c1c2c3c4c5c6c7c8c9cacbef286a0aea9f2db15ec0fe8dbd040277ae4a352269617c347b514aaabe8851596d00'
    + '4b9e95ca66e3114ae4c0766f22df',
  kekTajnyj: '200635afc24d7351ac71ec30da754412f92315ac32897885fd870f9f41067fec',
  code: '000G-40R4-0M30-E209-185G-R38E-1W81-24GK',
  rk: '42016050bfc0356055604e42ac95ac6e2d4b8c435080d9ebc19afce9534a637b',
  rcWrapped: 'd0d1d2d3d4d5d6d7d8d9dadbb6cc36b04bc3bf16c793f5e678f59c58e21baaa6a68ac5d13237380e5ddcafcec8aa'
    + '2a67e3a0431ecccb1025e1c4af9d',
};

test('subkeys, vault id and document ids match the Java vectors', () => {
  assert.strictEqual(hex(encKey(DEK)), V.encKey);
  assert.strictEqual(hex(idKey(DEK)), V.idKey);
  assert.strictEqual(keyId(DEK), V.kid);
  assert.strictEqual(docId(idKey(DEK), 'message', SID), V.docId);
  assert.notStrictEqual(docId(idKey(DEK), 'chat', SID), V.docId);
});

test('an uncompressed record is byte-for-byte the Java vector', () => {
  const blob = seal(encKey(DEK), Buffer.from(P1, 'utf8'), UID, V.docId, seq(0xa0, 12), false);
  assert.strictEqual(hex(blob), V.blob1);
  assert.strictEqual(open(encKey(DEK), blob, UID, V.docId).toString('utf8'), P1);
});

test('records deflated by Node and by Java both open', () => {
  for (const b of [V.blob2, V.blob3]) {
    assert.strictEqual(open(encKey(DEK), Buffer.from(b, 'hex'), UID, V.docId).toString('utf8'), P2);
  }
  assert.strictEqual(seal(encKey(DEK), Buffer.from(P2, 'utf8'), UID, V.docId, seq(0xb0, 12), true)[1], 1);
});

test('a record does not open for another account, document or a changed byte', () => {
  const blob = Buffer.from(V.blob1, 'hex');
  assert.throws(() => open(encKey(DEK), blob, 'uid-other', V.docId));
  assert.throws(() => open(encKey(DEK), blob, UID, V.docId.slice(0, 31) + 'f'));
  assert.throws(() => open(idKey(DEK), blob, UID, V.docId));
  for (const i of [0, 1, 5, 20, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[i] ^= 1;
    assert.throws(() => open(encKey(DEK), bad, UID, V.docId), `byte ${i}`);
  }
});

test('the password key is PBKDF2 over the NFC UTF-8 password', () => {
  assert.strictEqual(hex(passwordKey('Пароль для теста 2026', seq(0x10, 16), 1000)), V.kek);
  const nfd = 'Тайный ключ'.normalize('NFD');
  assert.notStrictEqual(nfd, 'Тайный ключ');
  assert.strictEqual(hex(passwordKey(nfd, seq(0x10, 16), 1000)), V.kekTajnyj);
});

test('wrapped data keys match Java and need the right key, account and slot', () => {
  const kek = Buffer.from(V.kek, 'hex');
  const wrapped = wrapKey(kek, DEK, UID, 'pw', seq(0xc0, 12));
  assert.strictEqual(hex(wrapped), V.pwWrapped);
  assert.deepStrictEqual(unwrapKey(kek, wrapped, UID, 'pw'), DEK);
  assert.throws(() => unwrapKey(kek, wrapped, UID, 'rc'));
  assert.throws(() => unwrapKey(kek, wrapped, 'uid-other', 'pw'));
  assert.throws(() => unwrapKey(passwordKey('Пароль для теста 2025', seq(0x10, 16), 1000), wrapped, UID, 'pw'));
});

test('recovery codes: Crockford base32, lenient parsing, shared key', () => {
  const raw = seq(0, 20);
  assert.strictEqual(formatRecoveryCode(raw), V.code);
  assert.deepStrictEqual(parseRecoveryCode(V.code), raw);
  assert.deepStrictEqual(parseRecoveryCode('ooog 4or4 om3o e2o9 l85g r38e iw8l 24gk'), raw);
  assert.strictEqual(parseRecoveryCode(V.code.slice(0, -1) + 'U'), null);
  assert.strictEqual(parseRecoveryCode('000G-40R4'), null);
  assert.strictEqual(hex(recoveryKey(raw)), V.rk);
  assert.strictEqual(hex(wrapKey(recoveryKey(raw), DEK, UID, 'rc', seq(0xd0, 12))), V.rcWrapped);
});
