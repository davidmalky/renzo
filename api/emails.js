import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

export default async function handler(req, res) {
  let userId;
  try { ({ userId } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('email_accounts').select('*')
      .eq('user_id', userId)
      .order('sort_order', { ascending: true });
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
