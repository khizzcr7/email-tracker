// GET /api/opens?key=OPENS_KEY
// Returns grouped opens: one row per company (campaign), with an open
// count, instead of one row per pixel fetch. That is why the old dashboard
// showed the same company many times: every pixel fetch (a re-open, a
// forward, or a Gmail/Apple image-proxy refetch) was its own row, and
// every separate email to the same company used a new token but the same
// campaign name.
// An "open" here means one session: fetches of the same token within
// SESSION_WINDOW_MS of the previous fetch count as a single open, because
// Gmail/Apple image proxies fetch the same pixel several times per human
// open. Raw fetch counts are kept alongside as raw_fetches, so nothing
// is hidden. Same window as api/track.js uses to skip duplicate writes.
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
        opened_at: j && j.opened_at ? j.opened_at : null,
        token,
        token_short: token.slice(0, 6),
      };
    });
    rows.sort((a, b) => String(b.opened_at || '').localeCompare(String(a.opened_at || '')));

    // Mark session starts: the first fetch per token, or a fetch more than
    // SESSION_WINDOW_MS after the previous fetch of the same token. The
    // rows array itself stays raw (every fetch visible); only the counts
    // below use sessions.
    const SESSION_WINDOW_MS = 30 * 60 * 1000;
    const lastFetchByToken = new Map();
    for (const r of [...rows].sort((a, b) => String(a.opened_at || '').localeCompare(String(b.opened_at || '')))) {
      const t = Date.parse(r.opened_at || '');
      const last = lastFetchByToken.get(r.token);
      r.is_session = !last || Number.isNaN(t) || t - last > SESSION_WINDOW_MS;
      if (!Number.isNaN(t)) lastFetchByToken.set(r.token, t);
    }
    const totalSessions = rows.filter((r) => r.is_session).length;

    // Group by company, then by tracked email (token) inside it.
    const byCompany = new Map();
    for (const r of rows) {
      if (!byCompany.has(r.campaign)) {
        byCompany.set(r.campaign, { campaign: r.campaign, opens: 0, raw_fetches: 0, tokens: new Map(), first_opened_at: null, last_opened_at: null });
      }
      const c = byCompany.get(r.campaign);
      if (r.is_session) c.opens += 1;
      c.raw_fetches += 1;
      const t = c.tokens.get(r.token);
      if (!t) c.tokens.set(r.token, { token_short: r.token_short, opens: 0, raw_fetches: 0, first_opened_at: null, last_opened_at: null });
      const t2 = c.tokens.get(r.token);
      if (r.is_session) t2.opens += 1;
      t2.raw_fetches += 1;
      if (r.opened_at) {
        if (!c.first_opened_at || r.opened_at < c.first_opened_at) c.first_opened_at = r.opened_at;
        if (!c.last_opened_at || r.opened_at > c.last_opened_at) c.last_opened_at = r.opened_at;
        if (!t2.first_opened_at || r.opened_at < t2.first_opened_at) t2.first_opened_at = r.opened_at;
        if (!t2.last_opened_at || r.opened_at > t2.last_opened_at) t2.last_opened_at = r.opened_at;
      }
    }
    const companies = [...byCompany.values()].map((c) => ({
      campaign: c.campaign,
      opens: c.opens,
      raw_fetches: c.raw_fetches,
      emails: c.tokens.size,
      first_opened_at: c.first_opened_at,
      last_opened_at: c.last_opened_at,
      tokens: [...c.tokens.values()].sort((a, b) => String(b.last_opened_at || '').localeCompare(String(a.last_opened_at || ''))),
    }));
    companies.sort((a, b) => String(b.last_opened_at || '').localeCompare(String(a.last_opened_at || '')));

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      count: rows.length,
      opens: rows,
      companies,
      summary: {
        total_opens: totalSessions,
        raw_fetches: rows.length,
        companies_opened: companies.length,
        emails_opened: new Set(rows.map((r) => r.token)).size,
        emails_tracked: Object.keys(mappings).length,
      },
    });
  } catch (err) {
    console.error('opens list failed', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: 'could not list opens' });
  }
}
