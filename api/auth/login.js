import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  if (isRateLimited(ip))
    return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });

  const { email, password } = req.body || {};

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
}
