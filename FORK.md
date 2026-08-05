# Fork maintenance

This is a personal fork of [santifer/career-ops](https://github.com/santifer/career-ops),
customized as it gets used. This file explains how to pull upstream changes down
without losing those customizations.

## Remotes

| Remote     | Points at                       | Purpose                                  |
| ---------- | ------------------------------- | ---------------------------------------- |
| `upstream` | `santifer/career-ops`           | Read-only source of updates. Push is disabled on purpose. |
| `origin`   | your GitHub fork                | Backup of your customized copy.          |

`main` tracks `upstream/main`, and `pull.rebase` is set to `true` for this repo,
so your commits always replay on top of upstream rather than creating merge commits.

## Routine sync

```bash
./sync-upstream.sh --push
```

That fetches upstream, rebases your commits on top, reinstalls dependencies if
`package.json` changed, runs `npm run doctor`, and force-pushes the result to your
fork. Drop `--push` to update locally only.

Roughly monthly is enough. The project releases often, but nothing breaks by
staying a few versions behind.

## Two update mechanisms, don't mix them up

This repo ships its own updater, and it does **not** behave like git.

| | `./sync-upstream.sh` (git rebase) | `npm run update` (built-in updater) |
| --- | --- | --- |
| Source | `upstream` remote | Hardcoded `santifer/career-ops` URL, ignores your remotes |
| Method | Rebase: merges history, conflicts surface | Checks out upstream files **over** your working tree |
| Your edits to system files | Preserved (or flagged as conflicts) | **Silently overwritten** |
| Your git history | Kept | Untouched, but the working tree changes underneath it |

The files the built-in updater overwrites are listed as `SYSTEM_PATHS` in
[`update-system.mjs`](update-system.mjs), all of `modes/`, the root `*.mjs`
scripts, `AGENTS.md`, `CLAUDE.md`, and the other CLI entry files.

**Use `./sync-upstream.sh`.** Reach for `npm run update` only if you want to discard
your customizations to system files and snap back to stock. Since your work is
committed to git, `git diff` afterwards will show you exactly what it took away.

## Your data is never pushed

Everything personal is already in upstream's `.gitignore`:

`cv.md` · `config/profile.yml` · `portals.yml` · `modes/_profile.md` ·
`modes/_custom.md` · `.env` · `data/` · `reports/*.md` · `output/`

So a public fork stays free of your CV, salary figures, and pipeline. Verify any time
with `git status`, those files should never appear as untracked or staged.

Because they are untracked, they are also **not backed up by pushing to the fork.**
Back them up separately (Time Machine, a private repo, or a cloud folder).

## Making your own changes

Commit them like anything else:

```bash
git add -A && git commit -m "tweak scan defaults for my target roles"
```

Prefer editing files that upstream doesn't own, `config/profile.yml`, `portals.yml`,
`modes/_profile.md`, `modes/_custom.template.md`, since those never conflict.
Edits to `modes/*.md` or the root `*.mjs` scripts will occasionally conflict on
rebase; that is normal and the script tells you how to resolve it.

## Conflict recovery

```bash
# during a conflicted rebase
git status                       # see which files clashed
# edit the files, remove the <<<<<<< markers
git add <file>
git rebase --continue

# or give up and return to where you were
git rebase --abort
```

If a rebase goes badly wrong, `git reflog` shows every prior position and
`git reset --hard <sha>` returns you to one.
