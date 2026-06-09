import Stripe from 'stripe';
import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Disable automatic body parsing so we can handle raw body for webhooks
export const config = { api: { bodyParser: false } };

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PACKS = {
  signup:  { amount: 99,   credits: 0    },
  starter: { amount: 500,  credits: 100  },
  growth:  { amount: 2000, credits: 500  },
  pro:     { amount: 5000, credits: 1500 }
};

// ── GET /api/billing — return credit balance ──────────────────────────────────
async function handleStatus(req, res) {
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  let { data, error } = await supabase
    .from('billing').select('*').eq('user_id', userId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  if (!data) {
    const { data: ins, error: ie } = await supabase
      .from('billing').insert({ user_id: userId, credits: 0 }).select().single();
    if (ie) return res.status(500).json({ error: ie.message });
    data = ins;
  }
  return res.status(200).json({
    credits: data.credits,
    stripeCustomerId: data.stripe_customer_id,
    firstPackPurchased: data.first_pack_purchased
  });
}

// ── POST /api/billing — create PaymentIntent (returns clientSecret only) ────────
async function handleCreatePaymentIntent(req, body, res) {
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { type } = body;
  console.log('[billing] create-payment-intent userId:', userId, 'type:', type);

  const pack = PACKS[type];
  if (!pack) return res.status(400).json({ error: 'Invalid pack type' });

  try {
    let { data: billing } = await supabase
      .from('billing').select('*').eq('user_id', userId).maybeSingle();
    if (!billing) {
      const { data: ins } = await supabase
        .from('billing').insert({ user_id: userId, credits: 0 }).select().single();
      billing = ins;
    }

    const { data: user } = await supabase
      .from('users').select('email, name').eq('id', userId).single();

    let customerId = billing?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user?.email,
        name: user?.name,
        metadata: { userId }
      });
      customerId = customer.id;
      await supabase.from('billing').update({ stripe_customer_id: customerId })
        .eq('user_id', userId);
    }

    const creditsToAdd = pack.credits;

    // Build PaymentIntent params — omit customer field if no ID
    const buildPiParams = (cid) => ({
      amount: pack.amount,
      currency: 'usd',
      ...(cid ? { customer: cid } : {}),
      payment_method_types: ['card'],
      payment_method_options: { card: { require_cvc_recollection: false } },
      metadata: { userId, creditsToAdd: String(creditsToAdd), packType: type },
      description: `Renzo ${type} pack`
    });

    // Create PaymentIntent — do NOT confirm server-side, let Stripe.js handle it
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(buildPiParams(customerId));
    } catch (e) {
      if (e.code === 'resource_missing' || e.message?.includes('No such customer')) {
        // Stale customer ID (e.g. test-mode ID used against live-mode API) — reset and retry
        console.warn('[billing] Stale Stripe customer, resetting:', customerId);
        await supabase.from('billing').update({ stripe_customer_id: null }).eq('user_id', userId);
        const freshCustomer = await stripe.customers.create({
          email: user?.email,
          name: user?.name,
          metadata: { userId }
        });
        customerId = freshCustomer.id;
        await supabase.from('billing').update({ stripe_customer_id: customerId }).eq('user_id', userId);
        paymentIntent = await stripe.paymentIntents.create(buildPiParams(customerId));
      } else {
        throw e;
      }
    }

    console.log('[billing] PaymentIntent created:', paymentIntent.id, 'status:', paymentIntent.status);
    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      credits: creditsToAdd
    });
  } catch (e) {
    console.error('[billing] create-payment-intent error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── GET /api/billing?action=transactions — transaction history ────────────────
async function handleTransactions(req, res) {
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

// ── POST /api/billing — confirm credits after successful client-side payment ────
async function handleConfirmCredits(req, body, res) {
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { paymentIntentId } = body;
  if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId' });

  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!pi || pi.metadata?.userId !== userId) {
    return res.status(403).json({ error: 'PaymentIntent does not belong to this user' });
  }
  if (pi.status !== 'succeeded') {
    return res.status(400).json({ error: `Payment not succeeded: ${pi.status}` });
  }

  const creditsToAdd = parseInt(pi.metadata?.creditsToAdd || '0', 10);
  const packType = pi.metadata?.packType;
  const pack = PACKS[packType];

  // Fetch user email for receipt
  const { data: userRow } = await supabase.from('users').select('email').eq('id', userId).single();
  const userEmail = userRow?.email;

  const packLabels = {
    signup:  'Account Activation',
    starter: 'Starter Pack (100 credits)',
    growth:  'Growth Pack (500 credits)',
    pro:     'Pro Pack (1,500 credits)'
  };

  if (packType === 'signup') {
    // Card verification only — mark account verified, award no credits
    await supabase.from('billing')
      .upsert({ user_id: userId, first_pack_purchased: true, updated_at: new Date().toISOString() },
               { onConflict: 'user_id' });

    // Send activation receipt
    if (userEmail) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Renzo <noreply@meetrenzo.com>',
          to: userEmail,
          subject: 'Your Renzo receipt',
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
            <div style="font-family:Georgia,serif;font-size:28px;color:#1F6B47;margin-bottom:8px">Renzo</div>
            <h2 style="font-weight:600;font-size:20px;margin:0 0 16px">Payment confirmed</h2>
            <div style="background:#f5f0eb;border-radius:8px;padding:16px 20px;margin-bottom:20px">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#666">Item</span><span>${packLabels[packType]}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#666">Amount charged</span><span>$${((pack?.amount || 99) / 100).toFixed(2)}</span></div>
            </div>
            <p style="color:#444;line-height:1.6">Your account is now verified and ready to use.</p>
            <a href="https://www.meetrenzo.com/app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1F6B47;color:white;text-decoration:none;border-radius:8px;font-weight:600">Open Renzo</a>
            <p style="margin-top:32px;font-size:12px;color:#999">Questions? Contact <a href="mailto:support@meetrenzo.com" style="color:#1F6B47">support@meetrenzo.com</a></p>
          </div>`
        })
      }).catch(() => {});
    }

    return res.status(200).json({ success: true, credits: 0,
      message: 'Card verified — you\'re ready to purchase credits' });
  }

  if (creditsToAdd > 0) {
    const { data: fresh } = await supabase
      .from('billing').select('credits').eq('user_id', userId).single();
    if (fresh) {
      await supabase.from('billing').update({
        credits: fresh.credits + creditsToAdd,
        first_pack_purchased: true,
        updated_at: new Date().toISOString()
      }).eq('user_id', userId);
    }
    // Record transaction
    await supabase.from('transactions').insert({
      user_id: userId,
      amount_cents: pi.amount,
      credits_added: creditsToAdd,
      pack_type: packType,
      stripe_payment_intent_id: paymentIntentId
    });

    // Send credit purchase receipt
    if (userEmail) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Renzo <noreply@meetrenzo.com>',
          to: userEmail,
          subject: 'Your Renzo receipt',
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
            <div style="font-family:Georgia,serif;font-size:28px;color:#1F6B47;margin-bottom:8px">Renzo</div>
            <h2 style="font-weight:600;font-size:20px;margin:0 0 16px">Payment confirmed</h2>
            <div style="background:#f5f0eb;border-radius:8px;padding:16px 20px;margin-bottom:20px">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#666">Item</span><span>${packLabels[packType] || packType}</span></div>
              <div style="display:flex;justify-content:space-between"><span style="color:#666">Amount charged</span><span>$${((pack?.amount || pi.amount) / 100).toFixed(2)}</span></div>
            </div>
            <p style="color:#444;line-height:1.6">${creditsToAdd} credits have been added to your account.</p>
            <a href="https://www.meetrenzo.com/app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1F6B47;color:white;text-decoration:none;border-radius:8px;font-weight:600">Open Renzo</a>
            <p style="margin-top:32px;font-size:12px;color:#999">Questions? Contact <a href="mailto:support@meetrenzo.com" style="color:#1F6B47">support@meetrenzo.com</a></p>
          </div>`
        })
      }).catch(() => {});
    }
  }

  return res.status(200).json({ success: true, credits: creditsToAdd });
}

// ── POST /api/billing (with stripe-signature) — webhook ──────────────────────
async function handleWebhook(rawBody, sig, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook sig error:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'payment_intent.succeeded') {
    console.log('payment_intent.succeeded webhook received:', event.data.object.id);
  } else if (event.type === 'payment_intent.payment_failed') {
    console.error(`Payment failed: ${event.data.object.id}`);
  }

  return res.status(200).json({ received: true });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const rawBody = await readBody(req);
  const sig = req.headers['stripe-signature'];

  // Public config — returns publishable key, no auth required
  if (req.method === 'GET') {
    const qs = new URL(req.url, 'https://x').searchParams;
    if (qs.get('action') === 'config') {
      return res.status(200).json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
    }
    if (qs.get('action') === 'transactions') return handleTransactions(req, res);
    return handleStatus(req, res);
  }

  if (req.method === 'POST') {
    if (sig) {
      // Stripe webhook — use raw body
      return handleWebhook(rawBody, sig, res);
    }
    // Regular POST — parse JSON body
    let body = {};
    try { body = JSON.parse(rawBody.toString()); } catch {}
    req.body = body;
    if (body.action === 'confirm-credits') return handleConfirmCredits(req, body, res);
    return handleCreatePaymentIntent(req, body, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
