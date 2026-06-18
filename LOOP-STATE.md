# Renzo Overnight Build — Loop State

**Started:** 2026-06-18  
**Protocol:** DONALD Loop v3  
**Deploy target:** https://www.meetrenzo.com  
**Charter:** Overnight Build — Maximum Progress (55 items, Groups 1-11)

---

## BASELINES (wc -l authoritative)

| File | Baseline |
|------|---------|
| index.html | 5899 |
| landing.html | 842 |

Both must be equal or higher at completion.

---

## BLOCKED — NEEDS DAVID (skip, log only)

| Item | Reason |
|------|--------|
| 9.5 Secure cookie JWT | Security tradeoff discussion needed |
| 10.1 Impersonation | Requires explicit David approval |
| 10.5 health.js | Vercel Hobby 12-function limit — adding 13th function violates quota |
| 11.1 Privacy page | Legal content requires David review before publishing |
| 11.2 Terms page | Legal content requires David review before publishing |

---

## GROUP PROGRESS

| Group | Item | Status | Self-review |
|-------|------|--------|-------------|
| 1 | 1.1 Salesforce #sfCredModal fields | DONE | YES — sfUsername/sfPassword/sfToken confirmed in index.html |
| 1 | 1.2 proceedToApp no payment for free trial | DONE | YES — doSignup has no openPaymentModal |
| 1 | 1.3 normalizeContact missing fields | DONE | YES — all 8 fields present lines 2041-2062 |
| 1 | 1.4 auto-recharge import/export match | DONE | YES — checkAutoRecharge exported from billing.js, imported in ai.js |
| 1 | 1.5 queue subject line storage | DONE | YES — subject in POST body at addToQueue |
| 2 | 2.1 Salesforce sync uses stored token | DONE | YES — salesforce_sync reads stored token in contacts.js |
| 2 | 2.2 HubSpot token persistence upsert | DONE | YES — upsert at lines 350-353 contacts.js |
| 2 | 2.3 Integration status from server on load | DONE | YES — get_integrations fetch at line 4447 index.html |
| 2 | 2.4 Disconnect clears server-side | DONE | YES — disconnect_integration sets connected:false |
| 3 | 3.1 Free trial credit display amber | DONE | YES — updateCreditDisplay: amber ≤10 free credits, red Trial complete when 0 |
| 3 | 3.2 Welcome modal step 2 messaging | DONE | YES — obSave button text changed to "Generate my first message" |
| 3 | 3.3 Empty state renderDashboard two CTAs | DONE | YES — empty state with Add Contacts + Connect CRM confirmed |
| 4 | 4.1 Tone selector verification | DONE | YES — 4 .tone-btn buttons at lines 1445-1448 |
| 4 | 4.2 Subject line in AI modal | DONE | YES — #aiSubjectDisplay at lines 1466-1469 |
| 4 | 4.3 Context note patterns (RENEWAL/REACTIVATE/CONGRATULATE) | DONE | YES — added to buildGeneratePrompt in api/ai.js |
| 4 | 4.4 Batch filter prompt ends with JSON instruction | DONE | YES — runBatch returns matched/reasoning/context |
| 4 | 4.5 AI retry on JSON parse failure | DONE | YES — callAnthropic() in api/ai.js retries with JSON instruction |
| 5 | 5.1 Tag filter input above contacts table | DONE | YES — tagFilter input in toolbar, renderContacts filters by tgf |
| 5 | 5.2 Contact frequency display (overdue in red) | DONE | YES — "X days overdue" red, "Due soon" amber when ≤7 days |
| 5 | 5.3 History modal timeline | DONE | YES — dot + border-left:2px vertical timeline in sentHtml |
| 5 | 5.4 Bulk "Generate & Queue All" button | TODO | — |
| 5 | 5.5 exportCsv all fields | DONE | YES — added tags, doNotContact, source_system, repName columns |
| 6 | 6.1 Queue subject inline editing | DONE | YES — contenteditable span, saveQueueSubject(), queue.js PUT handles subject |
| 6 | 6.2 Queue estimated send time | DONE | YES — pace estimate banner at top of queue when >1 item |
| 6 | 6.3 Batch prompt save as template | DONE | YES — saveBatchPrompt/getBatchTemplates confirmed already implemented |
| 6 | 6.4 Email compose pre-fill subject | DONE | YES — openEmailCompose includes subject in Gmail/Outlook URL confirmed |
| 7 | 7.1 Email signature in generateMsg | DONE | YES — generateMsg appends signature confirmed |
| 7 | 7.2 Outreach rules in AI system prompt | DONE | YES — rules fetched via supabase in generate action, appended to system prompt |
| 7 | 7.3 Credit purchase history summary | DONE | YES — creditSummaryLine in settings populated with txn count and total |
| 7 | 7.4 API keys last-used timestamp | DONE | YES — last_used_at in list_api_keys query, shown in loadApiKeys |
| 7 | 7.5 Timezone display in Settings | DONE | YES — userTimezone span in settings, populated via Intl.DateTimeFormat |
| 8 | 8.1 Hero CTA text + secondary link | DONE | YES — "Start free — 10 messages included" on both hero and bottom CTA |
| 8 | 8.2 Social proof line (PH/Shipit/BetaList) | DONE | YES — Featured on Product Hunt · Shipit · BetaList line added after hero-badges |
| 8 | 8.3 Mobile pricing card stacking CSS | DONE | YES — @media(max-width:640px) block added with pricing-cards flex-direction:column |
| 8 | 8.4 JSON-LD structured data | DONE | YES — SoftwareApplication LD+JSON in <head> |
| 8 | 8.5 Lazy-load images | DONE | YES — loading="lazy" decoding="async" on all 6 below-fold img tags |
| 9 | 9.1 401 interceptor → session expired toast | DONE | YES — toast('Session expired — please sign in again','error') at line 2033 confirmed |
| 9 | 9.2 CSV import validation | DONE | YES — /.+@.+\..+/ regex, invalid email rows skipped and logged to missingFields |
| 9 | 9.3 Rate limit 429 with retry time | DONE | YES — minutesRemaining computed from resetAt, returned as retryAfter in api/ai.js |
| 9 | 9.4 XSS: esc() audit in renderContacts/renderQueue | DONE | YES — all dynamic fields use esc() in both functions |
| 9 | 9.5 Secure cookie | BLOCKED — NEEDS DAVID | — |
| 10 | 10.1 Admin impersonation | BLOCKED — NEEDS DAVID | — |
| 10 | 10.2 Admin revenue chart (Chart.js) | DONE | YES — Chart.js CDN + canvas + loadRevenueChart() in admin.html |
| 10 | 10.3 Usage analytics endpoint in billing.js | DONE | YES — admin_usage action in billing.js handleAdmin() |
| 10 | 10.4 Error logging in all API files | DONE | YES — try/catch + error_logs insert in all 10 API files |
| 10 | 10.5 health.js | BLOCKED — 12-function limit | — |
| 11 | 11.1 Privacy policy page | BLOCKED — NEEDS DAVID | — |
| 11 | 11.2 Terms of service page | BLOCKED — NEEDS DAVID | — |
| 11 | 11.3 Legal links audit | DONE | YES — /terms and /privacy confirmed in index.html line 435, help.html lines 99/100/336/337 |

---

## COMMIT LOG

(will be appended after each group commit)

---

## SQL TO RUN IN SUPABASE

```sql
-- Group 2
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS instance_url VARCHAR;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_sync TIMESTAMPTZ;

-- Group 10
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint VARCHAR,
  error TEXT,
  user_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Already from Groups B-J (run if not already done):
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags VARCHAR;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS category VARCHAR DEFAULT 'Follow-up';
ALTER TABLE queue ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_signature TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notify_overdue BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notify_weekly BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS low_credit_threshold INTEGER DEFAULT 10;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
```

---

## FINAL API FILE COUNTS

| File | Line count |
|------|-----------|
| api/ai.js | 273 |
| api/billing.js | 394 |
| api/contacts.js | 480 |
| api/profile.js | 209 |
| api/queue.js | 84 |
| api/drafts.js | 64 |
| api/activity.js | 65 |
| api/rules.js | 49 |
| api/auth/login.js | 67 |
| api/auth/signup.js | 108 |
| api/_validate.js | 40 |

## FINAL HTML FILE COUNTS

| File | Baseline | Final | Status |
|------|---------|-------|--------|
| index.html | 5899 | 5956 | ✓ +57 |
| landing.html | 842 | 862 | ✓ +20 |
| admin.html | — | 281 | ✓ |
