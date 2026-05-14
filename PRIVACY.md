# Sanko Vault — Privacy & Security Notice

**Version 1.0 · May 2026 · Applicable to MVP v1**

---

## What Sanko Vault collects

When you use Sanko Vault via WhatsApp, the following data is stored:

| Data | Why it is stored |
|---|---|
| Your WhatsApp phone number | Unique identifier — no passwords needed |
| Your display name | Shown in your Vault and on formulation records |
| Your preferred language | So the bot communicates in the right language |
| Formulation records you create | The core purpose of the product |
| Voice notes and photos you send | Source material for structuring formulations; stored so you can replay them |
| Transcripts of your voice notes | Used to structure your formulations via AI |
| Activity timestamps | Used to detect idle sessions and for basic usage analytics |

We do **not** collect patient names, patient phone numbers, or any information about the people you treat.

---

## Who can see your data

| Party | Access |
|---|---|
| You | Full access to your own formulations via WhatsApp |
| Felix Ayeni (Sanko operator, v1) | Read access to all records, for debugging and technical support only |
| Third parties | None. No formulation data is shared with any third party in v1. |
| Researchers | No access in v1. Research-partner data licensing is deferred to v2, with Nagoya-compliant data-sharing templates and practitioner consent. |

This will be disclosed to you again when you first message Sanko.

---

## Nagoya Protocol alignment

Every formulation record stores you — the practitioner — as the **source of knowledge**. Sanko does not claim ownership of your traditional knowledge. No formulation data is transferred to any research institution or commercial partner in v1. When research access is introduced in v2, it will require your explicit consent and will follow Nagoya Protocol requirements on access and benefit-sharing.

---

## How your data is stored and protected

- **In transit**: all connections use TLS 1.2+ (enforced by Railway and Supabase).
- **At rest**: Supabase encrypts all data using AES-256 at rest.
- **Voice notes and photos**: stored in Supabase Storage (private bucket) with signed-URL access only. Links expire after 1 hour.
- **Database region**: London (eu-west-2) or Frankfurt (EU). Your data does not leave EU jurisdiction.
- **Row-level security**: enabled on all tables. The WhatsApp bot accesses data using a service-role key; no practitioner can read another practitioner's records.

---

## Data retention

- Formulation records are kept indefinitely — they are your professional archive.
- Session state is deleted automatically after 30 minutes of inactivity.
- Events (technical logs) are kept for debugging; phone numbers in shared analytics are hashed.

---

## Your rights

You can request deletion of your account and all associated data at any time by messaging Felix directly. There is no self-service deletion in v1; this will be added in the practitioner web dashboard (v2).

---

## Contact

Felix Olajide Ayeni · felix@sanko.africa · Sanko Vault operator, v1

Full privacy policy (when published): sanko.africa/privacy
