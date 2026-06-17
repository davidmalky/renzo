import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';
import crypto from 'crypto';

function csrfOk(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'];
  if (!apiKey && origin && !origin.includes('meetrenzo.com') && !origin.includes('localhost')) return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'POST' && !csrfOk(req)) return res.status(403).json({ error: 'Forbidden' });

  // Public action — no JWT required
  if (req.method === 'GET' && req.query?.action === 'confirm_email') {
    const { token } = req.query;
    if (!token) { res.setHeader('Location', '/app?email_verified=error'); return res.status(302).end(); }
    const { data: profileRow } = await supabase
      .from('profiles').select('user_id, pending_email_verify').eq('verify_token', token).maybeSingle();
    if (!profileRow?.user_id || !profileRow?.pending_email_verify) {
      res.setHeader('Location', '/app?email_verified=error'); return res.status(302).end();
    }
    await supabase.from('email_accounts')
      .update({ verified: true })
      .eq('user_id', profileRow.user_id).eq('addr', profileRow.pending_email_verify);
    await supabase.from('profiles')
      .update({ pending_email_verify: null, verify_token: null }).eq('user_id', profileRow.user_id);
    res.setHeader('Location', '/app?email_verified=1');
    return res.status(302).end();
  }

  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  // ── EMAIL ACCOUNTS (r=emails) ────────────────────────────────────────────
  if (req.query?.r === 'emails') {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('email_accounts').select('*')
        .eq('user_id', userId).order('sort_order', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const { accounts = [] } = req.body || {};
      const { error: delErr } = await supabase
        .from('email_accounts').delete().eq('user_id', userId);
      if (delErr) return res.status(500).json({ error: delErr.message });
      if (accounts.length === 0) return res.status(200).json([]);
      const rows = accounts.map(a => ({
        user_id: userId, addr: a.addr,
        label: a.label ?? null, sort_order: a.sort_order ?? 0,
        verified: a.verified !== false
      }));
      const { data, error } = await supabase.from('email_accounts').insert(rows).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── API KEY MANAGEMENT ───────────────────────────────────────────────────

  // GET ?action=list_api_keys
  if (req.method === 'GET' && req.query?.action === 'list_api_keys') {
    const { data, error } = await supabase
      .from('api_keys').select('id, label, created_at, last_used_at')
      .eq('user_id', userId).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // POST {action:'generate_api_key', label?:'...'}
  if (req.method === 'POST' && req.body?.action === 'generate_api_key') {
    const label = (req.body.label || '').trim() || null;
    const rawKey = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { error } = await supabase.from('api_keys')
      .insert({ user_id: userId, key_hash: keyHash, label });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ key: rawKey, label });
  }

  // POST {action:'revoke_api_key', id:'...'}
  if (req.method === 'POST' && req.body?.action === 'revoke_api_key') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from('api_keys')
      .delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // POST {action:'verify_email', email:'...'}
  if (req.method === 'POST' && req.body?.action === 'verify_email') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const token = crypto.randomBytes(32).toString('hex');
    await supabase.from('profiles')
      .update({ pending_email_verify: email, verify_token: token }).eq('user_id', userId);
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Renzo <noreply@meetrenzo.com>',
        to: email,
        subject: 'Verify your email address for Renzo',
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
          <div style="font-family:Georgia,serif;font-size:24px;color:#1F6B47;margin-bottom:16px">Renzo</div>
          <p style="margin-bottom:16px">Someone added this email to their Renzo account. Click below to verify it's yours.</p>
          <a href="https://www.meetrenzo.com/api/profile?action=confirm_email&token=${token}"
             style="display:inline-block;padding:12px 24px;background:#1F6B47;color:white;text-decoration:none;border-radius:8px;font-weight:600;margin:8px 0 16px">
            Verify Email Address
          </a>
          <p style="font-size:12px;color:#999;margin-top:24px">If you didn't add this email to Renzo, you can ignore this message.</p>
        </div>`
      })
    }).catch(() => {});
    return res.json({ success: true });
  }

  // POST {action:'complete_onboarding'}
  if (req.method === 'POST' && req.body?.action === 'complete_onboarding') {
    const { error } = await supabase
      .from('profiles')
      .upsert(
        { user_id: userId, profile_name: profileName, onboarding_completed: true },
        { onConflict: 'user_id,profile_name' }
      );
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // POST {action:'delete_account', confirmation:'DELETE'}
  if (req.method === 'POST' && req.body?.action === 'delete_account') {
    const { confirmation } = req.body;
    if (confirmation !== 'DELETE') return res.status(400).json({ error: 'Invalid confirmation' });
    const tables = ['contacts','activity','queue','drafts','rules','billing','profiles',
                    'integrations','transactions','api_keys','email_accounts'];
    for (const table of tables) {
      await supabase.from(table).delete().eq('user_id', userId);
    }
    await supabase.from('users').delete().eq('id', userId);
    return res.json({ success: true });
  }

  // POST {action:'change_password', currentPassword:'...', newPassword:'...'}
  if (req.method === 'POST' && req.body?.action === 'change_password') {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const bcrypt = await import('bcryptjs');
    const { data: user } = await supabase.from('users').select('password_hash').eq('id', userId).single();
    if (!user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: newHash }).eq('id', userId);
    return res.json({ success: true });
  }

  // ── PROFILE ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('profiles').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || {});
  }

  if (req.method === 'POST') {
    const { company, website, sell, customer, role, tone, rep_name, repName } = req.body || {};
    const { data, error } = await supabase
      .from('profiles')
      .upsert(
        { user_id: userId, profile_name: profileName, company, website, sell,
          customer, role, tone, rep_name: rep_name ?? repName ?? null },
        { onConflict: 'user_id,profile_name' }
      )
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
