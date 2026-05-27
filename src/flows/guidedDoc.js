// Flow 2 — Guided Documentation (PRD §5.2)
// Trigger: practitioner types 'new' / taps Document New Formulation.
//
// W3: happy path — 5 questions → Claude → confirmation → DB write.
// W4 edge cases added:
//   • Cancel at any step (type 'cancel' or 'stop')
//   • Low-confidence Whisper: retry up to 2×, then suggest typing
//   • Session timeout: handled by router (detects expired session)
//   • Field-level edit from confirmation card (field picker → re-answer one field)

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const { logEvent, saveMedia, uploadVoiceNote, saveFormulation } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { transcribe } = require('../services/whisper');
const { structureFormulation } = require('../services/claude');

const STEPS = ['awaiting_condition', 'awaiting_plants', 'awaiting_preparation', 'awaiting_dosage', 'awaiting_notes'];

const QUESTIONS = {
  awaiting_condition:   'What condition does this formulation treat?\n_(e.g. "fever", "iba", "typhoid")_',
  awaiting_plants:      'What plants go into it? List them one by one, including how much of each.\n_(e.g. "10 neem leaves, one handful of bitter leaf")_',
  awaiting_preparation: 'How is it prepared?\n_(e.g. "boil in water for 20 minutes")_',
  awaiting_dosage:      'What is the dosage?\n_(e.g. "one cup, twice a day, for five days")_',
  awaiting_notes:       'Any notes or warnings? _(optional — reply *skip* to leave blank)_',
};

// Maps each question step to its context key and display label
const FIELD = {
  awaiting_condition:   { key: 'condition',   label: 'Condition' },
  awaiting_plants:      { key: 'plants',       label: 'Plants' },
  awaiting_preparation: { key: 'preparation',  label: 'Preparation' },
  awaiting_dosage:      { key: 'dosage',        label: 'Dosage' },
  awaiting_notes:       { key: 'notes',         label: 'Notes' },
};

// Field-level edit steps — parallel to STEPS but prefixed
const EDIT_STEP_FOR = {
  Condition:   'awaiting_condition',
  Plants:      'awaiting_plants',
  Preparation: 'awaiting_preparation',
  Dosage:      'awaiting_dosage',
};
const EDIT_FIELDS = Object.keys(EDIT_STEP_FOR);

// WhatsApp interactive buttons support max 3 items — use a numbered text menu instead.
function _fieldPickerText(header) {
  return `${header}\n\n${EDIT_FIELDS.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nReply with a number or the field name.`;
}

function _resolveFieldChoice(message) {
  const raw = _buttonOrText(message).trim();
  const num = parseInt(raw, 10);
  if (!isNaN(num) && num >= 1 && num <= EDIT_FIELDS.length) return EDIT_FIELDS[num - 1];
  return EDIT_FIELDS.find(f => f.toLowerCase() === raw.toLowerCase()) ?? null;
}

const CANCEL_WORDS = new Set(['cancel', 'stop', 'quit', 'abort']);
const MAX_RETRIES = 2;

// ─── entry point ──────────────────────────────────────────────────────────────

async function handle(message, from, practitioner) {
  await setSession(practitioner.id, 'guided_doc', 'awaiting_condition', {});
  await sendTextMessage(from, "Let's document a new formulation. I'll ask you five quick questions.\n\nYou can answer by voice note or text. Type *cancel* at any time to stop.");
  return sendTextMessage(from, `*Question 1 of 5*\n\n${QUESTIONS.awaiting_condition}`);
}

// ─── session resume ───────────────────────────────────────────────────────────

async function resume(session, message, from, practitioner) {
  const { step, context } = session;

  // Cancel keyword terminates the flow from any step
  if (_isCancelIntent(message)) {
    await endSession(practitioner.id);
    await logEvent({ practitioner_id: practitioner.id, event_type: 'formulation_cancelled', payload: { step } });
    return sendTextMessage(from, 'Formulation discarded. Type *new* whenever you want to try again.');
  }

  if (step === 'awaiting_confirmation') {
    return _handleConfirmation(message, from, practitioner, context);
  }

  if (step === 'awaiting_edit_field_choice') {
    return _handleFieldChoice(message, from, practitioner, context);
  }

  // Resuming a single-field edit after the picker
  if (step.startsWith('awaiting_edit_')) {
    return _handleEditAnswer(step, message, from, practitioner, context);
  }

  if (STEPS.includes(step)) {
    return _handleAnswer(step, message, from, practitioner, context);
  }

  // Unknown step — restart cleanly
  await endSession(practitioner.id);
  return handle(message, from, practitioner);
}

// ─── question answer handler ──────────────────────────────────────────────────

async function _handleAnswer(step, message, from, practitioner, context) {
  const { answer, failed } = await _extractAnswer(message, from, practitioner);

  if (failed) {
    const retries = (context._retries?.[step] ?? 0) + 1;
    const updatedRetries = { ...(context._retries ?? {}), [step]: retries };

    if (retries >= MAX_RETRIES) {
      // Suggest typing after repeated audio failures
      await setSession(practitioner.id, 'guided_doc', step, { ...context, _retries: updatedRetries });
      return sendTextMessage(from, "I'm having trouble with that voice note. You can type your answer instead, or send another voice note.");
    }

    await setSession(practitioner.id, 'guided_doc', step, { ...context, _retries: updatedRetries });
    return sendTextMessage(from, "Sorry, I didn't catch that clearly. Please try again.");
  }

  // Reset retry count for this step on success
  const { _retries, ...cleanContext } = context;
  const updatedContext = { ...cleanContext, [FIELD[step].key]: answer };

  const stepIndex = STEPS.indexOf(step);
  const nextStep = STEPS[stepIndex + 1];

  if (nextStep) {
    await setSession(practitioner.id, 'guided_doc', nextStep, updatedContext);
    return sendTextMessage(from, `*Question ${stepIndex + 2} of 5*\n\n${QUESTIONS[nextStep]}`);
  }

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
    await logEvent({ practitioner_id: practitioner.id, event_type: 'error', payload: { step: 'structuring', error: err.message } });
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Sorry, something went wrong processing your formulation. Please try again by typing *new*.');
  }

  await setSession(practitioner.id, 'guided_doc', 'awaiting_confirmation', {
    structured,
    answers: context,
    original_text: transcript,
    original_language: structured.metadata?.original_language ?? 'en',
  });

  await sendTextMessage(from, `Here's what I recorded:\n\n${_formatCard(structured)}`);
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
    await logEvent({ practitioner_id: practitioner.id, event_type: 'formulation_cancelled', payload: { step: 'confirmation' } });
    return sendTextMessage(from, 'Formulation discarded. Type *new* whenever you want to try again.');
  }

  if (reply.includes('edit')) {
    await setSession(practitioner.id, 'guided_doc', 'awaiting_edit_field_choice', context);
    return sendTextMessage(from, _fieldPickerText('Which part would you like to change?'));
  }

  return sendButtonMessage(from, 'Please choose one of the options below.', ['Yes, save', 'Edit', 'Cancel']);
}

// ─── field-level edit ─────────────────────────────────────────────────────────

async function _handleFieldChoice(message, from, practitioner, context) {
  const choice = _resolveFieldChoice(message);
  const editStep = choice ? EDIT_STEP_FOR[choice] : null;

  if (!editStep) {
    return sendTextMessage(from, _fieldPickerText('Please pick a field to edit.'));
  }

  await setSession(practitioner.id, 'guided_doc', `awaiting_edit_${editStep.replace('awaiting_', '')}`, context);
  return sendTextMessage(from, `OK, let's update the *${choice.toLowerCase()}*.\n\n${QUESTIONS[editStep]}`);
}

async function _handleEditAnswer(step, message, from, practitioner, context) {
  // step is e.g. 'awaiting_edit_condition' — map back to the original step key
  const originalStep = step.replace('awaiting_edit_', 'awaiting_');
  const fieldMeta = FIELD[originalStep];

  if (!fieldMeta) {
    await endSession(practitioner.id);
    return handle(message, from, practitioner);
  }

  const { answer, failed } = await _extractAnswer(message, from, practitioner);

  if (failed) {
    return sendTextMessage(from, "Sorry, I didn't catch that. Please try again or type your answer.");
  }

  // Patch the answers and rebuild the confirmation
  const updatedAnswers = { ...(context.answers ?? {}), [fieldMeta.key]: answer };
  return _buildConfirmation(from, practitioner, updatedAnswers);
}

// ─── save ─────────────────────────────────────────────────────────────────────

async function _saveAndClose(from, practitioner, context) {
  const { structured, original_text, original_language } = context;

  const formulation = await saveFormulation({
    practitioner_id: practitioner.id,
    source_media_id: null,
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

// Returns { answer, failed } — 'failed' true means retry is needed
async function _extractAnswer(message, from, practitioner) {
  if (message.type === 'text') {
    const body = message.text?.body?.trim();
    if (!body) return { answer: null, failed: true };
    if (body.toLowerCase() === 'skip') return { answer: '', failed: false };
    return { answer: body, failed: false };
  }

  if (message.type === 'audio') {
    const { buffer, mimeType } = await downloadMedia(message.audio.id);
    const { text, confidence } = await transcribe(buffer, mimeType);

    if (confidence < 0.7 || !text?.trim()) return { answer: null, failed: true };

    uploadVoiceNote(practitioner.id, buffer, mimeType)
      .then(path => saveMedia({ practitioner_id: practitioner.id, kind: 'voice', storage_path: path, transcript: text }))
      .catch(e => console.warn('media save failed (non-fatal):', e.message));

    return { answer: text.trim(), failed: false };
  }

  return { answer: null, failed: true };
}

function _isCancelIntent(message) {
  const text = message.type === 'text' ? (message.text?.body ?? '').toLowerCase().trim() : '';
  return CANCEL_WORDS.has(text);
}

function _contextToTranscript(context) {
  const parts = [];
  if (context.condition)   parts.push(`Condition: ${context.condition}`);
  if (context.plants)      parts.push(`Plants: ${context.plants}`);
  if (context.preparation) parts.push(`Preparation: ${context.preparation}`);
  if (context.dosage)      parts.push(`Dosage: ${context.dosage}`);
  if (context.notes)       parts.push(`Notes: ${context.notes}`);
  return parts.join('\n');
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

module.exports = { handle, resume, _formatCard, _contextToTranscript, _isCancelIntent };
