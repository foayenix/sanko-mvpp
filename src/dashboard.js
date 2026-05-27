// Institutional dashboard — PRD §11
// Public read-only page at /dashboard. No auth: aimed at grant reviewers and visa
// endorsers who need to confirm Sanko Vault is live and growing. Aggregate counts
// only — no phone numbers, no display names, no transcripts.

const express = require('express');
const { dashboardGetStats } = require('./services/supabase');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const stats = await dashboardGetStats();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_renderPage(stats));
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).send('<pre>Dashboard temporarily unavailable.</pre>');
  }
});

function _renderPage({ practitioners, formulations, byDay, updated_at }) {
  const updatedLabel = new Date(updated_at).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  const last30Total = byDay.reduce((s, b) => s + b.count, 0);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sanko Vault — Live Impact</title>
  <meta name="description" content="Sanko Vault: live impact metrics from a WhatsApp bot helping African traditional medicine practitioners document herbal formulations.">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f4; color: #1c1917; line-height: 1.5; }
    .wrap { max-width: 880px; margin: 0 auto; padding: 3rem 1.25rem 2rem; }
    header { margin-bottom: 2.5rem; }
    .brand { display: flex; align-items: center; gap: 0.6rem; color: #166534; font-weight: 700; font-size: 1.1rem; margin-bottom: 0.4rem; }
    h1 { font-size: 2rem; font-weight: 700; color: #1c1917; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
    .tagline { color: #57534e; font-size: 1.05rem; max-width: 60ch; }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 2.5rem; }
    @media (max-width: 540px) { .stats { grid-template-columns: 1fr; } }
    .stat { background: #fff; border-radius: 12px; padding: 1.75rem; border: 1px solid #e7e5e4; }
    .stat-num { font-size: 3rem; font-weight: 700; color: #166534; letter-spacing: -0.03em; line-height: 1; }
    .stat-label { font-size: 0.95rem; color: #57534e; margin-top: 0.6rem; font-weight: 500; }
    section { background: #fff; border-radius: 12px; padding: 1.75rem; border: 1px solid #e7e5e4; margin-bottom: 2rem; }
    section h2 { font-size: 1rem; font-weight: 600; color: #1c1917; margin-bottom: 0.25rem; }
    section .sub { font-size: 0.85rem; color: #78716c; margin-bottom: 1.5rem; }
    .spark { display: flex; align-items: flex-end; gap: 3px; height: 110px; padding-top: 0.5rem; }
    .bar { flex: 1; background: #bbf7d0; border-radius: 2px 2px 0 0; min-height: 2px; position: relative; transition: background 0.15s; }
    .bar.has { background: #166534; }
    .bar:hover { background: #14532d; }
    .bar-axis { display: flex; justify-content: space-between; font-size: 0.7rem; color: #a8a29e; margin-top: 0.5rem; }
    footer { text-align: center; color: #a8a29e; font-size: 0.8rem; margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e7e5e4; }
    footer a { color: #166534; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="brand">🌿 Sanko Vault</div>
    <h1>Live impact dashboard</h1>
    <p class="tagline">A WhatsApp bot helping African traditional medicine practitioners document their herbal formulations in their own voice and language — turned into structured, searchable, encrypted records they own.</p>
  </header>

  <div class="stats">
    <div class="stat">
      <div class="stat-num">${practitioners.toLocaleString('en-GB')}</div>
      <div class="stat-label">Practitioners onboarded</div>
    </div>
    <div class="stat">
      <div class="stat-num">${formulations.toLocaleString('en-GB')}</div>
      <div class="stat-label">Formulations documented</div>
    </div>
  </div>

  <section>
    <h2>Formulations logged — last 30 days</h2>
    <p class="sub">${last30Total.toLocaleString('en-GB')} new formulation${last30Total === 1 ? '' : 's'} saved in the last 30 days.</p>
    ${_renderSparkline(byDay)}
  </section>

  <footer>
    Last updated ${_esc(updatedLabel)} UTC · <a href="https://github.com/foayenix/sanko-mvpp">github.com/foayenix/sanko-mvpp</a>
  </footer>

</div>
</body>
</html>`;
}

function _renderSparkline(byDay) {
  if (!byDay.length) return '<p style="color:#a8a29e;font-style:italic">No data yet.</p>';
  const max = Math.max(1, ...byDay.map(b => b.count));
  const bars = byDay.map(b => {
    const pct = Math.round((b.count / max) * 100);
    return `<div class="bar${b.count > 0 ? ' has' : ''}" style="height:${pct}%" title="${_esc(b.day)}: ${b.count}"></div>`;
  }).join('');
  const first = byDay[0]?.day ?? '';
  const last  = byDay[byDay.length - 1]?.day ?? '';
  return `<div class="spark">${bars}</div>
    <div class="bar-axis"><span>${_esc(first)}</span><span>${_esc(last)}</span></div>`;
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
module.exports._renderPage = _renderPage;
module.exports._renderSparkline = _renderSparkline;
