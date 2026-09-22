#!/usr/bin/env bash
#
# The cross-repo gates, run before every parent commit.
#
# ## Why this exists
#
# 🔴 **Seventeen gates that nothing ran automatically** (F5). Each sub-repository
# has its own `ci.yml`; the parent has none, and the parent is where the
# cross-repository checks live -- type parity, capability parity, fixture hashes,
# wire keys, the ledger, and whether `ARCHITECTURE.md` still describes the code.
# They ran only when a person typed `bash bin/check.sh`.
#
# ⚠️ **And a GitHub workflow cannot fix that yet.** None of the four repositories
# has a git remote: nothing is pushed anywhere, so Actions has nothing to run and
# no sub-repository to check out. A workflow committed today would be a file that
# *looks* like enforcement -- which is worse than no file, because the finding
# would read as closed.
#
# So enforcement is local until a remote exists. `.github/workflows/ci.yml` is
# written and dormant, and says so.
#
# ## Why the logic is here rather than in `.git/hooks/`
#
# 📌 **`.git/hooks/` is not version controlled.** A hook written there exists on
# one machine and vanishes on a fresh clone. So the logic lives here and the hook
# is a two-line pointer at it, installed by `bin/install-hooks.sh`.
#
# 🔴 **This file is NOT yet committed, and neither are 12 of the gates it runs**
# (F49, F50). The project commits nothing by standing instruction, so a fresh
# clone gets **8 of 21** files from `bin/` and runs **6** gates, all of which fail
# for want of the sub-repositories. Measured 2026-09-22 by cloning to a temporary
# directory, not reasoned about.
#
# ⚠️ **So "the logic is committed" is the intent, not the state.** Until these
# files are tracked, this hook enforces on **one machine** — which is better than
# nothing and is not what a version-controlled hook means. Saying so here because
# a comment claiming a property the repository does not have is worse than no
# comment at all.
#
# ## Bypassing
#
# `git commit --no-verify` skips this, deliberately. A gate that cannot be
# bypassed gets bypassed by deleting it.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

printf '\033[1m== Cross-repo gates (pre-commit) ==\033[0m\n'

if ! bash "$ROOT/bin/check.sh"; then
  printf '\n\033[31mCommit refused: a cross-repo gate failed.\033[0m\n'
  printf 'Fix it, or commit with --no-verify if you know why it is wrong.\n'
  exit 1
fi

exit 0
