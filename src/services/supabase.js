const { createClient } = require('@supabase/supabase-js');

let _client;

function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _client;
}

async function logEvent({ practitioner_id, event_type, payload }) {
  const { error } = await getClient()
    .from('events')
    .insert({ practitioner_id, event_type, payload });
  if (error) console.error('logEvent error:', error.message);
}

async function getPractitioner(phoneNumber) {
  const { data, error } = await getClient()
    .from('practitioners')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();
  if (error && error.code !== 'PGRST116') console.error('getPractitioner error:', error.message);
  return data ?? null;
}

async function createPractitioner({ phone_number, display_name, preferred_language }) {
  const { data, error } = await getClient()
    .from('practitioners')
    .insert({ phone_number, display_name, preferred_language })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function updatePractitioner(id, fields) {
  const { data, error } = await getClient()
    .from('practitioners')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getSession(practitioner_id) {
  const { data } = await getClient()
    .from('sessions')
    .select('*')
    .eq('practitioner_id', practitioner_id)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data ?? null;
}

// Returns an expired session (expires_at in the past) so the router can notify
// the practitioner and clean up, rather than silently dropping the session.
async function getExpiredSession(practitioner_id) {
  const { data } = await getClient()
    .from('sessions')
    .select('*')
    .eq('practitioner_id', practitioner_id)
    .lte('expires_at', new Date().toISOString())
    .single();
  return data ?? null;
}

async function upsertSession({ practitioner_id, flow, step, context }) {
  const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const { error } = await getClient()
    .from('sessions')
    .upsert({ practitioner_id, flow, step, context, expires_at, updated_at: new Date().toISOString() });
  if (error) console.error('upsertSession error:', error.message);
}

async function clearSession(practitioner_id) {
  const { error } = await getClient()
    .from('sessions')
    .delete()
    .eq('practitioner_id', practitioner_id);
  if (error) console.error('clearSession error:', error.message);
}

async function updateLastActive(practitioner_id) {
  const { error } = await getClient()
    .from('practitioners')
    .update({ last_active_at: new Date().toISOString() })
    .eq('id', practitioner_id);
  if (error) console.error('updateLastActive error:', error.message);
}

async function saveMedia({ practitioner_id, kind, storage_path, duration_seconds, transcript }) {
  const { data, error } = await getClient()
    .from('media')
    .insert({ practitioner_id, kind, storage_path, duration_seconds, transcript })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function uploadVoiceNote(practitioner_id, buffer, mimeType) {
  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp4';
  const path = `voice/${practitioner_id}/${Date.now()}.${ext}`;
  const { error } = await getClient()
    .storage
    .from('sanko-media')
    .upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

async function saveFormulation({ practitioner_id, source_media_id, structured, original_text, original_language }) {
  const row = {
    practitioner_id,
    source_media_id: source_media_id ?? null,
    condition_local:   structured.condition?.local_name ?? null,
    condition_std:     structured.condition?.standardised ?? null,
    icd_11_code:       structured.condition?.icd_11_code ?? null,
    plants:            structured.plants ?? [],
    preparation:       structured.preparation ?? null,
    dosage:            structured.dosage ?? null,
    notes:             structured.notes ?? null,
    original_text:     original_text ?? null,
    original_language: original_language ?? structured.metadata?.original_language ?? null,
    confidence_score:  structured.metadata?.confidence_score ?? null,
    status:            'active',
  };
  const { data, error } = await getClient()
    .from('formulations')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Returns the 10 most recent active formulations for a practitioner (PRD §5.4)
async function listFormulations(practitioner_id, limit = 10) {
  const { data, error } = await getClient()
    .from('formulations')
    .select('id, short_code, condition_local, condition_std, created_at, source_media_id')
    .eq('practitioner_id', practitioner_id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Returns one full formulation row plus its source media (for voice replay)
async function getFormulation(id) {
  const { data, error } = await getClient()
    .from('formulations')
    .select('*, media:source_media_id(storage_path, transcript)')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data ?? null;
}

// Creates a signed URL (1-hour expiry) for a voice note stored in Supabase Storage
async function getSignedMediaUrl(storagePath, expiresIn = 3600) {
  const { data, error } = await getClient()
    .storage
    .from('sanko-media')
    .createSignedUrl(storagePath, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// Returns a single formulation by its human-readable short_code for a given practitioner
async function getFormulationByShortCode(short_code, practitioner_id) {
  const { data, error } = await getClient()
    .from('formulations')
    .select('*')
    .eq('short_code', short_code.toUpperCase())
    .eq('practitioner_id', practitioner_id)
    .eq('status', 'active')
    .single();
  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data ?? null;
}

// Overwrites a single JSONB or text field on a formulation row.
// field must be one of: 'plants', 'preparation', 'dosage', 'notes'
async function updateFormulationField(id, field, value) {
  const ALLOWED = new Set(['plants', 'preparation', 'dosage', 'notes', 'condition_local', 'condition_std', 'icd_11_code']);
  if (!ALLOWED.has(field)) throw new Error(`updateFormulationField: unknown field '${field}'`);
  const { data, error } = await getClient()
    .from('formulations')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ─── admin queries ────────────────────────────────────────────────────────────

async function adminGetPractitioners() {
  const { data, error } = await getClient()
    .from('practitioners')
    .select('id, display_name, phone_number, preferred_language, created_at, last_active_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function adminGetFormulations() {
  const { data, error } = await getClient()
    .from('formulations')
    .select('id, short_code, condition_std, condition_local, confidence_score, status, created_at, practitioner_id, practitioners(display_name)')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Returns low-confidence formulations + unknown-plant and error events
async function adminGetFlagged() {
  const [{ data: lowConf }, { data: events }] = await Promise.all([
    getClient()
      .from('formulations')
      .select('short_code, condition_std, condition_local, confidence_score, created_at, practitioner_id, practitioners(display_name)')
      .lt('confidence_score', 0.75)
      .eq('status', 'active')
      .order('created_at', { ascending: false }),
    getClient()
      .from('events')
      .select('id, event_type, payload, created_at, practitioner_id, practitioners(display_name)')
      .in('event_type', ['unknown_plant_flagged', 'error'])
      .order('created_at', { ascending: false })
      .limit(50),
  ]);
  return { lowConf: lowConf ?? [], events: events ?? [] };
}

async function adminGetCounts() {
  const [{ count: practCount }, { count: formCount }, { count: flagCount }] = await Promise.all([
    getClient().from('practitioners').select('*', { count: 'exact', head: true }),
    getClient().from('formulations').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    getClient().from('formulations').select('*', { count: 'exact', head: true }).lt('confidence_score', 0.75).eq('status', 'active'),
  ]);
  return { practitioners: practCount ?? 0, formulations: formCount ?? 0, flagged: flagCount ?? 0 };
}

async function uploadPhoto(practitioner_id, buffer, mimeType) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const storagePath = `photos/${practitioner_id}/${Date.now()}.${ext}`;
  const { error } = await getClient()
    .storage
    .from('sanko-media')
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(error.message);
  return storagePath;
}

module.exports = {
  getClient,
  logEvent,
  getPractitioner,
  createPractitioner,
  updatePractitioner,
  updateLastActive,
  getSession,
  getExpiredSession,
  upsertSession,
  clearSession,
  saveMedia,
  uploadVoiceNote,
  uploadPhoto,
  saveFormulation,
  listFormulations,
  getFormulation,
  getFormulationByShortCode,
  getSignedMediaUrl,
  updateFormulationField,
  adminGetPractitioners,
  adminGetFormulations,
  adminGetFlagged,
  adminGetCounts,
};
