import { validateRequest, resolveAuth } from './_validate.js';
import supabase from './_supabase.js';
import { checkAutoRecharge } from './billing.js';

const MODEL_MAP = {
  standard: 'claude-haiku-4-5',
  enhanced: 'claude-sonnet-4-5'
};

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
- Write in first person from the sender's perspective
- Keep it to 3-4 short paragraphs maximum
- Reference specific context from the contact's data (contract dates, last contact, relationship notes)
- Sound warm and human — like a colleague checking in, not a sales pitch
- Never use phrases like "I hope this email finds you well" or "I wanted to reach out"
- End with a clear but low-pressure call to action
- If contract expiry is mentioned and it's within 90 days, acknowledge it naturally
- Do not mention Renzo or AI anywhere in the message
- Do not include a subject line unless specifically asked
- Return only the email body, nothing else`;

// Build a structured user message from a canonical relationship record
function buildGeneratePrompt(record, context) {
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
      // Trigger auto-recharge in the background if balance is low
      checkAutoRecharge(userId).catch(() => {});
    }

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
