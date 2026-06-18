import { validateRequest } from './_validate.js';
import supabase from './_supabase.js';

function csrfOk(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'];
  if (!apiKey && origin && !origin.includes('meetrenzo.com') && !origin.includes('localhost')) return false;
  return true;
}

export default async function handler(req, res) {
  try {
  if (req.method === 'POST' && !csrfOk(req)) return res.status(403).json({ error: 'Forbidden' });

  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    const limit = parseInt(req.query.limit, 10) || 200;
    const offset = parseInt(req.query.offset, 10) || 0;
    const { data, error } = await supabase
      .from('activity').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('ts', { ascending: false })
      .range(offset, offset + limit - 1);
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
  } catch (e) {
    supabase.from('error_logs').insert({ endpoint: req.url, error: e.message, created_at: new Date().toISOString() }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}
