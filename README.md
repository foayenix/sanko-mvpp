# Sanko Vault

WhatsApp bot for African traditional medicine practitioners to document herbal formulations.

**Stack**: Node.js 20 · Express 4 · Supabase (Postgres) · OpenAI Whisper · Claude Sonnet 4.6 · Railway

## Quick start

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev            # starts on port 3000
```

## Environment variables

See `.env.example` for all required keys.

## Webhook setup (Meta Cloud API)

1. Set `META_VERIFY_TOKEN` in `.env` to any secret string you choose.
2. In Meta Developer Console → WhatsApp → Configuration → Webhook, enter:
   - Callback URL: `https://<your-railway-url>/webhook`
   - Verify token: the value you set above
3. Subscribe to the `messages` webhook field.

## Running tests

```bash
npm test
```

Smoke tests in `tests/smoke.test.js` cover one happy path per flow.
Tests that hit real APIs require all env vars to be set.

## Folder layout

```
src/
  index.js          Express app + webhook
  router.js         Classify inbound message, dispatch to flows
  flows/            One file per user flow (PRD §5)
  services/         whatsapp · whisper · claude · supabase
  prompts/          LLM prompt files (plain text, <800 tokens each)
  utils/            session · plantLookup
data/
  plant_lookup_v1.json   Nigerian medicinal plant name mappings
tests/
  smoke.test.js
```

## Deployment (Railway)

1. Connect this repo to Railway.
2. Set all env vars in Railway → Variables.
3. Railway auto-deploys on push to `main`.

## Build progress

| Week | Theme | Status |
|------|-------|--------|
| W1 | Skeleton + echo bot | ✅ Done |
| W2 | DB + Flow 1 (first contact) | ⬜ Next |
| W3 | Flow 2 guided doc (happy path) | ⬜ |
| W4 | Flow 2 edge cases | ⬜ |
| W5 | Flow 3 express doc | ⬜ |
| W6 | Flow 4 browse vault | ⬜ |
| W7 | Flow 5 edit formulation | ⬜ |
| W8 | Flow 6 photo capture | ⬜ |
| W9 | Admin view | ⬜ |
| W10–12 | Testing, pilot, demo | ⬜ |
