// AGY runtime probe for the on-device Claude Code CLI.
//
// The self-test loads it with BUN_OPTIONS="--preload /opt/agy/probe.mjs" in
// front of `claude --version`. It checks, one at a time, the runtime features
// Claude Code relies on while it starts, prints every result to stderr at once
// and exits before Claude Code itself runs. If a step hangs, the last "…" line
// names it.
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import dns from 'node:dns';

const started = Date.now();
const say = (line) => {
  try {
    fs.writeSync(2, `[probe +${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`);
  } catch {
    // stderr closed: nothing to report to
  }
};
const short = (value) => String(value).replace(/\s+/g, ' ').trim().slice(0, 180);
const hasBun = typeof Bun !== 'undefined';

function limit(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`нет ответа за ${ms} мс`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let failures = 0;
async function step(name, fn, ms = 8000) {
  say(`… ${name}`);
  const t = Date.now();
  try {
    const value = await limit(Promise.resolve().then(fn), ms);
    say(`ok ${name} · ${Date.now() - t} мс${value === undefined ? '' : ' · ' + short(value)}`);
  } catch (e) {
    failures++;
    const reason = e && e.message ? `${e.code ? e.code + ' ' : ''}${e.message}` : e;
    say(`FAIL ${name} · ${Date.now() - t} мс · ${short(reason)}`);
  }
}

const flags = Object.keys(process.env).filter((k) => k.startsWith('BUN_FEATURE_FLAG_'));
say(`bun ${process.versions.bun || '?'} · ${process.platform}/${process.arch} · ядро ${os.release()} · pid ${process.pid}`);
say(`флаги Bun: ${flags.length ? flags.join(', ') : 'нет'} · stdin TTY: ${Boolean(process.stdin.isTTY)}`);

await step('микрозадачи', () => Promise.resolve('да'));
await step('таймер 0 мс', () => new Promise((resolve) => setTimeout(resolve, 0)));
await step('таймер 300 мс', async () => {
  const t = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return `${Date.now() - t} мс`;
});
await step('setImmediate', () => new Promise((resolve) => setImmediate(resolve)));
await step('файл: синхронное чтение', () => fs.readFileSync('/etc/os-release', 'utf8').split('\n')[0]);
await step('файл: асинхронное чтение', async () => `${(await fs.promises.readFile('/etc/os-release', 'utf8')).length} байт`);
if (hasBun) await step('файл: Bun.file', async () => `${(await Bun.file('/etc/os-release').text()).length} байт`);
await step('файл: запись и удаление в /tmp', async () => {
  const path = `/tmp/agy-probe-${process.pid}`;
  await fs.promises.writeFile(path, 'agy');
  await fs.promises.rm(path);
});
await step('fs.watch', () => {
  const watcher = fs.watch('/tmp');
  watcher.close();
});
await step('os: процессор, память, сеть', () =>
  `${os.cpus().length} ядер · ${Math.round(os.totalmem() / 1048576)} МБ · ${Object.keys(os.networkInterfaces()).join(',')}`);
await step('os.userInfo', () => os.userInfo().username);
if (hasBun) await step('Bun.which git / rg', () => `git: ${Bun.which('git') || 'нет'} · rg: ${Bun.which('rg') || 'нет'}`);
await step('процесс: child_process.spawnSync', () => {
  const r = cp.spawnSync('/bin/busybox', ['echo', 'ok']);
  if (r.error) throw r.error;
  return `код ${r.status} · ${String(r.stdout).trim()}`;
});
await step('процесс: child_process.execSync (sh)', () => String(cp.execSync('echo ok')).trim());
if (hasBun) {
  await step('процесс: Bun.spawnSync', () => {
    const r = Bun.spawnSync(['/bin/busybox', 'echo', 'ok']);
    return `код ${r.exitCode} · ${r.stdout.toString().trim()}`;
  });
}
await step('процесс: child_process.execFile', () => new Promise((resolve, reject) => {
  cp.execFile('/bin/busybox', ['echo', 'ok'], (err, out) => (err ? reject(err) : resolve(String(out).trim())));
}));
if (hasBun) {
  await step('процесс: Bun.spawn', async () => {
    const p = Bun.spawn(['/bin/busybox', 'echo', 'ok'], { stdout: 'pipe' });
    const out = await new Response(p.stdout).text();
    return `код ${await p.exited} · ${out.trim()}`;
  });
}
await step('DNS: dns.lookup', async () =>
  (await dns.promises.lookup('api.anthropic.com', { all: true })).map((a) => a.address).join(', '), 12000);
await step('DNS: dns.resolve4', async () => (await dns.promises.resolve4('api.anthropic.com')).join(', '), 12000);
await step('HTTPS: fetch api.anthropic.com', async () => {
  const res = await fetch('https://api.anthropic.com/', { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  return `HTTP ${res.status}`;
}, 20000);
await step('crypto.randomUUID', () => crypto.randomUUID());

say(failures ? `done · ошибок: ${failures}` : 'done · всё в порядке');
process.exit(0);
