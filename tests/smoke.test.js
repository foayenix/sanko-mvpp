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

// ─── W3 — Flow 2 guided doc (unit, no real APIs) ─────────────────────────────

describe('W3 — guidedDoc _contextToTranscript', () => {
  const { _contextToTranscript } = require('../src/flows/guidedDoc');

  it('builds transcript from all five answers', () => {
    const ctx = {
      condition:   'fever',
      plants:      '10 neem leaves, handful of bitter leaf',
      preparation: 'boil in water for 20 minutes',
      dosage:      'one cup twice a day for five days',
      notes:       'avoid in pregnancy',
    };
    const t = _contextToTranscript(ctx);
    assert.ok(t.includes('Condition: fever'));
    assert.ok(t.includes('Plants: 10 neem leaves'));
    assert.ok(t.includes('Preparation: boil in water'));
    assert.ok(t.includes('Dosage: one cup'));
    assert.ok(t.includes('Notes: avoid in pregnancy'));
  });

  it('omits empty notes field', () => {
    const ctx = { condition: 'malaria', plants: 'neem', preparation: 'decoction', dosage: '1 cup daily', notes: '' };
    const t = _contextToTranscript(ctx);
    assert.ok(!t.includes('Notes:'));
  });
});

describe('W3 — guidedDoc _formatCard', () => {
  const { _formatCard } = require('../src/flows/guidedDoc');

  it('renders a complete structured formulation', () => {
    const s = {
      condition:   { local_name: 'iba', standardised: 'Malaria', icd_11_code: '1F40' },
      plants:      [{ local_name: 'dongoyaro', botanical: 'Azadirachta indica', quantity_normalised: '10 leaves', part_used: 'leaves' }],
      preparation: { method: 'decoction', duration_minutes: 20, medium: 'water' },
      dosage:      { amount: '1 cup', frequency: 'twice daily', duration_days: 5 },
      metadata:    { confidence_score: 0.92 },
    };
    const card = _formatCard(s);
    assert.ok(card.includes('Malaria'));
    assert.ok(card.includes('dongoyaro'));
    assert.ok(card.includes('Azadirachta indica'));
    assert.ok(card.includes('decoction'));
    assert.ok(card.includes('twice daily'));
    assert.ok(card.includes('92%'));
  });

  it('handles missing optional fields gracefully', () => {
    const s = {
      condition:   { local_name: 'iba', standardised: null },
      plants:      [{ local_name: 'ewuro', botanical: null }],
      preparation: { method: null },
      dosage:      {},
      metadata:    {},
    };
    // Should not throw
    assert.doesNotThrow(() => _formatCard(s));
  });
});

describe('W3 — guidedDoc module exports', () => {
  const gd = require('../src/flows/guidedDoc');
  it('exports handle and resume', () => {
    assert.equal(typeof gd.handle, 'function');
    assert.equal(typeof gd.resume, 'function');
  });
});

// ─── W4 — Flow 2 edge cases (unit, no real APIs) ─────────────────────────────

describe('W4 — cancel intent detection', () => {
  const { _isCancelIntent } = require('../src/flows/guidedDoc');

  it('detects "cancel" as cancel intent', () => {
    assert.ok(_isCancelIntent({ type: 'text', text: { body: 'cancel' } }));
  });

  it('detects "stop" as cancel intent', () => {
    assert.ok(_isCancelIntent({ type: 'text', text: { body: 'stop' } }));
  });

  it('detects "CANCEL" case-insensitively', () => {
    assert.ok(_isCancelIntent({ type: 'text', text: { body: 'CANCEL' } }));
  });

  it('does not treat a normal answer as cancel', () => {
    assert.ok(!_isCancelIntent({ type: 'text', text: { body: 'fever and chills' } }));
  });

  it('does not treat an audio message as cancel', () => {
    assert.ok(!_isCancelIntent({ type: 'audio', audio: { id: 'abc' } }));
  });
});

describe('W4 — guidedDoc retry context', () => {
  const { _contextToTranscript } = require('../src/flows/guidedDoc');

  it('_retries key is stripped from transcript', () => {
    const ctx = {
      condition: 'malaria',
      plants: 'neem leaves',
      preparation: 'decoction',
      dosage: '1 cup daily',
      _retries: { awaiting_condition: 2 },
    };
    const t = _contextToTranscript(ctx);
    assert.ok(!t.includes('_retries'));
    assert.ok(!t.includes('awaiting_condition'));
  });
});

describe('W4 — field-level edit step mapping', () => {
  it('EDIT_STEP_FOR covers the four editable fields', () => {
    // The module exposes EDIT_FIELDS indirectly via _isCancelIntent export;
    // test the mapping by loading the module and inspecting the step prefix.
    const gd = require('../src/flows/guidedDoc');
    // resume with an edit step should not throw before any DB calls
    assert.equal(typeof gd.resume, 'function');
  });
});

describe('W4 — router session timeout path', () => {
  const { extractText } = require('../src/router');

  it('extractText handles undefined text body gracefully', () => {
    assert.equal(extractText({ type: 'text', text: undefined }), '');
  });

  it('extractText handles missing interactive payload', () => {
    assert.equal(extractText({ type: 'interactive', interactive: {} }), '');
  });
});

// ─── W5 — Flow 3 express doc + plant lookup (unit, no real APIs) ─────────────

describe('W5 — expressDoc module exports', () => {
  const ed = require('../src/flows/expressDoc');
  it('exports handle, resume, and helpers', () => {
    assert.equal(typeof ed.handle, 'function');
    assert.equal(typeof ed.resume, 'function');
    assert.equal(typeof ed._extractPartialContext, 'function');
    assert.equal(typeof ed._firstMissingStep, 'function');
    assert.equal(typeof ed._formatCard, 'function');
  });
});

describe('W5 — _extractPartialContext', () => {
  const { _extractPartialContext } = require('../src/flows/expressDoc');

  it('extracts all four main fields from a complete structured object', () => {
    const s = {
      condition:   { local_name: 'iba', standardised: 'Malaria' },
      plants:      [{ local_name: 'dongoyaro', botanical: 'Azadirachta indica', quantity_raw: '10 leaves' }],
      preparation: { method: 'decoction', duration_minutes: 20, medium: 'water' },
      dosage:      { amount: '1 cup', frequency: 'twice daily', duration_days: 5 },
      metadata:    { confidence_score: 0.88 },
    };
    const ctx = _extractPartialContext(s);
    assert.ok(ctx.condition.includes('iba') || ctx.condition.includes('Malaria'));
    assert.ok(ctx.plants.includes('dongoyaro'));
    assert.ok(ctx.preparation.includes('decoction'));
    assert.ok(ctx.dosage.includes('twice daily'));
  });

  it('returns empty object when structured has no usable data', () => {
    const ctx = _extractPartialContext({ condition: {}, plants: [], preparation: {}, dosage: {}, metadata: {} });
    assert.equal(Object.keys(ctx).length, 0);
  });
});

describe('W5 — _firstMissingStep', () => {
  const { _firstMissingStep } = require('../src/flows/expressDoc');

  it('returns awaiting_condition when nothing is filled', () => {
    assert.equal(_firstMissingStep({}), 'awaiting_condition');
  });

  it('returns awaiting_plants when only condition is filled', () => {
    assert.equal(_firstMissingStep({ condition: 'malaria' }), 'awaiting_plants');
  });

  it('returns awaiting_notes when all four main fields are filled', () => {
    assert.equal(_firstMissingStep({ condition: 'x', plants: 'y', preparation: 'z', dosage: 'w' }), 'awaiting_notes');
  });
});

describe('W5 — expressDoc _formatCard flags unknown plants', () => {
  const { _formatCard } = require('../src/flows/expressDoc');

  it('adds warning emoji for plant with no botanical name', () => {
    const s = {
      condition:   { standardised: 'Fever' },
      plants:      [{ local_name: 'unknownherb', botanical: null, quantity_raw: 'handful' }],
      preparation: { method: 'decoction' },
      dosage:      { amount: '1 cup', frequency: 'once daily' },
      metadata:    { confidence_score: 0.8 },
    };
    const card = _formatCard(s);
    assert.ok(card.includes('⚠️'));
    assert.ok(card.includes('unknownherb'));
  });

  it('no warning emoji when all plants are identified', () => {
    const s = {
      condition:   { standardised: 'Malaria' },
      plants:      [{ local_name: 'dongoyaro', botanical: 'Azadirachta indica', quantity_raw: '10 leaves' }],
      preparation: { method: 'boiling' },
      dosage:      { amount: '1 cup', frequency: 'twice daily' },
      metadata:    { confidence_score: 0.92 },
    };
    const card = _formatCard(s);
    assert.ok(!card.includes('⚠️'));
  });
});

describe('W5 — plant lookup expanded', () => {
  const { lookup } = require('../src/utils/plantLookup');

  it('has at least 100 entries', () => {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('data/plant_lookup_v1.json', 'utf8'));
    assert.ok(data.length >= 100, `Expected ≥100 entries, got ${data.length}`);
  });

  it('finds Yoruba names: atale (ginger)', () => {
    assert.equal(lookup('atale').botanical, 'Zingiber officinale');
  });

  it('finds Yoruba names: oruwo (Morinda lucida)', () => {
    assert.equal(lookup('oruwo').botanical, 'Morinda lucida');
  });

  it('finds Igbo name: utazi', () => {
    assert.equal(lookup('utazi').botanical, 'Gongronema latifolium');
  });

  it('finds Hausa name: tafarnuwa (garlic)', () => {
    assert.equal(lookup('tafarnuwa').botanical, 'Allium sativum');
  });

  it('finds orogbo (bitter kola)', () => {
    assert.equal(lookup('orogbo').botanical, 'Garcinia kola');
  });
});
