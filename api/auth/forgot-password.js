import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Resend } from 'resend';
import supabase from '../_supabase.js';

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * POST {email}                          → initiate reset (send code)
 * POST {email, code, newPassword}       → complete reset (verify code + update pw)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, code, newPassword } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // ── COMPLETE RESET (code + newPassword present) ──────────────────────────
  if (code && newPassword) {
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { data: user } = await supabase
      .from('users').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset code' });

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

    const password_hash = await bcrypt.hash(newPassword, 12);
    const { error: updateErr } = await supabase
      .from('users').update({ password_hash }).eq('id', user.id);
    if (updateErr) return res.status(500).json({ error: 'Failed to update password' });

    await supabase.from('password_resets').update({ used: true }).eq('id', reset.id);
    return res.status(200).json({ success: true });
  }

  // ── INITIATE RESET (email only) ──────────────────────────────────────────
  const { data: user } = await supabase
    .from('users').select('id, email').eq('email', email.toLowerCase().trim()).maybeSingle();

  // Always respond success to avoid email enumeration
  if (!user) return res.status(200).json({ success: true, message: 'If that email exists, a reset code has been sent.' });

  const code2 = crypto.randomBytes(3).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // Invalidate old codes
  await supabase.from('password_resets').update({ used: true }).eq('user_id', user.id).eq('used', false);

  const { error } = await supabase
    .from('password_resets').insert({ user_id: user.id, code: code2, expires_at: expiresAt, used: false });
  if (error) return res.status(500).json({ error: 'Failed to create reset code' });

  // Send reset email via Resend
  const { data: emailData, error: emailError } = await resend.emails.send({
    from: 'Renzo <onboarding@resend.dev>',
    to: user.email,
    subject: 'Your Renzo password reset code',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 8px">Reset your Renzo password</h2>
        <p style="color:#666;margin:0 0 24px">Use the code below to reset your password. It expires in 1 hour.</p>
        <div style="background:#f5f0e8;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">
          <span style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:monospace">${code2}</span>
        </div>
        <p style="color:#999;font-size:13px;margin:0">If you didn't request this, you can safely ignore this email. Your password will not change.</p>
      </div>
    `
  });

  if (emailError) {
    console.error('[forgot-password] Resend error:', JSON.stringify(emailError));
    return res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }

  console.log('[forgot-password] Email sent:', emailData?.id, '→', user.email);

  return res.status(200).json({
    success: true,
    message: 'If that email exists, a reset code has been sent.'
  });
}
