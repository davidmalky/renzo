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

  // ── SALESFORCE OAUTH (public — no JWT needed) ────────────────────────────
  if (req.method === 'GET' && req.query.action === 'salesforce_oauth_start') {
    const clientId = process.env.SALESFORCE_CLIENT_ID;
    const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=salesforce_oauth_callback';
    const state = req.query.userId || '';
    const authUrl = 'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=' + encodeURIComponent(clientId) + '&redirect_uri=' + encodeURIComponent(redirectUri) + '&scope=api+refresh_token&state=' + encodeURIComponent(state);
    return res.redirect(authUrl);
  }
  if (req.method === 'GET' && req.query.action === 'salesforce_oauth_callback') {
    return handleSfOAuthCallback(req, res);
  }

  // ── MICROSOFT OAUTH (public — no JWT needed) ─────────────────────────────
  if (req.method === 'GET' && req.query.action === 'microsoft_oauth_start') {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=microsoft_oauth_callback';
    const state = req.query.userId || '';
    const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
      + '?client_id=' + encodeURIComponent(clientId)
      + '&response_type=code'
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&scope=' + encodeURIComponent('Contacts.Read offline_access')
      + '&state=' + encodeURIComponent(state)
      + '&response_mode=query';
    return res.redirect(authUrl);
  }
  if (req.method === 'GET' && req.query.action === 'microsoft_oauth_callback') {
    return handleMsOAuthCallback(req, res);
  }

  // ── QUICKBOOKS OAUTH (public — no JWT needed) ────────────────────────────
  if (req.method === 'GET' && req.query.action === 'quickbooks_oauth_start') {
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=quickbooks_oauth_callback';
    const state = req.query.userId || '';
    const authUrl = 'https://appcenter.intuit.com/connect/oauth2'
      + '?client_id=' + encodeURIComponent(clientId)
      + '&response_type=code'
      + '&scope=' + encodeURIComponent('com.intuit.quickbooks.accounting')
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&state=' + encodeURIComponent(state);
    return res.redirect(authUrl);
  }
  if (req.method === 'GET' && req.query.action === 'quickbooks_oauth_callback') {
    return handleQbOAuthCallback(req, res);
  }

  // ── All other routes require JWT ──────────────────────────────────────────
  let userId, profileName;
  try { ({ userId, profileName } = await validateRequest(req)); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  if (req.method === 'GET') {
    if (req.query.action === 'salesforce_status') {
      const { data: intData } = await supabase.from('integrations').select('connected').eq('user_id', userId).eq('provider', 'salesforce').maybeSingle();
      return res.status(200).json({ connected: intData?.connected || false });
    }
    if (req.query.action === 'microsoft_status') {
      const { data: intData } = await supabase.from('integrations').select('connected').eq('user_id', userId).eq('provider', 'microsoft').maybeSingle();
      return res.status(200).json({ connected: intData?.connected || false });
    }
    if (req.query.action === 'quickbooks_status') {
      const { data: intData } = await supabase.from('integrations').select('connected').eq('user_id', userId).eq('provider', 'quickbooks').maybeSingle();
      return res.status(200).json({ connected: intData?.connected || false });
    }
    const { data, error } = await supabase
      .from('contacts').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST' && req.body?.action === 'microsoft_sync') {
    const { data: msInt } = await supabase.from('integrations').select('*').eq('user_id', userId).eq('provider', 'microsoft').maybeSingle();
    if (!msInt || !msInt.access_token) return res.status(400).json({ error: 'Microsoft not connected. Please connect first.' });

    // Try refresh if needed
    let accessToken = msInt.access_token;
    if (msInt.refresh_token) {
      try {
        const refreshRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: msInt.refresh_token,
            client_id: process.env.MICROSOFT_CLIENT_ID,
            client_secret: process.env.MICROSOFT_CLIENT_SECRET,
            scope: 'Contacts.Read offline_access'
          })
        });
        if (refreshRes.ok) {
          const refreshed = await refreshRes.json();
          accessToken = refreshed.access_token;
          await supabase.from('integrations').update({ access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || msInt.refresh_token }).eq('user_id', userId).eq('provider', 'microsoft');
        }
      } catch(e) { /* use existing token */ }
    }

    const msRes = await fetch('https://graph.microsoft.com/v1.0/me/contacts?$top=500&$select=displayName,emailAddresses,businessPhones,companyName,jobTitle', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (msRes.status === 401) {
      await supabase.from('integrations').update({ connected: false }).eq('user_id', userId).eq('provider', 'microsoft');
      return res.status(401).json({ error: 'Microsoft session expired. Please reconnect.' });
    }
    const msData = await msRes.json();
    if (!msRes.ok) return res.status(400).json({ error: msData.error?.message || 'Microsoft sync failed' });

    const msRecs = msData.value || [];
    let msSynced = 0, msErrors = [];
    for (const r of msRecs) {
      try {
        const email = r.emailAddresses?.[0]?.address || null;
        const phone = r.businessPhones?.[0] || null;
        const m = { name: r.displayName || 'Unknown', email, phone, company: r.companyName || null, source_system: 'Microsoft', source_record_id: 'ms:' + r.id, updated_at: new Date().toISOString() };
        const { data: ex } = await supabase.from('contacts').select('id').eq('user_id', userId).eq('source_system', 'Microsoft').eq('source_record_id', 'ms:' + r.id).maybeSingle();
        if (ex) { await supabase.from('contacts').update(m).eq('id', ex.id); }
        else { await supabase.from('contacts').insert({ ...m, user_id: userId, profile_name: profileName }); }
        msSynced++;
      } catch(e) { msErrors.push({ id: r.id, error: e.message }); }
    }
    return res.status(200).json({ success: true, synced: msSynced, errors: msErrors });
  }

  if (req.method === 'POST' && req.body?.action === 'quickbooks_sync') {
    const { data: qbInt } = await supabase.from('integrations').select('*').eq('user_id', userId).eq('provider', 'quickbooks').maybeSingle();
    if (!qbInt || !qbInt.access_token) return res.status(400).json({ error: 'QuickBooks not connected. Please connect first.' });

    // Refresh token
    let accessToken = qbInt.access_token;
    try {
      const creds = Buffer.from(process.env.QUICKBOOKS_CLIENT_ID + ':' + process.env.QUICKBOOKS_CLIENT_SECRET).toString('base64');
      const refreshRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + creds },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: qbInt.refresh_token })
      });
      if (refreshRes.ok) {
        const refreshed = await refreshRes.json();
        accessToken = refreshed.access_token;
        await supabase.from('integrations').update({ access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || qbInt.refresh_token }).eq('user_id', userId).eq('provider', 'quickbooks');
      }
    } catch(e) { /* use existing token */ }

    const realmId = qbInt.instance_url;
    const isProd = !realmId?.startsWith('sandbox');
    const baseUrl = 'https://quickbooks.api.intuit.com';
    const qbRes = await fetch(`${baseUrl}/v3/company/${realmId}/query?query=SELECT%20*%20FROM%20Customer%20WHERE%20Active%3Dtrue%20MAXRESULTS%20500&minorversion=65`, {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' }
    });
    if (qbRes.status === 401) {
      await supabase.from('integrations').update({ connected: false }).eq('user_id', userId).eq('provider', 'quickbooks');
      return res.status(401).json({ error: 'QuickBooks session expired. Please reconnect.' });
    }
    const qbData = await qbRes.json();
    if (!qbRes.ok) return res.status(400).json({ error: qbData.Fault?.Error?.[0]?.Message || 'QuickBooks sync failed' });

    const qbRecs = qbData.QueryResponse?.Customer || [];
    let qbSynced = 0, qbErrors = [];
    for (const r of qbRecs) {
      try {
        const email = r.PrimaryEmailAddr?.Address || null;
        const phone = r.PrimaryPhone?.FreeFormNumber || null;
        const balance = r.Balance != null ? String(r.Balance) : null;
        const m = { name: r.DisplayName || r.CompanyName || 'Unknown', email, phone, company: r.CompanyName || null, invoice_amount: balance, source_system: 'QuickBooks', source_record_id: 'qb:' + r.Id, updated_at: new Date().toISOString() };
        const { data: ex } = await supabase.from('contacts').select('id').eq('user_id', userId).eq('source_system', 'QuickBooks').eq('source_record_id', 'qb:' + r.Id).maybeSingle();
        if (ex) { await supabase.from('contacts').update(m).eq('id', ex.id); }
        else { await supabase.from('contacts').insert({ ...m, user_id: userId, profile_name: profileName }); }
        qbSynced++;
      } catch(e) { qbErrors.push({ id: r.Id, error: e.message }); }
    }
    return res.status(200).json({ success: true, synced: qbSynced, errors: qbErrors });
  }

  if (req.method === 'POST' && req.body?.action === 'salesforce_sync') {
    const { data: sfInt } = await supabase.from('integrations').select('*').eq('user_id', userId).eq('provider', 'salesforce').maybeSingle();
    if (!sfInt || !sfInt.access_token) return res.status(400).json({ error: 'Salesforce not connected. Please connect first.' });
    const sfRes = await fetch(sfInt.instance_url + '/services/data/v57.0/query?q=' + encodeURIComponent('SELECT Id,Name,Email,Phone,Account.Name FROM Contact ORDER BY LastModifiedDate DESC LIMIT 500'), { headers: { Authorization: 'Bearer ' + sfInt.access_token } });
    if (sfRes.status === 401) { await supabase.from('integrations').update({ connected: false }).eq('user_id', userId).eq('provider', 'salesforce'); return res.status(401).json({ error: 'Salesforce session expired. Please reconnect.' }); }
    const sfData = await sfRes.json();
    if (!sfRes.ok) return res.status(400).json({ error: sfData[0]?.message || 'Salesforce sync failed' });
    const sfRecs = sfData.records || [];
    let sfSynced = 0, sfErrors = [];
    for (const r of sfRecs) {
      try {
        const m = { name: r.Name||'Unknown', email: r.Email||null, phone: r.Phone||null, company: r.Account?.Name||null, source_system: 'Salesforce', source_record_id: 'sf:'+r.Id, updated_at: new Date().toISOString() };
        const { data: ex } = await supabase.from('contacts').select('id').eq('user_id', userId).eq('source_system', 'Salesforce').eq('source_record_id', 'sf:'+r.Id).maybeSingle();
        if (ex) { await supabase.from('contacts').update(m).eq('id', ex.id); } else { await supabase.from('contacts').insert({ ...m, user_id: userId, profile_name: profileName }); }
        sfSynced++;
      } catch(e) { sfErrors.push({ id: r.Id, error: e.message }); }
    }
    return res.status(200).json({ success: true, synced: sfSynced, errors: sfErrors });
  }

  // ── VCS SYNC (POST {action:'vcs_sync'}) ─────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'vcs_sync') {
    const VCS_URL = 'https://script.google.com/macros/s/AKfycbzjSZX_QmdQ9voaWbOOSYpAE39y9S7SwNstCPJTjjKrcZyzA7fS1jQR6ORryQoAuVxJ/exec';
    const VCS_KEY = '63a1448f-9f89-4565-83b2-1509abe74064-6bfb6be9-3de9-47c4-b072-c96d7b203f9a';

    let records;
    try {
      const r = await fetch(`${VCS_URL}?action=renzoGetRecords&renzoKey=${VCS_KEY}`);
      if (!r.ok) return res.status(502).json({ error: `VCS proxy error: ${r.status}` });
      const body = await r.json();
      records = Array.isArray(body) ? body : (body.records || []);
    } catch (e) {
      return res.status(502).json({ error: `VCS fetch failed: ${e.message}` });
    }

    const priorityMap = { high: 90, medium: 60, low: 30 };
    const tierMap     = { CALL: 'A', EMAIL: 'B' };
    const freqMap     = { A: 14, B: 30, C: 60 };

    let synced = 0;
    const errors = [];

    for (const r of records) {
      if (!r.source_record_id) {
        errors.push({ source_record_id: null, error: 'missing source_record_id' });
        continue;
      }
      const safeDate = (val) => {
        if (!val) return null;
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
      };
      const vcsTier = r.vcs_tier ? String(r.vcs_tier).toUpperCase() : null;
      const tier    = tierMap[vcsTier] || 'C';
      const mapped = {
        profile_name:        profileName,
        source_system:       'VCS',
        source_record_id:    String(r.source_record_id),
        name:                r.contact_name || r.company_name || null,
        company:             r.company_name || null,
        email:               r.contact_email || null,
        phone:               r.contact_phone || null,
        notes:               r.context_notes || null,
        last_contact:        safeDate(r.last_contact_date),
        contract_expiry:     safeDate(r.renewal_or_contract_date),
        relationship_status: r.relationship_status || 'Active',
        priority_score:      priorityMap[String(r.priority || '').toLowerCase()] ?? 50,
        tags:                Array.isArray(r.tags) ? r.tags : [],
        tier,
        frequency:           freqMap[tier]
      };

      try {
        const { data: existing } = await supabase
          .from('contacts')
          .select('id')
          .eq('user_id', userId)
          .eq('source_system', 'VCS')
          .eq('source_record_id', String(r.source_record_id))
          .maybeSingle();

        if (existing) {
          const { error } = await supabase.from('contacts').update(mapped).eq('id', existing.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from('contacts').insert({ ...mapped, user_id: userId });
          if (error) throw error;
        }
        synced++;
      } catch (e) {
        errors.push({ source_record_id: r.source_record_id, error: e.message });
      }
    }

    return res.status(200).json({ success: true, synced, errors });
  }

  // ── VCS WRITEBACK (POST {action:'vcs_writeback'}) ────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'vcs_writeback') {
    const VCS_URL = 'https://script.google.com/macros/s/AKfycbzjSZX_QmdQ9voaWbOOSYpAE39y9S7SwNstCPJTjjKrcZyzA7fS1jQR6ORryQoAuVxJ/exec';
    const VCS_KEY = '63a1448f-9f89-4565-83b2-1509abe74064-6bfb6be9-3de9-47c4-b072-c96d7b203f9a';

    const { records = [] } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required and must not be empty' });
    }

    try {
      const r = await fetch(VCS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'renzoWriteUpdate', renzoKey: VCS_KEY, records })
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : 502).json(data);
    } catch (e) {
      return res.status(502).json({ error: `VCS writeback failed: ${e.message}` });
    }
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
    const { id, deleteAll } = req.body || {};
    if (deleteAll) {
      const { error } = await supabase
        .from('contacts').delete().eq('user_id', userId).eq('profile_name', profileName);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, deleted: 'all' });
    }
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase
      .from('contacts').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleSfOAuthCallback(req, res) {
  const { code, state: userId } = req.query;
  if (!code) return res.status(400).send('No authorization code received from Salesforce');
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=salesforce_oauth_callback';
  try {
    const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return res.status(400).send('Salesforce auth failed: ' + (tokens.error_description || tokens.error || 'Unknown error'));
    }
    await supabase.from('integrations').upsert({ user_id: userId, provider: 'salesforce', access_token: tokens.access_token, refresh_token: tokens.refresh_token || null, instance_url: tokens.instance_url, connected: true, connected_at: new Date().toISOString() }, { onConflict: 'user_id,provider' });
    return res.redirect('https://www.meetrenzo.com/app?sf_connected=1');
  } catch(e) {
    return res.status(500).send('OAuth error: ' + e.message);
  }
}

async function handleMsOAuthCallback(req, res) {
  const { code, state: userId, error: oauthError, error_description } = req.query;
  if (oauthError) return res.status(400).send('Microsoft auth failed: ' + (error_description || oauthError));
  if (!code) return res.status(400).send('No authorization code received from Microsoft');
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=microsoft_oauth_callback';
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        scope: 'Contacts.Read offline_access'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return res.status(400).send('Microsoft auth failed: ' + (tokens.error_description || tokens.error || 'Unknown error'));
    }
    await supabase.from('integrations').upsert({
      user_id: userId,
      provider: 'microsoft',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      instance_url: null,
      connected: true,
      connected_at: new Date().toISOString()
    }, { onConflict: 'user_id,provider' });
    return res.redirect('https://www.meetrenzo.com/app?ms_connected=1');
  } catch(e) {
    return res.status(500).send('OAuth error: ' + e.message);
  }
}

async function handleQbOAuthCallback(req, res) {
  const { code, state: userId, realmId, error: oauthError } = req.query;
  if (oauthError) return res.status(400).send('QuickBooks auth failed: ' + oauthError);
  if (!code) return res.status(400).send('No authorization code received from QuickBooks');
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=quickbooks_oauth_callback';
  try {
    const creds = Buffer.from(clientId + ':' + clientSecret).toString('base64');
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + creds
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return res.status(400).send('QuickBooks auth failed: ' + (tokens.error_description || tokens.error || 'Unknown error'));
    }
    await supabase.from('integrations').upsert({
      user_id: userId,
      provider: 'quickbooks',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      instance_url: realmId || null,
      connected: true,
      connected_at: new Date().toISOString()
    }, { onConflict: 'user_id,provider' });
    return res.redirect('https://www.meetrenzo.com/app?qb_connected=1');
  } catch(e) {
    return res.status(500).send('OAuth error: ' + e.message);
  }
}
