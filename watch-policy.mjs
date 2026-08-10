#!/usr/bin/env node
// watch-policy.mjs — load the targeting policy the alert gates enforce.
//
// WHY THIS IS A FILE AND NOT CONSTANTS IN THE GATES:
//
// The lists are personal. `never_claim_stack` is a statement of which
// technologies the user cannot honestly claim, and `home_metro` says where
// they live. This checkout is a PUBLIC fork, so hardcoding either into
// archetype-gate.mjs or location-gate.mjs would publish it against a
// name-attached GitHub account while the user is actively job hunting.
//
// So: config/watch-policy.yml holds the real values and is gitignored,
// config/watch-policy.example.yml ships generic defaults and is committed, and
// a fresh clone falls back to the example rather than crashing.
//
// Keep config/watch-policy.yml in sync with modes/_profile.md. That file is the
// human statement of the policy and is what evaluations read; this is the
// machine form the alert path enforces.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname);
const USER = path.join(ROOT, 'config', 'watch-policy.yml');
const EXAMPLE = path.join(ROOT, 'config', 'watch-policy.example.yml');

let cached = null;

/** Load the policy, preferring the user's file. Cached for the process. */
export function loadPolicy() {
  if (cached) return cached;

  const file = existsSync(USER) ? USER : EXAMPLE;
  let cfg = {};
  try {
    cfg = yaml.load(readFileSync(file, 'utf8')) || {};
  } catch (e) {
    // A malformed policy must be loud. Silently falling back to empty lists
    // would turn every gate into a pass-through, and the user would see a
    // flood of junk alerts with no indication why.
    throw new Error(`watch-policy: could not parse ${path.basename(file)} — ${e.message}`);
  }

  const arr = (v) => (Array.isArray(v) ? v.map((s) => String(s).toLowerCase()) : []);
  const a = cfg.archetypes || {};
  const l = cfg.location || {};

  const relocation = {};
  for (const [metro, cities] of Object.entries(l.relocation_metros || {})) {
    relocation[String(metro).toLowerCase()] = arr(cities);
  }

  cached = {
    source: path.basename(file),
    isUserPolicy: file === USER,
    archetypes: {
      primary: arr(a.primary),
      secondary: arr(a.secondary),
      rejectDiscipline: arr(a.reject_discipline),
      rejectLevel: arr(a.reject_level),
      neverClaimStack: arr(a.never_claim_stack),
    },
    location: {
      homeMetro: arr(l.home_metro),
      relocationMetros: relocation,
    },
  };
  return cached;
}

// CLI: `node watch-policy.mjs` prints which file is in effect and its sizes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = loadPolicy();
  console.log(JSON.stringify({
    source: p.source,
    isUserPolicy: p.isUserPolicy,
    counts: {
      primary: p.archetypes.primary.length,
      secondary: p.archetypes.secondary.length,
      rejectDiscipline: p.archetypes.rejectDiscipline.length,
      rejectLevel: p.archetypes.rejectLevel.length,
      neverClaimStack: p.archetypes.neverClaimStack.length,
      homeMetro: p.location.homeMetro.length,
      relocationMetros: Object.keys(p.location.relocationMetros).length,
    },
  }, null, 2));
}
