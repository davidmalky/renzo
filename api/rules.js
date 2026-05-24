import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

export default async function handler(req, res) {
  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('rules').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { rules = [] } = req.body || {};
    const { error: delErr } = await supabase
      .from('rules').delete()
      .eq('user_id', userId).eq('profile_name', profileName);
    if (delErr) return res.status(500).json({ error: delErr.message });
    if (rules.length === 0) return res.status(200).json([]);
    const rows = rules.map(r => ({
      user_id: userId, profile_name: profileName,
      rule_text: r.rule_text, sort_order: r.sort_order ?? 0
    }));
    const { data, error } = await supabase.from('rules').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
