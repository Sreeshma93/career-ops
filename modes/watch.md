# Mode: watch

The scheduled job-alert path. One command, one schedule, four gates.

Replaces `fresh-alert.mjs` and the two hand-written launchd agents
(`io.careerops.fresh-alert`, `io.careerops.fresh-alert-deep`), retired
2026-08-10. Their plists are archived at `data/alerts/retired/` for reference.

## Command

```bash
node watch.mjs [--tier fast|deep|auto] [--notify] [--quiet] [--dry-run]
```

| Flag | Effect |
|---|---|
| `--tier auto` | Default. Fast tier every run, plus the deep tier when the last deep sweep is more than 20 hours old. This is what the schedule uses. |
| `--tier fast` | Greenhouse + Lever + Ashby, 15,862 boards, about 10 minutes. |
| `--tier deep` | Workday + iCIMS + BambooHR, 34,308 boards, about 2.5 hours. |
| `--notify` | macOS banner plus iMessage. Fires only when there is at least one match. |
| `--dry-run` | Runs every sweep and gate, writes nothing, notifies nobody. |
| `--no-content-gates` | Skips the sponsorship and clearance fetches. Debugging only. |

There is deliberately no second schedule for the deep tier. The script tracks
`lastDeepRun` in `data/alerts/watch-state.json` and folds it in when due, so two
sweeps can never overlap the way two independent agents could.

## Search on demand

```bash
node watch.mjs --search
```

Same passes, same gates, same policy as the scheduled run. The one difference:
**first-sighting dedup is off**, so it answers "everything that fits right now"
rather than "what changed since last time". Roles already alerted on reappear,
which is intended, and there is deliberately no suppression logic for them.

| Flag | Effect |
|---|---|
| `--search` | On-demand mode. Implies `--dry-run`, never notifies. |
| `--since N` | How many days back to look. Default 1. |
| `--tier fast` | Default for `--search`. About 10 minutes. |
| `--tier deep` | Workday + iCIMS + BambooHR. About 2.5 hours. |
| `--tier all` | Both. `--tier auto` is rejected here: "is the deep sweep due" is meaningless on demand. |

Common forms:

```bash
node watch.mjs --search --since 3
```

```bash
node watch.mjs --search --tier all --since 7
```

**It writes nothing.** No `pipeline.md` rows, no `scan-history.tsv` rows, no
monthly log, no `latest.json`, no `portals.yml` growth, no iMessage. That is
load-bearing rather than politeness: a full re-listing written back would flood
`pipeline.md` with thousands of rows and rewrite `scan-history.tsv`, and
destroying that file destroys the first-sighting signal the scheduled path is
built on.

**The freshness gate is skipped in search mode.** The sweep's own `--since`
window already bounds the results, and layering a 3-hour cutoff on top would
make an on-demand search return roughly what the last alert returned. Age is
still computed and still reported in hours.

Everything else is identical: the archetype, location, sponsorship and clearance
gates all apply, and rejections are still listed with their reasons.

## The gate chain

Cheapest gates first, so the network-backed ones only ever see survivors.

| Order | Gate | Module | Cost | Rejects |
|---|---|---|---|---|
| 1 | Archetype | `archetype-gate.mjs` | none | Wrong discipline, wrong level, never-claim stack in the title |
| 2 | Location | `location-gate.mjs` | none | Non-US, and on-site outside OC/LA and the seven relocation metros |
| 3 | Freshness | inline | none | Dated postings past their window |
| 4 | Sponsorship | `sponsorship-filter.mjs` | 1 fetch | Explicit refusal to sponsor |
| 5 | Clearance | `clearance-filter.mjs` | shares the fetch, plus 1 for the form | Clearance, ITAR US Person, citizenship |

Gates 4 and 5 share a single JD fetch per posting. Nothing is fetched twice.

Every gate **annotates**, never deletes. Rejections land in the monthly log
under a collapsed `<details>` block with their evidence sentence, so a wrong
call is auditable rather than invisible.

Both content gates **fail open**: a fetch failure classifies as silent and the
posting passes. A network hiccup must never quietly discard a live role.

## Freshness

Two windows, because the providers are not comparable:

- **3 hours** when the provider stamps a real time. Greenhouse, Lever, Ashby and
  Oracle Cloud do.
- **48 hours** when the stamp is a day bucket. Workday and iCIMS land on
  midnight UTC, so hour precision would be fiction. A midnight-exact timestamp
  is treated as day precision.
- **No window** when there is no date at all. First sighting carries it.

First-sighting dedup (`scan-ats-full.mjs` against `data/scan-history.tsv`) is
the primary guarantee: anything reported did not exist on the previous sweep.
The timestamp check is secondary, and exists to catch a board newly added to the
public dataset dumping its whole backlog as "new".

**Always report age in hours**, and say which basis was used. Never say "recent".

## Company-list growth

`watch.mjs` appends to `portals.yml` `tracked_companies` automatically when a
match clears every gate at a company that is not tracked yet. The vendor and
tenant are read straight off the job URL, so this costs no extra network calls.
`portals.yml` is backed up to `portals.yml.bak` before each append, entries are
tagged `auto-added by watch.mjs`, and the digest names every company added.

**This cannot find the Oracle Cloud class of employer.** Oracle Cloud,
SuccessFactors, Phenom, Avature and Radancy publish no company directory, so no
sweep can discover them and they are reachable only by name. That is exactly how
Providence, Hoag and Masimo stayed invisible. Closing that gap is a periodic
manual step, roughly monthly:

```bash
node detect-ats.mjs --in config/socal-employers.yml
```

Anything it reports as "provider exists, needs portals.yml entry" gets added by
hand. Verify the board returns a non-zero job count before adding it: Oracle
Cloud site numbers vary, and `CX_1` frequently exists while returning zero when
the live board is `CX_1002`.

## Reporting rules

Carried over from `modes/_custom.md`, and they still apply when reporting a run
to the user:

1. **Screen every hit against `modes/_profile.md`.** The gates do the mechanical
   part; level, comp and stack fit still need a read. Never hand over a raw list.
2. **Give posting age in hours.**
3. **State the board count explicitly, including when the result is zero.**
   "0 new across 15,862 boards" is a real answer. Silence reads as a failure.
4. **Say when the machine slept.** Gaps over ~70 minutes between runs in
   `data/alerts/*.md` are lost coverage, not clean scans.

## Reading a run without re-running one

```bash
cat data/alerts/latest.json
```

Carries `matches`, `rejected` (with gate and evidence), `grown`, `boards`,
`degraded` and `sweepErrors`. The month's history is `data/alerts/YYYY-MM.md`.
Do not re-run a sweep just to answer "what did the scanner find".

## Alerting

macOS banner plus iMessage to `config/profile.yml` `alerts.imessage_to`.

iMessage was chosen over a paid SMS gateway on 2026-08-10. The tradeoff is
explicit: delivery requires the Mac awake with Messages signed in. If alerts
ever need to arrive independently of the machine, that means Twilio, an account
and an API key, and the user has to set those up.

Alerts fire **only on matches**. An empty run stays silent, or the channel
trains the user to ignore it.

## Known limits

- Workday and iCIMS publish no application-form schema, so a clearance question
  asked only in their forms is still invisible. Greenhouse is covered.
- Greenhouse rate-limits to HTTP 406 under heavy sweeping and recovers in hours.
  No backoff is implemented yet.
- Directory datasets are incomplete. PIMCO (Ashby) and Applied Medical (iCIMS)
  are absent from the public lists despite running swept platforms. Tracking
  them in `portals.yml` is the workaround.
- Delivery stops when the Mac sleeps. AC sleep is disabled; battery sleep is
  not, so unplugged hours are uncovered.
