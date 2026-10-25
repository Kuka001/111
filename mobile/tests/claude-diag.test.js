'use strict';

// The self-test preloads these scripts into Claude Code's own Bun runtime
// (BUN_OPTIONS=--preload, see LocalBackendServer.runProbe / runFullStart).
// A broken script would not fail loudly: the probe would just print nothing.
// So check here that both parse, and that the probe runs to its last line and
// reports every step in the format the report relies on.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', '..', 'android', 'assets', 'claude-diag');

test('diagnostic preload scripts parse', () => {
  for (const name of ['probe.mjs', 'trace.cjs', 'android.cjs']) {
    const r = spawnSync(process.execPath, ['--check', path.join(dir, name)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test('probe runs every step and ends with "done"', () => {
  const r = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], { encoding: 'utf8', timeout: 90000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stderr.trim().split('\n');
  assert.match(lines[0], /^\[probe \+\d+\.\ds\] bun /);
  assert.match(lines[lines.length - 1], /\] done · /);
  // Every started step ("… name") is followed by its result line.
  const started = lines.filter((l) => / … /.test(l)).length;
  const finished = lines.filter((l) => /\] (ok|FAIL) /.test(l)).length;
  assert.strictEqual(finished, started);
  assert.ok(lines.some((l) => /ok таймер 0 мс/.test(l)));
});

test('android shim points the resolver at AGY_DNS_SERVERS and tolerates getifaddrs failures', () => {
  const script = [
    "const os = require('node:os');",
    "require('node:os').networkInterfaces = os.networkInterfaces;",
    "console.log(JSON.stringify(require('node:dns').getServers()));",
    "console.log(typeof os.networkInterfaces());",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-r', path.join(dir, 'android.cjs'), '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, AGY_DNS_SERVERS: '192.0.2.53, 198.51.100.53' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const [servers, kind] = r.stdout.trim().split('\n');
  assert.deepStrictEqual(JSON.parse(servers), ['192.0.2.53', '198.51.100.53']);
  assert.strictEqual(kind, 'object');
});

test('trace reports child processes and the exit code', () => {
  const r = spawnSync(process.execPath, ['-r', path.join(dir, 'trace.cjs'), '-e',
    "require('node:child_process').spawnSync(process.execPath, ['-v'])"], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /\] trace · pid \d+/);
  assert.match(r.stderr, /child_process\.spawnSync .*→ готово|child_process\.spawnSync/);
  assert.match(r.stderr, /\] exit 0/);
});
