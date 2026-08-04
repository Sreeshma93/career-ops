#!/usr/bin/env bash
#
# Sync this fork with upstream santifer/career-ops.
#
# Your own commits are replayed on top of upstream's latest main (rebase),
# so your customizations survive the update.
#
#   ./sync-upstream.sh          # pull upstream changes into local main
#   ./sync-upstream.sh --push   # ...and push the result to your GitHub fork
#
# See FORK.md for the full workflow and conflict handling.

set -euo pipefail
cd "$(dirname "$0")"

PUSH=0
[[ "${1:-}" == "--push" ]] && PUSH=1

# A rebase over a dirty tree loses work. Refuse instead.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ You have uncommitted changes to tracked files."
  echo "  Commit them first (git add -A && git commit -m 'my changes'),"
  echo "  or park them with 'git stash'. Then re-run this script."
  echo
  git status --short --untracked-files=no
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "✗ You are on '$branch', not main. Switch with: git checkout main"
  exit 1
fi

before="$(git rev-parse HEAD)"

echo "→ Fetching upstream..."
git fetch upstream main

if [[ "$(git rev-parse HEAD)" == "$(git rev-parse upstream/main)" ]]; then
  echo "✓ Already up to date with upstream."
else
  echo "→ Replaying your commits on top of upstream/main..."
  if ! git rebase upstream/main; then
    echo
    echo "✗ Rebase hit a conflict — upstream changed a file you also changed."
    echo "  Fix the marked files, then: git add <file> && git rebase --continue"
    echo "  Or bail out entirely with:   git rebase --abort"
    exit 1
  fi
fi

# package-lock.json is gitignored here, so compare the manifest instead.
if ! git diff --quiet "$before" HEAD -- package.json; then
  echo "→ Dependencies changed upstream, reinstalling..."
  npm install
fi

echo "→ Verifying setup..."
npm run doctor

if [[ "$PUSH" == "1" ]]; then
  if git remote get-url origin >/dev/null 2>&1; then
    # Rebase rewrites history, so the fork needs a force push.
    # --force-with-lease refuses if origin has commits you have not seen.
    echo "→ Pushing to your fork (force-with-lease)..."
    git push --force-with-lease origin main
  else
    echo "! No 'origin' remote configured — nothing to push."
    echo "  See FORK.md to connect your GitHub fork."
  fi
else
  echo
  echo "Local main is updated. To back it up to your fork:"
  echo "  ./sync-upstream.sh --push"
fi

echo "✓ Done."
