# Renzo Build Loop — DONALD v3

**Started:** 2026-06-18
**Completed:** 2026-06-18
**Protocol:** DONALD Loop v3
**Deploy target:** https://www.meetrenzo.com

---

## BASELINES (wc -l authoritative)

| File | Baseline | Final | Status |
|------|---------|-------|--------|
| index.html | 6004 | 6152 | ✅ +148 |
| landing.html | 862 | 862 | ✅ equal |

---

## CRITICAL CONSTRAINT

**Vercel Hobby 12-function limit — DO NOT add new files to api/.**
All new functionality must be added as new actions in existing API files.

---

## BLOCKED / NOTES

- GROUP 7 reveal_api_key: requires `key_value VARCHAR` column on api_keys table — SQL included in SQL block below. Also requires updating generate_api_key to store raw key.
- GROUP 9 Google Drive: Implemented as "Coming Soon" with waitlist email capture — SQL included.
- GROUP 10/11 Outlook/QuickBooks: credentials provided as env vars, NOT hardcoded.

---

## GROUP PROGRESS

| Group | Description | Status |
|-------|-------------|--------|
| 1 | Contacts tab Chrome extension catch fix + retry button | ✅ DONE |
| 2 | Sidebar stats populated after loadProfileData | ✅ DONE |
| 3 | "Launch Week" → "Launch Special" in landing + index | ✅ DONE |
| 4 | Remove Shipit badge from sidebar | ✅ DONE |
| 5 | Settings cards max-width 560 → 680 | ✅ DONE |
| 6 | Mobile bottom nav "More ⋯" drawer | ✅ DONE |
| 7 | API key reveal (show key one-time) | ✅ DONE |
| 8 | Fix credits summary calculation (credits_added not credits) | ✅ DONE |
| 9 | Export data: dated filenames + Google Drive waitlist | ✅ DONE |
| 10 | Outlook OAuth + sync in contacts.js | ✅ DONE |
| 11 | QuickBooks OAuth + sync in contacts.js | ✅ DONE |

**ALL GROUPS COMPLETE**

---

## COMMIT LOG

- Group 1-2: Contacts error handling + sidebar stats fix
- Group 3-4: Launch Special rename + remove Shipit badge
- Group 5-6: Settings wider cards + More drawer nav
- Group 7: API key reveal (Show Key button + 30s auto-hide + copy)
- Group 8: Fix credits_added field in purchase summary
- Group 9: Dated export filenames + Google Drive Coming Soon waitlist
- Groups 10-11: Outlook and QuickBooks OAuth + contact sync

---

## node --check RESULTS (all API files)

| File | Result |
|------|--------|
| api/_supabase.js | PASS |
| api/_validate.js | PASS |
| api/ai.js | PASS |
| api/auth/login.js | PASS |
| api/auth/signup.js | PASS |
| api/billing.js | PASS |
| api/contacts.js | PASS |
| api/health.js | PASS |
| api/profile.js | PASS |
| api/stripe-webhook.js | PASS |

---

## SQL BLOCK (run in Supabase)

```sql
-- GROUP 7: allow API key reveal (stores raw key)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_value VARCHAR;

-- GROUP 9: waitlist for Google Drive export (and future features)
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR,
  feature VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now()
);
```
