#!/usr/bin/env bash
#
# Point this repository's git hooks at the committed scripts in `bin/`.
#
# ## Why an installer rather than a committed hook
#
# 📌 **`.git/hooks/` cannot be version controlled**, so a hook only exists on the
# machine that wrote it. This installs a two-line pointer at `bin/pre-commit.sh`,
# so the logic can travel with the repository and the pointer is regenerated.
#
# ⚠️ **"Can travel" is the design; it does not travel yet** (F49). Neither this
# script nor `bin/pre-commit.sh` is tracked, because the project commits nothing
# by standing instruction. Until they are, running this installs a hook on **one
# machine**.
#
# Run once after cloning:
#
#     bash bin/install-hooks.sh
#
# ⚠️ **Refuses to overwrite a hook it did not write.** A developer's own
# pre-commit is theirs; silently replacing it is how a tool loses trust.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"
MARKER='# installed by bin/install-hooks.sh'

if [ ! -d "$ROOT/.git" ]; then
  printf '\033[31mNot a git repository: %s\033[0m\n' "$ROOT"
  exit 1
fi

if [ -f "$HOOK" ] && ! grep -q "$MARKER" "$HOOK"; then
  printf '\033[31mRefusing to overwrite an existing pre-commit hook.\033[0m\n'
  printf 'Move %s aside, or add this line to it:\n\n' "$HOOK"
  printf '    bash "%s" || exit 1\n' "$ROOT/bin/pre-commit.sh"
  exit 1
fi

cat > "$HOOK" <<HOOKEOF
#!/usr/bin/env bash
$MARKER
bash "\$(git rev-parse --show-toplevel)/bin/pre-commit.sh" || exit 1
HOOKEOF

chmod +x "$HOOK"

printf '\033[32mok\033[0m    pre-commit hook installed -> bin/pre-commit.sh\n'
printf '      The 17 cross-repo gates now run before every commit\n'
printf '      \033[1mon this machine only\033[0m -- the hook scripts are untracked (F49),\n'
printf '      so a fresh clone has neither them nor 12 of the gates.\n'
printf '      Bypass with `git commit --no-verify` when you know why.\n'
