import jwt from 'jsonwebtoken';

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
