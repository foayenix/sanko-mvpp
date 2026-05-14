const { getSession, upsertSession, clearSession } = require('../services/supabase');

async function getActiveSession(practitioner_id) {
  return getSession(practitioner_id);
}

async function setSession(practitioner_id, flow, step, context = {}) {
  return upsertSession({ practitioner_id, flow, step, context });
}

async function endSession(practitioner_id) {
  return clearSession(practitioner_id);
}

module.exports = { getActiveSession, setSession, endSession };
