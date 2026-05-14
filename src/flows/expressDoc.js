// Flow 3 — Express Documentation (PRD §5.3)
// Trigger: practitioner sends a voice note (30–180 s) with NO active session.
//
// Pipeline:
//   1. Acknowledge immediately ("one moment…") — PRD §7 requires reply ≤ 10 s
//   2. Whisper transcription
//   3. Claude structureFormulation → full JSON in one pass
//   4. confidence ≥ 0.75 → show confirmation card → save on approval
//   5. confidence < 0.75  → fall back to guided Flow 2 with partial context pre-filled
//
// Acceptance criteria (PRD §5.3):
//   • ≥ 3 plants, condition, preparation, dosage extracted from a 90-s Yoruba voice note
//   • Unknown plant → stored with botanical: null, event logged for admin review
//   • Practitioner never waits > 10 s for a reply

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const { logEvent, saveMedia, uploadVoiceNote, saveFormulation } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { transcribe } = require('../services/whisper');
const { structureFormulation } = require('../services/claude');
const guidedDoc = require('./guidedDoc');

const CONFIDENCE_THRESHOLD = 0.75;
const CANCEL_WORDS = new Set(['cancel', 'stop', 'quit', 'abort']);

// ─── entry point ──────────────────────────────────────────────────────────────

async function handle(message, from, practitioner) {
  // Send acknowledgement FIRST to meet the 10-second SLA (PRD §7)
  await sendTextMessage(from, 'Got it — one moment while I process your voice note…');

  const { buffer, mimeType } = await downloadMedia(message.audio.id);

  // Transcribe
  let transcript, language, whisperConfidence;
  try {
    ({ text: transcript, language, confidence: whisperConfidence } = await transcribe(buffer, mimeType));
  } catch (err) {
    console.error('Whisper error:', err.message);
    await logEvent({ practitioner_id: practitioner.id, event_type: 'error', payload: { step: 'whisper', error: err.message } });
    return sendTextMessage(from, 'Sorry, I had trouble processing your voice note. Please try again.');
  }

  if (!transcript?.trim() || whisperConfidence < 0.5) {
    return sendTextMessage(from, "Sorry, I couldn't make out enough of that voice note. Please try again in a quiet place, or type your formulation.");
  }

  // Store the voice note (non-fatal)
  let mediaId = null;
  try {
    const storagePath = await uploadVoiceNote(practitioner.id, buffer, mimeType);
    const media = await saveMedia({ practitioner_id: practitioner.id, kind: 'voice', storage_path: storagePath, transcript });
    mediaId = media.id;
  } catch (e) {
    console.warn('media save failed (non-fatal):', e.message);
  }

  await logEvent({ practitioner_id: practitioner.id, event_type: 'whisper_call', payload: { language, confidence: whisperConfidence } });

  // Structure with Claude
  let structured;
  try {
    structured = await structureFormulation(transcript);
  } catch (err) {
    console.error('Claude error:', err.message);
    await logEvent({ practitioner_id: practitioner.id, event_type: 'error', payload: { step: 'claude_structure', error: err.message } });
    return sendTextMessage(from, 'Sorry, something went wrong while analysing your formulation. Please try again.');
  }

  await logEvent({ practitioner_id: practitioner.id, event_type: 'claude_call', payload: { confidence: structured.metadata?.confidence_score } });

  // Flag unknown plants for admin review
  _flagUnknownPlants(structured, practitioner.id);

  const confidence = structured.metadata?.confidence_score ?? 0;

  if (confidence >= CONFIDENCE_THRESHOLD) {
    return _showConfirmation(from, practitioner, structured, transcript, language, mediaId);
  }

  // Low confidence → fall back to guided doc with partial context
  return _fallbackToGuided(from, practitioner, structured, transcript);
}

// ─── confirmation (high-confidence path) ─────────────────────────────────────

async function _showConfirmation(from, practitioner, structured, transcript, language, mediaId) {
  const card = _formatCard(structured);

  await setSession(practitioner.id, 'express_doc', 'awaiting_confirmation', {
    structured,
    original_text: transcript,
    original_language: language ?? structured.metadata?.original_language ?? 'en',
    source_media_id: mediaId,
  });

  await sendTextMessage(from, `Here's what I recorded from your voice note:\n\n${card}`);
  return sendButtonMessage(from, 'Is this correct?', ['Yes, save', 'Edit', 'Cancel']);
}

// ─── session resume (confirmation step) ───────────────────────────────────────

async function resume(session, message, from, practitioner) {
  const { step, context } = session;

  // Cancel at confirmation
  const text = (message.type === 'text' ? message.text?.body ?? '' : '').toLowerCase().trim();
  if (CANCEL_WORDS.has(text)) {
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Formulation discarded. Send a voice note any time to try again.');
  }

  if (step === 'awaiting_confirmation') {
    return _handleConfirmation(message, from, practitioner, context);
  }

  // Unexpected step — clear and let next message restart
  await endSession(practitioner.id);
  return sendTextMessage(from, 'Session cleared. Send a voice note to document a formulation.');
}

async function _handleConfirmation(message, from, practitioner, context) {
  const reply = _buttonOrText(message).toLowerCase().trim();

  if (reply.includes('yes') || reply.includes('save')) {
    const { structured, original_text, original_language, source_media_id } = context;

    const formulation = await saveFormulation({
      practitioner_id:  practitioner.id,
      source_media_id:  source_media_id ?? null,
      structured,
      original_text,
      original_language,
    });

    await logEvent({
      practitioner_id: practitioner.id,
      event_type: 'formulation_saved',
      payload: { short_code: formulation.short_code, flow: 'express_doc' },
    });

    await endSession(practitioner.id);
    return sendTextMessage(from, `✅ Saved as *${formulation.short_code}*.\n\nType *my vault* to browse, or send another voice note to document the next one.`);
  }

  if (reply.includes('cancel')) {
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Formulation discarded. Send a voice note any time to try again.');
  }

  if (reply.includes('edit')) {
    // Hand off to guided doc for field-level editing (reuses W4 logic)
    await endSession(practitioner.id);
    await sendTextMessage(from, "Let's go through it question by question so you can correct any details.");
    return guidedDoc.handle(message, from, practitioner);
  }

  return sendButtonMessage(from, 'Please choose one of the options.', ['Yes, save', 'Edit', 'Cancel']);
}

// ─── low-confidence fallback ──────────────────────────────────────────────────

async function _fallbackToGuided(from, practitioner, structured, transcript) {
  // Pre-fill whatever Claude managed to extract so the practitioner only fills gaps
  const partial = _extractPartialContext(structured);
  const firstMissingStep = _firstMissingStep(partial);

  await sendTextMessage(
    from,
    `I got _some_ of that, but I'm not confident about the full formulation (${Math.round((structured.metadata?.confidence_score ?? 0) * 100)}% confidence).\n\nLet me ask you a few questions to fill in the gaps.`
  );

  if (firstMissingStep === 'awaiting_condition') {
    // Nothing usable — start guided doc from scratch
    return guidedDoc.handle({ type: 'text', text: { body: 'new' } }, from, practitioner);
  }

  // Start guided doc at the first missing field with partial context already in session
  await setSession(practitioner.id, 'guided_doc', firstMissingStep, partial);
  const stepIndex = ['awaiting_condition', 'awaiting_plants', 'awaiting_preparation', 'awaiting_dosage', 'awaiting_notes'].indexOf(firstMissingStep);
  const qNum = stepIndex + 1;

  const QUESTIONS = {
    awaiting_condition:   'What condition does this formulation treat?\n_(e.g. "fever", "iba", "typhoid")_',
    awaiting_plants:      'What plants go into it? List them one by one, including how much of each.',
    awaiting_preparation: 'How is it prepared?\n_(e.g. "boil in water for 20 minutes")_',
    awaiting_dosage:      'What is the dosage?\n_(e.g. "one cup, twice a day, for five days")_',
    awaiting_notes:       'Any notes or warnings? _(reply *skip* to leave blank)_',
  };

  return sendTextMessage(from, `*Question ${qNum} of 5*\n\n${QUESTIONS[firstMissingStep]}`);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Log an event for every plant that couldn't be matched to a botanical name
function _flagUnknownPlants(structured, practitioner_id) {
  const unknowns = (structured.plants ?? []).filter(p => !p.botanical);
  for (const p of unknowns) {
    logEvent({
      practitioner_id,
      event_type: 'unknown_plant_flagged',
      payload: { local_name: p.local_name },
    }).catch(e => console.warn('flagUnknownPlant log failed:', e.message));
  }
}

function _extractPartialContext(structured) {
  const ctx = {};
  const cond = structured.condition?.local_name || structured.condition?.standardised;
  if (cond) ctx.condition = cond;

  if (structured.plants?.length) {
    ctx.plants = structured.plants.map(p => {
      const qty = p.quantity_raw || p.quantity_normalised || '';
      return qty ? `${p.local_name} (${qty})` : p.local_name;
    }).join(', ');
  }

  if (structured.preparation?.method) {
    const dur = structured.preparation.duration_minutes ? ` for ${structured.preparation.duration_minutes} minutes` : '';
    const med = structured.preparation.medium ? ` in ${structured.preparation.medium}` : '';
    ctx.preparation = `${structured.preparation.method}${dur}${med}`;
  }

  if (structured.dosage?.amount || structured.dosage?.frequency) {
    const parts = [structured.dosage.amount, structured.dosage.frequency].filter(Boolean);
    if (structured.dosage.duration_days) parts.push(`for ${structured.dosage.duration_days} days`);
    ctx.dosage = parts.join(', ');
  }

  return ctx;
}

function _firstMissingStep(partial) {
  const order = ['awaiting_condition', 'awaiting_plants', 'awaiting_preparation', 'awaiting_dosage', 'awaiting_notes'];
  const keys   = ['condition', 'plants', 'preparation', 'dosage'];
  for (let i = 0; i < keys.length; i++) {
    if (!partial[keys[i]]) return order[i];
  }
  return 'awaiting_notes'; // all main fields present, only notes missing
}

function _formatCard(s) {
  const lines = [];

  const cond = s.condition?.standardised || s.condition?.local_name;
  if (cond) lines.push(`*Condition:* ${cond}`);

  if (s.plants?.length) {
    lines.push('*Plants:*');
    for (const p of s.plants) {
      const name = p.botanical ? `${p.local_name} (${p.botanical})` : p.local_name;
      const qty  = p.quantity_normalised || p.quantity_raw || '';
      lines.push(`  • ${name}${qty ? ' — ' + qty : ''}${!p.botanical ? ' ⚠️' : ''}`);
    }
  }

  if (s.preparation?.method) {
    const dur = s.preparation.duration_minutes ? ` for ${s.preparation.duration_minutes} min` : '';
    const med = s.preparation.medium ? ` in ${s.preparation.medium}` : '';
    lines.push(`*Preparation:* ${s.preparation.method}${dur}${med}`);
  }

  if (s.dosage?.amount || s.dosage?.frequency) {
    const amt  = s.dosage.amount || '';
    const freq = s.dosage.frequency ? `, ${s.dosage.frequency}` : '';
    const days = s.dosage.duration_days ? `, for ${s.dosage.duration_days} days` : '';
    lines.push(`*Dosage:* ${amt}${freq}${days}`);
  }

  const conf = s.metadata?.confidence_score;
  if (conf != null) lines.push(`_Confidence: ${Math.round(conf * 100)}%_`);

  if (s.plants?.some(p => !p.botanical)) {
    lines.push('_⚠️ = plant not in lookup, flagged for review_');
  }

  return lines.join('\n');
}

function _buttonOrText(message) {
  if (message.type === 'interactive') return message.interactive?.button_reply?.title ?? '';
  return message.text?.body ?? '';
}

module.exports = { handle, resume, _extractPartialContext, _firstMissingStep, _formatCard };
