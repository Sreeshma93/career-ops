#!/usr/bin/env node
//
// ⚠️  SUPERSEDED 2026-08-10 by watch.mjs. Do not schedule or run this.
//
// It applies ONE gate (sponsorship), which is why it texted a Canadian role,
// three Solutions Architect roles and a Figma Data Engineer on 2026-08-10:
// none matched the policy in modes/_profile.md. watch.mjs adds the archetype,
// location, freshness and clearance gates, and folds the deep tier into a
// single schedule. See modes/watch.md.
//
// Kept only as the reference for how the sweep passes were wired.
//
// fresh-alert.mjs — hourly "what just opened" alert across the full public ATS
// directories (~15,900 company career sites), not a curated company list.
//
// WHY THIS SHAPE:
//
// "Posted in the last hour" can be answered two ways. Filtering on the
// provider's publish timestamp is the obvious one, but it is not the reliable
// one: many boards report only a date, and some backdate. The dependable
// signal is *first sighting* — scan-ats-full.mjs dedups every match against
// data/scan-history.tsv, so anything it reports is a URL that did not exist on
// the previous sweep. Run it hourly and "new match" literally means "appeared
// within the last hour". That works even for providers with coarse dates.
//
// TIERS:
//   fast (default) — greenhouse + lever + ashby (~15.9k boards, ~8 min).
//                    Real publish timestamps. Safe to run hourly.
//   deep           — workday + icims + bamboohr (~34k boards, ~2.5 h).
//                    Day-granularity at best, far slower. Daily, never hourly.
//
// BambooHR sits in `deep` despite being a fast per-tenant API: every tenant is
// its own subdomain, so a sweep is 11,316 unique DNS lookups and the resolver
// pacer dominates (measured: 500 tenants = 73s wall, 1,167s of cumulative DNS
// delay, extrapolating to ~28 min). Hourly would mean ~35 min of continuous
// network activity every hour for a segment that yields few matches.
//
// Usage: node fresh-alert.mjs [--tier fast|deep] [--notify] [--quiet]

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { annotateSponsorship } from './sponsorship-filter.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};
const TIER = flag('--tier', 'fast');
const NOTIFY = args.includes('--notify');
const QUIET = args.includes('--quiet');

// timeoutMin must exceed the tier's real runtime with headroom. A too-short
// timeout kills the sweep mid-directory and reports a partial run as a clean
// one: the deep tier ran for weeks against a 50-minute cap it could never
// finish inside, which is why its log lines read "? boards".
const TIERS = {
  fast: { ats: 'greenhouse,lever,ashby', since: '1', timeoutMin: 50 },
  deep: { ats: 'workday,icims,bamboohr', since: '1', timeoutMin: 300 },
};
if (!TIERS[TIER]) {
  console.error(`unknown tier "${TIER}" — expected: ${Object.keys(TIERS).join(', ')}`);
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname);
const LOG_DIR = path.join(ROOT, 'data', 'alerts');
mkdirSync(LOG_DIR, { recursive: true });

const started = new Date();
const stamp = started.toISOString();

// ── Pass 1: portals.yml tracked_companies (scan.mjs) ────────────────────────
//
// The directory sweep below only reaches ATS platforms that publish a public
// company list. Employers on Oracle Cloud, SuccessFactors, Phenom, Avature and
// friends are reachable ONLY by name, via portals.yml — and scan.mjs, the thing
// that reads portals.yml, was scheduled nowhere. Providence was added to
// portals.yml on 2026-08-09 and still would never have fired an alert.
//
// It runs first because it is small (~40 companies, about a minute) and it is
// the highest-signal list: these are hand-picked local employers.
//
// scan.mjs prints matches without URLs, so the new rows are read off the tail
// of data/pipeline.md instead — that carries url | company | title | location.
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const pipelineLines = () => {
  try { return readFileSync(PIPELINE, 'utf8').split('\n').filter(l => l.startsWith('- [ ] ')); }
  catch { return []; }
};

const beforePending = new Set(pipelineLines());
let trackedFailed = null;
try {
  execFileSync(process.execPath, ['scan.mjs'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
} catch (e) {
  trackedFailed = e.message;
}

const trackedMatches = pipelineLines()
  .filter(l => !beforePending.has(l))
  .map((l) => {
    const [url, company, title, location] = l.replace(/^- \[ \] /, '').split('|').map(s => s.trim());
    return { source: 'portals', company: company || '?', title: title || '?', location: location || '', url: url || '' };
  })
  .filter(m => m.url && m.title !== '?');

// ── Pass 2: public ATS directory sweep ──────────────────────────────────────
let stdout = '';
let failed = null;
try {
  stdout = execFileSync(
    process.execPath,
    ['scan-ats-full.mjs', '--ats', TIERS[TIER].ats, '--since', TIERS[TIER].since],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: TIERS[TIER].timeoutMin * 60 * 1000 }
  );
} catch (e) {
  // A partial sweep still yields usable matches, so parse whatever came back
  // rather than discarding the run.
  stdout = (e.stdout || '').toString();
  failed = e.message;
}

// Match lines look like:
//   + [greenhouse-full] 2026-08-07 | acme | Senior BI Developer | Remote - US
//     https://job-boards.greenhouse.io/acme/jobs/123
const matches = [];
const lines = stdout.split('\n');
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*\+\s*\[([^\]]+)\]\s*(\S+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.*)$/);
  if (!m) continue;
  const url = (lines[i + 1] || '').trim();
  matches.push({
    source: m[1],
    date: m[2],
    company: m[3],
    title: m[4],
    location: m[5],
    url: /^https?:\/\//.test(url) ? url : '',
  });
}

const scanned = (stdout.match(/Companies scanned:\s+([\d,]+)/) || [])[1] || '?';

// Tracked-company hits join the directory hits BEFORE the sponsorship gate and
// the alert, so a portals.yml employer gets identical treatment to a swept one.
matches.unshift(...trackedMatches);

// ── Sponsorship gate ────────────────────────────────────────────────────────
//
// config/profile.yml sets needs_sponsorship: true, and modes/_profile.md makes
// an explicit "we do not sponsor" a hard blocker. scan-ats-full filters on
// title and location only, so those postings arrive here and cost a read every
// time (3 of 5 recent matches on 2026-08-07). Match counts per run are small,
// so fetching each JD to check is cheap.
//
// Only an EXPLICIT refusal is dropped. Silence passes, and so does a fetch
// failure, so a network hiccup can never quietly discard a live role.
let blocked = [];
if (!args.includes('--no-sponsorship-filter') && matches.length) {
  const annotated = await annotateSponsorship(matches);
  blocked = annotated.filter((m) => m.sponsorship?.status === 'blocked');
  matches.length = 0;
  matches.push(...annotated.filter((m) => m.sponsorship?.status !== 'blocked'));
}

// Append to a rolling log so a missed notification is never a lost role.
const digest = [
  `\n## ${stamp} — tier: ${TIER} — ${matches.length} new (${scanned} boards)`,
  failed ? `> directory sweep ended early: ${failed}` : '',
  trackedFailed ? `> tracked-company scan failed: ${trackedFailed.split('\n')[0]}` : '',
  ...matches.map(
    (j) => `- **${j.company}** — ${j.title}${j.sponsorship?.status === 'positive' ? ' ✅ sponsors' : ''}\n  - ${j.location}\n  - ${j.url}`
  ),
  // Blocked roles are logged, never silently vanished: if the classifier is
  // ever wrong, the evidence sentence is right here to audit.
  ...(blocked.length
    ? [`\n<details><summary>${blocked.length} filtered: no visa sponsorship</summary>\n`,
       ...blocked.map((j) => `- ~~${j.company} — ${j.title}~~\n  - ${j.url}\n  - > ${j.sponsorship.evidence}`),
       '\n</details>']
    : []),
].filter(Boolean).join('\n');
appendFileSync(path.join(LOG_DIR, `${stamp.slice(0, 7)}.md`), digest + '\n');

// Latest-run snapshot, so anything downstream reads one predictable file.
writeFileSync(
  path.join(LOG_DIR, 'latest.json'),
  JSON.stringify({ ran_at: stamp, tier: TIER, boards: scanned, error: failed, matches, blocked }, null, 2)
);

// Scraped job titles reach AppleScript, which is an injection target, so
// quotes and backslashes are stripped rather than escaped.
const osaSafe = (s) => String(s).replace(/["\\]/g, '');

function notifyDesktop(body) {
  try {
    execFileSync('osascript', [
      '-e',
      `display notification "${osaSafe(body)}" with title "career-ops: fresh roles" sound name "Glass"`,
    ]);
  } catch {
    /* best-effort; never fail the sweep over a notification */
  }
}

/**
 * Text the user's own number via Messages.app. This is a note-to-self channel:
 * the recipient comes from config/profile.yml `alerts.imessage_to` and is the
 * user's own number, never an outbound contact.
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

if (NOTIFY && matches.length) {
  const n = matches.length;
  const plural = n > 1 ? 's' : '';
  notifyDesktop(`${n} new role${plural} — ${matches.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join(' · ')}`);

  // Read the destination lazily so removing the key cleanly disables iMessage.
  let imessageTo = null;
  try {
    const yaml = (await import('js-yaml')).default;
    const { readFileSync } = await import('node:fs');
    imessageTo = yaml.load(readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8'))?.alerts?.imessage_to || null;
  } catch { /* no profile, no iMessage */ }

  if (imessageTo) {
    const lines = matches.map((j) => `• ${j.company} — ${j.title}\n  ${j.location || 'location n/a'}\n  ${j.url}`);
    const suffix = blocked.length ? `\n\n(${blocked.length} filtered: no visa sponsorship)` : '';
    notifyIMessage(imessageTo, `career-ops: ${n} new role${plural}\n\n${lines.join('\n\n')}${suffix}`);
  }
}

if (!QUIET) {
  console.log(`[${stamp}] tier=${TIER} boards=${scanned} new=${matches.length}${blocked.length ? ` (${blocked.length} filtered: no sponsorship)` : ''}`);
  for (const j of matches) {
    const plus = j.sponsorship?.status === 'positive' ? '  ✅ sponsors' : '';
    console.log(`  + ${j.company} | ${j.title} | ${j.location}${plus}\n    ${j.url}`);
  }
  for (const j of blocked) console.log(`  - ${j.company} | ${j.title}  (no sponsorship)`);
  if (failed) console.log(`  ! directory sweep ended early: ${failed}`);
  if (trackedFailed) console.log(`  ! tracked-company scan failed: ${trackedFailed.split('\n')[0]}`);
}
