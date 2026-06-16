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

function checkAiLimit(userId) {
  const now = Date.now();
  const entry = aiUsage.get(userId);
  if (!entry || now >= entry.resetAt) {
    aiUsage.set(userId, { count: 1, resetAt: now + AI_WINDOW_MS });
    return true;
  }
  if (entry.count >= AI_MAX) return false;
  entry.count++;
  return true;
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

const GENERATE_SYSTEM_PROMPT = `You are an expert relationship outreach writer. Your job is to write warm, personalized, professional emails that sound like they were written by a real person — not a template, not AI.

Rules:
- If context_notes begins with "INTRODUCTION:", treat this as a vendor introduction email — do NOT reference contracts, fees, or renewal dates. Write a short, warm intro connecting two parties.
- Write in first person from the sender's perspective
- Keep it to 3-4 short paragraphs maximum
- Reference specific context from the contact's data (contract dates, last contact, relationship notes)
- Sound warm and human — like a colleague checking in, not a sales pitch
- Never use phrases like "I hope this email finds you well" or "I wanted to reach out"
- End with a clear but low-pressure call to action
- If contract expiry is mentioned and it's within 90 days, acknowledge it naturally
- Do not mention Renzo or AI anywhere in the message
- Do not include a subject line unless specifically asked
- Never use em dashes (—) or double hyphens (--) as punctuation — rewrite the sentence instead
- Return only the email body, nothing else`;

// Build a structured user message from a canonical relationship record
function buildGeneratePrompt(record, context) {
  if ((record.context_notes || '').trimStart().startsWith('INTRODUCTION:')) {
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

  return lines.filter(Boolean).join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── GENERATE (API key or JWT, no session required) ────────────────────────
  if (req.body?.action === 'generate') {
    const identity = await resolveAuth(req);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });

    const { record = {}, context = '' } = req.body;
    const prompt = buildGeneratePrompt(record, context);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system: GENERATE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || 'AI error' });
      }
      const draft = data.content?.[0]?.text || '';
      return res.status(200).json({ draft });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── All other AI requests require JWT + credit deduction ──────────────────
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (!checkAiLimit(userId))
    return res.status(429).json({ error: 'Generation limit reached. Try again in an hour.' });

  const { model: modelKey = 'standard', ...anthropicBody } = req.body || {};
  const anthropicModel = MODEL_MAP[modelKey] || MODEL_MAP.standard;
  const payload = { ...anthropicBody, model: anthropicModel };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

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
      // Trigger auto-recharge in the background if balance is low
      checkAutoRecharge(userId).catch(() => {});
    }

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
