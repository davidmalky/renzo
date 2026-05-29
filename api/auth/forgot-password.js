import crypto from 'crypto';
import supabase from '../_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Look up user by email
  const { data: user } = await supabase
    .from('users')
    .select('id, email, name')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();

  // Always return success to avoid email enumeration
  if (!user) {
    return res.status(200).json({ success: true, message: 'If that email exists, a reset code has been sent.' });
  }

  // Generate 6-char hex reset code
  const code = crypto.randomBytes(3).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  // Invalidate any existing unused codes for this user
  await supabase
    .from('password_resets')
    .update({ used: true })
    .eq('user_id', user.id)
    .eq('used', false);

  // Store new reset code
  const { error } = await supabase
    .from('password_resets')
    .insert({ user_id: user.id, code, expires_at: expiresAt, used: false });

  if (error) {
    console.error('[forgot-password] insert error:', error.message);
    return res.status(500).json({ error: 'Failed to create reset code' });
  }

  // TODO: send real email here. For now, log and return code in response.
  console.log(`[forgot-password] Reset code for ${email}: ${code}`);

  return res.status(200).json({
    success: true,
    message: 'If that email exists, a reset code has been sent.',
    // Remove the line below once real email sending is wired up:
    _dev_code: code
  });
}
