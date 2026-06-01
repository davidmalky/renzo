import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import supabase from './_supabase.js';

export async function validateRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) throw { status: 401, error: 'Unauthorized' };
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const profileName = req.headers['x-profile'] || 'default';
    return { userId: payload.userId, profileName };
  } catch {
    throw { status: 401, error: 'Unauthorized' };
  }
}

/**
 * Resolves identity from either a JWT or an API key (Bearer header).
 * Returns { userId, profileName } or null if neither validates.
 * Updates last_used_at on successful API key auth.
 */
export async function resolveAuth(req) {
  // Try JWT first
  try { return await validateRequest(req); } catch {}
  // Fall back to API key hash lookup
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const hash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex');
  console.error('[resolveAuth] computed hash:', hash);
  const { data } = await supabase
    .from('api_keys').select('user_id').eq('key_hash', hash).maybeSingle();
  console.error('[resolveAuth] supabase result:', JSON.stringify(data), 'error not shown');
  if (!data) return null;
  await supabase.from('api_keys')
    .update({ last_used_at: new Date().toISOString() }).eq('key_hash', hash);
  const profileName = req.headers['x-profile'] || 'default';
  return { userId: data.user_id, profileName };
}
