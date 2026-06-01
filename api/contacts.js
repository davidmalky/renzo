import { validateRequest, resolveAuth } from './_validate.js';
import supabase from './_supabase.js';

// Map canonical ingest record → contacts table row
function canonicalToRow(r, userId, profileName) {
  const priorityRaw = r.priority != null ? parseInt(r.priority, 10) : null;
  return {
    user_id:             userId,
    profile_name:        profileName,
    source_system:       r.source_system       || null,
    source_record_id:    r.source_record_id    || null,
    name:                r.contact_name        || null,
    company:             r.company_name        || null,
    email:               r.contact_email       || null,
    phone:               r.contact_phone       || null,
    last_contact:        r.last_contact_date   || null,
    contract_expiry:     r.renewal_or_contract_date || null,
    annual_spend:        r.annual_value != null ? String(r.annual_value) : null,
    notes:               r.context_notes       || null,
    relationship_status: r.relationship_status || 'Active',
    entity_type:         r.entity_type         || 'vendor',
    tags:                Array.isArray(r.tags) ? r.tags : [],
    priority_score:      Number.isFinite(priorityRaw) ? priorityRaw : null
  };
}

export default async function handler(req, res) {

  // ── INGEST (POST {action:'ingest'}) — accepts JWT or API key ──────────────
  if (req.method === 'POST' && req.body?.action === 'ingest') {
    const identity = await resolveAuth(req);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });

    const { records = [] } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required and must not be empty' });
    }

    const { userId, profileName } = identity;
    let upserted = 0;
    const errors = [];

    for (const r of records) {
      if (!r.source_system || !r.source_record_id) {
        errors.push({ source_record_id: r.source_record_id || null,
          error: 'source_system and source_record_id are required' });
        continue;
      }
      const row = canonicalToRow(r, userId, profileName);
      const { error } = await supabase
        .from('contacts')
        .upsert(row, { onConflict: 'user_id,source_system,source_record_id' });
      if (error) {
        errors.push({ source_record_id: r.source_record_id, error: error.message });
      } else {
        upserted++;
      }
    }

    return res.status(200).json({ success: true, upserted, errors });
  }

  // ── All other routes require JWT ──────────────────────────────────────────
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
