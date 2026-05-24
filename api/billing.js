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

// ── POST /api/billing (no stripe-signature) — create PaymentIntent ────────────
async function handleCreatePaymentIntent(req, body, res) {
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { type } = body;
  const pack = PACKS[type];
  if (!pack) return res.status(400).json({ error: 'Invalid pack type' });

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

  let creditsToAdd = pack.credits;
  if (type !== 'signup' && !billing?.first_pack_purchased && pack.credits > 0) {
    creditsToAdd = Math.floor(pack.credits * 1.2);
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: pack.amount,
    currency: 'usd',
    customer: customerId,
    metadata: { userId, creditsToAdd: String(creditsToAdd), packType: type },
    description: `Renzo ${type} pack`
  });

  return res.status(200).json({
    clientSecret: paymentIntent.client_secret,
    amount: pack.amount,
    credits: creditsToAdd
  });
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
    const pi = event.data.object;
    const { userId, creditsToAdd } = pi.metadata || {};
    if (userId && creditsToAdd) {
      const credits = parseInt(creditsToAdd, 10);
      const { data: billing } = await supabase
        .from('billing').select('credits').eq('user_id', userId).single();
      if (billing) {
        await supabase.from('billing').update({
          credits: billing.credits + credits,
          first_pack_purchased: true,
          updated_at: new Date().toISOString()
        }).eq('user_id', userId);
        console.log(`Added ${credits} credits to ${userId}`);
      }
    }
  } else if (event.type === 'payment_intent.payment_failed') {
    console.error(`Payment failed: ${event.data.object.id}`);
  }

  return res.status(200).json({ received: true });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const rawBody = await readBody(req);
  const sig = req.headers['stripe-signature'];

  if (req.method === 'GET') {
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
    // Attach parsed body so validateRequest can work (reads req.headers only)
    req.body = body;
    return handleCreatePaymentIntent(req, body, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
