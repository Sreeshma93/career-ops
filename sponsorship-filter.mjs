#!/usr/bin/env node
// sponsorship-filter.mjs — classify a posting's visa-sponsorship stance.
//
// WHY: config/profile.yml sets needs_sponsorship: true and modes/_profile.md
// makes an explicit "we do not sponsor" a HARD blocker. Those postings are
// invisible to scan.mjs, which filters on title and location only, so they
// reach the alert and cost a read every time. On 2026-08-07 they were 3 of the
// 5 most recent matches.
//
// Classification is deliberately asymmetric:
//   blocked  — an explicit refusal phrase is present. Only these are dropped.
//   positive — the employer states it sponsors. Surfaced as a plus.
//   silent   — no sponsorship language at all. ALWAYS PASSES.
//
// Silence is the common case and must never be treated as refusal: the same
// "don't penalize missing data" rule the location and date filters follow.

// Refusal phrases. Each is specific enough that a substring match is safe:
// "unable to sponsor" cannot be produced by "able to sponsor" plus context,
// because the negation is inside the matched span rather than adjacent to it.
const BLOCK_PATTERNS = [
  /\bunable to (?:provide |offer |take over )?(?:visa |employment |immigration )?sponsor/i,
  /\bnot able to (?:provide |offer )?(?:visa |employment )?sponsor/i,
  /\b(?:do|does|will|can) not (?:provide|offer|sponsor|support)\b[^.]{0,40}\bsponsor/i,
  /\bwill not sponsor\b/i,
  /\bcannot sponsor\b/i,
  /\bnot eligible for (?:employment |visa |immigration )*sponsor/i,
  /\bno (?:visa |employment )?sponsorship\b/i,
  // Missed the Centene wording on 2026-08-10 ("Sponsorship and future
  // sponsorship are not available…"): the old pattern demanded the exact
  // phrase "sponsorship is not". Allow words between the noun and the
  // negation, and accept plural agreement.
  /\bsponsorship\b[^.]{0,60}\b(?:is|are|will) not (?:be )?(?:available|offered|provided|supported|considered)\b/i,
  /\bnot (?:be )?(?:available|offered|provided)\b[^.]{0,40}\bsponsor/i,
  // Also missed by the old version, which required "visa " or "employment "
  // to sit immediately before "sponsor". Real postings write "the need for
  // employment-based visa sponsorship", with a hyphenated qualifier between.
  /\bwithout the need for\b[^.]{0,40}\bsponsor/i,
  /\bwithout (?:requiring |the need of )?[^.]{0,30}\bsponsorship\b/i,
  /\bmust be (?:legally )?authorized to work\b[^.]{0,60}\bwithout\b[^.]{0,40}\bsponsor/i,
  /\bdoes not (?:currently )?sponsor\b/i,
  /\bare not (?:currently )?sponsoring\b/i,
  /\bnot (?:be )?considering candidates (?:who )?requir\w+ sponsor/i,
];

// Explicit willingness. Not required to pass, only surfaced as a positive.
const POSITIVE_PATTERNS = [
  /\bwe (?:do |will |can )?sponsor\b/i,
  /\bvisa sponsorship (?:is )?(?:available|provided|offered)\b/i,
  /\bwilling to sponsor\b/i,
  /\bh-?1b transfer\b/i,
  /\bwe (?:provide|offer) (?:visa |immigration )?sponsorship\b/i,
  /\bsponsorship available\b/i,
];

/** Classify JD text. Returns { status, evidence }. */
export function classifySponsorship(text) {
  if (!text || text.length < 100) return { status: 'silent', evidence: null };
  const flat = text.replace(/\s+/g, ' ');

  for (const re of BLOCK_PATTERNS) {
    const m = flat.match(re);
    if (!m) continue;
    // Return the surrounding sentence so a human can audit the call rather
    // than trusting a boolean.
    const i = flat.indexOf(m[0]);
    const start = Math.max(0, flat.lastIndexOf('.', i) + 1);
    const end = flat.indexOf('.', i + m[0].length);
    return {
      status: 'blocked',
      evidence: flat.slice(start, end === -1 ? i + 200 : end + 1).trim().slice(0, 240),
    };
  }
  for (const re of POSITIVE_PATTERNS) {
    const m = flat.match(re);
    if (!m) continue;
    const i = flat.indexOf(m[0]);
    const start = Math.max(0, flat.lastIndexOf('.', i) + 1);
    const end = flat.indexOf('.', i + m[0].length);
    return {
      status: 'positive',
      evidence: flat.slice(start, end === -1 ? i + 200 : end + 1).trim().slice(0, 240),
    };
  }
  return { status: 'silent', evidence: null };
}

const strip = (h) =>
  String(h || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

/**
 * Fetch a posting's body text. Prefers the ATS API (structured, reliable) and
 * falls back to fetching the URL. A failure returns '' so the caller classifies
 * it as `silent` and the posting passes: a network hiccup must never silently
 * discard a role.
 */
export async function fetchPostingText(url, timeoutMs = 15000) {
  const go = async (u) => {
    const ctl = AbortController ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(u, {
        signal: ctl?.signal,
        headers: { 'user-agent': 'career-ops sponsorship-filter' },
      });
      if (!r.ok) return null;
      return r;
    } finally {
      if (t) clearTimeout(t);
    }
  };

  try {
    // Greenhouse: canonical board URL, or any URL carrying gh_jid.
    const gh = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
    const ghId = url.match(/gh_jid=(\d+)/);
    if (gh) {
      const r = await go(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}`);
      if (r) return strip((await r.json()).content);
    } else if (ghId) {
      // Custom careers domain proxying Greenhouse: the slug isn't in the URL,
      // so fall through to the raw fetch below.
    }

    const lv = url.match(/lever\.co\/([^/?#]+)\/([a-f0-9-]{8,})/i);
    if (lv) {
      const host = url.includes('eu.lever.co') ? 'api.eu.lever.co' : 'api.lever.co';
      const r = await go(`https://${host}/v0/postings/${lv[1]}/${lv[2]}`);
      if (r) {
        const j = await r.json();
        return strip(j.descriptionPlain || j.description || '');
      }
    }

    const ab = url.match(/ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{8,})/i);
    if (ab) {
      const r = await go(`https://api.ashbyhq.com/posting-api/job-board/${ab[1]}?includeCompensation=true`);
      if (r) {
        const j = await r.json();
        const hit = (j.jobs || []).find((x) => (x.jobUrl || '').includes(ab[2]));
        if (hit) return strip(hit.descriptionHtml || hit.descriptionPlain || '');
      }
    }

    const r = await go(url);
    return r ? strip(await r.text()) : '';
  } catch {
    return ''; // fail open: unknown is not refusal
  }
}

/** Classify a batch of {url,...} matches, adding `sponsorship` to each. */
export async function annotateSponsorship(matches, concurrency = 6) {
  const out = [...matches];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, out.length) }, async () => {
    while (i < out.length) {
      const idx = i++;
      const text = await fetchPostingText(out[idx].url);
      out[idx].sponsorship = classifySponsorship(text);
    }
  });
  await Promise.all(workers);
  return out;
}
