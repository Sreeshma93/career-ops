#!/usr/bin/env node
// location-gate.mjs — decide whether a posting's location is acceptable.
//
// WHY THIS EXISTS: portals.yml `location_filter` is a substring matcher, and a
// substring matcher cannot express this policy. Two failures made that concrete:
//
//   1. "Remote, Ontario" (telus-digital, 2026-08-10) was alerted as a match.
//      The block list carries "Canada" and "Toronto" but no PROVINCES, so a
//      Canadian posting that never writes the word Canada walks straight
//      through. Enumerating provinces in the block list would then break
//      Ontario, California — a real city in San Bernardino County.
//   2. The policy is conditional: on-site is acceptable in the home metro and
//      in the configured relocation metros, and NOT acceptable elsewhere in
//      the US, where only remote works. A flat allow/block pair has nowhere to
//      put a rule whose answer depends on the work model.
//
// So this gate tokenizes instead of substring-matching, and returns a verdict
// per posting rather than a boolean per keyword.
//
// Policy source: modes/_profile.md "Your Location Policy". Keep them in sync.

import { loadPolicy } from './watch-policy.mjs';

// ── Vocabulary ──────────────────────────────────────────────────────────────

const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

const US_STATE_NAMES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia',
]);

const US_MARKERS = [
  'united states', 'usa', 'u.s.a', 'u.s.', 'us-based', 'us based',
  'united states of america', 'nationwide', 'anywhere in the us',
  // Bare "us" earns its place: "Remote - US" is one of the most common
  // location strings on Greenhouse and Lever, and without this it fell through
  // to "remote, country not stated" and got flagged for review every time.
  // Safe only because this function is fed location strings, never prose,
  // so the pronoun sense ("join us") does not arise.
  'us',
];

// Canadian provinces are the specific hole that let telus-digital through.
// "GA" (Georgia) and "CA" (California) collide with nothing here, but note
// that Canadian province codes ARE included and are disambiguated below by
// requiring the absence of a US signal in the same string.
const CA_PROVINCES = new Set([
  'ontario','quebec','québec','british columbia','alberta','manitoba',
  'saskatchewan','nova scotia','new brunswick','newfoundland',
  'prince edward island','yukon','nunavut','northwest territories',
]);
const CA_PROVINCE_CODES = new Set(['ON','QC','BC','AB','MB','SK','NS','NB','NL','PE','YT','NT','NU']);

const NON_US_MARKERS = [
  'canada','mexico','brazil','argentina','colombia','chile','peru','uruguay',
  'united kingdom','great britain','england','scotland','wales','ireland',
  'germany','france','netherlands','spain','portugal','italy','poland',
  'romania','czech','slovakia','sweden','norway','denmark','finland',
  'switzerland','austria','belgium','luxembourg','greece','hungary','bulgaria',
  'serbia','croatia','ukraine','turkey','israel','india','pakistan','china',
  'hong kong','taiwan','japan','korea','singapore','malaysia','thailand',
  'vietnam','indonesia','philippines','australia','new zealand','south africa',
  'nigeria','kenya','egypt','morocco','uae','dubai','abu dhabi','saudi',
  'qatar','emea','apac','latam','emeia','europe','european','asia','africa',
  'middle east','nordic','benelux','dach','worldwide','global',
  // Cities distinctive enough to decide on their own.
  'toronto','vancouver','montreal','ottawa','calgary','london','dublin',
  'berlin','munich','paris','amsterdam','madrid','barcelona','lisbon','milan',
  'rome','warsaw','krakow','prague','bucharest','stockholm','oslo',
  'copenhagen','helsinki','zurich','geneva','vienna','brussels','athens',
  'budapest','belgrade','kyiv','istanbul','tel aviv','bangalore','bengaluru',
  'hyderabad','mumbai','delhi','gurgaon','pune','chennai','karachi','beijing',
  'shanghai','shenzhen','tokyo','osaka','seoul','sydney','melbourne',
  'auckland','sao paulo','são paulo','mexico city','guadalajara','bogota',
  'bogotá','buenos aires','santiago','lima',
];

// ── Policy geography ────────────────────────────────────────────────────────
//
// Loaded from config/watch-policy.yml (gitignored) rather than hardcoded:
// home_metro says where the user lives and relocation_metros says where they
// would move, and this fork is PUBLIC. Generic geography (US states, foreign
// countries, remote wording) stays above, since none of it is personal.
// See watch-policy.mjs.
const { location: GEO } = loadPolicy();

// Home metro. On-site, hybrid and remote are all acceptable here.
const HOME_METRO = GEO.homeMetro;

// Metros the user would relocate to. On-site acceptable. Satellites matter:
// "Somerville, Massachusetts" is Boston, and a bare metro list would reject it.
const RELOCATION_METROS = GEO.relocationMetros;

const REMOTE_MARKERS = [
  'remote','work from home','wfh','distributed','anywhere','virtual',
  'telecommute','home-based','home based','fully remote',
];
const ONSITE_MARKERS = ['on-site','onsite','in-office','in office','in-person'];
const HYBRID_MARKERS = ['hybrid','flexible'];

// ── Helpers ─────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Substring test that still respects word edges, so "CA" never matches
 *  "Canada" and "ITAR" never matches "military" (bug #4 in the handoff). */
function hasPhrase(haystack, phrase) {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, 'i').test(haystack);
}

/** Uppercase two-letter tokens, e.g. "Tustin, CA" -> ["CA"]. Case-sensitive
 *  on purpose: lowercase "on" in "Hands-on" is not the province of Ontario. */
function stateCodes(raw) {
  return (String(raw || '').match(/\b[A-Z]{2}\b/g) || []);
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Classify a posting location against the user's policy.
 *
 * Returns { verdict, reason, region, workModel }:
 *   verdict 'allow'   — meets the policy outright
 *   verdict 'review'  — cannot be decided from the string; PASSES to the user
 *                       with a flag, because "don't penalize missing data" is
 *                       the same rule the date and sponsorship gates follow
 *   verdict 'reject'  — outside the policy, with a reason worth logging
 */
export function classifyLocation(raw) {
  const text = norm(raw);
  const codes = stateCodes(raw);

  if (!text) return { verdict: 'review', reason: 'no location given', region: null, workModel: 'unknown' };

  // ── Work model ────────────────────────────────────────────────────────────
  const isRemote = REMOTE_MARKERS.some((m) => hasPhrase(text, m));
  const isHybrid = HYBRID_MARKERS.some((m) => hasPhrase(text, m));
  const isOnsite = ONSITE_MARKERS.some((m) => hasPhrase(text, m));
  const workModel = isRemote ? (isHybrid ? 'hybrid' : 'remote') : isHybrid ? 'hybrid' : isOnsite ? 'onsite' : 'unspecified';

  // ── US signal ─────────────────────────────────────────────────────────────
  const hasUsState = codes.some((c) => US_STATE_CODES.has(c))
    || [...US_STATE_NAMES].some((n) => hasPhrase(text, n));
  const hasUsMarker = US_MARKERS.some((m) => hasPhrase(text, m));
  const usSignal = hasUsState || hasUsMarker;

  // ── Non-US signal ─────────────────────────────────────────────────────────
  //
  // Provinces are checked ONLY when nothing in the string says United States.
  // That is what separates "Ontario" (the province, reject) from
  // "Ontario, CA" (San Bernardino County, keep) without needing a city list
  // for either. Same trick for the bare province codes.
  const foreignMarker = NON_US_MARKERS.find((m) => hasPhrase(text, m));
  const foreignProvince = !usSignal && [...CA_PROVINCES].find((p) => hasPhrase(text, p));
  const foreignCode = !usSignal && codes.find((c) => CA_PROVINCE_CODES.has(c) && !US_STATE_CODES.has(c));
  const foreign = foreignMarker || foreignProvince || foreignCode;

  // A posting listing BOTH ("San Francisco, CA • London") is a multi-location
  // req: the US half is real, so it passes and the string itself shows why.
  if (foreign && !usSignal) {
    return { verdict: 'reject', reason: `non-US location (${foreign})`, region: 'non-us', workModel };
  }

  // ── Home metro: any work model ────────────────────────────────────────────
  const home = HOME_METRO.find((c) => hasPhrase(text, c));
  if (home) return { verdict: 'allow', reason: `home metro (${home})`, region: 'home', workModel };

  // ── Relocation metros: on-site acceptable ─────────────────────────────────
  for (const [metro, cities] of Object.entries(RELOCATION_METROS)) {
    const hit = cities.find((c) => hasPhrase(text, c));
    if (hit) return { verdict: 'allow', reason: `relocation metro: ${metro} (${hit})`, region: 'relocation', workModel };
  }

  // ── Rest of the US: remote only ───────────────────────────────────────────
  if (isRemote) {
    if (usSignal) return { verdict: 'allow', reason: 'remote, US', region: 'us-remote', workModel };
    // "Remote · Remote" with no country at all. Common, and often really is a
    // US role, so it is surfaced for a human rather than dropped.
    return { verdict: 'review', reason: 'remote, country not stated', region: 'remote-unknown', workModel };
  }

  // Country-level only, e.g. a bare "United States" with no city and no state.
  // A posting that names no work site is not an on-site posting: it is
  // nationwide or unstated, and rejecting it as "on-site outside policy"
  // (which is what happened before this branch existed) drops exactly the
  // US-wide reqs worth seeing.
  if (hasUsMarker && !hasUsState) {
    return { verdict: 'allow', reason: 'US-wide, no work site named', region: 'us-remote', workModel };
  }

  if (usSignal) {
    return {
      verdict: 'reject',
      reason: 'on-site or hybrid outside the home metro and the relocation metros',
      region: 'us-elsewhere',
      workModel,
    };
  }

  return { verdict: 'review', reason: `unrecognized location: ${raw}`, region: null, workModel };
}

/** Annotate a batch of {location,...} matches, adding `locationGate` to each. */
export function annotateLocation(matches) {
  for (const m of matches) m.locationGate = classifyLocation(m.location);
  return matches;
}

// CLI: `node location-gate.mjs "Remote, Ontario"` for quick manual checks.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.slice(2).join(' ');
  if (!arg) {
    console.error('usage: node location-gate.mjs "<location string>"');
    process.exit(1);
  }
  console.log(JSON.stringify(classifyLocation(arg), null, 2));
}
