import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import supabase from '../_supabase.js';

// In-memory rate limiting: 5 failed attempts per IP within 10 minutes
const failedAttempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) { failedAttempts.delete(ip); return false; }
  return entry.count >= MAX_FAILS;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Bootstraps a new user the same way api/auth/signup.js does — a `profiles`
// row and a `billing` row are required for the app to function, not optional.
async function provisionNewUser(user) {
  await supabase.from('profiles').insert({ user_id: user.id, profile_name: 'default' });
  await supabase.from('billing').insert({ user_id: user.id, credits: 10, first_pack_purchased: false });
  await supabase.from('transactions').insert({
    user_id: user.id, amount_cents: 0, credits_added: 10, pack_type: 'free_trial', created_at: new Date().toISOString()
  });
}

// ── LINKEDIN OAUTH (public — no JWT needed) ──────────────────────────────
async function handleLinkedInOAuthStart(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `renzo_li_state=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`);
  const redirectUri = 'https://www.meetrenzo.com/api/auth/linkedin_callback';
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${encodeURIComponent(process.env.LINKEDIN_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('openid profile email')}&state=${encodeURIComponent(state)}`;
  return res.redirect(authUrl);
}

async function handleLinkedInCallback(req, res) {
  const { code, state, error: liError } = req.query;
  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies['renzo_li_state'];
  // Clear the state cookie regardless of outcome — it's single-use.
  res.setHeader('Set-Cookie', 'renzo_li_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');

  if (liError) return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=' + encodeURIComponent(liError));
  if (!code || !state || !expectedState || state !== expectedState) {
    return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=invalid_state');
  }

  try {
    const redirectUri = 'https://www.meetrenzo.com/api/auth/linkedin_callback';
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=token_failed');
    }

    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    const profile = await profileRes.json();
    if (!profileRes.ok || !profile.email) {
      return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=profile_failed');
    }
    // LinkedIn's OpenID Connect userinfo includes email_verified — refuse to
    // link/create an account off an email LinkedIn itself hasn't verified.
    if (profile.email_verified === false) {
      return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=email_not_verified');
    }

    const email = profile.email.trim().toLowerCase();
    const name = profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || null;

    let { data: user } = await supabase.from('users').select('id, email, name').eq('email', email).maybeSingle();

    if (!user) {
      const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const { data: newUser, error: userErr } = await supabase
        .from('users')
        .insert({ email, password_hash, name })
        .select('id, email, name')
        .single();
      if (userErr || !newUser) return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=create_failed');
      user = newUser;
      await provisionNewUser(user);
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    return res.redirect('https://www.meetrenzo.com/app?li_token=' + encodeURIComponent(token));
  } catch (e) {
    return res.redirect('https://www.meetrenzo.com/?li_error=1&msg=' + encodeURIComponent(e.message));
  }
}

export default async function handler(req, res) {
  try {
  if (req.method === 'GET' && req.query.action === 'linkedin_oauth_start') {
    return handleLinkedInOAuthStart(req, res);
  }
  if (req.method === 'GET' && (req.query.action === 'linkedin_callback' || (req.url && req.url.includes('/api/auth/linkedin_callback')))) {
    return handleLinkedInCallback(req, res);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  if (isRateLimited(ip))
    return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });

  const email = (req.body?.email || '').trim().toLowerCase();
  const { password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { data: user } = await supabase
    .from('users')
    .select('id, email, name, password_hash')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (!user) { recordFailure(ip); return res.status(401).json({ error: 'Email or password is incorrect. Please try again.' }); }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) { recordFailure(ip); return res.status(401).json({ error: 'Email or password is incorrect. Please try again.' }); }

  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.status(200).json({ token, userId: user.id, email: user.email, name: user.name });
  } catch (e) {
    supabase.from('error_logs').insert({ endpoint: '/api/auth/login', error: e.message, created_at: new Date().toISOString() }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}
