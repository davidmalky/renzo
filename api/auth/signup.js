import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import supabase from '../_supabase.js';

// In-memory rate limiting: 5 signup attempts per IP within 10 minutes
const signupAttempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const entry = signupAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) { signupAttempts.delete(ip); return false; }
  return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const entry = signupAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    signupAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export default async function handler(req, res) {
  try {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  if (isRateLimited(ip))
    return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  recordAttempt(ip);

  const email = (req.body?.email || '').trim().toLowerCase();
  const { password, name } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email' });

  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const password_hash = await bcrypt.hash(password, 10);

  const { data: user, error: userErr } = await supabase
    .from('users')
    .insert({ email, password_hash, name: name || null })
    .select('id, email, name')
    .single();

  if (userErr) return res.status(500).json({ error: 'Failed to create user' });

  await supabase
    .from('profiles')
    .insert({ user_id: user.id, profile_name: 'default' });

  // Grant 10 free trial credits
  await supabase.from('billing').insert({
    user_id: user.id,
    credits: 10,
    first_pack_purchased: false
  });
  await supabase.from('transactions').insert({
    user_id: user.id,
    amount_cents: 0,
    credits_added: 10,
    pack_type: 'free_trial',
    created_at: new Date().toISOString()
  });

  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Queue 3-email onboarding sequence into scheduled_emails
  const displayName = user.name ? user.name.split(' ')[0] : 'there';
  const nowTs = new Date();
  const in24h = new Date(nowTs.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const in72h = new Date(nowTs.getTime() + 72 * 60 * 60 * 1000).toISOString();
  try {
    await supabase.from('scheduled_emails').insert([
      {
        user_id: user.id,
        email: user.email,
        subject: "Welcome to Renzo — here's how to get started",
        body: `Hi ${displayName},\n\nWelcome to Renzo. You have 10 free messages to start — no credit card needed.\n\nHere's the fastest way to get value in the next 5 minutes:\n\n1. Go to Connections and import your contacts from a CSV, Salesforce, HubSpot, or Outlook\n2. Renzo will score them by priority — who's overdue, whose contract is expiring, who's gone quiet\n3. Click Generate on any contact and get a personalized message in one click\n\nStart here: https://meetrenzo.com/app\n\nThe Renzo Team`,
        send_at: nowTs.toISOString()
      },
      {
        user_id: user.id,
        email: user.email,
        subject: 'Have you tried generating your first message?',
        body: `Hi ${displayName},\n\nJust checking in — did you get a chance to try Renzo yet?\n\nThe fastest way to see what it can do: import a CSV of your contacts and click Generate on whoever is most overdue for a follow-up.\n\nMost people are surprised how human the messages sound. That's because Renzo reads your relationship history and writes something specific to that contact — not a template.\n\nYou still have your free credits waiting: https://meetrenzo.com/app\n\nThe Renzo Team`,
        send_at: in24h
      },
      {
        user_id: user.id,
        email: user.email,
        subject: 'One thing Renzo users tell us every week',
        body: `Hi ${displayName},\n\nThe most common thing we hear from Renzo users:\n\n"I had no idea how many relationships I was letting go cold."\n\nMost people managing a contact list of 50, 100, or 200 people think they're on top of it. Renzo shows them the reality — and then makes it easy to fix.\n\nIf you haven't tried it yet, your 10 free messages are still waiting.\n\nIf you have tried it and want to keep going, credits start at $5 for 100 messages.\n\nEither way — we're here if you have questions.\n\nhttps://meetrenzo.com/app\n\nThe Renzo Team`,
        send_at: in72h
      }
    ]);
  } catch(e) { console.error('Onboarding email queue failed:', e.message); }

  return res.status(201).json({ token, userId: user.id, email: user.email, name: user.name });
  } catch (e) {
    supabase.from('error_logs').insert({ endpoint: '/api/auth/signup', error: e.message, created_at: new Date().toISOString() }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}
