// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Attrax provider — careers-site platform used by large enterprises (Experian
// and others). Added 2026-08-10 while closing SoCal coverage gaps.
//
// WHY HTML AND NOT JSON: Attrax boards render server-side. The marketing
// careers page (e.g. www.experian.com/careers) is a JS shell with no job data,
// which is why generic detection missed it, but the real board at
// jobs.<company>.com/jobs ships complete vacancy tiles in the HTML. There is no
// public JSON API; probing /api/jobs, /jobs/json and /Search/GetJobs all 404.
//
// Tile shape (stable across pages):
//   <div class="attrax-vacancy-tile …" data-jobid="5901">
//     <a class="attrax-vacancy-tile__title …" href="/job/{slug}-jid-{id}">Title</a>
//     <div class="attrax-vacancy-tile__location-freetext …">
//       <p class="…item-label">Location</p><p class="…item-value">Santiago, Chile</p>
//
// Pagination is `?page=N`, 1-based, 12 tiles per page.
//
// Detection cannot key on the hostname (boards live on branded domains like
// jobs.experian.com), so entries must set `provider: attrax` explicitly. The
// bundle URL `js--compiled--attraxbundle.js` is the platform's fingerprint if
// you need to identify a new one by hand.

const PAGE_SIZE = 12;
const MAX_PAGES = 60; // 720 postings; Experian's whole board is ~493
const INTER_PAGE_DELAY_MS = 150;

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  accept: 'text/html',
};

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve the board origin from an entry's careers_url / api. */
function resolveOrigin(entry) {
  const raw = String(entry.api || entry.careers_url || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return `https://${u.hostname}`;
}

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Parse one Attrax listing page. Exported for tests.
 * @returns {Array<{title:string,url:string,company:string,location:string}>}
 */
export function parseAttraxPage(html, origin, companyName) {
  const jobs = [];
  // Split on the tile boundary so a title and its location can't be paired
  // across two different vacancies.
  const tiles = String(html).split('attrax-vacancy-tile ').slice(1);
  for (const tile of tiles) {
    const a = tile.match(/class="[^"]*attrax-vacancy-tile__title[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)</i);
    if (!a) continue;
    const href = a[1];
    const title = decode(a[2]);
    if (!title) continue;

    // Location lives in the item-value <p> inside the location-freetext block.
    let location = '';
    const locBlock = tile.match(/attrax-vacancy-tile__location-freetext[\s\S]{0,400}?item-value[^>]*>([^<]*)</i);
    if (locBlock) location = decode(locBlock[1]);
    // Fallback: the slug encodes it as "…-in-{location}-jid-{id}".
    if (!location) {
      const m = href.match(/-in-([a-z0-9-]+)-jid-\d+/i);
      if (m) location = m[1].replace(/-/g, ' ');
    }

    jobs.push({
      title,
      url: href.startsWith('http') ? href : `${origin}${href}`,
      company: companyName,
      location,
      // Attrax tiles carry no posting date. Tracked-company scans don't need
      // one; the reverse sweep would drop these as undated, which is why this
      // provider is intended for portals.yml entries.
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'attrax',

  detect(entry) {
    // Branded hosts carry no "attrax" token, so never auto-claim: an entry must
    // opt in with `provider: attrax`.
    return null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`attrax: cannot derive board origin for ${entry.name}`);
    const maxPages = Number(entry.max_pages) > 0 ? Number(entry.max_pages) : MAX_PAGES;

    const all = [];
    const seen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const html = await ctx.fetchText(`${origin}/jobs?page=${page}`, { headers: HEADERS });
      const pageJobs = parseAttraxPage(html, origin, entry.name);
      if (!pageJobs.length) break;

      // Attrax serves the last real page again for an out-of-range `page`, so
      // stop when a page adds nothing new rather than looping to the cap.
      let added = 0;
      for (const j of pageJobs) {
        if (seen.has(j.url)) continue;
        seen.add(j.url);
        all.push(j);
        added++;
      }
      if (added === 0) break;
      if (pageJobs.length < PAGE_SIZE) break;
    }
    return all;
  },
};
