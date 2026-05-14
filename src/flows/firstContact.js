// Flow 1 — First Contact (PRD §5.1)
// Trigger: any inbound message from a phone number NOT in practitioners table.
//
// Conversation:
//   BOT  → language picker (button message)
//   USER → taps button OR types language name OR sends voice note (Whisper auto-detects)
//   BOT  → "Great. Please send a voice note with your full name …"
//   USER → voice note with name (and optional practice name)
//   BOT  → "Welcome, <name> 👏 Your Vault is ready …"
//
// Key design decision: the practitioner record is created as soon as the language
// is confirmed (not after the name step) so that the session FK constraint is
// satisfied and resume() is reachable on the next inbound message.
//
// Writes: practitioners (create + update display_name), media (voice note), events

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const { createPractitioner, getPractitioner, updatePractitioner, logEvent, saveMedia, uploadVoiceNote } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { transcribe } = require('../services/whisper');

const LANGUAGE_OPTIONS = ['English', 'Yorùbá', 'Igbo', 'Hausa'];
const LANGUAGE_CODE_MAP = {
  english: 'en', yoruba: 'yo', yorùbá: 'yo', igbo: 'ig', hausa: 'ha',
};

// Entry point — called by router when the phone number is unknown
async function handle(message, from) {
  // Audio before language picker: Whisper detects language, skip straight to name step
  if (message.type === 'audio') {
    const { text, language, confidence } = await _transcribeMessage(message, from);
    if (confidence < 0.7) {
      return sendTextMessage(from, "Sorry, I didn't catch that. Please try again, or tap a language button below.\n\n" +
        "Hello 👋 I'm Sanko. What language do you prefer?")
        .then(() => sendButtonMessage(from, 'Choose your language:', LANGUAGE_OPTIONS));
    }
    const langCode = _whisperLangToCode(language);
    const practitioner = await _getOrCreatePractitioner(from, langCode);
    await setSession(practitioner.id, 'first_contact', 'awaiting_name', { name_attempt: text.trim() });
    return _askForName(from);
  }

  // Check if this looks like a language selection (button tap or typed name)
  const langInput = message.type === 'interactive'
    ? (message.interactive?.button_reply?.title ?? '')
    : (message.type === 'text' ? (message.text?.body ?? '') : '');

  const chosen = _resolveLanguage(langInput);
  if (chosen) {
    // Language confirmed — create practitioner now so session FK is valid
    const practitioner = await _getOrCreatePractitioner(from, chosen);
    await setSession(practitioner.id, 'first_contact', 'awaiting_name', {});
    return _askForName(from);
  }

  // Default path: show language picker
  return sendButtonMessage(
    from,
    "Hello 👋 I'm Sanko. I help traditional medicine practitioners document their work.\n\nWhat language do you prefer?",
    LANGUAGE_OPTIONS
  );
}

// Called by router when the practitioner exists and has an active first_contact session
async function resume(session, message, from, practitioner) {
  const { step } = session;

  if (step === 'awaiting_name') {
    return _handleNameVoiceNote(message, from, practitioner);
  }

  // Unexpected state — restart
  await endSession(practitioner.id);
  return sendButtonMessage(
    from,
    "Let's start over. What language do you prefer?",
    LANGUAGE_OPTIONS
  );
}

// ─── step handlers ────────────────────────────────────────────────────────────

async function _handleNameVoiceNote(message, from, practitioner) {
  let displayName = null;
  let mediaRecord = null;

  if (message.type === 'audio') {
    const { buffer, mimeType } = await downloadMedia(message.audio.id);
    const { text, confidence } = await transcribe(buffer, mimeType);

    if (confidence < 0.7 || !text) {
      return sendTextMessage(from, "Sorry, I didn't catch that. Please try again — send a clear voice note with your full name.");
    }

    // Store voice note (best-effort — non-fatal)
    let storagePath = null;
    try {
      storagePath = await uploadVoiceNote(practitioner.id, buffer, mimeType);
    } catch (e) {
      console.warn('Voice note upload failed (non-fatal):', e.message);
    }

    displayName = _extractName(text);
    mediaRecord = { kind: 'voice', storage_path: storagePath, transcript: text };

  } else if (message.type === 'text') {
    displayName = message.text?.body?.trim() ?? null;
    mediaRecord = { kind: 'text', transcript: displayName };
  } else {
    return sendTextMessage(from, 'Please send a voice note (or type) with your full name.');
  }

  if (!displayName) {
    return sendTextMessage(from, "I couldn't make out a name. Please try again.");
  }

  // Update the practitioner record with their display name
  await updatePractitioner(practitioner.id, { display_name: displayName });

  await saveMedia({ practitioner_id: practitioner.id, ...mediaRecord }).catch(e =>
    console.warn('saveMedia failed (non-fatal):', e.message)
  );

  await logEvent({
    practitioner_id: practitioner.id,
    event_type: 'practitioner_onboarded',
    payload: { display_name: displayName, preferred_language: practitioner.preferred_language },
  });

  await endSession(practitioner.id);

  return sendTextMessage(
    from,
    `Welcome, ${displayName} 👏\n\nYour Vault is ready. You can start documenting a formulation now — just send me a voice note describing one, or type *help*.`
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _askForName(from) {
  return sendTextMessage(
    from,
    'Great. Please send me a voice note with your full name and the name of your practice, if you have one.'
  );
}

function _resolveLanguage(input) {
  const normalised = input.toLowerCase().replace(/[^a-zà-ú]/g, '');
  for (const [key, code] of Object.entries(LANGUAGE_CODE_MAP)) {
    if (normalised.includes(key)) return code;
  }
  return null;
}

function _whisperLangToCode(whisperLang) {
  const map = { yoruba: 'yo', igbo: 'ig', hausa: 'ha', english: 'en' };
  return map[whisperLang?.toLowerCase()] ?? 'en';
}

// Heuristic: extract name from transcript
function _extractName(text) {
  const match = text.match(/(?:my name is|i(?:'| a)m|call me)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i);
  if (match) return match[1].trim();
  return text.trim().split(/\s+/).slice(0, 4).join(' ');
}

// Creates a new practitioner or returns the existing one if the phone already exists
// (guards against duplicate delivery of the language-selection message)
async function _getOrCreatePractitioner(from, langCode) {
  try {
    return await createPractitioner({ phone_number: from, preferred_language: langCode, display_name: null });
  } catch (_) {
    const existing = await getPractitioner(from);
    if (existing) return existing;
    throw new Error('Could not create or retrieve practitioner');
  }
}

async function _transcribeMessage(message, _from) {
  const { buffer, mimeType } = await downloadMedia(message.audio.id);
  return transcribe(buffer, mimeType);
}

module.exports = { handle, resume };
