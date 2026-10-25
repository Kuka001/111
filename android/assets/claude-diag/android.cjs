// AGY Android shim for the on-device Claude Code CLI.
//
// Claude Code runs straight on Android (no proot): the app starts it through
// Alpine's musl loader and preloads this file with BUN_OPTIONS="--preload ...".
// Android has no /etc/resolv.conf, so Bun's resolver would ask 127.0.0.1:53,
// where nothing listens; point it at the phone's own DNS servers instead
// (AGY_DNS_SERVERS, comma-separated, set by the app from the active network).
'use strict';

const dns = require('node:dns');

const servers = String(process.env.AGY_DNS_SERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (servers.length) {
  try {
    dns.setServers(servers);
  } catch (e) {
    process.stderr.write(`[agy] dns.setServers failed: ${e && e.message}\n`);
  }
}

// Apps may not list network interfaces on Android (getifaddrs fails), which
// Bun turns into a thrown error; report none instead.
const os = require('node:os');
const networkInterfaces = os.networkInterfaces;
os.networkInterfaces = function safeNetworkInterfaces(...args) {
  try {
    return networkInterfaces.apply(this, args);
  } catch {
    return {};
  }
};
