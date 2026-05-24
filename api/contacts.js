import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

export default async function handler(req, res) {
  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('contacts').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { name, company, title, email, phone, tier, frequency, last_contact,
            contract_expiry, invoice_amount, annual_spend, location, account_size,
            products, history, notes } = req.body || {};
    if (!name || !company) return res.status(400).json({ error: 'name and company are required' });
    const { data, error } = await supabase
      .from('contacts')
      .insert({ user_id: userId, profile_name: profileName, name, company, title, email,
                phone, tier, frequency, last_contact, contract_expiry, invoice_amount,
                annual_spend, location, account_size, products, history, notes })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'PUT') {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    delete fields.user_id; delete fields.profile_name; delete fields.created_at;
    const { data, error } = await supabase
      .from('contacts').update(fields)
      .eq('id', id).eq('user_id', userId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase
      .from('contacts').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
