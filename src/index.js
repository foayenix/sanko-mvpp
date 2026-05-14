require('dotenv').config();
const express = require('express');
const { handleWebhook, verifyWebhook } = require('./router');

const app = express();
app.use(express.json());

// Meta webhook verification (GET) and message receipt (POST)
app.get('/webhook', verifyWebhook);
app.post('/webhook', handleWebhook);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sanko Vault listening on port ${PORT}`));
