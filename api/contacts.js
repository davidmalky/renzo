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

  // ── SALESFORCE OAUTH CALLBACK — public, called by Salesforce redirect ─────
  if (req.method === 'GET' && req.query?.action === 'salesforce_oauth_callback') {
    return handleSfOAuthCallback(req, res);
  }

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
    const action = req.query?.action;
    if (action === 'salesforce_oauth_start') return handleSfOAuthStart(req, res, userId);
    if (action === 'salesforce_status')      return handleSfStatus(req, res, userId);
    // Default: fetch contacts
    const { data, error } = await supabase
      .from('contacts').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
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

  // ── SALESFORCE OAUTH SYNC (POST {action:'salesforce_sync'}) ────────────────
  if (req.method === 'POST' && req.body?.action === 'salesforce_sync') {
    return handleSfSync(req, res, userId, profileName);
  }

  // ── CRM SYNC (POST {action:'crm_sync'}) ─────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'crm_sync') {
    return handleCrmSync(req, res, supabase, userId, profileName);
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

// ── SALESFORCE OAUTH HANDLERS ─────────────────────────────────────────────────

async function handleSfOAuthStart(req, res, userId) {
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Salesforce client ID not configured' });
  const redirectUri = 'https://www.meetrenzo.com/api/contacts?action=salesforce_oauth_callback';
  const authUrl = 'https://login.salesforce.com/services/oauth2/authorize'
    + `?response_type=code`
    + `&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent('api refresh_token')}`
    + `&state=${encodeURIComponent(userId)}`;
  return res.redirect(authUrl);
}

async function handleSfOAuthCallback(req, res) {
  const { code, state: userId, error: sfError, error_description } = req.query;
  if (sfError) return res.status(400).send(`Salesforce auth error: ${error_description || sfError}`);
  if (!code)   return res.status(400).send('No authorization code received');

  const clientId     = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  const redirectUri  = 'https://www.meetrenzo.com/api/contacts?action=salesforce_oauth_callback';

  try {
    const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return res.status(400).send(`Salesforce auth failed: ${tokens.error_description || tokens.error || 'Unknown error'}`);
    }

    await supabase.from('integrations').upsert({
      user_id:       userId,
      provider:      'salesforce',
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      instance_url:  tokens.instance_url,
      connected:     true,
      connected_at:  new Date().toISOString()
    }, { onConflict: 'user_id,provider' });

    return res.redirect('https://www.meetrenzo.com/app?sf_connected=1');
  } catch (e) {
    return res.status(500).send(`OAuth callback error: ${e.message}`);
  }
}

async function handleSfStatus(req, res, userId) {
  const { data } = await supabase.from('integrations')
    .select('connected, connected_at')
    .eq('user_id', userId).eq('provider', 'salesforce').maybeSingle();
  return res.status(200).json({ connected: !!(data?.connected) });
}

async function handleSfSync(req, res, userId, profileName) {
  const { data: integration } = await supabase.from('integrations')
    .select('*').eq('user_id', userId).eq('provider', 'salesforce').single();
  if (!integration?.access_token) {
    return res.status(400).json({ error: 'Salesforce not connected. Please connect first.' });
  }

  const query = encodeURIComponent('SELECT Id,Name,Email,Phone,Account.Name,LastModifiedDate FROM Contact ORDER BY LastModifiedDate DESC LIMIT 500');
  const sfRes = await fetch(`${integration.instance_url}/services/data/v57.0/query?q=${query}`, {
    headers: { 'Authorization': `Bearer ${integration.access_token}`, 'Content-Type': 'application/json' }
  });

  if (sfRes.status === 401) {
    await supabase.from('integrations').update({ connected: false })
      .eq('user_id', userId).eq('provider', 'salesforce');
    return res.status(401).json({ error: 'Salesforce session expired. Please reconnect.' });
  }

  const sfData = await sfRes.json();
  if (!sfRes.ok) return res.status(400).json({ error: sfData[0]?.message || 'Salesforce sync failed' });

  const records = sfData.records || [];
  let synced = 0;
  const errors = [];

  for (const r of records) {
    try {
      const mapped = {
        profile_name:     profileName,
        name:             r.Name || 'Unknown',
        email:            r.Email || null,
        phone:            r.Phone || null,
        company:          r.Account?.Name || null,
        source_system:    'Salesforce',
        source_record_id: `sf:${r.Id}`,
        updated_at:       new Date().toISOString()
      };
      const { data: existing } = await supabase.from('contacts').select('id')
        .eq('user_id', userId).eq('source_system', 'Salesforce')
        .eq('source_record_id', `sf:${r.Id}`).maybeSingle();
      if (existing) {
        await supabase.from('contacts').update(mapped).eq('id', existing.id);
      } else {
        await supabase.from('contacts').insert({ ...mapped, user_id: userId });
      }
      synced++;
    } catch (e) { errors.push({ id: r.Id, error: e.message }); }
  }

  // Update last sync time
  await supabase.from('integrations')
    .update({ connected_at: new Date().toISOString() })
    .eq('user_id', userId).eq('provider', 'salesforce');

  return res.status(200).json({ success: true, synced, errors });
}

// ── CRM SYNC HANDLER ─────────────────────────────────────────────────────────
async function handleCrmSync(req, res, supabase, userId, profileName) {
  const { provider, credentials } = req.body;

  if (provider === 'salesforce') {
    const { username, password, security_token } = credentials;
    const loginBody = `<?xml version="1.0" encoding="utf-8"?>
      <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
        <env:Body>
          <n1:login xmlns:n1="urn:partner.soap.sforce.com">
            <n1:username>${username}</n1:username>
            <n1:password>${password}${security_token}</n1:password>
          </n1:login>
        </env:Body>
      </env:Envelope>`;

    const loginRes = await fetch('https://login.salesforce.com/services/Soap/u/57.0', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'login' },
      body: loginBody
    });
    const loginXml = await loginRes.text();

    const sessionMatch = loginXml.match(/<sessionId>([^<]+)<\/sessionId>/);
    const serverMatch  = loginXml.match(/<serverUrl>([^<]+)<\/serverUrl>/);

    if (!sessionMatch) {
      const faultMatch = loginXml.match(/<faultstring>([^<]+)<\/faultstring>/);
      return res.status(400).json({ error: faultMatch ? faultMatch[1] : 'Salesforce login failed' });
    }

    const sessionId    = sessionMatch[1];
    const sfInstanceUrl = serverMatch[1].match(/^(https:\/\/[^\/]+)/)[1];

    const query = encodeURIComponent('SELECT Id,Name,Email,Phone,Account.Name,LastModifiedDate FROM Contact ORDER BY LastModifiedDate DESC LIMIT 500');
    const sfRes = await fetch(`${sfInstanceUrl}/services/data/v57.0/query?q=${query}`, {
      headers: { 'Authorization': `Bearer ${sessionId}`, 'Content-Type': 'application/json' }
    });
    const sfData = await sfRes.json();

    if (!sfRes.ok) return res.status(400).json({ error: sfData.message || 'Salesforce query failed' });

    const records = sfData.records || [];
    let synced = 0;
    const errors = [];

    for (const r of records) {
      try {
        const mapped = {
          profile_name:     profileName,
          name:             r.Name || 'Unknown',
          email:            r.Email || null,
          phone:            r.Phone || null,
          company:          r.Account?.Name || null,
          source_system:    'Salesforce',
          source_record_id: `sf:${r.Id}`,
          updated_at:       new Date().toISOString()
        };
        const { data: existing } = await supabase.from('contacts').select('id')
          .eq('user_id', userId).eq('source_system', 'Salesforce').eq('source_record_id', `sf:${r.Id}`).maybeSingle();
        if (existing) {
          await supabase.from('contacts').update(mapped).eq('id', existing.id);
        } else {
          await supabase.from('contacts').insert({ ...mapped, user_id: userId });
        }
        synced++;
      } catch (e) { errors.push({ id: r.Id, error: e.message }); }
    }
    return res.status(200).json({ success: true, synced, errors, provider: 'Salesforce' });
  }

  if (provider === 'hubspot') {
    const { api_key } = credentials;
    const hsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,phone,company', {
      headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' }
    });
    const hsData = await hsRes.json();

    if (!hsRes.ok) return res.status(400).json({ error: hsData.message || 'HubSpot API error — check your API key' });

    const records = hsData.results || [];
    let synced = 0;
    const errors = [];

    for (const r of records) {
      try {
        const props = r.properties || {};
        const mapped = {
          profile_name:     profileName,
          name:             [props.firstname, props.lastname].filter(Boolean).join(' ') || 'Unknown',
          email:            props.email || null,
          phone:            props.phone || null,
          company:          props.company || null,
          source_system:    'HubSpot',
          source_record_id: `hs:${r.id}`,
          updated_at:       new Date().toISOString()
        };
        const { data: existing } = await supabase.from('contacts').select('id')
          .eq('user_id', userId).eq('source_system', 'HubSpot').eq('source_record_id', `hs:${r.id}`).maybeSingle();
        if (existing) {
          await supabase.from('contacts').update(mapped).eq('id', existing.id);
        } else {
          await supabase.from('contacts').insert({ ...mapped, user_id: userId });
        }
        synced++;
      } catch (e) { errors.push({ id: r.id, error: e.message }); }
    }
    return res.status(200).json({ success: true, synced, errors, provider: 'HubSpot' });
  }

  return res.status(400).json({ error: 'Unknown provider' });
}
