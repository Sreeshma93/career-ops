# Mode: search

Run the scheduled alert search **right now**, on demand.

Same passes, same gates and same policy as the hourly agent
(`io.careerops.watch`), with one difference: **first-sighting dedup is off**, so
roles already alerted on reappear. That is intended. Do not suppress them, do
not cross-reference `data/alerts/*.md` to hide them, and do not apologize for
repeats.

Full mechanics: `modes/watch.md`.

## Run it

```bash
node watch.mjs --search
```

Default: last 1 day, Greenhouse + Lever + Ashby, ~15,900 boards, about
10 minutes.

| Ask | Command |
|---|---|
| Wider window | `node watch.mjs --search --since 7` |
| Every board career-ops can reach (~50,200, about 2.5 h) | `node watch.mjs --search --tier all` |
| Workday + iCIMS + BambooHR only | `node watch.mjs --search --tier deep` |

Pick the window from what the user asked for. "Anything new today" is the
default; "what's out there" wants `--since 7` or more. If they ask for
everything, say the deep tier takes about 2.5 hours before starting it.

`--tier auto` is rejected here on purpose: "is the deep sweep due" is a
scheduling question and means nothing on demand.

## It writes nothing

No `pipeline.md` rows, no `scan-history.tsv` rows, no monthly log, no
`latest.json`, no `portals.yml` growth, no iMessage. This is load-bearing:
a full re-listing written back would flood `pipeline.md` and rewrite
`scan-history.tsv`, and that file is the first-sighting signal the scheduled
alerts depend on.

**Never pass `--ignore-history` to `scan.mjs` or `scan-ats-full.mjs` directly
without `--dry-run`.** `--search` pairs them for you.

## Reporting

The gates do the mechanical screening. They do not do judgment, so before
handing results over:

1. **Screen every hit against `modes/_profile.md`** for level, comp, stack fit
   and sponsorship. Never hand over a raw dump. Call out anything that clears
   the gates but fails the profile, and say why.
2. **Give posting age in hours.** Postings marked `no posting date published`
   have no provider timestamp at all: say that rather than guessing.
3. **State the board count explicitly, including when the result is zero.**
   "0 across 15,862 boards" is a real answer; silence reads as a failure.
4. **Flag roles marked `[adjacent]`** as adjacent rather than on-target. They
   matched the secondary tier, not an archetype.
5. **Mention the filtered count** and offer the breakdown. Do not paste the
   whole rejection list unless asked.

## Known quirks

- A company tracked in `portals.yml` that also sits on a swept ATS can appear
  twice under different casing, once per pass. Cosmetic; mention it rather than
  presenting the two as separate openings.
- Tracked-company results carry no posting date, so they always read
  `no posting date published`.
