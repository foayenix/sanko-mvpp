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
// Writes: practitioners, media (voice note), events (practitioner_onboarded)

const { sendTextMessage, sendButtonMessage, downloadMedia } = require('../services/whatsapp');
const { createPractitioner, logEvent, saveMedia, uploadVoiceNote } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');
const { transcribe } = require('../services/whisper');

const LANGUAGE_OPTIONS = ['English', 'Yorùbá', 'Igbo', 'Hausa'];
const LANGUAGE_CODE_MAP = {
  english: 'en', yoruba: 'en', yorùbá: 'yo', igbo: 'ig', hausa: 'ha',
};

// Entry point — called by router when the phone number is unknown
async function handle(message, from) {
  // Edge case: practitioner sends a voice note before choosing a language.
  // Whisper will auto-detect; we skip straight to name collection.
  if (message.type === 'audio') {
    const { text, language, confidence } = await _transcribeMessage(message, from);
    if (confidence < 0.7) {
      return sendTextMessage(from, "Sorry, I didn't catch that. Please try again, or type your name.");
    }
    const langCode = _whisperLangToCode(language);
    await setSession(from, 'first_contact', 'awaiting_name', { preferred_language: langCode, name_attempt: text });
    return _askForName(from);
  }

  // Normal path: show language picker
  await setSession(from, 'first_contact', 'awaiting_language', {});
  return sendButtonMessage(
    from,
    "Hello 👋 I'm Sanko. I help traditional medicine practitioners document their work.\n\nWhat language do you prefer?",
    LANGUAGE_OPTIONS
  );
}

// Called by router when a practitioner has an active first_contact session
async function resume(session, message, from, _practitioner) {
  const { step, context } = session;

  if (step === 'awaiting_language') {
    return _handleLanguageChoice(message, from, context);
  }

  if (step === 'awaiting_name') {
    return _handleNameVoiceNote(message, from, context);
  }

  // Unexpected state — restart
  await endSession(from);
  return handle(message, from);
}

// ─── step handlers ────────────────────────────────────────────────────────────

async function _handleLanguageChoice(message, from, context) {
  let chosen = null;

  if (message.type === 'interactive') {
    // Button tap
    const title = message.interactive?.button_reply?.title ?? '';
    chosen = _resolveLanguage(title);
  } else if (message.type === 'text') {
    // Free-text fallback (PRD §5.1 edge case)
    chosen = _resolveLanguage(message.text?.body ?? '');
  } else if (message.type === 'audio') {
    // Voice before choosing — auto-detect and continue
    const { text, language, confidence } = await _transcribeMessage(message, from);
    if (confidence < 0.7) {
      return sendTextMessage(from, "Sorry, I didn't catch that. Please tap one of the language buttons.");
    }
    chosen = _whisperLangToCode(language);
    await setSession(from, 'first_contact', 'awaiting_name', { ...context, preferred_language: chosen, name_attempt: text });
    return _askForName(from);
  }

  if (!chosen) {
    return sendButtonMessage(
      from,
      "Please tap one of the options below, or type: English, Yoruba, Igbo, or Hausa.",
      LANGUAGE_OPTIONS
    );
  }

  await setSession(from, 'first_contact', 'awaiting_name', { ...context, preferred_language: chosen });
  return _askForName(from);
}

async function _handleNameVoiceNote(message, from, context) {
  let displayName = null;
  let mediaRecord = null;

  if (message.type === 'audio') {
    const { buffer, mimeType } = await downloadMedia(message.audio.id);
    const { text, confidence } = await transcribe(buffer, mimeType);

    if (confidence < 0.7 || !text) {
      return sendTextMessage(from, "Sorry, I didn't catch that. Please try again — send a clear voice note with your full name.");
    }

    // Store voice note in Supabase Storage (best-effort — don't block onboarding if it fails)
    let storagePath = null;
    try {
      // We don't have a practitioner id yet; use phone number as temp folder
      storagePath = await uploadVoiceNote(from.replace('+', ''), buffer, mimeType);
    } catch (e) {
      console.warn('Voice note upload failed (non-fatal):', e.message);
    }

    displayName = _extractName(text);

    // Save media row after practitioner created below
    mediaRecord = { kind: 'voice', storage_path: storagePath, transcript: text };

  } else if (message.type === 'text') {
    // Accept typed name as fallback
    displayName = message.text?.body?.trim() ?? null;
    mediaRecord = { kind: 'text', transcript: displayName };
  } else {
    return sendTextMessage(from, 'Please send a voice note (or type) with your full name.');
  }

  if (!displayName) {
    return sendTextMessage(from, "I couldn't make out a name. Please try again.");
  }

  // Create practitioner record
  const practitioner = await createPractitioner({
    phone_number: from,
    display_name: displayName,
    preferred_language: context.preferred_language ?? 'en',
  });

  // Save media record now that we have the practitioner id
  await saveMedia({ practitioner_id: practitioner.id, ...mediaRecord }).catch(e =>
    console.warn('saveMedia failed (non-fatal):', e.message)
  );

  await logEvent({
    practitioner_id: practitioner.id,
    event_type: 'practitioner_onboarded',
    payload: { display_name: displayName, preferred_language: context.preferred_language },
  });

  await endSession(from);

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

// Heuristic: take the longest run of capitalised words from the transcript
// as the practitioner's name. Works well enough for "My name is Baba Adewale Ayoola".
function _extractName(text) {
  const match = text.match(/(?:my name is|i(?:'| a)m|call me)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i);
  if (match) return match[1].trim();
  // Fallback: first 4 words (covers cases without "my name is" preamble)
  return text.trim().split(/\s+/).slice(0, 4).join(' ');
}

async function _transcribeMessage(message, _from) {
  const { buffer, mimeType } = await downloadMedia(message.audio.id);
  return transcribe(buffer, mimeType);
}

module.exports = { handle, resume };
