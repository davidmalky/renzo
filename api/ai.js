import { validateRequest, resolveAuth } from './_validate.js';
import supabase from './_supabase.js';
import { checkAutoRecharge } from './billing.js';

const MODEL_MAP = {
  standard: 'claude-haiku-4-5',
  enhanced: 'claude-sonnet-4-5'
};

// In-memory per-user rate limit: 30 AI requests per hour
const aiUsage = new Map();
const AI_WINDOW_MS = 60 * 60 * 1000;
const AI_MAX = 30;

// 9.3 — returns {ok, resetAt} so caller can compute retry-after minutes
function checkAiLimit(userId) {
  const now = Date.now();
  const entry = aiUsage.get(userId);
  if (!entry || now >= entry.resetAt) {
    aiUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= AI_MAX) return { ok: false, resetAt: entry.resetAt };
  entry.count++;
  return { ok: true };
}

async function deductCredits(userId, tokensUsed, model) {
  let creditsToDeduct = Math.ceil(tokensUsed / 1000);
  if (model === 'enhanced') creditsToDeduct = creditsToDeduct * 2;
  if (creditsToDeduct < 1) creditsToDeduct = 1;

  const { data: billing } = await supabase
    .from('billing').select('credits').eq('user_id', userId).maybeSingle();

  const currentBalance = billing?.credits ?? 0;
  if (currentBalance < creditsToDeduct) {
    return { error: 'insufficient_credits', credits: currentBalance };
  }

  const { data: updated, error } = await supabase
    .from('billing')
    .update({ credits: currentBalance - creditsToDeduct, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('credits', currentBalance)
    .select('credits')
    .single();

  if (error || !updated) {
    const { data: refetch } = await supabase
      .from('billing').select('credits').eq('user_id', userId).single();
    const fresh = refetch?.credits ?? 0;
    if (fresh < creditsToDeduct) return { error: 'insufficient_credits', credits: fresh };
    await supabase.from('billing')
      .update({ credits: fresh - creditsToDeduct, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return { creditsDeducted: creditsToDeduct, creditsRemaining: fresh - creditsToDeduct };
  }

  return { creditsDeducted: creditsToDeduct, creditsRemaining: updated.credits };
}

const ANTHROPIC_HEADERS = {
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01'
};

// 4.5 — calls Anthropic with JSON-parse retry on failure
async function callAnthropic(payload) {
  const makeCall = async (p) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { ...ANTHROPIC_HEADERS, 'x-api-key': process.env.ANTHROPIC_API_KEY },
      body: JSON.stringify(p)
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      const err = new Error('JSON parse failed: ' + text.slice(0, 200));
      err.isJsonError = true;
      throw err;
    }
    return { response: r, data };
  };

  try { return await makeCall(payload); }
  catch (e) {
    if (!e.isJsonError) throw e;
    // Second attempt with explicit JSON instruction
    const retryPayload = { ...payload };
    if (Array.isArray(retryPayload.messages) && retryPayload.messages.length > 0) {
      retryPayload.messages = [...retryPayload.messages,
        { role: 'user', content: 'IMPORTANT: Return ONLY valid JSON, nothing else. No markdown, no explanation, no code blocks.' }
      ];
    }
    return await makeCall(retryPayload);
  }
}

const GENERATE_SYSTEM_PROMPT = `You are an expert relationship outreach writer. Write warm, personalized, professional emails.

Rules:
- If context_notes begins with "INTRODUCTION:", treat this as a vendor introduction email — do NOT reference contracts, fees, or renewal dates. Write a short, warm intro connecting two parties.
- Write in first person
- Keep it to 3-4 short paragraphs maximum — brevity is critical
- Always reference something specific from the contact's context (contract date, last meeting, their role, notes)
- Sound like a human colleague, not a sales rep
- Never start with "I hope this email finds you well" or "I wanted to reach out"
- Never use "touch base", "circle back", "ping", "synergy", or corporate buzzwords
- End with one clear, low-pressure ask — a call, a reply, a quick question
- If contract expiry is within 90 days, acknowledge it naturally and specifically
- If this is a first contact, mention how you know them or why you're reaching out
- Do NOT mention Renzo, AI, or that this message was generated
- Return ONLY the email body — no subject line, no greeting label, no signature instructions
- The tone should match the relationship: warm for long-term accounts, professional for newer ones`;

// 4.3 — Build structured prompt; detects RENEWAL/REACTIVATE/CONGRATULATE context prefixes
function buildGeneratePrompt(record, context) {
  const contextNotes = (record.context_notes || '').trimStart();

  if (contextNotes.startsWith('INTRODUCTION:')) {
    return `You are writing a vendor-to-vendor introduction email on behalf of ${record.contact_name ? 'the sender' : 'David Genuth at Prime Source Expense Experts'}.

This is NOT a follow-up or check-in. This is a warm introduction connecting two vendors.

Rules:
- Do NOT mention contracts, fees, renewal dates, or admin fees
- Do NOT reference the recipient's existing relationship with the sender
- Keep it to 3-4 sentences maximum
- Tone: warm, collegial, helpful — not transactional
- Structure: (1) introduce the other party and their category, (2) explain why you see a natural fit, (3) soft ask to connect
- Sign off as: David Genuth, Prime Source Expense Experts
- Return ONLY the email body, no subject line, no preamble

Context: ${record.context_notes}
Recipient: ${record.contact_name} at ${record.company_name}`;
  }

  const daysSince = record.last_contact_date
    ? Math.floor((Date.now() - new Date(record.last_contact_date).getTime()) / 86400000)
    : null;
  const renewalDays = record.renewal_or_contract_date
    ? Math.floor((new Date(record.renewal_or_contract_date).getTime() - Date.now()) / 86400000)
    : null;

  const lines = [
    'Write an outreach email for the following relationship:',
    'Contact: ' + (record.contact_name || 'Unknown'),
    'Company: ' + (record.company_name || 'Unknown'),
    record.relationship_status ? 'Relationship status: ' + record.relationship_status : '',
    record.entity_type ? 'Entity type: ' + record.entity_type : '',
    daysSince != null ? 'Last contacted: ' + daysSince + ' days ago' : '',
    record.annual_value != null ? 'Annual value: $' + record.annual_value : '',
    renewalDays != null && renewalDays <= 90
      ? 'IMPORTANT — Contract/renewal in ' + renewalDays + ' days' : '',
    record.context_notes ? 'Context notes: ' + record.context_notes : '',
    context ? 'Outreach goal: ' + context : '',
  ];

  // 4.3 — Append tone guidance based on context_notes prefix
  if (contextNotes.startsWith('RENEWAL:'))
    lines.push('IMPORTANT: This is a contract renewal conversation. Reference the upcoming expiry naturally. The goal is to start the renewal discussion without pressure.');
  else if (contextNotes.startsWith('REACTIVATE:'))
    lines.push('IMPORTANT: This contact has gone dark. The goal is to re-engage warmly without making them feel guilty for not responding.');
  else if (contextNotes.startsWith('CONGRATULATE:'))
    lines.push('IMPORTANT: This is a congratulatory message for a milestone or achievement. Keep it genuine and brief.');

  return lines.filter(Boolean).join('\n');
}

function csrfOk(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'];
  if (!apiKey && origin && !origin.includes('meetrenzo.com') && !origin.includes('localhost')) return false;
  return true;
}

export default async function handler(req, res) {
  // 10.4 — top-level error logging
  let _userId = null;
  try {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!csrfOk(req)) return res.status(403).json({ error: 'Forbidden' });

  // ── GENERATE (API key or JWT, no session required) ────────────────────────
  if (req.body?.action === 'generate') {
    const identity = await resolveAuth(req);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });
    _userId = identity.userId;

    const { record = {}, context = '' } = req.body;
    const prompt = buildGeneratePrompt(record, context);

    // 7.2 — fetch user outreach rules and append to system prompt
    const { data: userRules } = await supabase.from('rules').select('rule')
      .eq('user_id', identity.userId).limit(20);
    const rulesText = (userRules || []).map(r => r.rule).filter(Boolean).join('\n');
    const systemPrompt = GENERATE_SYSTEM_PROMPT + (rulesText ? '\n\nUser outreach rules:\n' + rulesText : '');

    try {
      const { response, data } = await callAnthropic({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || 'AI error' });
      }
      const draft = data.content?.[0]?.text || '';
      return res.status(200).json({ draft });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GENERATE_SIMPLE (API key or JWT, no session required) ──────────────────
  if (req.body?.action === 'generate_simple') {
    const identity = await resolveAuth(req);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });
    _userId = identity.userId;

    const { contactName = 'there', context = '' } = req.body;
    const prompt = `Write a short, warm, professional outreach message to ${contactName}. Keep it under 5 sentences. Sound like a real person, not a sales robot.`
      + (context ? ` Context: ${context}` : '');

    try {
      const { response, data } = await callAnthropic({
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }]
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || 'AI error' });
      }
      const message = data.content?.[0]?.text || '';
      return res.status(200).json({ message });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── All other AI requests require JWT + credit deduction ──────────────────
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }
  _userId = userId;

  // 9.3 — rate limit with exact retry-after minutes
  const limitCheck = checkAiLimit(userId);
  if (!limitCheck.ok) {
    const minutesRemaining = Math.ceil((limitCheck.resetAt - Date.now()) / 60000);
    return res.status(429).json({
      error: `Generation limit reached. You can generate up to 30 messages per hour. Try again in ${minutesRemaining} minutes.`,
      retryAfter: minutesRemaining
    });
  }

  const { model: modelKey = 'standard', ...anthropicBody } = req.body || {};
  const anthropicModel = MODEL_MAP[modelKey] || MODEL_MAP.standard;
  const payload = { ...anthropicBody, model: anthropicModel };

  try {
    const { response, data } = await callAnthropic(payload);

    if (response.ok && data.usage) {
      const tokensUsed = (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0);
      const deductResult = await deductCredits(userId, tokensUsed, modelKey);
      if (deductResult.error === 'insufficient_credits') {
        return res.status(402).json({ error: 'insufficient_credits', credits: deductResult.credits });
      }
      data._credits = deductResult;
      // Log usage (non-blocking)
      supabase.from('usage_logs').insert({
        user_id: userId, action: 'generate', model: anthropicModel,
        credits_used: deductResult.creditsDeducted || 1
      }).then(() => {}).catch(() => {});
      // Trigger auto-recharge in background if balance is low
      checkAutoRecharge(userId).catch(() => {});
      // Send credit exhaustion email when balance hits exactly 0 (non-blocking)
      if (deductResult.creditsRemaining === 0) {
        (async () => {
          try {
            const { data: u } = await supabase.from('users').select('email, name').eq('id', userId).single();
            if (u?.email) {
              const firstName = u.name ? u.name.split(' ')[0] : 'there';
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'Renzo <noreply@meetrenzo.com>',
                  to: u.email,
                  subject: "You've used your free Renzo credits",
                  text: `Hi ${firstName},\n\nYou've used all 10 of your free Renzo messages.\n\nHere's what other users are doing with Renzo:\n- Staying on top of vendor relationships before contracts auto-renew\n- Following up with clients they haven't spoken to in months\n- Generating personalized outreach in seconds instead of spending 20 minutes writing an email\n\nYour contacts aren't going anywhere — but the relationships are getting colder every day you wait.\n\nGet more credits and keep going:\nhttps://meetrenzo.com/app\n\nStarter pack: 100 credits for $5\nGrowth pack: 500 credits for $20\nPro pack: 1500 credits for $50\n\nThe Renzo Team`
                })
              });
            }
          } catch(e) { console.error('[credit-exhaustion] email failed:', e.message); }
        })();
      }
    }

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  } catch (e) {
    // 10.4 — fire-and-forget error log
    supabase.from('error_logs').insert({ endpoint: req.url, error: e.message, user_id: _userId, created_at: new Date().toISOString() }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}
