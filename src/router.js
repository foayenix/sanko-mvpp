const { sendTextMessage } = require('./services/whatsapp');
const { logEvent } = require('./services/supabase');

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

  await logEvent({ practitioner_id: null, event_type: 'inbound_msg', payload: { from, message } });

  // W1: echo bot — will be replaced by flow dispatch in W2
  await sendTextMessage(from, `Echo: ${extractText(message)}`);
}

function extractText(message) {
  if (message.type === 'text') return message.text?.body ?? '';
  if (message.type === 'audio') return '[voice note]';
  if (message.type === 'image') return '[photo]';
  return `[${message.type}]`;
}

module.exports = { verifyWebhook, handleWebhook };
