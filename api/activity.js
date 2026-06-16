import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

export default async function handler(req, res) {
  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('activity').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('ts', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });

    if (req.query.format === 'csv') {
      const rows = [['Date','Contact','Company','Subject','Message']];
      (data || []).forEach(a => {
        rows.push([
          new Date(a.ts).toLocaleString(),
          a.c_name || '',
          a.co || '',
          a.trigger || '',
          (a.msg || '').slice(0, 200).replace(/"/g, "'")
        ]);
      });
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="renzo-activity.csv"');
      return res.status(200).send(csv);
    }

    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { contactId, msg, reason, trigger } = req.body || {};
    const { data, error } = await supabase
      .from('activity')
      .insert({ user_id: userId, profile_name: profileName,
                contact_id: contactId || null, msg, reason, trigger })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
