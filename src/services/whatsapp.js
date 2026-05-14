const axios = require('axios');

const BASE_URL = 'https://graph.facebook.com/v19.0';

async function sendTextMessage(to, text) {
  return _send(to, { type: 'text', text: { body: text, preview_url: false } });
}

async function sendButtonMessage(to, body, buttons) {
  return _send(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.map((b, i) => ({
          type: 'reply',
          reply: { id: `btn_${i}`, title: b },
        })),
      },
    },
  });
}

async function downloadMedia(mediaId) {
  const { data: meta } = await axios.get(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
  });
  const response = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
    responseType: 'arraybuffer',
  });
  return { buffer: Buffer.from(response.data), mimeType: meta.mime_type };
}

async function _send(to, messagePayload) {
  try {
    await axios.post(
      `${BASE_URL}/${process.env.META_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...messagePayload },
      { headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data ?? err.message);
  }
}

module.exports = { sendTextMessage, sendButtonMessage, downloadMedia };
