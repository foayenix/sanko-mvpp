const { sendTextMessage } = require('./services/whatsapp');
const { logEvent, getPractitioner, updateLastActive } = require('./services/supabase');
const { getActiveSession, getTimedOutSession, endSession } = require('./utils/session');
const firstContact = require('./flows/firstContact');
const guidedDoc = require('./flows/guidedDoc');
const expressDoc = require('./flows/expressDoc');
const browseVault = require('./flows/browseVault');
const editFormulation = require('./flows/editFormulation');
const photoCapture = require('./flows/photoCapture');

// Meta Cloud API webhook verification handshake
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

async function handleWebhook(req, res) {
  // Acknowledge immediately — Meta requires 200 within 5 seconds
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const messages = value?.messages;

  if (!messages?.length) return;

  const message = messages[0];
  const from = message.from; // E.164 phone number

  try {
    await dispatch(from, message);
  } catch (err) {
    console.error('dispatch error:', err);
    await logEvent({ practitioner_id: null, event_type: 'error', payload: { from, error: err.message } });
    await sendTextMessage(from, 'Something went wrong on our end. Please try again in a moment.');
  }
}

async function dispatch(from, message) {
  await logEvent({ practitioner_id: null, event_type: 'inbound_msg', payload: { from, type: message.type } });

  // Unknown number → Flow 1 (first contact)
  const practitioner = await getPractitioner(from);
  if (!practitioner) {
    return firstContact.handle(message, from);
  }

  await updateLastActive(practitioner.id);

  // Photo → Flow 6 regardless of active session
  if (message.type === 'image') {
    return photoCapture.handle(message, from, practitioner);
  }

  const text = extractText(message).toLowerCase().trim();

  // Browse vault trigger (PRD §5.4)
  if (!message._inSession && (text === 'my vault' || text === 'list' || text === 'vault')) {
    return browseVault.handle(message, from, practitioner);
  }

  // New formulation trigger (PRD §5.2)
  if (!message._inSession && (text === 'new' || text === 'help')) {
    return guidedDoc.handle(message, from, practitioner);
  }

  // Edit trigger (PRD §5.5)
  if (!message._inSession && (text.startsWith('edit fm-') || text === 'edit')) {
    return editFormulation.handle(message, from, practitioner);
  }

  // Resume active session if one exists
  const session = await getActiveSession(practitioner.id);
  if (session) {
    return resumeSession(session, message, from, practitioner);
  }

  // No active session — check if one just timed out (PRD §7: 30-min idle)
  const timedOut = await getTimedOutSession(practitioner.id);
  if (timedOut) {
    await endSession(practitioner.id);
    await logEvent({ practitioner_id: practitioner.id, event_type: 'session_timeout', payload: { flow: timedOut.flow, step: timedOut.step } });
    await sendTextMessage(from, "Your previous session timed out after 30 minutes of inactivity. No data was saved.\n\nType *new* to start a fresh formulation.");
    return;
  }

  // Unprompted voice note (30–180s) → Flow 3 (express doc)
  if (message.type === 'audio') {
    return expressDoc.handle(message, from, practitioner);
  }

  // Fallback
  await sendTextMessage(
    from,
    `Hi ${practitioner.display_name || 'there'} 👋\n\nSend a voice note to document a formulation, or type:\n• *new* — guided documentation\n• *my vault* — browse your records\n• *help* — this menu`
  );
}

function resumeSession(session, message, from, practitioner) {
  switch (session.flow) {
    case 'first_contact': return firstContact.resume(session, message, from, practitioner);
    case 'guided_doc':    return guidedDoc.resume(session, message, from, practitioner);
    case 'express_doc':   return expressDoc.resume(session, message, from, practitioner);
    case 'edit':          return editFormulation.resume(session, message, from, practitioner);
    default:
      console.warn('Unknown session flow:', session.flow);
      return sendTextMessage(from, 'Session expired. Please start again.');
  }
}

function extractText(message) {
  if (message.type === 'text') return message.text?.body ?? '';
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title ??
           message.interactive?.list_reply?.title ?? '';
  }
  if (message.type === 'audio') return '';
  if (message.type === 'image') return '';
  return '';
}

module.exports = { verifyWebhook, handleWebhook, extractText };
