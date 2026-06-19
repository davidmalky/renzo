# Renzo Build Loop — DONALD v3

**Started:** 2026-06-18
**Protocol:** DONALD Loop v3
**Deploy target:** https://www.meetrenzo.com

---

## BASELINES (wc -l authoritative)

| File | Baseline |
|------|---------|
| index.html | 6004 |
| landing.html | 862 |

Both must be ≥ baseline at completion.

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
| 1 | Contacts tab Chrome extension catch fix + retry button | TODO |
| 2 | Sidebar stats populated after loadProfileData | TODO |
| 3 | "Launch Week" → "Launch Special" in landing + index | TODO |
| 4 | Remove Shipit badge from sidebar | TODO |
| 5 | Settings cards max-width 560 → 680 | TODO |
| 6 | Mobile bottom nav "More ⋯" drawer | TODO |
| 7 | API key reveal (show key one-time) | TODO |
| 8 | Fix credits summary calculation (credits_added not credits) | TODO |
| 9 | Export data: dated filenames + Google Drive waitlist | TODO |
| 10 | Outlook OAuth + sync in contacts.js | TODO |
| 11 | QuickBooks OAuth + sync in contacts.js | TODO |

---

## COMMIT LOG

(appended per group)

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
