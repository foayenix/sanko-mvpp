// Flow 5 — Edit Formulation (PRD §5.5)
// Trigger: 'edit FM-00034' from anywhere, or 'edit' from a detail card with a code in context.
//
// Steps:
//   1. Look up formulation by short_code → verify ownership
//   2. Show field picker: [Plants] [Preparation] [Dosage] [Notes]  (PRD §5.5)
//   3. Practitioner picks field → bot asks for the correction (voice or text)
//   4. Claude editField re-runs on just that field
//   5. UPDATE the matching DB column (overwrite; original_text preserved)
//   6. Write formulation_edited event
//   7. Confirm with updated value
//
// Versioning (PRD §5.5): simple overwrite. original_text is never changed.

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const {
  getFormulationByShortCode,
  updateFormulationField,
  logEvent,
  saveMedia,
  uploadVoiceNote,
} = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { transcribe } = require('../services/whisper');
const { editField } = require('../services/claude');

// Fields the practitioner can edit (PRD §5.5 button list)
const EDIT_FIELDS   = ['Plants', 'Preparation', 'Dosage', 'Notes'];
const FIELD_TO_COL  = { Plants: 'plants', Preparation: 'preparation', Dosage: 'dosage', Notes: 'notes' };
const FIELD_PROMPTS = {
  Plants:      'Send a voice note (or type) describing the plants — list each one with the quantity.',
  Preparation: 'Send a voice note (or type) describing how it is prepared.',
  Dosage:      'Send a voice note (or type) describing the new dosage.',
  Notes:       'Send a voice note (or type) with your notes or warnings. Reply *skip* to clear notes.',
};

// ─── entry point ──────────────────────────────────────────────────────────────

async function handle(message, from, practitioner) {
  const shortCode = _parseShortCode(message);

  if (!shortCode) {
    return sendTextMessage(from, 'Please include the formulation code, e.g. *edit FM-00034*');
  }

  const formulation = await getFormulationByShortCode(shortCode, practitioner.id);

  if (!formulation) {
    return sendTextMessage(
      from,
      `I couldn't find *${shortCode}* in your Vault. Type *my vault* to see your formulations.`
    );
  }

  await setSession(practitioner.id, 'edit', 'awaiting_field_choice', {
    formulation_id:       formulation.id,
    short_code:           formulation.short_code,
    formulation_snapshot: _toSnapshot(formulation),
  });

  return sendButtonMessage(
    from,
    `Editing *${formulation.short_code}*. Which part would you like to change?`,
    EDIT_FIELDS
  );
}

// ─── session resume ───────────────────────────────────────────────────────────

async function resume(session, message, from, practitioner) {
  const { step, context } = session;

  // Cancel at any point
  const text = (message.type === 'text' ? message.text?.body ?? '' : '').toLowerCase().trim();
  if (text === 'cancel' || text === 'stop') {
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Edit cancelled. No changes were saved.');
  }

  if (step === 'awaiting_field_choice') {
    return _handleFieldChoice(message, from, practitioner, context);
  }

  if (step === 'awaiting_correction') {
    return _handleCorrection(message, from, practitioner, context);
  }

  await endSession(practitioner.id);
  return handle(message, from, practitioner);
}

// ─── step handlers ────────────────────────────────────────────────────────────

async function _handleFieldChoice(message, from, practitioner, context) {
  const choice = _buttonOrText(message).trim();

  if (!FIELD_TO_COL[choice]) {
    return sendButtonMessage(
      from,
      'Please pick one of the fields below.',
      EDIT_FIELDS
    );
  }

  await setSession(practitioner.id, 'edit', 'awaiting_correction', { ...context, field: choice });
  return sendTextMessage(from, FIELD_PROMPTS[choice]);
}

async function _handleCorrection(message, from, practitioner, context) {
  const { formulation_id, short_code, field, formulation_snapshot } = context;

  // Extract the correction text
  const { answer, failed } = await _extractAnswer(message, from, practitioner);
  if (failed) {
    return sendTextMessage(from, "Sorry, I didn't catch that. Please try again.");
  }

  // Notes field: 'skip' clears the field without calling Claude
  const col = FIELD_TO_COL[field];
  if (col === 'notes') {
    const newValue = answer === '' ? null : answer;
    await updateFormulationField(formulation_id, col, newValue);
    await _logEdit(practitioner.id, short_code, field, answer);
    await endSession(practitioner.id);
    return sendTextMessage(
      from,
      newValue
        ? `✅ Notes updated on *${short_code}*.\n\n_"${newValue}"_`
        : `✅ Notes cleared on *${short_code}*.`
    );
  }

  // For structured fields (plants, preparation, dosage) — ask Claude to re-parse
  let updated;
  try {
    updated = await editField(formulation_snapshot, field.toLowerCase(), answer);
  } catch (err) {
    console.error('Claude editField error:', err.message);
    await logEvent({ practitioner_id: practitioner.id, event_type: 'error', payload: { step: 'edit_field', error: err.message } });
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Sorry, something went wrong processing your correction. Please try again.');
  }

  // Extract just the changed field from Claude's full response
  const newValue = updated[field.toLowerCase()] ?? updated[col];

  if (newValue == null) {
    await endSession(practitioner.id);
    return sendTextMessage(from, "I couldn't parse that correction. No changes were saved. Please try again with *edit " + short_code + '*.');
  }

  await updateFormulationField(formulation_id, col, newValue);
  await _logEdit(practitioner.id, short_code, field, answer);
  await endSession(practitioner.id);

  const summary = _summariseField(field, newValue);
  return sendTextMessage(
    from,
    `✅ *${field}* updated on *${short_code}*.\n\n${summary}\n\nType *my vault* to review the full record.`
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Extracts correction text from voice or text message.
// Returns { answer, failed } where answer === '' means 'skip'.
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

// Parses 'FM-00034' from 'edit fm-00034' or 'edit FM-00034'
function _parseShortCode(message) {
  const text = (message.type === 'text' ? message.text?.body ?? '' : '').trim();
  const match = text.match(/FM-\d+/i);
  return match ? match[0].toUpperCase() : null;
}

// Converts a DB formulation row to the PRD §4.3 JSON shape Claude expects
function _toSnapshot(f) {
  return {
    formulation_id: f.short_code,
    condition:   { local_name: f.condition_local, standardised: f.condition_std, icd_11_code: f.icd_11_code },
    plants:      f.plants ?? [],
    preparation: f.preparation ?? {},
    dosage:      f.dosage ?? {},
    notes:       f.notes ?? null,
    metadata:    { confidence_score: f.confidence_score, original_language: f.original_language },
  };
}

// Produces a short human-readable summary of the new field value for the confirmation message
function _summariseField(field, value) {
  if (field === 'Plants' && Array.isArray(value)) {
    return '*Plants:*\n' + value.map(p => {
      const name = p.botanical ? `${p.local_name} (${p.botanical})` : p.local_name;
      const qty  = p.quantity_normalised || p.quantity_raw || '';
      return `  • ${name}${qty ? ' — ' + qty : ''}`;
    }).join('\n');
  }
  if (field === 'Preparation' && value?.method) {
    const dur = value.duration_minutes ? ` for ${value.duration_minutes} min` : '';
    const med = value.medium ? ` in ${value.medium}` : '';
    return `*Preparation:* ${value.method}${dur}${med}`;
  }
  if (field === 'Dosage' && (value?.amount || value?.frequency)) {
    const parts = [value.amount, value.frequency].filter(Boolean);
    if (value.duration_days) parts.push(`for ${value.duration_days} days`);
    return `*Dosage:* ${parts.join(', ')}`;
  }
  return JSON.stringify(value);
}

async function _logEdit(practitioner_id, short_code, field, correction_text) {
  await logEvent({
    practitioner_id,
    event_type: 'formulation_edited',
    payload: { short_code, field, correction_text },
  });
}

function _buttonOrText(message) {
  if (message.type === 'interactive') return message.interactive?.button_reply?.title ?? '';
  return message.text?.body ?? '';
}

module.exports = { handle, resume, _parseShortCode, _toSnapshot, _summariseField };
