// Admin dashboard — PRD §6.4
// Password-protected read-only web page at /admin.
// HTTP Basic Auth: username 'felix', password from ADMIN_PASSWORD env var.
// Bare server-rendered HTML — no frontend framework needed.

const express = require('express');
const { adminGetCounts, adminGetPractitioners, adminGetFormulations, adminGetFlagged } = require('./services/supabase');

const router = express.Router();

// ─── Basic Auth middleware ────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return _challenge(res);
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedPass) {
    console.error('ADMIN_PASSWORD env var not set — admin route blocked');
    return res.status(503).send('Admin not configured.');
  }
  if (user !== 'felix' || pass !== expectedPass) {
    return _challenge(res);
  }
  next();
}

function _challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Sanko Vault Admin"');
  return res.status(401).send('Unauthorised');
}

// ─── dashboard route ──────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const [counts, practitioners, formulations, flagged] = await Promise.all([
      adminGetCounts(),
      adminGetPractitioners(),
      adminGetFormulations(),
      adminGetFlagged(),
    ]);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_renderPage({ counts, practitioners, formulations, flagged }));
  } catch (err) {
    console.error('Admin page error:', err.message);
    res.status(500).send(`<pre>Error loading dashboard: ${err.message}</pre>`);
  }
});

// ─── HTML renderer ────────────────────────────────────────────────────────────

function _renderPage({ counts, practitioners, formulations, flagged }) {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sanko Vault — Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f4; color: #1c1917; }
    header { background: #166534; color: #fff; padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    header span { font-size: 0.8rem; opacity: 0.8; }
    .container { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }
    .stat { background: #fff; border-radius: 8px; padding: 1.25rem 1.5rem; border-left: 4px solid #166534; }
    .stat.warn { border-left-color: #b45309; }
    .stat-num { font-size: 2rem; font-weight: 700; color: #166534; }
    .stat.warn .stat-num { color: #b45309; }
    .stat-label { font-size: 0.85rem; color: #78716c; margin-top: 0.25rem; }
    section { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; }
    section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #166534; border-bottom: 1px solid #e7e5e4; padding-bottom: 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; background: #f5f5f4; font-weight: 600; color: #44403c; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #f5f5f4; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-amber { background: #fef3c7; color: #92400e; }
    .badge-red   { background: #fee2e2; color: #991b1b; }
    .badge-gray  { background: #f5f5f4; color: #78716c; }
    .empty { color: #a8a29e; font-style: italic; padding: 1rem 0; }
    .meta { font-size: 0.75rem; color: #a8a29e; }
    .flag-item { padding: 0.75rem; border-left: 3px solid #b45309; background: #fffbeb; margin-bottom: 0.5rem; border-radius: 0 4px 4px 0; font-size: 0.875rem; }
    .flag-item strong { display: block; margin-bottom: 0.2rem; }
    .flag-item .meta { margin-top: 0.2rem; }
  </style>
</head>
<body>
<header>
  <h1>🌿 Sanko Vault — Admin</h1>
  <span>Read-only · Refreshed ${now}</span>
</header>
<div class="container">

  <div class="stats">
    <div class="stat">
      <div class="stat-num">${counts.practitioners}</div>
      <div class="stat-label">Practitioners</div>
    </div>
    <div class="stat">
      <div class="stat-num">${counts.formulations}</div>
      <div class="stat-label">Formulations (active)</div>
    </div>
    <div class="stat warn">
      <div class="stat-num">${counts.flagged}</div>
      <div class="stat-label">Flagged (confidence &lt; 75%)</div>
    </div>
  </div>

  <section>
    <h2>Practitioners (${practitioners.length})</h2>
    ${practitioners.length === 0
      ? '<p class="empty">No practitioners yet.</p>'
      : `<table>
        <thead><tr>
          <th>Name</th><th>Phone</th><th>Language</th><th>Joined</th><th>Last active</th>
        </tr></thead>
        <tbody>
          ${practitioners.map(p => `<tr>
            <td>${_esc(p.display_name || '—')}</td>
            <td class="meta">${_esc(p.phone_number)}</td>
            <td>${_langBadge(p.preferred_language)}</td>
            <td class="meta">${_date(p.created_at)}</td>
            <td class="meta">${_date(p.last_active_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
    }
  </section>

  <section>
    <h2>Formulations — most recent 100</h2>
    ${formulations.length === 0
      ? '<p class="empty">No formulations yet.</p>'
      : `<table>
        <thead><tr>
          <th>Code</th><th>Condition</th><th>Practitioner</th><th>Confidence</th><th>Saved</th>
        </tr></thead>
        <tbody>
          ${formulations.map(f => `<tr>
            <td><strong>${_esc(f.short_code)}</strong></td>
            <td>${_esc(f.condition_std || f.condition_local || '—')}</td>
            <td class="meta">${_esc(f.practitioners?.display_name || '—')}</td>
            <td>${_confBadge(f.confidence_score)}</td>
            <td class="meta">${_date(f.created_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
    }
  </section>

  <section>
    <h2>Flagged items</h2>

    <h3 style="font-size:0.85rem;color:#44403c;margin:0.75rem 0 0.5rem">Low confidence formulations (${flagged.lowConf.length})</h3>
    ${flagged.lowConf.length === 0
      ? '<p class="empty">None.</p>'
      : flagged.lowConf.map(f => `
        <div class="flag-item">
          <strong>${_esc(f.short_code)} — ${_esc(f.condition_std || f.condition_local || 'Unknown condition')}</strong>
          Practitioner: ${_esc(f.practitioners?.display_name || '—')} &nbsp;|&nbsp; Confidence: ${_confBadge(f.confidence_score)}
          <div class="meta">${_date(f.created_at)}</div>
        </div>`).join('')
    }

    <h3 style="font-size:0.85rem;color:#44403c;margin:1rem 0 0.5rem">Unknown plants &amp; errors (${flagged.events.length})</h3>
    ${flagged.events.length === 0
      ? '<p class="empty">None.</p>'
      : flagged.events.map(e => `
        <div class="flag-item">
          <strong>${_esc(e.event_type)}</strong>
          ${_renderPayload(e.payload)}
          <div class="meta">${_esc(e.practitioners?.display_name || '—')} · ${_date(e.created_at)}</div>
        </div>`).join('')
    }
  </section>

</div>
</body>
</html>`;
}

// ─── small helpers ────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _date(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function _langBadge(lang) {
  const labels = { en: 'English', yo: 'Yoruba', ig: 'Igbo', ha: 'Hausa' };
  return `<span class="badge badge-gray">${_esc(labels[lang] || lang)}</span>`;
}

function _confBadge(score) {
  if (score == null) return '<span class="badge badge-gray">—</span>';
  const pct = Math.round(score * 100);
  const cls = score >= 0.75 ? 'badge-green' : score >= 0.6 ? 'badge-amber' : 'badge-red';
  return `<span class="badge ${cls}">${pct}%</span>`;
}

function _renderPayload(payload) {
  if (!payload) return '';
  const parts = [];
  if (payload.local_name)  parts.push(`Plant: <strong>${_esc(payload.local_name)}</strong>`);
  if (payload.short_code)  parts.push(`Formulation: <strong>${_esc(payload.short_code)}</strong>`);
  if (payload.error)       parts.push(`Error: <em>${_esc(payload.error)}</em>`);
  if (payload.step)        parts.push(`Step: ${_esc(payload.step)}`);
  return parts.length ? `<div>${parts.join(' &nbsp;|&nbsp; ')}</div>` : '';
}

module.exports = router;
module.exports.requireAuth = requireAuth;
