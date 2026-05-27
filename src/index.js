require('dotenv').config();
const express = require('express');
const { handleWebhook, verifyWebhook } = require('./router');
const adminRouter = require('./admin');
const dashboardRouter = require('./dashboard');

const app = express();
app.use(express.json());

// Meta webhook verification (GET) and message receipt (POST)
app.get('/webhook', verifyWebhook);
app.post('/webhook', handleWebhook);

// Admin dashboard (PRD §6.4) — HTTP Basic Auth, read-only
app.use('/admin', adminRouter);

// Institutional dashboard (PRD §11) — public, aggregate counts only
app.use('/dashboard', dashboardRouter);

app.get('/', (_req, res) => {
	res.json({
		service: 'sanko-vault',
		status: 'ok',
		endpoints: ['/webhook', '/admin', '/dashboard', '/health']
	});
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sanko Vault listening on port ${PORT}`));
