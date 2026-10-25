'use strict';

// Tests for the Claude Code CLI provider detection on the web layer. The CLI
// itself and its stream-json parsing live in Java (LocalBackendServer); here we
// only verify the UI's provider routing helper, which decides when the on-device
// Claude fields (system-prompt .md, first-message .md, project path) are sent.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadAppInternals } = require('./harness');

const { isClaudeCliModel } = loadAppInternals();

test('isClaudeCliModel detects on-device Claude Code models', () => {
  assert.strictEqual(isClaudeCliModel('claude-code-opus'), true);
  assert.strictEqual(isClaudeCliModel('claude-code-sonnet'), true);
});

test('isClaudeCliModel does NOT match Vertex Anthropic or Gemini models', () => {
  // Vertex Anthropic models (routed to :rawPredict) must keep the old path.
  assert.strictEqual(isClaudeCliModel('claude-opus-5-5'), false);
  assert.strictEqual(isClaudeCliModel('claude-sonnet-5-5'), false);
  assert.strictEqual(isClaudeCliModel('gemini-4-argon'), false);
});

test('isClaudeCliModel is safe on empty / non-string input', () => {
  assert.strictEqual(isClaudeCliModel(''), false);
  assert.strictEqual(isClaudeCliModel(undefined), false);
  assert.strictEqual(isClaudeCliModel(null), false);
  assert.strictEqual(isClaudeCliModel(123), false);
});
