import jwt from 'jsonwebtoken';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) return res.status(200).json({ valid: false });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return res.status(200).json({
      valid: true,
      userId: payload.userId,
      email: payload.email,
      name: payload.name
    });
  } catch {
    return res.status(200).json({ valid: false });
  }
}
