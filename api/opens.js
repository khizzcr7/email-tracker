// GET /api/opens?key=OPENS_KEY
// Returns opens with campaign names only, no email addresses, no tokens
// in full (only first 6 chars for debugging). Requires the OPENS_KEY env
// var, which is only in Vercel env and in the owner's private dashboard link.
import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (!process.env.OPENS_KEY || req.query.key !== process.env.OPENS_KEY) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  try {
    const opens = [];
    let cursor;
    do {
      const page = await list({ prefix: 'opens/', cursor, limit: 1000 });
      opens.push(...page.blobs);
      cursor = page.cursor;
    } while (cursor);
    const mappings = {};
    let mcursor;
    do {
      const page = await list({ prefix: 'mappings/', cursor: mcursor, limit: 1000 });
      for (const b of page.blobs) {
        const name = b.pathname.split('/').pop().replace(/\.json$/, '');
        try {
          const r = await fetch(b.url);
          const j = await r.json();
          mappings[name] = j.campaign || 'UNKNOWN';
        } catch { mappings[name] = 'UNKNOWN'; }
      }
      mcursor = page.cursor;
    } while (mcursor);
    const rows = [];
    for (const b of opens) {
      const parts = b.pathname.split('/');
      const token = parts.length >= 2 ? parts[1] : 'unknown';
      let opened_at = null;
      try {
        const r = await fetch(b.url);
        const j = await r.json();
        opened_at = j.opened_at || null;
      } catch { /* keep null */ }
      rows.push({
        campaign: mappings[token] || 'UNKNOWN',
        opened_at,
        token_short: token.slice(0, 6),
      });
    }
    rows.sort((a, b) => String(b.opened_at || '').localeCompare(String(a.opened_at || '')));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, count: rows.length, opens: rows });
  } catch (err) {
    console.error('opens list failed', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: 'could not list opens' });
  }
}
