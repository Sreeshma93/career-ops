#!/usr/bin/env node
// archetype-gate.mjs — screen a job title against the configured target
// archetypes.
//
// WHY: portals.yml `title_filter` is a keyword OR-list, which is the right
// shape for a sweep (cast wide, cheap) and the wrong shape for an alert. On
// 2026-08-10 the hourly agent texted four roles that each matched a positive
// keyword while being the wrong discipline entirely. modes/_custom.md requires
// every hit be screened against the user's profile before it reaches them, and
// nothing was doing that.
//
// Three outcomes, not two:
//   primary — squarely one of the target archetypes. Alert it.
//   review  — adjacent (one step off the archetype). Alert it, flagged.
//   reject  — wrong discipline, wrong level, or built on a never-claim stack.
//
// The `review` tier exists because the adjacent titles are where sponsorship-
// willing employers often sit, and silently dropping them would narrow the
// search more than the user asked for.

import { loadPolicy } from './watch-policy.mjs';

// ── Policy ──────────────────────────────────────────────────────────────────
//
// The lists live in config/watch-policy.yml (gitignored) rather than here.
// `never_claim_stack` is a statement of which technologies the user cannot
// honestly claim, and this fork is PUBLIC: hardcoding it would publish it
// against a name-attached account mid-job-search. See watch-policy.mjs.
const { archetypes: POLICY } = loadPolicy();
const PRIMARY = POLICY.primary;
const SECONDARY = POLICY.secondary;
const WRONG_DISCIPLINE = POLICY.rejectDiscipline;
const WRONG_LEVEL = POLICY.rejectLevel;
const NEVER_CLAIM_STACK = POLICY.neverClaimStack;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const has = (hay, needle) => hay.includes(needle);

/**
 * Classify a job title. Returns { verdict, reason, tier }.
 *   verdict 'allow'  (tier 'primary' | 'secondary')
 *   verdict 'reject' (tier 'discipline' | 'level' | 'stack' | 'no-match')
 */
export function classifyArchetype(title, company = '') {
  const t = norm(title);
  if (!t) return { verdict: 'reject', reason: 'no title', tier: 'no-match' };

  const primaryHit = PRIMARY.find((p) => has(t, p));

  // Level is disqualifying even for a perfect archetype match: a Director of
  // Business Intelligence is still a Director.
  const levelHit = WRONG_LEVEL.find((p) => has(t, p));
  if (levelHit) return { verdict: 'reject', reason: `level: "${levelHit.trim()}"`, tier: 'level' };

  if (primaryHit) return { verdict: 'allow', reason: `archetype: ${primaryHit}`, tier: 'primary' };

  const disciplineHit = WRONG_DISCIPLINE.find((p) => has(t, p));
  if (disciplineHit) return { verdict: 'reject', reason: `discipline: "${disciplineHit.trim()}"`, tier: 'discipline' };

  // Only applied to non-primary titles: a target-archetype title AT a company
  // whose name is a never-claim technology is still a real target, whereas a
  // role built around that technology is not.
  const stackHit = NEVER_CLAIM_STACK.find((p) => has(t, p));
  if (stackHit) return { verdict: 'reject', reason: `never-claim stack in title: "${stackHit.trim()}"`, tier: 'stack' };

  const secondaryHit = SECONDARY.find((p) => has(t, p));
  if (secondaryHit) return { verdict: 'allow', reason: `adjacent: ${secondaryHit}`, tier: 'secondary' };

  return { verdict: 'reject', reason: 'no archetype match', tier: 'no-match' };
}

/** Annotate a batch of {title, company} matches, adding `archetype` to each. */
export function annotateArchetype(matches) {
  for (const m of matches) m.archetype = classifyArchetype(m.title, m.company);
  return matches;
}

// CLI: `node archetype-gate.mjs "Specialist Solutions Architect"`
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.slice(2).join(' ');
  if (!arg) {
    console.error('usage: node archetype-gate.mjs "<job title>"');
    process.exit(1);
  }
  console.log(JSON.stringify(classifyArchetype(arg), null, 2));
}
