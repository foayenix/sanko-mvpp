// Flow 6 — Photo Capture (PRD §5.6)
// Trigger: practitioner sends ANY photo — router routes images here regardless of active session.
//
// Pipeline:
//   1. Download image from Meta CDN
//   2. Store in Supabase Storage (photos/ bucket)
//   3. Send to Claude Sonnet vision with readNotebook.txt prompt
//   4. If Claude returns {"error":"unreadable"} or confidence < 0.6 → ask for retake
//   5. Otherwise → show confirmation card → save on approval
//
// Acceptance criteria (PRD §5.6):
//   • Clear photo of handwritten Yoruba notebook → ≥ 1 structured formulation extracted
//   • Blurry / rotated photo → bot asks for retake, does NOT guess

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const { logEvent, saveMedia, uploadPhoto, saveFormulation } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { readNotebookPhoto } = require('../services/claude');

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const CANCEL_WORDS = new Set(['cancel', 'stop', 'quit', 'abort']);

// ─── entry point (called for every inbound image) ─────────────────────────────

async function handle(message, from, practitioner) {
  // Acknowledge immediately — vision call can take several seconds
  await sendTextMessage(from, 'Got your photo — one moment while I read it…');

  const mediaId = message.image?.id;
  if (!mediaId) {
    return sendTextMessage(from, 'Sorry, I could not access that image. Please try sending it again.');
  }

  // Download from Meta CDN
  let buffer, mimeType;
  try {
    ({ buffer, mimeType } = await downloadMedia(mediaId));
  } catch (err) {
    console.error('Photo download error:', err.message);
    return sendTextMessage(from, 'Sorry, I had trouble downloading your photo. Please try again.');
  }

  // Store in Supabase Storage (non-fatal — don't block if upload fails)
  let mediaRecord = null;
  try {
    const storagePath = await uploadPhoto(practitioner.id, buffer, mimeType);
    mediaRecord = await saveMedia({
      practitioner_id: practitioner.id,
      kind: 'photo',
      storage_path: storagePath,
    });
  } catch (e) {
    console.warn('Photo upload failed (non-fatal):', e.message);
  }

  await logEvent({
    practitioner_id: practitioner.id,
    event_type: 'inbound_photo',
    payload: { media_id: mediaRecord?.id ?? null },
  });

  // Send to Claude vision
  let structured;
  try {
    const imageBase64 = buffer.toString('base64');
    structured = await readNotebookPhoto(imageBase64, mimeType);
  } catch (err) {
    console.error('Claude vision error:', err.message);
    await logEvent({ practitioner_id: practitioner.id, event_type: 'error', payload: { step: 'claude_vision', error: err.message } });
    return sendTextMessage(from, 'Sorry, something went wrong reading your photo. Please try again.');
  }

  await logEvent({
    practitioner_id: practitioner.id,
    event_type: 'claude_call',
    payload: { type: 'vision', confidence: structured?.metadata?.confidence_score ?? null },
  });

  // Unreadable photo — Claude returns {error: "unreadable"}
  if (structured.error === 'unreadable') {
    return sendTextMessage(
      from,
      `I couldn't read that page clearly${structured.reason ? ': ' + structured.reason : ''}.\n\nPlease retake the photo:\n• Make sure the page is flat and fully in frame\n• Use good lighting — natural light works best\n• Hold the camera directly above the page`
    );
  }

  const confidence = structured.metadata?.confidence_score ?? 0;

  // Low confidence — retake (PRD §5.6 acceptance criteria)
  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    return sendTextMessage(
      from,
      `The photo was a bit hard to read (${Math.round(confidence * 100)}% confidence). Please retake it:\n• Make sure the writing is in focus\n• Avoid shadows across the page\n• Hold the camera steady`
    );
  }

  // Good confidence — show confirmation card
  return _showConfirmation(from, practitioner, structured, mediaRecord?.id ?? null);
}

// ─── confirmation ─────────────────────────────────────────────────────────────

async function _showConfirmation(from, practitioner, structured, mediaId) {
  const card = _formatCard(structured);

  await setSession(practitioner.id, 'photo_capture', 'awaiting_confirmation', {
    structured,
    source_media_id: mediaId,
    original_language: structured.metadata?.original_language ?? 'en',
  });

  await sendTextMessage(from, `Here's what I read from your notebook:\n\n${card}`);
  return sendButtonMessage(from, 'Is this correct?', ['Yes, save', 'Edit', 'Cancel']);
}

// ─── session resume ───────────────────────────────────────────────────────────

async function resume(session, message, from, practitioner) {
  const { step, context } = session;

  const text = (message.type === 'text' ? message.text?.body ?? '' : '').toLowerCase().trim();
  if (CANCEL_WORDS.has(text)) {
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Formulation discarded. Send another photo any time.');
  }

  if (step === 'awaiting_confirmation') {
    return _handleConfirmation(message, from, practitioner, context);
  }

  await endSession(practitioner.id);
  return sendTextMessage(from, 'Session cleared. Send a photo to try again.');
}

async function _handleConfirmation(message, from, practitioner, context) {
  const reply = _buttonOrText(message).toLowerCase().trim();

  if (reply.includes('yes') || reply.includes('save')) {
    const { structured, source_media_id, original_language } = context;

    const formulation = await saveFormulation({
      practitioner_id:  practitioner.id,
      source_media_id:  source_media_id ?? null,
      structured,
      original_text:    structured.metadata?.original_text ?? null,
      original_language,
    });

    await logEvent({
      practitioner_id: practitioner.id,
      event_type: 'formulation_saved',
      payload: { short_code: formulation.short_code, flow: 'photo_capture' },
    });

    await endSession(practitioner.id);
    return sendTextMessage(
      from,
      `✅ Saved as *${formulation.short_code}*.\n\nType *my vault* to browse your records, or send another photo to capture the next formulation.`
    );
  }

  if (reply.includes('cancel')) {
    await endSession(practitioner.id);
    return sendTextMessage(from, 'Formulation discarded. Send another photo any time.');
  }

  if (reply.includes('edit')) {
    // Hand off to guided doc — practitioner goes through the 5 questions to correct details
    await endSession(practitioner.id);
    const guidedDoc = require('./guidedDoc');
    await sendTextMessage(from, "Let's go through the details so you can correct anything I missed.");
    return guidedDoc.handle(message, from, practitioner);
  }

  return sendButtonMessage(from, 'Please choose one of the options.', ['Yes, save', 'Edit', 'Cancel']);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

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
  lines.push(`_Source: photo_`);

  if (s.plants?.some(p => !p.botanical)) {
    lines.push('_⚠️ = plant not in lookup, flagged for review_');
  }

  return lines.join('\n');
}

function _buttonOrText(message) {
  if (message.type === 'interactive') return message.interactive?.button_reply?.title ?? '';
  return message.text?.body ?? '';
}

module.exports = { handle, resume, _formatCard };
