import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.meetrenzo.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, action } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  if (action === 'users') {
    const { data } = await supabase
      .from('users')
      .select('id,email,name,created_at')
      .order('created_at', { ascending: false });
    const { data: billing } = await supabase
      .from('billing')
      .select('user_id,credits');
    const creditMap = Object.fromEntries((billing || []).map(b => [b.user_id, b.credits]));
    return res.json({ users: (data || []).map(u => ({ ...u, credits: creditMap[u.id] ?? 0 })) });
  }

  if (action === 'delete_user') {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    await supabase.from('contacts').delete().eq('user_id', userId);
    await supabase.from('billing').delete().eq('user_id', userId);
    await supabase.from('profiles').delete().eq('user_id', userId);
    await supabase.from('activity').delete().eq('user_id', userId);
    await supabase.from('transactions').delete().eq('user_id', userId);
    await supabase.from('integrations').delete().eq('user_id', userId);
    await supabase.from('users').delete().eq('id', userId);
    return res.json({ success: true });
  }

  if (action === 'transactions') {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    return res.json({ transactions: data || [] });
  }

  if (action === 'stats') {
    const { count: userCount } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });
    const { data: txns } = await supabase
      .from('transactions')
      .select('amount_cents,credits_added');
    const revenue = (txns || []).reduce((s, t) => s + (t.amount_cents || 0), 0) / 100;
    const credits = (txns || []).reduce((s, t) => s + (t.credits_added || 0), 0);
    return res.json({ userCount, revenue, credits });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
