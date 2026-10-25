// POST /api/register  { token, campaign }
// Header: x-opens-key must match OPENS_KEY env var.
// Stores a private mapping blob: mappings/<token>.json with campaign only.
// NEVER store recipient email addresses here. Campaign is a company name
// only, which is what the dashboard shows. The email -> token map stays
// in the sender's private workspace.
import { put } from '@vercel/blob';
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const key = req.headers['x-opens-key'];
  if (!process.env.OPENS_KEY || key !== process.env.OPENS_KEY) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const token = String((body && body.token) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  const campaign = String((body && body.campaign) || '').slice(0, 200);
  if (!token || !campaign) {
    res.status(400).json({ ok: false, error: 'token and campaign required' });
    return;
  }
  await put(`mappings/${token}.json`, JSON.stringify({ token, campaign, registered_at: new Date().toISOString() }), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  res.status(200).json({ ok: true });
}
