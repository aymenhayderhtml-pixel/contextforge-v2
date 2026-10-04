# Pushing ContextForge v2

**This repository is already public and pushed.** `origin` points at
`https://github.com/<your-github-handle>/contextforge-v2.git`, and `main` is
tracking it.

Nothing here needs doing unless you are starting fresh on another machine, or
publishing a fork.

---

## Where it stands right now

| | |
| --- | --- |
| **Remote** | `origin` → `https://github.com/<your-github-handle>/contextforge-v2.git` |
| **Branch** | `main`, tracking `origin/main` |
| **Visibility** | public |
| **Licence** | MIT — `LICENSE`, `Copyright (c) 2026 Aymen Hayder` |

Check it yourself:

```bash
git remote -v
git status -sb          # should say "## main...origin/main"
gh repo view --json visibility,url
```

---

## Every day: committing

Nothing here is unusual.

```bash
cd "<your-projects-folder>/contextforge-v2"
npm run verify          # 75 files, 1501 tests — must be green before you commit
git add -A
git commit -m "What changed and why"
git push
```

`npm run verify` before committing is not ceremony: two of the bugs fixed in
Step 5 (a silent data-loss in `generateProject`, and an extraction that died on
one broken file) were both invisible to `typecheck` and to reading the code.

---

## First push on a new machine

Only if `git remote -v` is empty.

### With `gh` (installed)

```bash
cd "<your-projects-folder>/contextforge-v2"
gh auth login                                    # once
gh repo create contextforge-v2 --public --source=. --remote=origin --push
```

`--source=.` uses this folder; `--remote=origin` names the remote; `--push`
sends `main` immediately.

### Without `gh`

```bash
cd "<your-projects-folder>/contextforge-v2"
git remote add origin https://github.com/<you>/contextforge-v2.git
git push -u origin main
```

Create the empty repository on GitHub first (with **no** README, licence or
`.gitignore` — this repo already has all three, and a remote README would
conflict on the first push).

---

## A fork

```bash
gh repo fork --remote-name fork
git push fork main
```

The licence and the `MIT` notice travel with the fork. The copyright line still
names the original author, which is what MIT asks for.

---

## Before making it public, if you have not yet

The repo is already public, so this is for a **new** project or a reset. Three
things to check first — the first two are automated here, the third is a
judgement call.

```bash
# 1. No secrets in tracked files
git grep -nEi "(api[_-]?key|secret|token|password|bearer)['\"]?\s*[:=]" -- '*.ts' '*.json' '*.mjs'

# 2. No personal absolute paths. The user name is a wildcard rather than a
#    literal, so this command does not match the line above it — a literal here
#    would make every clean run report a hit in this very file.
git grep -nE "/home/[a-z]+/" || echo "clean: no personal paths in tracked files"

# 3. Build output is ignored, not committed
git ls-files | grep -E "node_modules|/dist/|tsbuildinfo|\.contextforge" 
```

3. **Screenshots.** `screenshots/` is committed on purpose — it is the evidence
behind the claims in the README. The *publishable* copies in `docs/images/` are
run through `scripts/redact-screenshots.py`, which replaces the author's absolute
path with a neutral placeholder. If you add a capture, redact it before it goes
into `docs/images/`:

```bash
python3 scripts/redact-screenshots.py   # needs Pillow; not part of npm run verify
```

The one place the personal path still appears in the tree is
`scripts/redact-screenshots.py`'s own docstring, where it is quoted as the worked
example the script exists to remove. That is deliberate.

**Correction (2026-10-04):** that sentence was wrong. The docstring's example had
already been redacted to `<project-path>`, and every `screenshots/*/report*.json`
now records its project as `<your-projects-folder>/…`. Nothing personal remains
outside `LICENSE`.

Worth keeping as a checklist item though: **a report written by a fresh harness
contains the real path until it is redacted**, and three of them were. That is why
step 1 above is a command to run rather than a claim to trust.

---

## Verifying a push landed

```bash
git fetch origin
git log --oneline origin/main -3
git status -sb                    # no "ahead" means everything arrived
```

Anonymously, without being logged in — this is what proves the repo is genuinely
public rather than merely visible to you:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://raw.githubusercontent.com/<your-github-handle>/contextforge-v2/main/README.md
```

---

## Undo, before anyone clones

Commit history is rewritten in place, so this only works cleanly while the repo
is private or uncloned.

```bash
git reset --hard HEAD~1
git push --force-with-lease origin main
```

`--force-with-lease` rather than `--force`: it refuses if someone else pushed in
the meantime, which is the one case where you would not want to overwrite them.