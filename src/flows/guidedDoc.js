// Flow 2 — Guided Documentation (PRD §5.2)
// Trigger: practitioner types 'new' / taps Document New Formulation, OR offered at first contact.
//
// Five questions, one at a time. Each answer accepted via voice or text.
// After Q5 → Claude structures the collected answers → confirmation card.
// [Yes, save] → INSERT formulations. [Cancel] → discard. [Edit] → back to Q1 (W4).
//
// W3 scope: happy path only. Edge cases (cancel, low-confidence, session timeout) are W4.

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const { logEvent, saveMedia, uploadVoiceNote, saveFormulation } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { transcribe } = require('../services/whisper');
const { structureFormulation } = require('../services/claude');

// Steps in order — maps directly to PRD §5.2 "five questions"
const STEPS = ['awaiting_condition', 'awaiting_plants', 'awaiting_preparation', 'awaiting_dosage', 'awaiting_notes'];

const QUESTIONS = {
  awaiting_condition:   'What condition does this formulation treat?\n_(e.g. "fever", "iba", "typhoid")_',
  awaiting_plants:      'What plants go into it? List them one by one, including how much of each.\n_(e.g. "10 neem leaves, one handful of bitter leaf")_',
  awaiting_preparation: 'How is it prepared?\n_(e.g. "boil in water for 20 minutes")_',
  awaiting_dosage:      'What is the dosage?\n_(e.g. "one cup, twice a day, for five days")_',
  awaiting_notes:       'Any notes or warnings? _(optional — reply *skip* to leave blank)_',
};

const CONTEXT_KEY = {
  awaiting_condition:   'condition',
  awaiting_plants:      'plants',
  awaiting_preparation: 'preparation',
  awaiting_dosage:      'dosage',
  awaiting_notes:       'notes',
};

// ─── entry point ──────────────────────────────────────────────────────────────

async function handle(message, from, practitioner) {
  await setSession(practitioner.id, 'guided_doc', 'awaiting_condition', {});
  await sendTextMessage(from, "Let's document a new formulation. I'll ask you five quick questions.\n\nYou can answer by voice note or text.");
  return sendTextMessage(from, `*Question 1 of 5*\n\n${QUESTIONS.awaiting_condition}`);
}

// ─── session resume ───────────────────────────────────────────────────────────

async function resume(session, message, from, practitioner) {
  const { step, context } = session;

  if (step === 'awaiting_confirmation') {
    return _handleConfirmation(message, from, practitioner, context);
  }

  if (STEPS.includes(step)) {
    return _handleAnswer(step, message, from, practitioner, context);
  }

  // Unknown step — restart
  await endSession(practitioner.id);
  return handle(message, from, practitioner);
}

// ─── answer handler ───────────────────────────────────────────────────────────

async function _handleAnswer(step, message, from, practitioner, context) {
  const answer = await _extractAnswer(message, from, practitioner);

  if (!answer && answer !== '') {
    return sendTextMessage(from, "Sorry, I didn't catch that. Please try again.");
  }

  const key = CONTEXT_KEY[step];
  const updatedContext = { ...context, [key]: answer };

  const stepIndex = STEPS.indexOf(step);
  const nextStep = STEPS[stepIndex + 1];

  if (nextStep) {
    await setSession(practitioner.id, 'guided_doc', nextStep, updatedContext);
    const qNum = stepIndex + 2;
    return sendTextMessage(from, `*Question ${qNum} of 5*\n\n${QUESTIONS[nextStep]}`);
  }

  // All 5 questions answered — structure with Claude and show confirmation card
  return _buildConfirmation(from, practitioner, updatedContext);
}

// ─── structuring + confirmation ───────────────────────────────────────────────

async function _buildConfirmation(from, practitioner, context) {
  await sendTextMessage(from, 'Got it. Let me put that together for you…');

  const transcript = _contextToTranscript(context);
  let structured;

  try {
    structured = await structureFormulation(transcript);
  } catch (err) {
    console.error('Claude structuring error:', err.message);
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Sorry, something went wrong while processing your formulation. Please try again by typing *new*.');
  }

  const card = _formatCard(structured);

  await setSession(practitioner.id, 'guided_doc', 'awaiting_confirmation', {
    structured,
    original_text: transcript,
    original_language: structured.metadata?.original_language ?? 'en',
  });

  await sendTextMessage(from, `Here's what I recorded:\n\n${card}`);
  return sendButtonMessage(from, 'Is this correct?', ['Yes, save', 'Edit', 'Cancel']);
}

// ─── confirmation handler ─────────────────────────────────────────────────────

async function _handleConfirmation(message, from, practitioner, context) {
  const reply = _buttonOrText(message).toLowerCase().trim();

  if (reply.includes('yes') || reply.includes('save')) {
    return _saveAndClose(from, practitioner, context);
  }

  if (reply.includes('cancel')) {
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Formulation discarded. Type *new* whenever you want to try again.');
  }

  if (reply.includes('edit')) {
    // W4 will implement field-level editing within guided flow; restart for now
    await endSession(practitioner.id);
    await sendTextMessage(from, "Let's go through the questions again.");
    return handle(message, from, practitioner);
  }

  // Unrecognised reply — re-prompt
  return sendButtonMessage(from, 'Please choose one of the options below.', ['Yes, save', 'Edit', 'Cancel']);
}

async function _saveAndClose(from, practitioner, context) {
  const { structured, original_text, original_language } = context;

  const formulation = await saveFormulation({
    practitioner_id:  practitioner.id,
    source_media_id:  null,
    structured,
    original_text,
    original_language,
  });

  await logEvent({
    practitioner_id: practitioner.id,
    event_type: 'formulation_saved',
    payload: { short_code: formulation.short_code, flow: 'guided_doc' },
  });

  await endSession(practitioner.id);

  return sendTextMessage(
    from,
    `✅ Saved as *${formulation.short_code}*.\n\nType *my vault* to see all your formulations, or *new* to document another one.`
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function _extractAnswer(message, from, practitioner) {
  if (message.type === 'text') {
    const body = message.text?.body?.trim();
    if (!body) return null;
    if (body.toLowerCase() === 'skip') return '';
    return body;
  }

  if (message.type === 'audio') {
    const { buffer, mimeType } = await downloadMedia(message.audio.id);
    const { text, confidence } = await transcribe(buffer, mimeType);
    if (confidence < 0.7 || !text?.trim()) return null;

    // Store the voice note (non-fatal if it fails)
    uploadVoiceNote(practitioner.id, buffer, mimeType)
      .then(path => saveMedia({ practitioner_id: practitioner.id, kind: 'voice', storage_path: path, transcript: text }))
      .catch(e => console.warn('media save failed (non-fatal):', e.message));

    return text.trim();
  }

  return null;
}

// Build a plain-English transcript from the 5 collected answers for Claude to structure
function _contextToTranscript(context) {
  const parts = [];
  if (context.condition)   parts.push(`Condition: ${context.condition}`);
  if (context.plants)      parts.push(`Plants: ${context.plants}`);
  if (context.preparation) parts.push(`Preparation: ${context.preparation}`);
  if (context.dosage)      parts.push(`Dosage: ${context.dosage}`);
  if (context.notes)       parts.push(`Notes: ${context.notes}`);
  return parts.join('\n');
}

// Format a structured formulation as a readable WhatsApp card
function _formatCard(s) {
  const lines = [];

  const cond = s.condition?.standardised || s.condition?.local_name;
  if (cond) lines.push(`*Condition:* ${cond}`);

  if (s.plants?.length) {
    lines.push('*Plants:*');
    for (const p of s.plants) {
      const name = p.botanical ? `${p.local_name} (${p.botanical})` : p.local_name;
      const qty  = p.quantity_normalised || p.quantity_raw || '';
      lines.push(`  • ${name}${qty ? ' — ' + qty : ''}`);
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

  return lines.join('\n');
}

function _buttonOrText(message) {
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title ?? '';
  }
  return message.text?.body ?? '';
}

module.exports = { handle, resume, _formatCard, _contextToTranscript };
