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

    // Create PaymentIntent — do NOT confirm server-side, let Stripe.js handle it
    const paymentIntent = await stripe.paymentIntents.create({
      amount: pack.amount,
      currency: 'usd',
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { userId, creditsToAdd: String(creditsToAdd), packType: type },
      description: `Renzo ${type} pack`
    });

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

  // Retrieve card details for the transaction record
  let card_last4 = null, card_brand = null;
  try {
    const pmId = pi.payment_method;
    if (pmId) {
      const pm = await stripe.paymentMethods.retrieve(pmId);
      card_last4 = pm?.card?.last4 || null;
      card_brand = pm?.card?.brand || null;
    }
  } catch (e) { console.error('[confirm-credits] card retrieve failed:', e.message); }

  if (packType === 'signup') {
    // Card verification only — mark account verified, award no credits
    await supabase.from('billing')
      .upsert({ user_id: userId, first_pack_purchased: true, updated_at: new Date().toISOString() },
               { onConflict: 'user_id' });
    await supabase.from('transactions').insert({ user_id: userId, pack_type: 'signup', amount_cents: pi.amount, credits_added: 0, stripe_pi_id: pi.id, card_last4, card_brand });
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
    await supabase.from('transactions').insert({ user_id: userId, pack_type: packType, amount_cents: pi.amount, credits_added: creditsToAdd, stripe_pi_id: pi.id, card_last4, card_brand });
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

// ── ADMIN ACTIONS ────────────────────────────────────────────────────────────
async function handleAdmin(req, body, res) {
  const pw = body.password || '';
  if (!pw || pw !== (process.env.ADMIN_PASSWORD || '')) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const action = body.action || '';

  if (action === 'admin_users') {
    const { data: users } = await supabase.from('users').select('id,email,name,created_at').order('created_at',{ascending:false});
    const { data: billing } = await supabase.from('billing').select('user_id,credits');
    const creditMap = Object.fromEntries((billing||[]).map(b=>[b.user_id,b.credits]));
    return res.json({ users: (users||[]).map(u=>({...u, credits: creditMap[u.id]||0})) });
  }
  if (action === 'admin_delete_user') {
    const { userId } = body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    for (const tbl of ['contacts','billing','profiles','activity','transactions','integrations','queue','drafts','rules','api_keys']) {
      await supabase.from(tbl).delete().eq('user_id', userId);
    }
    await supabase.from('users').delete().eq('id', userId);
    return res.json({ success: true });
  }
  if (action === 'admin_transactions') {
    const { data } = await supabase.from('transactions').select('*').order('created_at',{ascending:false}).limit(20);
    return res.json({ transactions: data||[] });
  }
  if (action === 'admin_stats') {
    const { count: userCount } = await supabase.from('users').select('*',{count:'exact',head:true});
    const { data: txns } = await supabase.from('transactions').select('amount_cents,credits_added');
    const revenue = (txns||[]).reduce((s,t)=>s+(t.amount_cents||0),0)/100;
    const credits = (txns||[]).reduce((s,t)=>s+(t.credits_added||0),0);
    return res.json({ userCount, revenue, credits });
  }
  return res.status(400).json({ error: 'Unknown admin action' });
}

export default async function handler(req, res) {
  const rawBody = await readBody(req);
  const sig = req.headers['stripe-signature'];

  // Public config — returns publishable key, no auth required
  // User transaction history (JWT-protected, no admin required)
  if (req.method === 'GET' && req.query.action === 'transactions') {
    let uid;
    try { ({ userId: uid } = await validateRequest(req)); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const { data: txns } = await supabase.from('transactions').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20);
    return res.json({ transactions: txns || [] });
  }

  if (req.method === 'GET') {
    const qs = new URL(req.url, 'https://x').searchParams;
    if (qs.get('action') === 'config') {
      return res.status(200).json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
    }
    if (qs.get('action') === 'payment_methods') {
      let uid; try { ({ userId: uid } = await validateRequest(req)); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
      const { data: billing } = await supabase.from('billing').select('stripe_customer_id').eq('user_id', uid).single();
      if (!billing?.stripe_customer_id) return res.json({ methods: [] });
      const pms = await stripe.paymentMethods.list({ customer: billing.stripe_customer_id, type: 'card' });
      const customer = await stripe.customers.retrieve(billing.stripe_customer_id);
      const defaultPm = customer.invoice_settings?.default_payment_method;
      return res.json({ methods: pms.data.map(pm => ({ id: pm.id, brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year, isDefault: pm.id === defaultPm })) });
    }
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
    if ((body.action||'').startsWith('admin_') || body.action === 'admin_users' || body.action === 'admin_stats' || body.action === 'admin_transactions' || body.action === 'admin_delete_user') return handleAdmin(req, body, res);
    if (body.action === 'set_default_card') {
      let uid; try { ({ userId: uid } = await validateRequest(req)); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
      const { pmId } = body;
      const { data: billing } = await supabase.from('billing').select('stripe_customer_id').eq('user_id', uid).single();
      await stripe.customers.update(billing.stripe_customer_id, { invoice_settings: { default_payment_method: pmId } });
      await supabase.from('billing').update({ stripe_default_pm: pmId }).eq('user_id', uid);
      return res.json({ success: true });
    }
    if (body.action === 'remove_card') {
      let uid; try { ({ userId: uid } = await validateRequest(req)); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
      const { pmId } = body;
      await stripe.paymentMethods.detach(pmId);
      return res.json({ success: true });
    }
    if (body.action === 'add_card') {
      let uid; try { ({ userId: uid } = await validateRequest(req)); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
      const { data: billing } = await supabase.from('billing').select('stripe_customer_id').eq('user_id', uid).single();
      let customerId = billing?.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: uid });
        customerId = customer.id;
        await supabase.from('billing').update({ stripe_customer_id: customerId }).eq('user_id', uid);
      }
      const setupIntent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
      return res.json({ clientSecret: setupIntent.client_secret });
    }
    return handleCreatePaymentIntent(req, body, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
