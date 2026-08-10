#!/usr/bin/env node
// detect-ats.mjs — identify which ATS an employer actually runs.
//
// discover-ats.mjs probes Greenhouse/Ashby/Lever by guessing a slug from the
// company name. That works for startups and fails for large employers, which
// mostly run Workday, iCIMS, SuccessFactors, Oracle Cloud, Phenom or Avature —
// platforms whose URLs cannot be guessed from a name.
//
// This works the other way round: follow the company's own careers page and
// read the ATS off the redirect chain, the HTML, and any embedded iframe. That
// is how you learn the real tenant coordinates (e.g. edwards.wd5.../edwardscareers)
// which portals.yml needs.
//
// Usage: node detect-ats.mjs --in config/socal-employers.yml [--json]

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const inFile = args[args.indexOf('--in') + 1];
const AS_JSON = args.includes('--json');
if (!inFile || inFile.startsWith('--')) {
  console.error('Usage: node detect-ats.mjs --in <companies.yml> [--json]');
  process.exit(1);
}

// Ordered: the first match wins, so put the specific hosts before generic ones.
const SIGNATURES = [
  [/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i, 'workday'],
  [/careers-([a-z0-9-]+)\.icims\.com/i, 'icims'],
  [/([a-z0-9-]+)\.icims\.com/i, 'icims'],
  [/jobs\.smartrecruiters\.com\/([A-Za-z0-9]+)/i, 'smartrecruiters'],
  [/job-boards\.(?:eu\.)?greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/boards\.greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.(?:eu\.)?lever\.co\/([a-z0-9-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, 'ashby'],
  [/([a-z0-9-]+)\.bamboohr\.com/i, 'bamboohr'],
  [/career\d*\.successfactors\.(?:com|eu)/i, 'successfactors'],
  [/([a-z0-9-]+)\.sapsf\.(?:com|eu)/i, 'successfactors'],
  [/([a-z0-9-]+)\.fa\.(?:us\d|em\d|ocs)\.oraclecloud\.com/i, 'oraclecloud'],
  [/([a-z0-9-]+)\.phenompeople\.com/i, 'phenom'],
  [/([a-z0-9-]+)\.avature\.net/i, 'avature'],
  [/([a-z0-9-]+)\.csod\.com/i, 'cornerstone'],
  [/([a-z0-9-]+)\.taleo\.net/i, 'taleo'],
  [/jobs\.jobvite\.com\/([a-z0-9-]+)/i, 'jobvite'],
  [/([a-z0-9-]+)\.recruitee\.com/i, 'recruitee'],
  [/apply\.workable\.com\/([a-z0-9-]+)/i, 'workable'],
  [/([a-z0-9-]+)\.breezy\.hr/i, 'breezy'],
  [/([a-z0-9-]+)\.teamtailor\.com/i, 'teamtailor'],
  [/([a-z0-9-]+)\.dayforcehcm\.com/i, 'dayforce'],
  [/recruiting\d*\.ultipro\.com/i, 'ultipro'],
  [/workforcenow\.adp\.com/i, 'adp'],
  [/([a-z0-9-]+)\.paylocity\.com/i, 'paylocity'],
  [/([a-z0-9-]+)\.jibeapply\.com/i, 'jibeapply'],
  [/([a-z0-9-]+)\.radancy\.(?:com|net)/i, 'radancy'],
  [/eightfold\.ai|\.eightfold\./i, 'eightfold'],
];

// Which detected platforms the reverse sweep can already scan, vs those that
// need a per-company portals.yml entry, vs those with no provider at all.
const SWEEPABLE = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'bamboohr']);
const HAS_PROVIDER = new Set([
  ...SWEEPABLE, 'smartrecruiters', 'successfactors', 'oraclecloud', 'phenom',
  'avature', 'cornerstone', 'jobvite', 'recruitee', 'workable', 'breezy',
  'teamtailor', 'jibeapply', 'radancy',
]);

async function grab(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const body = await r.text();
    return { finalUrl: r.url, body };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function identify(text) {
  for (const [re, vendor] of SIGNATURES) {
    const m = text.match(re);
    if (m) return { vendor, evidence: m[0] };
  }
  return null;
}

const cfg = yaml.load(readFileSync(inFile, 'utf8'));
const companies = cfg.companies || [];
const results = [];

let idx = 0;
const CONCURRENCY = 6;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < companies.length) {
      const c = companies[idx++];
      const site = (c.website || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!site) { results.push({ name: c.name, vendor: null }); continue; }

      let hit = null;
      // Careers pages sit at a handful of conventional paths; stop at the first
      // that identifies a vendor rather than fetching all of them every time.
      for (const path of ['/careers', '/careers/', '/jobs', '/about/careers', '/en/careers', '/company/careers', '']) {
        const res = await grab(`https://${site}${path}`);
        if (!res) continue;
        hit = identify(res.finalUrl) || identify(res.body);
        if (hit) break;
      }
      results.push({ name: c.name, website: site, ...(hit || { vendor: null }) });
    }
  })
);

results.sort((a, b) => (a.vendor || 'zzz').localeCompare(b.vendor || 'zzz') || a.name.localeCompare(b.name));

if (AS_JSON) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const by = {};
  for (const r of results) (by[r.vendor || 'unknown'] ??= []).push(r);
  console.log(`\nATS detection — ${results.length} employers\n`);
  for (const [vendor, list] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    const tag = vendor === 'unknown' ? '?  not detected'
      : SWEEPABLE.has(vendor) ? '✅ already swept'
      : HAS_PROVIDER.has(vendor) ? '➕ provider exists, needs portals.yml entry'
      : '⚠️  no provider';
    console.log(`${vendor.toUpperCase()} (${list.length}) — ${tag}`);
    for (const r of list) console.log(`   ${r.name}${r.evidence ? `\n     ${r.evidence}` : ''}`);
    console.log('');
  }
}
