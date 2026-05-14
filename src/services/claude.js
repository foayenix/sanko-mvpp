const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, '../prompts', name), 'utf8');
}

function loadPlantLookup() {
  const p = path.join(__dirname, '../../data/plant_lookup_v1.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

// Structures a transcript into the formulation JSON defined in PRD §4.3
async function structureFormulation(transcript) {
  const prompt = loadPrompt('structureFormulation.txt').replace(
    '{{PLANT_LOOKUP_JSON}}',
    JSON.stringify(loadPlantLookup())
  );

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\nINPUT:\n${transcript}` }],
  });

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// Extracts a structured formulation from a photo (base64 encoded)
async function readNotebookPhoto(imageBase64, mimeType = 'image/jpeg') {
  const prompt = loadPrompt('readNotebook.txt').replace(
    '{{PLANT_LOOKUP_JSON}}',
    JSON.stringify(loadPlantLookup())
  );

  const message = await getClient().messages.create({
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

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// Edits a single field of an existing formulation by voice transcript
async function editField(existingFormulation, field, transcript) {
  const prompt = loadPrompt('editField.txt');
  const userMessage = `
EXISTING FORMULATION:
${JSON.stringify(existingFormulation, null, 2)}

FIELD TO EDIT: ${field}

PRACTITIONER INSTRUCTION: ${transcript}

Return the full updated formulation JSON only.
`.trim();

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `${prompt}\n\n${userMessage}` }],
  });

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

module.exports = { structureFormulation, readNotebookPhoto, editField };
