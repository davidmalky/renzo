import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

function csrfOk(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'];
  if (!apiKey && origin && !origin.includes('meetrenzo.com') && !origin.includes('localhost')) return false;
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'POST' && !csrfOk(req)) return res.status(403).json({ error: 'Forbidden' });

  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const limit = parseInt(req.query.limit, 10) || 100;
    const search = (req.query.search || '').toLowerCase();
    let query = supabase
      .from('queue').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('added', { ascending: false })
      .limit(limit);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    const result = search
      ? data.filter(r => (r.c_name||'').toLowerCase().includes(search) || (r.co||'').toLowerCase().includes(search))
      : data;
    return res.status(200).json(result);
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

  if (req.method === 'PUT') {
    if (!csrfOk(req)) return res.status(403).json({ error: 'Forbidden' });
    const { id, scheduled_for, subject } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const updates = { scheduled_for: scheduled_for || null };
    if (subject !== undefined) updates.subject = subject;
    const { data, error } = await supabase
      .from('queue').update(updates)
      .eq('id', id).eq('user_id', userId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
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
