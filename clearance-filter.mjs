#!/usr/bin/env node
// clearance-filter.mjs — classify a posting's security-clearance / citizenship
// requirement.
//
// WHY: modes/_profile.md makes "requires an active security clearance or US
// citizenship" a hard blocker, alongside the sponsorship gate. For a candidate
// who needs sponsorship these are not negotiable and not worth a read.
//
// TWO FAILURES THIS FIXES:
//
//   1. `/ITAR/i` matched the substring in mil-ITAR-y and produced 16 false
//      positives on Anduril. Every pattern here is word-bounded, and the
//      module ships with a regression test for exactly that string.
//   2. Clearance is frequently absent from the JD body and asked ONLY in the
//      application form. Four Anduril roles read clean and gated at the form.
//      Greenhouse exposes the form schema (`?questions=true` on the board API),
//      so those questions are fetched and scanned too.
//
// Classification is asymmetric, matching sponsorship-filter.mjs:
//   blocked — an explicit clearance/citizenship requirement is present
//   silent  — no clearance language at all. ALWAYS PASSES.
//
// Coverage is honest about its own limits: Workday and iCIMS do not publish a
// form schema, so a posting there can still be form-gated and read clean. The
// verdict carries `checkedForm` so a report can say which.

// ── Patterns ────────────────────────────────────────────────────────────────
//
// Note the word boundaries on the acronyms. `\bITAR\b` cannot match "military";
// the old unbounded version did.
const BLOCK_PATTERNS = [
  // Clearance, in the forms postings actually write it.
  /\b(?:active|current|existing|maintain(?:s|ing)?|obtain(?:ing)?)\b[^.]{0,40}\bsecurity clearance\b/i,
  /\bsecurity clearance\b[^.]{0,40}\b(?:is |are )?(?:required|mandatory|necessary)\b/i,
  /\b(?:must|will need to|need to)\b[^.]{0,40}\b(?:hold|possess|have|obtain)\b[^.]{0,30}\bclearance\b/i,
  /\bTS\s*\/\s*SCI\b/i,
  /\btop secret\b/i,
  /\bsecret clearance\b/i,
  /\bDoD\s+(?:secret|clearance)\b/i,
  /\bpublic trust\b[^.]{0,30}\b(?:clearance|required)\b/i,
  /\bpolygraph\b/i,
  /\bclearance eligib\w+/i,
  /\bable to obtain (?:and maintain )?a\b[^.]{0,30}\bclearance\b/i,

  // ITAR / export control. Bounded, and "US Person" only counts in the
  // export-control sense, never as a stray phrase.
  /\bITAR\b/,
  /\bEAR\b(?=[^a-z])/,
  /\bexport control(?:led|s)?\b[^.]{0,60}\b(?:U\.?S\.?\s*person|citizen)/i,
  /\b(?:U\.?S\.?|United States)\s*Person\b[^.]{0,60}\b(?:as defined|status|required|ITAR|EAR)\b/i,
  /\bmust (?:be|qualify as) a\b[^.]{0,20}\b(?:U\.?S\.?|United States)\s*Person\b/i,

  // Citizenship requirements.
  /\bmust be a\b[^.]{0,20}\b(?:U\.?S\.?|United States)\s+citizen\b/i,
  /\b(?:U\.?S\.?|United States)\s+citizenship\b[^.]{0,40}\b(?:is |are )?(?:required|mandatory)\b/i,
  /\brequires?\b[^.]{0,30}\b(?:U\.?S\.?|United States)\s+citizenship\b/i,
  /\bcitizens(?:hip)? only\b/i,
  /\bU\.?S\.?\s+citizens\b[^.]{0,30}\bonly\b/i,
  /\brestricted to\b[^.]{0,30}\b(?:U\.?S\.?|United States)\s+citizens\b/i,
];

/** Classify JD or form text. Returns { status, evidence }. */
export function classifyClearance(text) {
  if (!text || text.length < 40) return { status: 'silent', evidence: null };
  const flat = text.replace(/\s+/g, ' ');

  for (const re of BLOCK_PATTERNS) {
    const m = flat.match(re);
    if (!m) continue;
    // Surrounding sentence, so a wrong call is auditable rather than a boolean.
    const i = flat.indexOf(m[0]);
    const start = Math.max(0, flat.lastIndexOf('.', i) + 1);
    const end = flat.indexOf('.', i + m[0].length);
    return {
      status: 'blocked',
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
 * Fetch the Greenhouse APPLICATION FORM questions for a posting.
 *
 * This is the half a JD-text scan cannot see. `?questions=true` returns the
 * field list, and a clearance gate shows up as a question label such as
 * "Are you a U.S. Person as defined by ITAR?" with yes/no values.
 *
 * Returns '' when the URL is not Greenhouse or the fetch fails, so the caller
 * classifies `silent` and the posting passes. Fail open, always.
 */
export async function fetchGreenhouseFormText(url, timeoutMs = 15000) {
  const gh = String(url || '').match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#&]+)\/jobs\/(\d+)/)
    || String(url || '').match(/greenhouse\.io\/([^/?#&]+)\/jobs\/(\d+)/);
  if (!gh) return '';

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}?questions=true`,
      { signal: ctl.signal, headers: { 'user-agent': 'career-ops clearance-filter' } }
    );
    if (!r.ok) return '';
    const j = await r.json();
    // Question labels AND their option values: the gate is sometimes the
    // dropdown option ("Active TS/SCI"), not the question label.
    const parts = [];
    for (const q of j.questions || []) {
      if (q.label) parts.push(strip(q.label));
      for (const f of q.fields || []) {
        for (const v of f.values || []) if (v.label) parts.push(strip(v.label));
      }
    }
    return parts.join('. ');
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

/**
 * Classify a batch of matches that already carry `jdText` (fetched once by the
 * caller and shared with the sponsorship gate, so no posting is fetched twice).
 * Adds `clearance` to each.
 */
export async function annotateClearance(matches, concurrency = 6) {
  const out = [...matches];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, out.length) }, async () => {
    while (i < out.length) {
      const idx = i++;
      const m = out[idx];

      const fromJd = classifyClearance(m.jdText || '');
      if (fromJd.status === 'blocked') {
        m.clearance = { ...fromJd, source: 'jd', checkedForm: false };
        continue;
      }

      const formText = await fetchGreenhouseFormText(m.url);
      if (!formText) {
        m.clearance = { status: 'silent', evidence: null, source: 'jd', checkedForm: false };
        continue;
      }
      const fromForm = classifyClearance(formText);
      m.clearance = { ...fromForm, source: fromForm.status === 'blocked' ? 'form' : 'jd', checkedForm: true };
    }
  });
  await Promise.all(workers);
  return out;
}

// CLI: `node clearance-filter.mjs "some text"` or a Greenhouse URL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.slice(2).join(' ');
  if (!arg) {
    console.error('usage: node clearance-filter.mjs "<text or greenhouse url>"');
    process.exit(1);
  }
  if (/^https?:\/\//.test(arg)) {
    const form = await fetchGreenhouseFormText(arg);
    console.log(JSON.stringify({ formFound: Boolean(form), ...classifyClearance(form) }, null, 2));
  } else {
    console.log(JSON.stringify(classifyClearance(arg), null, 2));
  }
}
