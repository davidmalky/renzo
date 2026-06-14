import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import supabase from '../_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, name } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email' });

  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const password_hash = await bcrypt.hash(password, 10);

  const { data: user, error: userErr } = await supabase
    .from('users')
    .insert({ email: email.toLowerCase(), password_hash, name: name || null })
    .select('id, email, name')
    .single();

  if (userErr) return res.status(500).json({ error: 'Failed to create user' });

  await supabase
    .from('profiles')
    .insert({ user_id: user.id, profile_name: 'default' });

  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Fire-and-forget welcome email
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Renzo <noreply@meetrenzo.com>',
      to: user.email,
      subject: 'Welcome to Renzo',
      html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a"><div style="font-family:Georgia,serif;font-size:28px;color:#1F6B47;margin-bottom:8px">Renzo</div><h2 style="font-weight:600;font-size:20px;margin:0 0 16px">Welcome aboard.</h2><p style="line-height:1.6;color:#444">You are all set to start managing your relationships smarter. Renzo helps you know who to reach out to and writes the message for you.</p><p style="line-height:1.6;color:#444">To get started:</p><ol style="line-height:2;color:#444"><li>Add your contacts or import from a CSV</li><li>Set up your company profile in Settings</li><li>Generate your first outreach message</li></ol><a href="https://www.meetrenzo.com/app" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1F6B47;color:white;text-decoration:none;border-radius:8px;font-weight:600">Open Renzo</a><p style="margin-top:32px;font-size:12px;color:#999">Questions? Visit <a href="https://www.meetrenzo.com/help" style="color:#1F6B47">meetrenzo.com/help</a></p></div>'
    })
  }).catch(() => {});

  return res.status(201).json({ token, userId: user.id, email: user.email, name: user.name });
}
