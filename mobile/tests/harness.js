// Minimal browser stub so mobile/www/app.js can be loaded under Node's test
// runner. app.js is a browser IIFE: it needs just enough of window/document to
// reach the end of its body and publish window.__appInternals.
//
// Nothing here simulates rendering — these tests cover the pure helpers only.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeElementStub() {
  const el = {
    value: '',
    textContent: '',
    innerHTML: '',
    src: '',
    disabled: false,
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add() {}, remove() {}, toggle() {},
      contains: () => false,
    },
    dataset: {},
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute() {},
    focus() {},
    blur() {},
    click() {},
    scrollTo() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
  el.parentElement = null;
  el.firstChild = null;
  return el;
}

/** Loads app.js in a sandbox and returns its exposed internals. */
function loadAppInternals() {
  const appPath = path.join(__dirname, '..', 'www', 'app.js');
  const code = fs.readFileSync(appPath, 'utf8');

  const documentStub = {
    documentElement: makeElementStub(),
    body: makeElementStub(),
    getElementById: () => makeElementStub(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    addEventListener() {},
    removeEventListener() {},
  };

  const windowStub = {
    location: { protocol: 'https:', host: 'appassets.agy.local', href: 'https://appassets.agy.local/index.html' },
    document: documentStub,
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node-test' },
    visualViewport: null,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    confirm: () => false,
    alert() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  windowStub.window = windowStub;

  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: windowStub.navigator,
    location: windowStub.location,
    localStorage: windowStub.localStorage,
    console,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    fetch: windowStub.fetch,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class Blob {},
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });

  if (!sandbox.window.__appInternals) {
    throw new Error('app.js did not expose window.__appInternals — did the export block change?');
  }
  return sandbox.window.__appInternals;
}

module.exports = { loadAppInternals };
