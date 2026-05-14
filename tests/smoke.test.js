// Smoke tests — one happy-path test per flow (PRD §3.3)
// Run with: node --test tests/smoke.test.js
// W1 tests use no real APIs. W2+ tests that need real APIs are skipped when env vars are absent.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── W1 — webhook routes ──────────────────────────────────────────────────────

describe('W1 — webhook routes', () => {
  it('verifyWebhook returns challenge when token matches', () => {
    process.env.META_VERIFY_TOKEN = 'test_token';
    const { verifyWebhook } = require('../src/router');
    let statusCode, body;
    const req = { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test_token', 'hub.challenge': 'abc123' } };
    const res = {
      status(code) { statusCode = code; return this; },
      send(b) { body = b; return this; },
      sendStatus(code) { statusCode = code; return this; },
    };
    verifyWebhook(req, res);
    assert.equal(statusCode, 200);
    assert.equal(body, 'abc123');
  });

  it('verifyWebhook returns 403 when token does not match', () => {
    process.env.META_VERIFY_TOKEN = 'test_token';
    const { verifyWebhook } = require('../src/router');
    let statusCode;
    const req = { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'abc' } };
    const res = { sendStatus(code) { statusCode = code; } };
    verifyWebhook(req, res);
    assert.equal(statusCode, 403);
  });
});

// ─── W1 — plantLookup utility ─────────────────────────────────────────────────

describe('plantLookup utility', () => {
  it('finds dongoyaro by local name', () => {
    const { lookup } = require('../src/utils/plantLookup');
    const result = lookup('dongoyaro');
    assert.equal(result.botanical, 'Azadirachta indica');
  });

  it('returns null for unknown plant', () => {
    const { lookup } = require('../src/utils/plantLookup');
    const result = lookup('unknownplantxyz');
    assert.equal(result, null);
  });

  it('lookup is case-insensitive', () => {
    const { lookup } = require('../src/utils/plantLookup');
    assert.ok(lookup('DONGOYARO'));
    assert.ok(lookup('Bitter Leaf'));
  });
});

// ─── W2 — Flow 1 first contact (unit, no real APIs) ──────────────────────────

describe('W2 — firstContact flow helpers', () => {
  // Access internal helpers via the module for unit testing
  const fc = require('../src/flows/firstContact');

  it('module exports handle and resume', () => {
    assert.equal(typeof fc.handle, 'function');
    assert.equal(typeof fc.resume, 'function');
  });
});

describe('W2 — router extractText', () => {
  const { extractText } = require('../src/router');

  it('extracts text from text message', () => {
    assert.equal(extractText({ type: 'text', text: { body: 'hello' } }), 'hello');
  });

  it('returns empty string for audio message', () => {
    assert.equal(extractText({ type: 'audio' }), '');
  });

  it('extracts button reply title from interactive message', () => {
    const msg = { type: 'interactive', interactive: { button_reply: { title: 'English' } } };
    assert.equal(extractText(msg), 'English');
  });
});
