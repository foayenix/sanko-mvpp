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

async function getSession(practitioner_id) {
  const { data } = await getClient()
    .from('sessions')
    .select('*')
    .eq('practitioner_id', practitioner_id)
    .gt('expires_at', new Date().toISOString())
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

module.exports = {
  getClient,
  logEvent,
  getPractitioner,
  createPractitioner,
  updateLastActive,
  getSession,
  upsertSession,
  clearSession,
  saveMedia,
  uploadVoiceNote,
};
