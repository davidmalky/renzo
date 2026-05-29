import bcrypt from 'bcryptjs';
import supabase from '../_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword)
    return res.status(400).json({ error: 'email, code, and newPassword are required' });

  if (newPassword.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // Look up user
  const { data: user } = await supabase
    .from('users')
    .select('id, email')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();

  if (!user) return res.status(400).json({ error: 'Invalid or expired reset code' });

  // Find valid reset code
  const { data: reset } = await supabase
    .from('password_resets')
    .select('id, expires_at, used')
    .eq('user_id', user.id)
    .eq('code', code.toLowerCase().trim())
    .eq('used', false)
    .maybeSingle();

  if (!reset) return res.status(400).json({ error: 'Invalid or expired reset code' });
  if (new Date(reset.expires_at) < new Date())
    return res.status(400).json({ error: 'Reset code has expired — please request a new one' });

  // Hash new password
  const password_hash = await bcrypt.hash(newPassword, 12);

  // Update password
  const { error: updateErr } = await supabase
    .from('users')
    .update({ password_hash })
    .eq('id', user.id);

  if (updateErr) {
    console.error('[reset-password] update error:', updateErr.message);
    return res.status(500).json({ error: 'Failed to update password' });
  }

  // Mark reset code as used
  await supabase
    .from('password_resets')
    .update({ used: true })
    .eq('id', reset.id);

  return res.status(200).json({ success: true });
}
