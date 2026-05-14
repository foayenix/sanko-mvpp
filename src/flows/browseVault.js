// Flow 4 — Browse Vault (PRD §5.4)
// Trigger: practitioner types 'my vault', 'list', or 'vault'.
//
// Step 1 — List: numbered list of 10 most recent formulations (short_code + condition).
// Step 2 — Detail: practitioner replies with a number → full detail card.
//          If the formulation has a source voice note, include a signed URL to replay it.

const { sendTextMessage } = require('../services/whatsapp');
const { listFormulations, getFormulation, getSignedMediaUrl, logEvent } = require('../services/supabase');
const { setSession, endSession } = require('../utils/session');

// ─── entry point ──────────────────────────────────────────────────────────────

async function handle(message, from, practitioner) {
  const formulations = await listFormulations(practitioner.id);

  if (!formulations.length) {
    return sendTextMessage(
      from,
      "Your Vault is empty so far. Send a voice note describing a formulation, or type *new* to get started."
    );
  }

  const listText = _formatList(formulations);

  await setSession(practitioner.id, 'browse_vault', 'awaiting_selection', {
    ids: formulations.map(f => f.id),
  });

  return sendTextMessage(
    from,
    `*Your Vault* — ${formulations.length} formulation${formulations.length !== 1 ? 's' : ''}\n\n${listText}\n\nReply with a number to open a formulation, or type *new* to add another.`
  );
}

// ─── session resume ───────────────────────────────────────────────────────────

async function resume(session, message, from, practitioner) {
  const { step, context } = session;

  if (step === 'awaiting_selection') {
    return _handleSelection(message, from, practitioner, context);
  }

  await endSession(practitioner.id);
  return handle(message, from, practitioner);
}

// ─── selection handler ────────────────────────────────────────────────────────

async function _handleSelection(message, from, practitioner, context) {
  const text = (message.type === 'text' ? message.text?.body ?? '' : '').trim();
  const num = parseInt(text, 10);

  if (isNaN(num) || num < 1 || num > (context.ids?.length ?? 0)) {
    return sendTextMessage(
      from,
      `Please reply with a number between 1 and ${context.ids?.length ?? '?'}.`
    );
  }

  const id = context.ids[num - 1];
  const formulation = await getFormulation(id);

  if (!formulation) {
    return sendTextMessage(from, "Sorry, I couldn't find that formulation. Type *my vault* to try again.");
  }

  await logEvent({
    practitioner_id: practitioner.id,
    event_type: 'formulation_viewed',
    payload: { short_code: formulation.short_code },
  });

  await endSession(practitioner.id);

  const card = await _formatDetailCard(formulation);
  return sendTextMessage(from, card);
}

// ─── formatters ───────────────────────────────────────────────────────────────

function _formatList(formulations) {
  return formulations.map((f, i) => {
    const condition = f.condition_std || f.condition_local || 'Unknown condition';
    return `${i + 1}. *${f.short_code}* — ${condition}`;
  }).join('\n');
}

async function _formatDetailCard(f) {
  const lines = [];

  lines.push(`*${f.short_code}*`);
  lines.push('');

  const cond = f.condition_std || f.condition_local;
  if (cond) lines.push(`*Condition:* ${cond}${f.icd_11_code ? ` (${f.icd_11_code})` : ''}`);

  const plants = Array.isArray(f.plants) ? f.plants : [];
  if (plants.length) {
    lines.push('*Plants:*');
    for (const p of plants) {
      const name = p.botanical ? `${p.local_name} (${p.botanical})` : p.local_name;
      const qty  = p.quantity_normalised || p.quantity_raw || '';
      lines.push(`  • ${name}${qty ? ' — ' + qty : ''}`);
    }
  }

  const prep = f.preparation;
  if (prep?.method) {
    const dur = prep.duration_minutes ? ` for ${prep.duration_minutes} min` : '';
    const med = prep.medium ? ` in ${prep.medium}` : '';
    lines.push(`*Preparation:* ${prep.method}${dur}${med}`);
  }

  const dose = f.dosage;
  if (dose?.amount || dose?.frequency) {
    const amt  = dose.amount || '';
    const freq = dose.frequency ? `, ${dose.frequency}` : '';
    const days = dose.duration_days ? `, for ${dose.duration_days} days` : '';
    lines.push(`*Dosage:* ${amt}${freq}${days}`);
  }

  if (f.notes) lines.push(`*Notes:* ${f.notes}`);

  if (f.confidence_score != null) {
    lines.push(`_Confidence: ${Math.round(f.confidence_score * 100)}%_`);
  }

  lines.push(
    `_Saved: ${new Date(f.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}_`
  );

  // Voice note replay — signed URL with 1-hour expiry (PRD §5.4)
  const storagePath = f.media?.storage_path;
  if (storagePath) {
    try {
      const url = await getSignedMediaUrl(storagePath);
      lines.push('');
      lines.push(`🔊 *Listen to original voice note:*\n${url}`);
    } catch (e) {
      console.warn('getSignedMediaUrl failed (non-fatal):', e.message);
    }
  }

  lines.push('');
  lines.push(`Type *edit ${f.short_code}* to update, or *my vault* to go back to the list.`);

  return lines.join('\n');
}

module.exports = { handle, resume, _formatList, _formatDetailCard };
