const OpenAI = require('openai');
const FormData = require('form-data');
const axios = require('axios');

let _openai;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// Returns { text, language, confidence }
// confidence is a rough heuristic: Whisper doesn't expose log-prob directly via REST,
// so we return 1.0 unless the text is suspiciously short.
async function transcribe(audioBuffer, mimeType = 'audio/ogg') {
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: mimeType });
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
  });

  const { text, language } = response.data;
  const confidence = text && text.trim().length > 10 ? 1.0 : 0.5;

  return { text: text?.trim() ?? '', language: language ?? 'en', confidence };
}

module.exports = { transcribe };
