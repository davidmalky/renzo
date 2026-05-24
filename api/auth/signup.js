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

  return res.status(201).json({ token, userId: user.id, email: user.email, name: user.name });
}
