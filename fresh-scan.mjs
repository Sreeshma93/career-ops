#!/usr/bin/env node
// fresh-scan.mjs — hour-precision freshness scan straight off company ATS boards.
//
// scan.mjs filters posting age in whole days (--since / max_posting_age_days).
// This asks a narrower question: what went live in the last N *hours*?
// Greenhouse and Ashby both return a full ISO timestamp, so that is answerable.
// Workday only exposes day buckets ("Posted Today"), so it is reported
// separately and never claimed to be hour-accurate.
//
// Sources are the companies' own ATS boards from portals.yml — no aggregators.
//
// Usage: node fresh-scan.mjs [--hours N] [--all] [--json]
//   --hours N  freshness window, default 1
//   --all      ignore title/location filters (show the raw firehose)
//   --json     machine output

import fs from 'node:fs';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const HOURS = Number(flag('--hours', '1'));
const SHOW_ALL = args.includes('--all');
const AS_JSON = args.includes('--json');

if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error('--hours must be a positive number');
  process.exit(1);
}

const cfg = yaml.load(fs.readFileSync('portals.yml', 'utf8'));
const companies = (cfg.tracked_companies || []).filter((c) => c.enabled !== false);
const tf = cfg.title_filter || {};
const lf = cfg.location_filter || {};

const now = Date.now();
const cutoff = now - HOURS * 3600 * 1000;

const has = (hay, needles) =>
  (needles || []).some((n) => hay.toLowerCase().includes(String(n).toLowerCase()));

function titleOk(title) {
  if (SHOW_ALL) return true;
  if (has(title, tf.negative)) return false;
  return has(title, tf.positive);
}

function locationOk(loc) {
  if (SHOW_ALL) return true;
  if (!loc) return true; // missing data is never penalized
  if (has(loc, lf.always_allow)) return true;
  if (has(loc, lf.block)) return false;
  if (!lf.allow || !lf.allow.length) return true;
  return has(loc, lf.allow);
}

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'user-agent': 'career-ops fresh-scan', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Providers ───────────────────────────────────────────────────────────────

async function greenhouse(c) {
  const slug = (c.careers_url.match(/greenhouse\.io\/([^/?#]+)/) || [])[1];
  if (!slug) return [];
  const data = await getJSON(
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
  );
  return (data.jobs || []).map((j) => ({
    company: c.name,
    title: j.title,
    url: j.absolute_url,
    location: j.location?.name || '',
    // first_published is when the posting actually went live; updated_at moves
    // on every edit, so it would report stale roles as fresh.
    posted: j.first_published || j.updated_at || null,
    precision: j.first_published ? 'exact' : 'updated_at',
  }));
}

async function ashby(c) {
  const slug = (c.careers_url.match(/ashbyhq\.com\/([^/?#]+)/) || [])[1];
  if (!slug) return [];
  const data = await getJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`
  );
  return (data.jobs || []).map((j) => ({
    company: c.name,
    title: j.title,
    url: j.jobUrl,
    location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location || s)]
      .filter(Boolean)
      .join(' · '),
    posted: j.publishedAt || null,
    precision: 'exact',
  }));
}

async function workday(c) {
  const m = c.careers_url.match(
    /https:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/
  );
  if (!m) return [];
  const [, tenant, shard, site] = m;
  const endpoint = `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const out = [];
  for (let offset = 0; offset < 200; offset += 20) {
    const data = await getJSON(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
    });
    const posts = data.jobPostings || [];
    if (!posts.length) break;
    for (const j of posts) {
      out.push({
        company: c.name,
        title: j.title,
        url: `https://${tenant}.${shard}.myworkdayjobs.com/${site}${j.externalPath}`,
        location: j.locationsText || '',
        // Workday exposes a bucket label ("Posted Today"), never a timestamp.
        posted: null,
        bucket: j.postedOn || '',
        precision: 'day-bucket',
      });
    }
    if (posts.length < 20) break;
  }
  return out;
}

function providerFor(c) {
  const u = c.careers_url || '';
  if (u.includes('greenhouse.io')) return greenhouse;
  if (u.includes('ashbyhq.com')) return ashby;
  if (u.includes('myworkdayjobs.com')) return workday;
  return null;
}

// ── Run ─────────────────────────────────────────────────────────────────────

const results = await Promise.all(
  companies.map(async (c) => {
    const fn = providerFor(c);
    if (!fn) return { company: c.name, error: 'no provider', jobs: [] };
    try {
      return { company: c.name, jobs: await fn(c) };
    } catch (e) {
      return { company: c.name, error: e.message, jobs: [] };
    }
  })
);

const errors = results.filter((r) => r.error);
const all = results.flatMap((r) => r.jobs);

const timestamped = all.filter((j) => j.posted);
const fresh = timestamped
  .filter((j) => new Date(j.posted).getTime() >= cutoff)
  .filter((j) => titleOk(j.title) && locationOk(j.location))
  .sort((a, b) => new Date(b.posted) - new Date(a.posted));

// Workday can only answer "today", so surface those as a separate, honest bucket.
const workdayToday = all
  .filter((j) => j.precision === 'day-bucket' && /today/i.test(j.bucket || ''))
  .filter((j) => titleOk(j.title) && locationOk(j.location));

// Widening context: how fresh is the freshest thing that matched at all?
const matchedAny = timestamped
  .filter((j) => titleOk(j.title) && locationOk(j.location))
  .sort((a, b) => new Date(b.posted) - new Date(a.posted));

const ageHrs = (p) => (now - new Date(p).getTime()) / 3600000;

if (AS_JSON) {
  console.log(JSON.stringify({ hours: HOURS, fresh, workdayToday, errors }, null, 2));
} else {
  const fmt = (j) =>
    `  ${j.company} | ${j.title} | ${j.location || '—'}\n    ${ageHrs(j.posted).toFixed(1)}h ago · ${j.url}`;

  console.log(`\nFresh scan — window: last ${HOURS}h`);
  console.log(`Boards polled: ${companies.length} (${errors.length} failed)`);
  console.log(`Postings seen: ${all.length} (${timestamped.length} with a real timestamp)\n`);

  console.log(`── Posted within ${HOURS}h (hour-accurate) ──`);
  console.log(fresh.length ? fresh.map(fmt).join('\n') : '  (none)');

  console.log(`\n── Workday boards: "Posted Today" (no hour precision available) ──`);
  console.log(
    workdayToday.length
      ? workdayToday.map((j) => `  ${j.company} | ${j.title} | ${j.location}\n    ${j.url}`).join('\n')
      : '  (none)'
  );

  console.log(`\n── Freshest 10 matches overall, for context ──`);
  for (const j of matchedAny.slice(0, 10)) {
    const h = ageHrs(j.posted);
    const age = h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(0)}d`;
    console.log(`  ${age.padStart(4)} · ${j.company} | ${j.title}`);
  }

  if (errors.length) {
    console.log(`\n── Boards that failed ──`);
    for (const e of errors) console.log(`  ${e.company}: ${e.error}`);
  }
  console.log('');
}
