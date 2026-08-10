#!/usr/bin/env node
// watch.mjs — the single scheduled job-alert command.
//
// Replaces fresh-alert.mjs and the two hand-written launchd agents
// (io.careerops.fresh-alert, io.careerops.fresh-alert-deep) with one command
// driven by one agent. The deep tier is not a second schedule: this script
// tracks when it last ran and folds it in when it is due, so there is exactly
// one plist and no way for two sweeps to overlap.
//
//   node watch.mjs [--tier fast|deep|auto] [--notify] [--quiet] [--dry-run]
//
//   --tier auto (default when scheduled): fast every run, plus deep when the
//   last deep sweep is more than DEEP_INTERVAL_H hours old.
//
// WHAT CHANGED FROM fresh-alert.mjs
//
// fresh-alert ran two sweeps and applied exactly one gate (sponsorship). On
// 2026-08-10 it texted a Canadian role ("Remote, Ontario") plus four roles of
// the wrong discipline entirely: none matched the policy in modes/_profile.md,
// and modes/_custom.md requires every hit be screened against that file before
// it reaches the user. This adds the three missing gates and orders them so the
// free ones run before the ones that cost a network fetch.
//
// GATE ORDER (deliberate, cheapest first):
//   1. archetype  — string only, no I/O. Kills the biggest source of noise.
//   2. location   — string only, no I/O. Kills non-US and out-of-policy on-site.
//   3. freshness  — string only, no I/O.
//   4. sponsorship + clearance — ONE fetch per surviving posting, shared
//      between both classifiers so nothing is fetched twice.
//
// Every gate annotates rather than deletes. Rejections are written to the
// monthly log with their evidence, so a wrong call is auditable instead of
// invisible: the same discipline fresh-alert.mjs already applied to the
// sponsorship gate.
//
// EACH TIER REPORTS AND NOTIFIES ON ITS OWN. The first build gated and
// notified once, after every tier had finished. With --tier auto that meant a
// role found by the 10-minute fast sweep sat unreported until the 2.5-hour
// deep sweep completed, which cannot coexist with a 3-hour freshness target.
// Tiers are therefore fully independent runs inside one invocation.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { classifySponsorship, fetchPostingText } from './sponsorship-filter.mjs';
import { classifyClearance, fetchGreenhouseFormText } from './clearance-filter.mjs';
import { classifyLocation } from './location-gate.mjs';
import { classifyArchetype } from './archetype-gate.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const TIER = flag('--tier', 'auto');
// --search: the on-demand path. Same passes, same gates, same policy, but the
// first-sighting dedup is switched off so it answers "everything that fits
// right now" rather than "what changed since last time". Re-listing a role
// already alerted on is intended, so no extra suppression logic exists.
//
// It implies --dry-run and never notifies. Both are load-bearing, not
// politeness: a full re-listing written back would append thousands of rows to
// pipeline.md and rewrite scan-history.tsv, and destroying that file destroys
// the first-sighting signal the scheduled path depends on. It would also text
// the whole result set.
const SEARCH = args.includes('--search');
// How many days back --search looks. The scheduled path is always 1: it only
// needs "since the last sweep". On demand, a wider window is usually the point.
const SEARCH_SINCE = flag('--since', '1');
const NOTIFY = args.includes('--notify') && !SEARCH;
const QUIET = args.includes('--quiet');
const DRY_RUN = args.includes('--dry-run') || SEARCH;

// timeoutMin must exceed the tier's real runtime with headroom. A too-short
// timeout kills the sweep mid-directory and reports a partial run as a clean
// one: the deep tier ran for weeks against a 50-minute cap it could never
// finish inside, which is why its old log lines read "? boards".
const TIERS = {
  fast: { ats: 'greenhouse,lever,ashby', since: '1', timeoutMin: 50 },
  deep: { ats: 'workday,icims,bamboohr', since: '1', timeoutMin: 300 },
};

// How stale the last deep sweep may get before --tier auto includes it. 20h,
// not 24h, so a missed wake never pushes it into a second lost day.
const DEEP_INTERVAL_H = 20;

// Freshness policy. Providers that stamp a real time (Greenhouse, Lever,
// Ashby, Oracle Cloud) are held to FRESH_H. Providers that only bucket by day
// (Workday, iCIMS) land on midnight UTC, which cannot be distinguished from a
// genuine midnight publish, so they get the wider fallback instead of being
// judged on precision they never had.
const FRESH_H = 3;
const FRESH_FALLBACK_H = 48;

const ROOT = path.resolve(import.meta.dirname);
const LOG_DIR = path.join(ROOT, 'data', 'alerts');
const STATE_FILE = path.join(LOG_DIR, 'watch-state.json');
const PORTALS = path.join(ROOT, 'portals.yml');
mkdirSync(LOG_DIR, { recursive: true });

const stamp = new Date().toISOString();
const state = (() => {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
})();

// ── Which tiers run this time ───────────────────────────────────────────────
let tiers;
if (SEARCH) {
  // `auto` is state-driven ("is the deep sweep due?"), which is meaningless for
  // an on-demand run. Default to fast, which is ~10 minutes; --tier deep or
  // --tier all are available when the wait is acceptable.
  const t = TIER === 'auto' ? 'fast' : TIER;
  tiers = t === 'all' ? ['fast', 'deep'] : TIERS[t] ? [t] : null;
  if (!tiers) {
    console.error(`unknown tier "${TIER}" — with --search expected: fast, deep, all`);
    process.exit(1);
  }
} else if (TIER === 'auto') {
  const lastDeep = state.lastDeepRun ? new Date(state.lastDeepRun).getTime() : 0;
  const deepDue = (Date.now() - lastDeep) / 36e5 >= DEEP_INTERVAL_H;
  tiers = deepDue ? ['fast', 'deep'] : ['fast'];
} else if (TIERS[TIER]) {
  tiers = [TIER];
} else {
  console.error(`unknown tier "${TIER}" — expected: fast, deep, auto`);
  process.exit(1);
}

// ── Pass 1: portals.yml tracked_companies (scan.mjs) ────────────────────────
//
// The directory sweeps only reach ATS platforms that publish a public company
// list. Employers on Oracle Cloud, SuccessFactors, Phenom, Avature and friends
// are reachable ONLY by name, via portals.yml. This is also the only pass that
// sees the hand-picked SoCal employers, so it runs once up front and its
// results ride along with the first tier.
//
// scan.mjs prints matches without URLs, so new rows are read off
// data/pipeline.md instead, which carries url | company | title | location.
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const pipelineLines = () => {
  try { return readFileSync(PIPELINE, 'utf8').split('\n').filter((l) => l.startsWith('- [ ] ')); }
  catch { return []; }
};

const beforePending = new Set(pipelineLines());
let trackedFailed = null;
let scanStdout = '';
try {
  scanStdout = execFileSync(
    process.execPath,
    // --search reads results off stdout, so it must NOT write: --dry-run keeps
    // pipeline.md and scan-history.tsv untouched, --ignore-history makes the
    // scan report every live match rather than only first sightings.
    SEARCH ? ['scan.mjs', '--dry-run', '--ignore-history'] : ['scan.mjs'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000 }
  );
} catch (e) {
  trackedFailed = e.message;
  scanStdout = (e.stdout || '').toString();
}

// Two readers, because the two modes leave results in different places.
//
// Scheduled: scan.mjs writes pipeline.md, so the new rows are the diff.
// Search:    scan.mjs is --dry-run and writes nothing, so the "New offers:"
//            block on stdout is the only record. Each match is a "  + company
//            | title | location" line followed by its indented URL.
const trackedRaw = SEARCH
  ? (() => {
      const out = [];
      const lines = scanStdout.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s{2}\+\s(.+?)\s\|\s(.+?)\s\|\s(.*?)(?:\s\[(?:Trust|BLACKLISTED).*)?$/);
        if (!m) continue;
        const url = (lines[i + 1] || '').trim();
        if (!/^https?:\/\//.test(url)) continue;
        out.push({
          source: 'portals', company: m[1].trim(), title: m[2].trim(),
          location: m[3].trim() === 'N/A' ? '' : m[3].trim(),
          url, postedAt: null, dateStatus: 'unknown',
        });
      }
      return out;
    })()
  : pipelineLines()
      .filter((l) => !beforePending.has(l))
      .map((l) => {
        const [url, company, title, location] = l.replace(/^- \[ \] /, '').split('|').map((s) => s.trim());
        return { source: 'portals', company: company || '?', title: title || '?', location: location || '', url: url || '', postedAt: null, dateStatus: 'unknown' };
      })
      .filter((m) => m.url && m.title !== '?');

// ── Freshness ───────────────────────────────────────────────────────────────
//
// First-sighting dedup (scan-ats-full against data/scan-history.tsv) is the
// primary guarantee: anything reported here did not exist on the previous
// sweep. The timestamp check is secondary, and catches the case dedup cannot:
// a board newly added to the public dataset dumping its whole backlog as new.
function freshness(m) {
  if (!m.postedAt) return { ageHours: null, precision: 'none', fresh: true, basis: 'first sighting' };
  const ms = Date.parse(m.postedAt);
  if (Number.isNaN(ms)) return { ageHours: null, precision: 'none', fresh: true, basis: 'unparseable date, first sighting' };

  const ageHours = (Date.now() - ms) / 36e5;
  // Midnight-exact UTC means the provider gave a day bucket, not a time.
  const d = new Date(ms);
  const dayOnly = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  const precision = dayOnly ? 'day' : 'hour';
  const window = dayOnly ? FRESH_FALLBACK_H : FRESH_H;

  return {
    ageHours: Math.max(0, Math.round(ageHours * 10) / 10),
    precision,
    fresh: ageHours <= window,
    basis: `${precision} precision, ${window}h window`,
  };
}

const ageLabel = (m) =>
  m.freshness?.ageHours == null
    ? 'age unknown, new since last sweep'
    : `${m.freshness.ageHours}h old${m.freshness.precision === 'day' ? ' (day precision)' : ''}`;

// ── Company-list growth ─────────────────────────────────────────────────────
//
// A gate-passing match at a company NOT in portals.yml means the only reason it
// was seen is that its ATS happens to publish a public directory. Adding it to
// tracked_companies gets it polled directly on every run, which is both faster
// and immune to that company dropping out of the dataset (PIMCO and Applied
// Medical are both missing from the public lists despite running swept
// platforms).
//
// The vendor and tenant are read straight off the job URL, so this costs no
// network calls: the URL already IS the ATS coordinate.
//
// This cannot discover the Oracle Cloud / Phenom / Avature class of employer,
// which publishes no directory and is therefore invisible to any sweep. That
// gap is closed by `node detect-ats.mjs --in config/socal-employers.yml`, run
// periodically per modes/watch.md, not by this function.
const VENDOR_FROM_URL = [
  [/https?:\/\/(?:job-boards|boards)\.(?:eu\.)?greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/https?:\/\/jobs\.(?:eu\.)?lever\.co\/([a-z0-9-]+)/i, 'lever'],
  [/https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, 'ashby'],
  [/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i, 'workday'],
  [/https?:\/\/careers-([a-z0-9-]+)\.icims\.com/i, 'icims'],
  [/https?:\/\/([a-z0-9-]+)\.bamboohr\.com/i, 'bamboohr'],
];

function boardUrl(vendor, hit) {
  switch (vendor) {
    case 'greenhouse': return `https://job-boards.greenhouse.io/${hit[1]}`;
    case 'lever': return `https://jobs.lever.co/${hit[1]}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${hit[1]}`;
    case 'workday': return `https://${hit[1]}.${hit[2]}.myworkdayjobs.com/${hit[3]}`;
    case 'icims': return `https://careers-${hit[1]}.icims.com/jobs/search`;
    case 'bamboohr': return `https://${hit[1]}.bamboohr.com/careers`;
    default: return null;
  }
}

function growTrackedCompanies(newMatches) {
  if (!newMatches.length || DRY_RUN) return [];
  let text;
  try { text = readFileSync(PORTALS, 'utf8'); } catch { return []; }

  let cfg;
  try { cfg = yaml.load(text); } catch { return []; }
  const known = new Set((cfg?.tracked_companies || []).map((c) => String(c.name || '').toLowerCase().trim()));

  const added = [];
  const seen = new Set();
  for (const m of newMatches) {
    const name = String(m.company || '').trim();
    const key = name.toLowerCase();
    if (!name || name === '?' || known.has(key) || seen.has(key)) continue;
    if (m.source === 'portals') continue; // already tracked by definition

    const sig = VENDOR_FROM_URL.find(([re]) => re.test(m.url));
    if (!sig) continue; // e.g. a branded domain proxying Greenhouse: no slug to read
    const [re, vendor] = sig;
    const careersUrl = boardUrl(vendor, m.url.match(re));
    if (!careersUrl) continue;

    seen.add(key);
    added.push({ name, careersUrl, vendor, why: `${m.title} (${m.locationGate.reason})` });
  }
  if (!added.length) return [];

  // portals.yml is a USER-LAYER file. Back it up before touching it, and append
  // as text rather than re-serializing the YAML, so the user's comments,
  // ordering and formatting all survive.
  copyFileSync(PORTALS, `${PORTALS}.bak`);
  appendFileSync(PORTALS, [
    '',
    `  # -- auto-added by watch.mjs on ${stamp.slice(0, 10)} --`,
    '  # Each of these produced a match that cleared every gate while not being',
    '  # tracked. Tracking them polls their board directly instead of relying on',
    '  # the company staying present in the public ATS directory.',
    ...added.flatMap((a) => ([
      '',
      `  - name: ${/[:#]/.test(a.name) ? JSON.stringify(a.name) : a.name}`,
      `    careers_url: ${a.careersUrl}`,
      // `provider:`, NOT `api_provider:`. providers/_registry.mjs reads
      // `provider:`; an entry using the other key is silently skipped.
      `    provider: ${a.vendor}`,
      '    enabled: true',
      `    notes: ${JSON.stringify(`auto-added by watch.mjs: ${a.why}`)}`,
    ])),
    '',
  ].join('\n'));
  return added;
}

// ── Notification ────────────────────────────────────────────────────────────
//
// Scraped job titles reach AppleScript, which is an injection target, so quotes
// and backslashes are stripped rather than escaped.
const osaSafe = (s) => String(s).replace(/["\\]/g, '');

function notifyDesktop(body) {
  try {
    execFileSync('osascript', ['-e',
      `display notification "${osaSafe(body)}" with title "career-ops: fresh roles" sound name "Glass"`]);
  } catch { /* best-effort; never fail the sweep over a notification */ }
}

/**
 * Text the user's own number via Messages.app. This is a note-to-self channel:
 * the recipient comes from config/profile.yml `alerts.imessage_to` and is the
 * user's own number, never an outbound contact.
 *
 * Delivery depends on the Mac being awake with Messages signed in. Confirmed
 * as the chosen channel on 2026-08-10 over a paid SMS gateway.
 */
function notifyIMessage(to, body) {
  const script = `
tell application "Messages"
  set svc to 1st account whose service type = iMessage
  send "${osaSafe(body)}" to participant "${osaSafe(to)}" of svc
end tell`;
  try {
    execFileSync('osascript', ['-e', script], { timeout: 30000 });
    return true;
  } catch (e) {
    console.error(`  ! iMessage failed: ${e.message.split('\n')[0]}`);
    return false;
  }
}

function readImessageTo() {
  try {
    return yaml.load(readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8'))?.alerts?.imessage_to || null;
  } catch { return null; }
}

// ── One tier, end to end ────────────────────────────────────────────────────
async function runTier(tier, seed) {
  const tierStamp = new Date().toISOString();
  const sweepErrors = [];
  const degraded = [];
  const raw = [...seed];
  let boards = 0;

  // --json is used instead of parsing the human log lines: it carries
  // companiesScanned, postedAt and dateStatus as data, and it distinguishes a
  // degraded sweep (capHit, stoppedByOutage) from an empty one. The human log
  // goes to stderr, so stdout is the payload alone.
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [
        'scan-ats-full.mjs', '--ats', TIERS[tier].ats,
        // --search takes its window from --since (default 1 day) and turns off
        // first-sighting dedup, so it lists everything live in that window
        // including roles already alerted on.
        '--since', SEARCH ? SEARCH_SINCE : TIERS[tier].since,
        '--json',
        ...(SEARCH ? ['--ignore-history', '--dry-run'] : []),
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: TIERS[tier].timeoutMin * 60 * 1000 }
    );
  } catch (e) {
    // A partial sweep still yields usable matches, so parse whatever came back
    // rather than discarding the run.
    out = (e.stdout || '').toString();
    sweepErrors.push(`${tier}: ${e.message.split('\n')[0]}`);
  }

  let payload = null;
  try { payload = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null'); }
  catch { sweepErrors.push(`${tier}: could not parse --json output`); }

  if (payload) {
    boards = payload.companiesScanned || 0;
    if (payload.capHit) degraded.push(`${tier}: board cap hit`);
    if (payload.stoppedByOutage) degraded.push(`${tier}: stopped by outage, --resume pending`);
    // datasetStatus is a per-source map ({greenhouse: 'fresh', lever: 'stale'}),
    // not a scalar. Reporting the object printed "dataset [object Object]".
    for (const [src, status] of Object.entries(payload.datasetStatus || {})) {
      if (status && status !== 'fresh') degraded.push(`${tier}/${src}: dataset ${status}`);
    }
    for (const o of payload.offers || []) {
      raw.push({
        source: o.source || tier,
        company: o.company,
        title: o.title,
        url: o.url,
        location: o.location || '',
        postedAt: o.postedAt || null,
        dateStatus: o.dateStatus || 'unknown',
      });
    }
  }

  // ── Gate chain: free gates first ──────────────────────────────────────────
  const rejected = [];
  const drop = (m, gate, reason, evidence = null) => rejected.push({ ...m, rejectedBy: gate, reason, evidence });

  let survivors = [];
  for (const m of raw) {
    m.archetype = classifyArchetype(m.title, m.company);
    if (m.archetype.verdict === 'reject') { drop(m, 'archetype', m.archetype.reason); continue; }

    m.locationGate = classifyLocation(m.location);
    if (m.locationGate.verdict === 'reject') { drop(m, 'location', m.locationGate.reason); continue; }

    // The freshness gate is a CHANGE detector, so --search skips it: the sweep's
    // own --since window already bounds the results, and applying a 3h cutoff on
    // top would make an on-demand search return roughly what the last alert
    // returned, which is the opposite of what it is for. Age is still computed
    // and still reported in hours.
    m.freshness = freshness(m);
    if (!SEARCH && !m.freshness.fresh) { drop(m, 'freshness', `${m.freshness.ageHours}h old (${m.freshness.basis})`); continue; }

    survivors.push(m);
  }

  // ── Fetch-backed gates: sponsorship + clearance, one JD fetch each ────────
  //
  // Both classifiers read the same JD body. fetchPostingText fails open
  // (returns ''), so a network hiccup classifies as silent and the posting
  // passes: a timeout must never quietly discard a live role.
  if (survivors.length && !args.includes('--no-content-gates')) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(6, survivors.length) }, async () => {
      while (i < survivors.length) {
        const m = survivors[i++];
        const jdText = await fetchPostingText(m.url);
        m.sponsorship = classifySponsorship(jdText);

        const fromJd = classifyClearance(jdText);
        if (fromJd.status === 'blocked') {
          m.clearance = { ...fromJd, source: 'jd', checkedForm: false };
        } else {
          // The Anduril case: clean JD, clearance question in the form.
          const formText = await fetchGreenhouseFormText(m.url);
          m.clearance = formText
            ? { ...classifyClearance(formText), source: 'form', checkedForm: true }
            : { status: 'silent', evidence: null, source: 'jd', checkedForm: false };
        }
      }
    }));

    const kept = [];
    for (const m of survivors) {
      if (m.sponsorship?.status === 'blocked') { drop(m, 'sponsorship', 'employer states it will not sponsor', m.sponsorship.evidence); continue; }
      if (m.clearance?.status === 'blocked') { drop(m, 'clearance', `clearance or citizenship required (${m.clearance.source})`, m.clearance.evidence); continue; }
      kept.push(m);
    }
    survivors = kept;
  }

  const grown = growTrackedCompanies(survivors);

  // ── Log ───────────────────────────────────────────────────────────────────
  const byGate = rejected.reduce((acc, r) => { (acc[r.rejectedBy] ??= []).push(r); return acc; }, {});
  const digest = [
    `\n## ${tierStamp} — tier: ${tier} — ${survivors.length} new (${boards.toLocaleString('en-US')} boards)`,
    sweepErrors.length ? `> sweep errors: ${sweepErrors.join('; ')}` : '',
    degraded.length ? `> degraded: ${degraded.join('; ')}` : '',
    trackedFailed ? `> tracked-company scan failed: ${trackedFailed.split('\n')[0]}` : '',
    ...survivors.map((j) => [
      `- **${j.company}** — ${j.title}${j.sponsorship?.status === 'positive' ? ' [sponsors]' : ''}${j.archetype.tier === 'secondary' ? ' [adjacent]' : ''}`,
      `  - ${j.location || 'location n/a'} (${j.locationGate.reason})`,
      `  - ${ageLabel(j)}`,
      `  - ${j.url}`,
    ].join('\n')),
    ...(grown.length ? ['', `> tracked ${grown.length} new ${grown.length === 1 ? 'company' : 'companies'} in portals.yml: ${grown.map((g) => g.name).join(', ')}`] : []),
    // Rejections are logged with evidence, never silently vanished: if a gate
    // is ever wrong, the reason is right here to audit.
    ...(rejected.length
      ? ['', `<details><summary>${rejected.length} filtered</summary>`, '',
         ...Object.entries(byGate).map(([gate, list]) =>
           [`**${gate}** (${list.length})`, ...list.map((j) =>
             `- ~~${j.company} — ${j.title}~~ — ${j.reason}${j.evidence ? `\n  - > ${j.evidence}` : ''}\n  - ${j.url}`
           )].join('\n')),
         '', '</details>']
      : []),
  ].filter(Boolean).join('\n');

  if (!DRY_RUN) appendFileSync(path.join(LOG_DIR, `${tierStamp.slice(0, 7)}.md`), digest + '\n');

  // ── Notify, per tier ──────────────────────────────────────────────────────
  //
  // Alerts fire ONLY on matches. An empty run is the normal case and must stay
  // silent, or the channel trains the user to ignore it.
  if (NOTIFY && survivors.length && !DRY_RUN) {
    const n = survivors.length;
    const plural = n > 1 ? 's' : '';
    notifyDesktop(`${n} new role${plural} — ${survivors.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join(' · ')}`);

    // Read the destination lazily so removing the key cleanly disables iMessage.
    const imessageTo = readImessageTo();
    if (imessageTo) {
      const lines = survivors.map((j) =>
        `• ${j.company} — ${j.title}\n  ${j.location || 'location n/a'}\n  ${ageLabel(j)}\n  ${j.url}`);
      const suffix = rejected.length ? `\n\n(${rejected.length} filtered)` : '';
      notifyIMessage(imessageTo, `career-ops: ${n} new role${plural}\n\n${lines.join('\n\n')}${suffix}`);
    }
  }

  // ── Console ───────────────────────────────────────────────────────────────
  //
  // The board count is printed even when nothing matched. modes/_custom.md:
  // "0 new across 15,862 boards" is a real answer, silence reads as a failure.
  if (!QUIET) {
    console.log(`[${tierStamp}] tier=${tier} boards=${boards.toLocaleString('en-US')} new=${survivors.length}${rejected.length ? ` (${rejected.length} filtered)` : ''}${DRY_RUN ? ' [dry-run]' : ''}`);
    for (const j of survivors) {
      const tags = [
        j.sponsorship?.status === 'positive' ? 'sponsors' : null,
        j.archetype.tier === 'secondary' ? 'adjacent' : null,
        j.clearance?.checkedForm ? 'form checked' : null,
      ].filter(Boolean);
      console.log(`  + ${j.company} | ${j.title} | ${j.location}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
      console.log(`    ${ageLabel(j)}\n    ${j.url}`);
    }
    for (const [gate, list] of Object.entries(byGate)) {
      console.log(`  - ${gate}: ${list.length} filtered`);
      for (const j of list) console.log(`      ${j.company} | ${j.title} — ${j.reason}`);
    }
    if (grown.length) console.log(`  → tracked ${grown.length} new companies in portals.yml: ${grown.map((g) => g.name).join(', ')}`);
    for (const e of sweepErrors) console.log(`  ! ${e}`);
    for (const d of degraded) console.log(`  ! ${d}`);
    if (trackedFailed) console.log(`  ! tracked-company scan failed: ${trackedFailed.split('\n')[0]}`);
  }

  return { tier, ran_at: tierStamp, boards, matches: survivors, rejected, grown, sweepErrors, degraded };
}

// ── Drive the tiers ─────────────────────────────────────────────────────────
//
// Sequential, not parallel: two concurrent sweeps would race on
// data/scan-history.tsv, and the dedup file is the whole basis of "new".
const runs = [];
for (const t of tiers) {
  // The tracked-company pass rides with the first tier only, so its matches
  // are neither duplicated nor delayed behind the slow sweep.
  const seed = runs.length === 0 ? trackedRaw : [];
  runs.push(await runTier(t, seed));

  if (t === 'deep') state.lastDeepRun = new Date().toISOString();
  if (!DRY_RUN) {
    // latest.json is rewritten after EVERY tier, accumulating as it goes, so a
    // reader mid-run sees the fast results rather than nothing.
    writeFileSync(path.join(LOG_DIR, 'latest.json'), JSON.stringify({
      ran_at: stamp,
      tiers: runs.map((r) => r.tier),
      boards: runs.reduce((a, r) => a + r.boards, 0),
      trackedFailed,
      sweepErrors: runs.flatMap((r) => r.sweepErrors),
      degraded: runs.flatMap((r) => r.degraded),
      matches: runs.flatMap((r) => r.matches),
      rejected: runs.flatMap((r) => r.rejected),
      grown: runs.flatMap((r) => r.grown),
      runs: runs.map((r) => ({ tier: r.tier, ran_at: r.ran_at, boards: r.boards, matches: r.matches.length, rejected: r.rejected.length })),
    }, null, 2));
    state.lastRun = new Date().toISOString();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}
