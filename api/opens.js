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
import { list } from '@vercel/blob';

async function fetchJson(b) {
  const url = b.downloadUrl || b.url;
  const headers = process.env.BLOB_READ_WRITE_TOKEN ? { Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('blob fetch failed');
  return r.json();
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
      for (const b of page.blobs) {
        const name = b.pathname.split('/').pop().replace(/\.json$/, '');
        try {
          const j = await fetchJson(b);
          mappings[name] = j.campaign || 'UNKNOWN';
        } catch { mappings[name] = 'UNKNOWN'; }
      }
      mcursor = page.cursor;
    } while (mcursor);

    // Flat rows, kept for backward compatibility.
    const rows = [];
    for (const b of opens) {
      const parts = b.pathname.split('/');
      const token = parts.length >= 2 ? parts[1] : 'unknown';
      let opened_at = null;
      try {
        const j = await fetchJson(b);
        opened_at = j.opened_at || null;
      } catch { /* keep null */ }
      rows.push({
        campaign: mappings[token] || 'UNKNOWN',
        opened_at,
        token,
        token_short: token.slice(0, 6),
      });
    }
    rows.sort((a, b) => String(b.opened_at || '').localeCompare(String(a.opened_at || '')));

    // Group by company, then by tracked email (token) inside it.
    const byCompany = new Map();
    for (const r of rows) {
      if (!byCompany.has(r.campaign)) {
        byCompany.set(r.campaign, { campaign: r.campaign, opens: 0, tokens: new Map(), first_opened_at: null, last_opened_at: null });
      }
      const c = byCompany.get(r.campaign);
      c.opens += 1;
      if (!c.tokens.has(r.token)) c.tokens.set(r.token, { token_short: r.token_short, opens: 0, first_opened_at: null, last_opened_at: null });
      const t = c.tokens.get(r.token);
      t.opens += 1;
      if (r.opened_at) {
        if (!c.first_opened_at || r.opened_at < c.first_opened_at) c.first_opened_at = r.opened_at;
        if (!c.last_opened_at || r.opened_at > c.last_opened_at) c.last_opened_at = r.opened_at;
        if (!t.first_opened_at || r.opened_at < t.first_opened_at) t.first_opened_at = r.opened_at;
        if (!t.last_opened_at || r.opened_at > t.last_opened_at) t.last_opened_at = r.opened_at;
      }
    }
    const companies = [...byCompany.values()].map((c) => ({
      campaign: c.campaign,
      opens: c.opens,
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
        total_opens: rows.length,
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
