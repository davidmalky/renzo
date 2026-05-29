import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

export default async function handler(req, res) {
  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('queue').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('added', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { contactId, msg, subject, reason, trigger, email, c_name, co } = req.body || {};
    const { data, error } = await supabase
      .from('queue')
      .insert({ user_id: userId, profile_name: profileName,
                contact_id: contactId || null, msg, subject, reason, trigger, email, c_name, co })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'DELETE') {
    const { id, deleteAll } = req.body || {};

    if (deleteAll) {
      const { data, error } = await supabase
        .from('queue').delete()
        .eq('user_id', userId).eq('profile_name', profileName)
        .select('id');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, deleted: data?.length ?? 0 });
    }

    if (!id) return res.status(400).json({ error: 'id or deleteAll is required' });
    const { error } = await supabase
      .from('queue').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
