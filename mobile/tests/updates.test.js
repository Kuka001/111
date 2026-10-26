// Tests for update-decision logic and the OTA signing payload.
//
// These mirror the Java implementations in LocalBackendServer.java:
//   compareSemver / nativeUpdateRequired  -> handleUpdatesCheck
//   buildOtaManifestPayload               -> OTA signature gate
// Keeping a JS mirror under test documents the contract and catches changes to
// the canonical payload, which would silently invalidate every signature.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

/** Mirror of compareSemver() in LocalBackendServer.java. */
function compareSemver(v1, v2) {
  const parse = (v) => String(v ?? '0.0.0').replace(/[^0-9.]/g, '').split('.');
  const p1 = parse(v1);
  const p2 = parse(v2);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const n1 = Number.parseInt(p1[i] ?? '', 10) || 0;
    const n2 = Number.parseInt(p2[i] ?? '', 10) || 0;
    if (n1 !== n2) return n1 > n2 ? 1 : -1;
  }
  return 0;
}

test('compareSemver orders versions numerically, not lexically', () => {
  assert.strictEqual(compareSemver('1.4.6', '1.4.5'), 1);
  assert.strictEqual(compareSemver('1.4.5', '1.4.6'), -1);
  assert.strictEqual(compareSemver('1.4.6', '1.4.6'), 0);
  // The classic string-compare trap: "1.4.10" < "1.4.9" lexically.
  assert.strictEqual(compareSemver('1.4.10', '1.4.9'), 1);
  assert.strictEqual(compareSemver('1.10.0', '1.9.9'), 1);
});

test('compareSemver tolerates prefixes, blanks and missing parts', () => {
  assert.strictEqual(compareSemver('v1.4.6', '1.4.6'), 0);
  assert.strictEqual(compareSemver('1.5', '1.5.0'), 0);
  assert.strictEqual(compareSemver(null, undefined), 0);
  assert.strictEqual(compareSemver('2.0', '1.9.9'), 1);
});

/** Mirror of the decision in handleUpdatesCheck(): a web layer fits exactly one APK build. */
function updateDecision({ latestVersion, latestBuild, currentVersion, bundledBuild }) {
  const nativeUpdateRequired = latestBuild > bundledBuild;
  const otaAvailable = latestBuild === bundledBuild && compareSemver(latestVersion, currentVersion) > 0;
  return { nativeUpdateRequired, otaAvailable, updateAvailable: nativeUpdateRequired || otaAvailable };
}

test('a newer build needs a new APK and is never installed over the air', () => {
  const d = updateDecision({ latestVersion: '1.8.0', latestBuild: 26, currentVersion: '1.7.0', bundledBuild: 25 });
  assert.deepStrictEqual(d, { nativeUpdateRequired: true, otaAvailable: false, updateAvailable: true });
});

test('a newer version for the same build is a web-only (OTA) update', () => {
  const d = updateDecision({ latestVersion: '1.7.1', latestBuild: 25, currentVersion: '1.7.0', bundledBuild: 25 });
  assert.deepStrictEqual(d, { nativeUpdateRequired: false, otaAvailable: true, updateAvailable: true });
});

test('the same version, or an older build in the repo, is no update at all', () => {
  assert.strictEqual(updateDecision({ latestVersion: '1.7.0', latestBuild: 25, currentVersion: '1.7.0', bundledBuild: 25 }).updateAvailable, false);
  // A stale remote must never ask the user to "downgrade".
  assert.strictEqual(updateDecision({ latestVersion: '1.6.6', latestBuild: 24, currentVersion: '1.7.0', bundledBuild: 25 }).updateAvailable, false);
});

test('the UI offers the action the engine decided', () => {
  const { updateAction } = require('./harness').loadAppInternals();
  assert.strictEqual(updateAction({ remoteReachable: true, nativeUpdateRequired: true, otaAvailable: false }), 'apk');
  assert.strictEqual(updateAction({ remoteReachable: true, nativeUpdateRequired: false, otaAvailable: true }), 'ota');
  assert.strictEqual(updateAction({ remoteReachable: true, nativeUpdateRequired: false, otaAvailable: false }), 'none');
  assert.strictEqual(updateAction({ remoteReachable: false, nativeUpdateRequired: true }), 'none');
  assert.strictEqual(updateAction(null), 'none');
});

/** Mirror of buildOtaManifestPayload() in LocalBackendServer.java. */
function buildOtaManifestPayload(version, build, indexHtml, appJs, stylesCss) {
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  return 'agy-ota-v1\n'
    + `version=${version}\n`
    + `build=${build}\n`
    + `index.html=${sha(indexHtml)}\n`
    + `app.js=${sha(appJs)}\n`
    + `styles.css=${sha(stylesCss)}\n`;
}

test('OTA payload is stable for identical inputs', () => {
  const a = buildOtaManifestPayload('1.4.7', 16, 'i', 'j', 'c');
  const b = buildOtaManifestPayload('1.4.7', 16, 'i', 'j', 'c');
  assert.strictEqual(a, b);
});

test('OTA payload changes when any bundle file changes', () => {
  const base = buildOtaManifestPayload('1.4.7', 16, 'i', 'j', 'c');
  assert.notStrictEqual(base, buildOtaManifestPayload('1.4.7', 16, 'i2', 'j', 'c'));
  assert.notStrictEqual(base, buildOtaManifestPayload('1.4.7', 16, 'i', 'j2', 'c'));
  assert.notStrictEqual(base, buildOtaManifestPayload('1.4.7', 16, 'i', 'j', 'c2'));
});

test('OTA payload binds the declared version and build', () => {
  // Prevents replaying a valid signature under a different version/build label.
  const base = buildOtaManifestPayload('1.4.7', 16, 'i', 'j', 'c');
  assert.notStrictEqual(base, buildOtaManifestPayload('1.4.8', 16, 'i', 'j', 'c'));
  assert.notStrictEqual(base, buildOtaManifestPayload('1.4.7', 17, 'i', 'j', 'c'));
});

test('OTA payload uses LF endings and the versioned header', () => {
  const p = buildOtaManifestPayload('1.4.7', 16, 'i', 'j', 'c');
  assert.ok(p.startsWith('agy-ota-v1\n'), 'header pins the payload format version');
  assert.ok(!p.includes('\r'), 'CRLF would break cross-platform signing');
  assert.strictEqual(p.split('\n').length - 1, 6, 'exactly six LF-terminated lines');
});

test('RSA-SHA256 signature over the payload verifies, and rejects tampering', () => {
  // End-to-end check of the scheme used by sign-ota.ps1 and verifyOtaSignature().
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = buildOtaManifestPayload('1.4.7', 16, 'index', 'app', 'css');
  const sig = crypto.sign('sha256', Buffer.from(payload, 'utf8'), privateKey);

  assert.strictEqual(
    crypto.verify('sha256', Buffer.from(payload, 'utf8'), publicKey, sig),
    true,
    'a correctly signed bundle must be accepted'
  );

  const tampered = buildOtaManifestPayload('1.4.7', 16, 'index', 'app/*evil*/', 'css');
  assert.strictEqual(
    crypto.verify('sha256', Buffer.from(tampered, 'utf8'), publicKey, sig),
    false,
    'modified app.js must invalidate the signature'
  );
});
