import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';
import crypto from 'crypto';

export default async function handler(req, res) {
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
        label: a.label ?? null, sort_order: a.sort_order ?? 0
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
