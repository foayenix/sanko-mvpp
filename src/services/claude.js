const Anthropic = require('@anthropic-ai/sdk');
const OpenAI   = require('openai');
const fs   = require('fs');
const path = require('path');

// ─── clients (lazy-initialised) ───────────────────────────────────────────────

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

let _openai;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function useOpenAI() {
  return (process.env.LLM_PROVIDER ?? 'claude').toLowerCase() === 'openai';
}

// ─── file helpers ─────────────────────────────────────────────────────────────

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, '../prompts', name), 'utf8');
}

function loadPlantLookup() {
  const p = path.join(__dirname, '../../data/plant_lookup_v1.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

function injectPlantLookup(prompt) {
  return prompt.replace('{{PLANT_LOOKUP_JSON}}', JSON.stringify(loadPlantLookup()));
}

function parseJson(raw, label) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`${label} returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}

// ─── structureFormulation ─────────────────────────────────────────────────────

async function structureFormulation(transcript) {
  const prompt = injectPlantLookup(loadPrompt('structureFormulation.txt'));

  if (useOpenAI()) {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: transcript },
      ],
    });
    return parseJson(resp.choices[0].message.content.trim(), 'GPT-4o (structureFormulation)');
  }

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\nINPUT:\n${transcript}` }],
  });
  return parseJson(message.content[0].text.trim(), 'Claude (structureFormulation)');
}

// ─── readNotebookPhoto ────────────────────────────────────────────────────────

async function readNotebookPhoto(imageBase64, mimeType = 'image/jpeg') {
  const prompt = injectPlantLookup(loadPrompt('readNotebook.txt'));

  if (useOpenAI()) {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });
    return parseJson(resp.choices[0].message.content.trim(), 'GPT-4o (readNotebookPhoto)');
  }

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  return parseJson(message.content[0].text.trim(), 'Claude (readNotebookPhoto)');
}

// ─── editField ────────────────────────────────────────────────────────────────

async function editField(existingFormulation, field, transcript) {
  const prompt = loadPrompt('editField.txt');
  const userContent = `EXISTING FORMULATION:\n${JSON.stringify(existingFormulation, null, 2)}\n\nFIELD TO EDIT: ${field}\n\nPRACTITIONER INSTRUCTION: ${transcript}\n\nReturn the full updated formulation JSON only.`;

  if (useOpenAI()) {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: userContent },
      ],
    });
    return parseJson(resp.choices[0].message.content.trim(), 'GPT-4o (editField)');
  }

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\n${userContent}` }],
  });
  return parseJson(message.content[0].text.trim(), 'Claude (editField)');
}

module.exports = { structureFormulation, readNotebookPhoto, editField };
