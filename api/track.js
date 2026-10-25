// GET /api/track?t=<token>
// Returns a 1x1 transparent GIF and logs the fetch to Vercel Blob.
// The token is an opaque hash made when the email is drafted; it is NOT
// the recipient's email address. The token -> recipient mapping lives only
// in Chotu's private workspace, never in this repo.
import { put } from '@vercel/blob';

const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export default async function handler(req, res) {
  const token = String(req.query.t || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  // Always return the pixel, even for a bad token, so a broken link never
  // shows up as a broken image in the email.
  const sendPixel = () => {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Length', GIF_1X1.length);
    res.status(200).send(GIF_1X1);
  };
  if (!token) {
    sendPixel();
    return;
  }
  try {
    const record = {
      token,
      opened_at: new Date().toISOString(),
      user_agent: req.headers['user-agent'] || null,
      // Note: for Gmail this is usually Google's image-proxy IP, not the
      // recipient's own IP. Do not treat it as the recipient's location.
      forwarded_for: req.headers['x-forwarded-for'] || null,
      referer: req.headers['referer'] || null,
    };
    const key = `opens/${token}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    await put(key, JSON.stringify(record, null, 2), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
    });
  } catch (err) {
    // Logging must never break the pixel itself.
    console.error('tracker log failed', err && err.message ? err.message : err);
  }
  sendPixel();
}
