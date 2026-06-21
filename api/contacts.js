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

const sanitize = s => typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : s;

function csrfOk(req) {
  const origin = req.headers.origin || '';
  const apiKey = req.headers['x-api-key'];
  if (!apiKey && origin && !origin.includes('meetrenzo.com') && !origin.includes('localhost')) return false;
  return true;
}

export default async function handler(req, res) {
  try {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST' && !csrfOk(req)) return res.status(403).json({ error: 'Forbidden' });

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
    const authUrl = `https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=api+refresh_token&state=${encodeURIComponent(state)}&prompt=login&display=popup`;
    return res.redirect(authUrl);
  }
  if (req.method === 'GET' && req.query.action === 'salesforce_oauth_callback') {
    return handleSfOAuthCallback(req, res);
  }

  // ── OUTLOOK OAUTH (public — no JWT needed) ───────────────────────────────
  if (req.method === 'GET' && req.query.action === 'outlook_oauth_start') {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const redirectUri = 'https://www.meetrenzo.com/api/microsoft_callback';
    const state = req.query.userId || '';
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=Contacts.Read+People.Read+Mail.Read+offline_access&state=${encodeURIComponent(state)}&prompt=select_account`;
    return res.redirect(authUrl);
  }
  if (req.method === 'GET' && req.url && req.url.includes('/api/microsoft_callback')) {
    const { code, state: userId, error: msError, error_description } = req.query;
    if (msError) return res.redirect('https://www.meetrenzo.com/app?outlook_error=1&msg=' + encodeURIComponent(error_description || msError));
    if (!code || !userId) return res.redirect('https://www.meetrenzo.com/app?outlook_error=1&msg=missing_params');
    try {
      const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: process.env.MICROSOFT_CLIENT_ID, client_secret: process.env.MICROSOFT_CLIENT_SECRET, redirect_uri: 'https://www.meetrenzo.com/api/microsoft_callback' })
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) return res.redirect('https://www.meetrenzo.com/app?outlook_error=1&msg=' + encodeURIComponent(tokens.error_description || 'token_failed'));
      const record = { access_token: tokens.access_token, refresh_token: tokens.refresh_token || null, connected: true, connected_at: new Date().toISOString(), scope_version: 2 };
      const { data: existing } = await supabase.from('integrations').select('id').eq('user_id', userId).eq('provider', 'outlook').maybeSingle();
      if (existing) { await supabase.from('integrations').update(record).eq('id', existing.id); }
      else { await supabase.from('integrations').insert({ user_id: userId, provider: 'outlook', ...record }); }
      return res.redirect('https://www.meetrenzo.com/app?outlook_connected=1');
    } catch (e) {
      return res.redirect('https://www.meetrenzo.com/app?outlook_error=1&msg=' + encodeURIComponent(e.message));
    }
  }

  // ── QUICKBOOKS OAUTH (public — no JWT needed) ────────────────────────────
  if (req.method === 'GET' && req.query.action === 'quickbooks_oauth_start') {
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const redirectUri = 'https://www.meetrenzo.com/api/quickbooks_callback';
    const state = req.query.userId || '';
    const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
    return res.redirect(authUrl);
  }
  if (req.method === 'GET' && req.url && req.url.includes('/api/quickbooks_callback')) {
    const { code, state: userId, realmId, error: qbError } = req.query;
    if (qbError) return res.redirect('https://www.meetrenzo.com/app?quickbooks_error=1&msg=' + encodeURIComponent(qbError));
    if (!code || !userId) return res.redirect('https://www.meetrenzo.com/app?quickbooks_error=1&msg=missing_params');
    try {
      const creds = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
      const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://www.meetrenzo.com/api/quickbooks_callback' })
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) return res.redirect('https://www.meetrenzo.com/app?quickbooks_error=1&msg=' + encodeURIComponent(tokens.error || 'token_failed'));
      const record = { access_token: tokens.access_token, refresh_token: tokens.refresh_token || null, instance_url: realmId || null, connected: true, connected_at: new Date().toISOString() };
      const { data: existing } = await supabase.from('integrations').select('id').eq('user_id', userId).eq('provider', 'quickbooks').maybeSingle();
      if (existing) { await supabase.from('integrations').update(record).eq('id', existing.id); }
      else { await supabase.from('integrations').insert({ user_id: userId, provider: 'quickbooks', ...record }); }
      return res.redirect('https://www.meetrenzo.com/app?quickbooks_connected=1');
    } catch (e) {
      return res.redirect('https://www.meetrenzo.com/app?quickbooks_error=1&msg=' + encodeURIComponent(e.message));
    }
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
    if (req.query.action === 'get_integrations') {
      const { data: ints } = await supabase.from('integrations').select('provider, connected, last_sync, instance_url, scope_version').eq('user_id', userId).eq('connected', true);
      return res.status(200).json(ints || []);
    }
    const limit = parseInt(req.query.limit, 10) || 500;
    const offset = parseInt(req.query.offset, 10) || 0;
    const { data, error } = await supabase
      .from('contacts').select('*')
      .eq('user_id', userId).eq('profile_name', profileName)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST' && req.body?.action === 'disconnect_integration') {
    const { provider, deleteContacts } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider required' });
    await supabase.from('integrations')
      .update({ connected: false, access_token: null, refresh_token: null, scope_version: null })
      .eq('user_id', userId).eq('provider', provider);
    if (deleteContacts) {
      const sourceSystem = provider.charAt(0).toUpperCase() + provider.slice(1);
      await supabase.from('contacts').delete().eq('user_id', userId).eq('source_system', sourceSystem);
    }
    return res.status(200).json({ success: true });
  }

  if (req.method === 'POST' && req.body?.action === 'salesforce_disconnect') {
    await supabase.from('integrations')
      .update({ connected: false, access_token: null, refresh_token: null })
      .eq('user_id', userId).eq('provider', 'salesforce');
    return res.status(200).json({ success: true });
  }

  if (req.method === 'POST' && req.body?.action === 'salesforce_connect_password') {
    const { username, password, securityToken } = req.body;
    if (!username || !password || !securityToken) return res.status(400).json({ error: 'username, password, and securityToken are required' });
    try {
      const params = new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.SALESFORCE_CLIENT_ID,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET,
        username,
        password: password + securityToken
      });
      const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return res.status(400).json({ error: tokenData.error_description || 'Salesforce authentication failed' });
      }
      const { error: upsertErr } = await supabase.from('integrations').upsert(
        { user_id: userId, provider: 'salesforce', access_token: tokenData.access_token,
          instance_url: tokenData.instance_url, connected: true, last_sync: new Date().toISOString() },
        { onConflict: 'user_id,provider' }
      );
      if (upsertErr) return res.status(500).json({ error: upsertErr.message });
      return res.status(200).json({ success: true, instance_url: tokenData.instance_url });
    } catch (e) {
      return res.status(502).json({ error: 'Salesforce token request failed: ' + e.message });
    }
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

  // ── CRM SYNC (POST {action:'crm_sync', provider:'hubspot', credentials:{api_key}}) ──
  if (req.method === 'POST' && req.body?.action === 'crm_sync') {
    const { provider, credentials = {} } = req.body;

    if (provider === 'hubspot') {
      const { api_key } = credentials;
      if (!api_key) return res.status(400).json({ error: 'HubSpot API key is required' });

      let allContacts = [];
      let after = null;
      const baseUrl = 'https://api.hubapi.com/crm/v3/objects/contacts';
      const props = 'firstname,lastname,email,phone,company,jobtitle,hs_lead_status,lastmodifieddate';

      try {
        do {
          const url = baseUrl + '?limit=100&properties=' + props + (after ? '&after=' + after : '');
          const hsRes = await fetch(url, { headers: { Authorization: 'Bearer ' + api_key } });
          if (!hsRes.ok) {
            const hsErr = await hsRes.json().catch(() => ({}));
            return res.status(400).json({ error: 'HubSpot API error: ' + (hsErr.message || hsRes.status) });
          }
          const hsData = await hsRes.json();
          allContacts = allContacts.concat(hsData.results || []);
          after = hsData.paging?.next?.after || null;
        } while (after);
      } catch (e) {
        return res.status(502).json({ error: 'HubSpot fetch failed: ' + e.message });
      }

      let synced = 0;
      const errors = [];
      for (const c of allContacts) {
        const props = c.properties || {};
        const name = [props.firstname, props.lastname].filter(Boolean).join(' ') || props.email || 'Unknown';
        const company = props.company || props.associatedcompanyid || 'Unknown';
        const mapped = {
          profile_name:        profileName,
          source_system:       'HubSpot',
          source_record_id:    'hs:' + c.id,
          name,
          company,
          email:               props.email || null,
          phone:               props.phone || null,
          notes:               props.jobtitle || null,
          relationship_status: 'Active',
          updated_at:          new Date().toISOString()
        };
        try {
          const { data: existing, error: selErr } = await supabase.from('contacts').select('id')
            .eq('user_id', userId).eq('source_system', 'HubSpot').eq('source_record_id', `hs:${c.id}`).maybeSingle();
          if (selErr) { console.error('[hs-sync] select error:', selErr.message, selErr.details); throw selErr; }
          if (existing) {
            const { error } = await supabase.from('contacts').update(mapped).eq('id', existing.id);
            if (error) { console.error('[hs-sync] update error:', error.message, error.details); throw error; }
          } else {
            const { error } = await supabase.from('contacts').insert({ ...mapped, user_id: userId, profile_name: profileName });
            if (error) { console.error('[hs-sync] insert error:', error.message, error.details); throw error; }
          }
          synced++;
        } catch (e) {
          errors.push({ id: c.id, error: e.message, details: e.details || null });
        }
      }
      await supabase.from('integrations').upsert(
        { user_id: userId, provider: 'hubspot', access_token: api_key, connected: true, last_sync: new Date().toISOString() },
        { onConflict: 'user_id,provider' }
      );
      return res.status(200).json({ success: true, synced, errors });
    }

    return res.status(400).json({ error: 'Unsupported provider: ' + provider });
  }

  if (req.method === 'POST' && !req.body?.action) {
    const { name: rawName, company: rawCompany, title, email, phone, tier, frequency, last_contact,
            contract_expiry, invoice_amount, annual_spend, location, account_size,
            products, history, notes, do_not_contact, tags } = req.body || {};
    const name = sanitize(rawName); const company = sanitize(rawCompany);
    if (!name || !company) return res.status(400).json({ error: 'name and company are required' });
    const { data, error } = await supabase
      .from('contacts')
      .insert({ user_id: userId, profile_name: profileName, name, company,
                title: sanitize(title), email: sanitize(email), phone: sanitize(phone),
                tier, frequency, last_contact, contract_expiry, invoice_amount,
                annual_spend, location: sanitize(location), account_size,
                products: sanitize(products), history: sanitize(history), notes: sanitize(notes),
                do_not_contact, tags: sanitize(tags) || null })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'PUT') {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    delete fields.user_id; delete fields.profile_name; delete fields.created_at;
    ['name','company','title','email','phone','notes','location','products','history','tags'].forEach(k=>{
      if(k in fields) fields[k]=sanitize(fields[k]);
    });
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

  // ── OUTLOOK SYNC (multi-pass) ───────────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'outlook_sync') {
    const opts = req.body.sync_options || { address_book: true, people: true, sent_mail: true, calendar: true };
    const { data: intData } = await supabase.from('integrations').select('*').eq('user_id', userId).eq('provider', 'outlook').maybeSingle();
    if (!intData?.access_token) return res.status(400).json({ error: 'Outlook not connected' });

    let accessToken = intData.access_token;
    const refreshToken = intData.refresh_token;

    const doTokenRefresh = async () => {
      if (!refreshToken) return false;
      try {
        const tr = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: process.env.MICROSOFT_CLIENT_ID, client_secret: process.env.MICROSOFT_CLIENT_SECRET, scope: 'Contacts.Read People.Read Mail.Read offline_access' })
        });
        const td = await tr.json();
        if (!td.access_token) return false;
        accessToken = td.access_token;
        await supabase.from('integrations').update({ access_token: td.access_token, refresh_token: td.refresh_token || refreshToken }).eq('user_id', userId).eq('provider', 'outlook');
        return true;
      } catch { return false; }
    };

    const graphGet = async (url) => {
      let r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
      if (r.status === 401) { if (!await doTokenRefresh()) return null; r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } }); }
      if (!r.ok) return null;
      return r.json();
    };

    const raw = [];

    // Pass 1 — Address Book
    if (opts.address_book !== false) {
      const d = await graphGet('https://graph.microsoft.com/v1.0/me/contacts?$select=displayName,emailAddresses,companyName,jobTitle,mobilePhone,businessPhones&$top=999');
      for (const c of (d?.value || [])) {
        const email = (c.emailAddresses || [])[0]?.address?.toLowerCase() || null;
        raw.push({ email, name: c.displayName || null, company: c.companyName || null, phone: c.mobilePhone || (c.businessPhones || [])[0] || null, msId: c.id });
      }
    }

    // Pass 2 — People
    if (opts.people !== false) {
      const d = await graphGet("https://graph.microsoft.com/v1.0/me/people?$select=displayName,emailAddresses,companyName,jobTitle,phones&$top=1000&$filter=personType/class eq 'Person'");
      for (const c of (d?.value || [])) {
        const email = (c.emailAddresses || [])[0]?.address?.toLowerCase() || null;
        raw.push({ email, name: c.displayName || null, company: c.companyName || null, phone: (c.phones || [])[0]?.number || null, msId: c.id || null });
      }
    }

    // Pass 3 — Sent Mail Recipients
    if (opts.sent_mail !== false) {
      const d = await graphGet('https://graph.microsoft.com/v1.0/me/mailFolders/sentItems/messages?$select=toRecipients,ccRecipients&$top=500&$filter=sentDateTime ge 2023-01-01T00:00:00Z');
      const seenEmails = new Set(raw.map(r => r.email).filter(Boolean));
      for (const msg of (d?.value || [])) {
        for (const recip of [...(msg.toRecipients || []), ...(msg.ccRecipients || [])]) {
          const email = recip.emailAddress?.address?.toLowerCase();
          if (email && !seenEmails.has(email)) {
            seenEmails.add(email);
            raw.push({ email, name: recip.emailAddress?.name || null, company: null, phone: null, msId: null });
          }
        }
      }
    }

    // Pass 4 — Calendar Attendees
    if (opts.calendar !== false) {
      const d = await graphGet("https://graph.microsoft.com/v1.0/me/events?$select=attendees&$top=500&$filter=start/dateTime ge '2023-01-01T00:00:00'");
      const seenEmails = new Set(raw.map(r => r.email).filter(Boolean));
      for (const evt of (d?.value || [])) {
        for (const att of (evt.attendees || [])) {
          const email = att.emailAddress?.address?.toLowerCase();
          if (email && !seenEmails.has(email)) {
            seenEmails.add(email);
            raw.push({ email, name: att.emailAddress?.name || null, company: null, phone: null, msId: null });
          }
        }
      }
    }

    // Deduplicate by email, merging fields preferring richer records
    const emailMap = new Map();
    for (const c of raw) {
      const key = c.email || null;
      if (!key) { if (c.msId) emailMap.set('msid:' + c.msId, c); continue; }
      if (!emailMap.has(key)) {
        emailMap.set(key, c);
      } else {
        const prev = emailMap.get(key);
        const score = r => (r.name ? 1 : 0) + (r.company ? 1 : 0) + (r.phone ? 1 : 0);
        emailMap.set(key, score(c) > score(prev)
          ? { ...c, msId: prev.msId || c.msId }
          : { ...prev, name: prev.name || c.name, company: prev.company || c.company, phone: prev.phone || c.phone });
      }
    }
    const deduped = Array.from(emailMap.values());

    let synced = 0; const errors = [];
    for (const c of deduped) {
      const uniqueKey = c.email || ('msid:' + c.msId);
      const sourceRecordId = 'outlook:' + uniqueKey;
      const mapped = { user_id: userId, profile_name: profileName, source_system: 'Outlook', source_record_id: sourceRecordId, name: c.name || null, company: c.company || null, email: c.email || null, phone: c.phone || null, relationship_status: 'Active', entity_type: 'vendor', tags: [] };
      try {
        const { data: existing } = await supabase.from('contacts').select('id').eq('user_id', userId).eq('source_system', 'Outlook').eq('source_record_id', sourceRecordId).maybeSingle();
        if (existing) {
          const { error: ue } = await supabase.from('contacts').update(mapped).eq('id', existing.id);
          if (ue) { errors.push({ key: uniqueKey, error: 'update: ' + ue.message }); continue; }
        } else {
          const { error: ie } = await supabase.from('contacts').insert(mapped);
          if (ie) { errors.push({ key: uniqueKey, error: 'insert: ' + ie.message }); continue; }
        }
        synced++;
      } catch (e) { errors.push({ key: uniqueKey, error: 'exception: ' + e.message }); }
    }
    await supabase.from('integrations').update({ last_sync: new Date().toISOString() }).eq('user_id', userId).eq('provider', 'outlook');
    return res.status(200).json({ success: true, synced, errors, total: deduped.length });
  }

  // ── QUICKBOOKS SYNC ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'quickbooks_sync') {
    const { data: intData } = await supabase.from('integrations').select('*').eq('user_id', userId).eq('provider', 'quickbooks').maybeSingle();
    if (!intData?.access_token) return res.status(400).json({ error: 'QuickBooks not connected' });
    const realmId = intData.instance_url;
    if (!realmId) return res.status(400).json({ error: 'QuickBooks realm ID missing' });
    const qbRes = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=SELECT+*+FROM+Customer+WHERE+Active+%3D+true+MAXRESULTS+100`, { headers: { Authorization: 'Bearer ' + intData.access_token, Accept: 'application/json' } });
    if (!qbRes.ok) return res.status(502).json({ error: 'QuickBooks API request failed' });
    const qbData = await qbRes.json();
    const customers = (qbData?.QueryResponse?.Customer || []);
    let synced = 0; const errors = [];
    for (const c of customers) {
      const email = c.PrimaryEmailAddr?.Address || null;
      const phone = c.PrimaryPhone?.FreeFormNumber || null;
      const mapped = { user_id: userId, profile_name: profileName, source_system: 'QuickBooks', source_record_id: 'qb:' + c.Id, name: c.DisplayName || c.CompanyName || null, company: c.CompanyName || null, email, phone, relationship_status: 'Active', entity_type: 'vendor', tags: [] };
      try {
        const { data: existing } = await supabase.from('contacts').select('id').eq('user_id', userId).eq('source_system', 'QuickBooks').eq('source_record_id', 'qb:' + c.Id).maybeSingle();
        if (existing) { await supabase.from('contacts').update(mapped).eq('id', existing.id); }
        else { await supabase.from('contacts').insert(mapped); }
        synced++;
      } catch (e) { errors.push({ id: c.Id, error: e.message }); }
    }
    await supabase.from('integrations').update({ last_sync: new Date().toISOString() }).eq('user_id', userId).eq('provider', 'quickbooks');
    return res.status(200).json({ success: true, synced, errors });
  }

  return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    supabase.from('error_logs').insert({ endpoint: req.url, error: e.message, created_at: new Date().toISOString() }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleSfOAuthCallback(req, res) {
  const { code, state: userId, error: sfError, error_description } = req.query;
  if (sfError) {
    console.error('[sf-callback] Salesforce error:', sfError, error_description);
    return res.redirect('https://www.meetrenzo.com/app?sf_error=1&msg=' + encodeURIComponent(error_description || sfError));
  }
  if (!code) {
    console.error('[sf-callback] No code received');
    return res.redirect('https://www.meetrenzo.com/app?sf_error=1&msg=no_code');
  }
  if (!userId) {
    console.error('[sf-callback] No userId in state');
    return res.redirect('https://www.meetrenzo.com/app?sf_error=1&msg=no_user');
  }

  const clientId     = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  const redirectUri  = 'https://www.meetrenzo.com/api/contacts?action=salesforce_oauth_callback';

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      console.error('[sf-callback] Token exchange failed:', tokens);
      return res.redirect('https://www.meetrenzo.com/app?sf_error=1&msg=' + encodeURIComponent(tokens.error_description || tokens.error || 'token_exchange_failed'));
    }

    const record = {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      instance_url:  tokens.instance_url,
      connected:     true,
      connected_at:  new Date().toISOString()
    };

    // Check-then-insert/update to avoid partial unique index issues with upsert
    const { data: existing, error: selErr } = await supabase
      .from('integrations')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', 'salesforce')
      .maybeSingle();

    if (selErr) console.error('[sf-callback] select error:', selErr);

    if (existing) {
      const { error: updErr } = await supabase.from('integrations').update(record).eq('id', existing.id);
      if (updErr) console.error('[sf-callback] update error:', updErr);
    } else {
      const { error: insErr } = await supabase.from('integrations').insert({ user_id: userId, provider: 'salesforce', ...record });
      if (insErr) console.error('[sf-callback] insert error:', insErr);
    }

    return res.redirect('https://www.meetrenzo.com/app?sf_connected=1');
  } catch (e) {
    console.error('[sf-callback] unexpected error:', e.message);
    return res.redirect('https://www.meetrenzo.com/app?sf_error=1&msg=' + encodeURIComponent(e.message));
  }
}
