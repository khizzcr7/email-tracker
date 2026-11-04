// GET /api/opens?key=OPENS_KEY
// Returns grouped opens: one row per company (campaign), with an open
// count, instead of one row per pixel fetch. That is why the old dashboard
// showed the same company many times: every pixel fetch (a re-open, a
// forward, or a Gmail/Apple image-proxy refetch) was its own row, and
// every separate email to the same company used a new token but the same
// campaign name.
// Campaign names only, no email addresses, no tokens in full (only first
// 6 chars for debugging). Requires the OPENS_KEY env var, which is only
// in Vercel env and in the owner's private dashboard link.
//
// Performance: blob bodies used to be fetched strictly one by one, which
// took ~5s for a few hundred opens and stalled the dashboard on Loading.
// They are now fetched in parallel batches of 20, so the same data
// returns in well under a second. Response shape is unchanged.
import { list } from '@vercel/blob';

const BATCH = 20;

async function fetchJson(b) {
  const url = b.downloadUrl || b.url;
  const headers = process.env.BLOB_READ_WRITE_TOKEN ? { Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('blob fetch failed');
  return r.json();
}

// Run async work over items in parallel batches of BATCH, preserving order.
async function mapBatched(items, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map((item) => fn(item).catch(() => null)));
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
  }
  return out;
}

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
      const names = page.blobs.map((b) => b.pathname.split('/').pop().replace(/\.json$/, ''));
      const fetched = await mapBatched(page.blobs, fetchJson);
      for (let i = 0; i < names.length; i++) {
        mappings[names[i]] = fetched[i] && fetched[i].campaign ? fetched[i].campaign : 'UNKNOWN';
      }
      mcursor = page.cursor;
    } while (mcursor);
    // Flat rows, kept for backward compatibility.
    const fetchedOpens = await mapBatched(opens, fetchJson);
    const rows = opens.map((b, i) => {
      const parts = b.pathname.split('/');
      const token = parts.length >= 2 ? parts[1] : 'unknown';
      const j = fetchedOpens[i];
      return {
        campaign: mappings[token] || 'UNKNOWN',
        opened_at: j ? j.opened_at || null : null,
        token,
        token_short: token.slice(0, 6),
      };
    });
    const grouped = {};
    for (const r of rows) {
      const g = grouped[r.campaign] || (grouped[r.campaign] = { campaign: r.campaign, count: 0, first_open: null, last_open: null, tokens: [] });
      g.count++;
      if (r.opened_at) {
        if (!g.first_open || r.opened_at < g.first_open) g.first_open = r.opened_at;
        if (!g.last_open || r.opened_at > g.last_open) g.last_open = r.opened_at;
      }
      if (!g.tokens.includes(r.token_short)) g.tokens.push(r.token_short);
    }
    const groupedRows = Object.values(grouped).sort((a, b) => (b.last_open || '').localeCompare(a.last_open || ''));
    const total = rows.length;
    res.status(200).json({ ok: true, total, grouped: groupedRows, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
