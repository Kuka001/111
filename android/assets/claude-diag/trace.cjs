// AGY start-up trace for the on-device Claude Code CLI.
//
// The self-test loads it with BUN_OPTIONS="--preload /opt/agy/trace.cjs": it
// prints a heartbeat while the event loop is alive and every child process
// Claude Code starts, straight to stderr, so a hang shows where it happened.
'use strict';

const fs = require('node:fs');

const started = Date.now();
const say = (line) => {
  try {
    fs.writeSync(2, `[agy +${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`);
  } catch {
    // stderr closed: nothing to report to
  }
};
const short = (value) => {
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
};

say(`trace · pid ${process.pid} · bun ${process.versions.bun || '?'}`);

let beats = 0;
const heartbeat = setInterval(() => say(`heartbeat ${++beats}`), 3000);
if (heartbeat.unref) heartbeat.unref();

const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = childProcess[name];
  if (typeof original !== 'function') continue;
  try {
    childProcess[name] = function traced(...args) {
      say(`child_process.${name} ${short(args[0])}${Array.isArray(args[1]) ? ' ' + short(args[1]) : ''}`);
      const result = original.apply(this, args);
      if (name.endsWith('Sync')) say(`child_process.${name} → готово`);
      return result;
    };
  } catch (e) {
    say(`child_process.${name} не отслеживается: ${e.message}`);
  }
}

if (typeof Bun !== 'undefined') {
  for (const name of ['spawn', 'spawnSync']) {
    const original = Bun[name];
    try {
      Bun[name] = function traced(...args) {
        const first = args[0];
        say(`Bun.${name} ${short(Array.isArray(first) ? first : first && first.cmd)}`);
        const result = original.apply(this, args);
        if (name === 'spawnSync') say('Bun.spawnSync → готово');
        return result;
      };
    } catch (e) {
      say(`Bun.${name} не отслеживается: ${e.message}`);
    }
  }
}

process.on('exit', (code) => say(`exit ${code}`));
