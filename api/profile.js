import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

export default async function handler(req, res) {
  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

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
