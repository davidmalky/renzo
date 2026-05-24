import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

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
    // Retry once on race condition
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  // Extract model selection from request; don't forward it to Anthropic
  const { model: modelKey = 'standard', ...anthropicBody } = req.body || {};
  const anthropicModel = MODEL_MAP[modelKey] || MODEL_MAP.standard;

  // Override model in the body sent to Anthropic
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
      // Attach credit info to response so frontend can update display
      data._credits = deductResult;
    }

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
