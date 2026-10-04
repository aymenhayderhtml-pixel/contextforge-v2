# Running ContextForge v2 on Ubuntu

Every command below was executed on this machine (Ubuntu, Node v22.14.0, npm
10.9.2). Where something does not work as you would expect, it says so and
explains why.

> **The paths are this machine's.** They are correct here and will need
> substituting elsewhere. Unlike the screenshots in `docs/images/`, this file is
> deliberately not path-free: a run guide that says `/your/path/to/thing` is
> harder to copy and paste than one that shows the real folder.

---

## Prerequisites

| | |
| --- | --- |
| **Node** | **22 or newer.** `node --version` must print `v22.x` or higher. `package.json` declares `"engines": { "node": ">=22" }`. |
| **npm** | Ships with Node. Anything from npm 10 works. |
| **Build tools** | **Not needed.** `tree-sitter` ships prebuilt binaries and nothing compiles from source on a normal install. |
| **A display** | Required for the GUI. See [No GUI on a headless machine](#no-gui-on-a-headless-machine). |

Check:

```bash
node --version
npm --version
```

---

## Install

```bash
cd "<your-projects-folder>/contextforge-v2"
npm ci
```

**Verified: exits 0, no peer-dependency conflict.**

### About `--legacy-peer-deps`

`package.json` has a `postinstall` note suggesting it. **You do not need it.**
The lockfile is v3 and already records a valid dependency tree, so npm never
re-checks the peer ranges:

| Command | Result |
| --- | --- |
| `npm ci` | **exit 0** |
| `npm install` | **exit 0** |
| `npm install --legacy-peer-deps` | works, but unnecessary |

The flag matters in exactly one case: **if you delete `package-lock.json`**. Then
npm resolves `tree-sitter@0.21.1` at the root while `packages/core` gets a
nested `0.25.1`, and the grammar tests break. Keep the lockfile.

To see the unsatisfied declarations for yourself:

```bash
npm ls tree-sitter
```

It marks `tree-sitter-typescript` and `tree-sitter-gdscript` as `invalid` and
**exits 1** with `ELSPROBLEMS`. That is npm reporting an unsatisfied peer range,
not a broken install — nothing above depends on it succeeding.

### One extra step: fetch the Electron binary

**`npm ci` does not download Electron.** `electron@44.5.1` declares no
`postinstall` hook, so npm never fetches the ~100 MB binary and any Electron
command fails with a missing-binary error. Fetch it once:

```bash
node node_modules/electron/install.js
```

(`npx electron --version` does the same thing by downloading on first call, but
running it directly is clearer about what you are doing.)

---

## Build

Two builds, writing to two different places. Both are needed before the app
runs.

```bash
# 1. TypeScript → packages/app/dist/electron/  (the main process + preload)
npm run typecheck

# 2. Vite → packages/app/dist/renderer/        (the Svelte UI bundle)
npm run build:ui -w @contextforge/app
```

`npm run typecheck` is a `tsc --build` across three project references
(core → app → renderer). It is incremental, so the second run is fast.

---

## Run the app

```bash
./node_modules/.bin/electron --no-sandbox packages/app/dist/electron/main.js
```

### `--no-sandbox` is required

The bundled `chrome-sandbox` helper ships **without the setuid bit**
(`node_modules/electron/dist/chrome-sandbox` is mode `-rwxr-xr-x`), and
Chromium refuses to start without it.

**This does not weaken the app.** `packages/app/src/electron/main.ts` keeps
`sandbox: true` and `contextIsolation: true` for the renderer. The flag disables
Chromium's setuid helper at process launch, not the renderer's own sandbox.

### Known gap: `npm run start` does not work here

```bash
npm run start -w @contextforge/app   # builds, then launches WITHOUT --no-sandbox
```

That script is missing the flag, so it fails at launch on this machine. **Use the
one-liner above.** The script should have the flag added.

### For renderer work in a browser

```bash
npm run dev -w @contextforge/app    # Vite dev server, port 5178
```

No preload bridge, so no file access — useful for CSS work only.

---

## Package it (AppImage)

Everything above runs the app from the repo. This section builds a single file
you can copy to another machine and double-click.

```bash
npm run dist:appimage      # → dist/ContextForge-<version>-x86_64.AppImage
```

That one command runs all three steps in order, because each depends on the one
before it:

```bash
npm run typecheck                          # tsc: main process → packages/app/dist/
npm run build:ui -w @contextforge/app      # vite: renderer → packages/app/dist/renderer/
npx electron-builder --linux AppImage      # packages the two into one AppImage
```

**This machine has no FUSE**, so the AppImage cannot mount itself and running it
directly prints `dlopen(): error loading libfuse.so.2`. Three ways round that:

```bash
sudo apt install libfuse2               # the normal fix
./dist/ContextForge-0.1.0-x86_64.AppImage --appimage-extract   # no install needed
cd squashfs-root && ./AppRun --no-sandbox
```

Or just use the launcher below, which now detects this itself: it checks for
`libfuse.so.2` on every run and adds `--appimage-extract-and-run` when the
library is absent, so the same menu entry works with or without FUSE. You will
see one line on stderr when it takes that path, because it is slower to start.

Installing the launcher never needed FUSE; *running* the app it points at did,
which is exactly what the wrapper now handles.

### Install the launcher

```bash
scripts/install-launcher.sh               # install for the current user
scripts/install-launcher.sh --uninstall   # remove it again
```

This writes, all under `$HOME` and with no root:

| | |
| --- | --- |
| `~/.local/share/applications/contextforge.desktop` | the launcher entry |
| `~/.local/bin/contextforge` | the command it runs |
| `~/.local/share/icons/hicolor/{64,256,512}x…/apps/contextforge.png` | the icons |

After that, **ContextForge** is in your application menu and `contextforge`
runs it from a terminal (assuming `~/.local/bin` is on your `PATH`).

The script points the launcher at the **newest** `*.AppImage` it finds in `dist/`,
so a rebuild followed by a re-run picks up the new build. It refuses, with a
message naming where it looked, when there is no build yet — it will not install
a launcher for an app that does not exist.

It validates the entry it just wrote with `desktop-file-validate` and fails if
that does not pass, so a malformed `.desktop` cannot end up half-installed.

### Icons are generated

`build/icon.svg` is the source; the PNGs beside it are generated:

```bash
npm run icons                             # build/icon-{64,256,512}.png + the xNxN forms
```

Rendering uses `@resvg/resvg-js` (MPL-2.0, already a devDependency) because this
machine has **neither ImageMagick `convert` nor `rsvg-convert`**. `rsvg-convert`,
`convert` and `inkscape` are used instead when they are present. The PNGs are
committed so a clean checkout can be packaged with nothing but `npm ci`.

---

## Test

```bash
npm test                              # vitest, all packages
npx vitest run packages/core/test/graph/analysis.test.ts   # one file
```

**Result on this machine: 75 test files, 1501 tests, ~60 s.**

Most suites are pure Node. Two Electron e2e suites are **skipped by default** and
say so in their output rather than passing silently. Run them with:

```bash
CF_E2E=1 npx vitest run packages/app/test/e2e/patchLoop.test.ts
```

(`CF_E2E_PATCH=1` works too for this one suite; the other two gate on `CF_E2E`
alone.)

They need a game project. Point them at one with `CF_PROJECT`:

```bash
CF_PROJECT="/path/to/your/game" CF_E2E=1 npx vitest run packages/app/test/e2e/
```

### The full gate

```bash
npm run verify
```

Five stages, in order:

| Stage | What it fails on |
| --- | --- |
| `check:boundaries` | `packages/core` importing the app, or using a DOM global (`window`, `document`, …) |
| `check:three` | the viewer and the game on different or non-exact `three` pins |
| `typecheck` | any TypeScript error, strict mode |
| `lint:prefabs` | a prefab using `this`, module-level `let`, `Math.random` or `scene.add` |
| `test` | any failing test |

**Result: exit 0, ~52 s.**

`check:three` has a **hardcoded default** game path
(`<your-projects-folder>/kart-dash-3d-v2`). Override it:

```bash
CF_GAME_ROOT="/path/to/your/game" npm run check:three
```

---

## Trying it with kart-dash-3d-v2

The test project lives outside this repo:

```
<your-projects-folder>/kart-dash-3d-v2
```

29 source files, 38 import edges, 4 unreferenced. It deliberately contains two
broken instances so the Problems panel has something real to report.

### First five things to try

**1. Open the project.** On the Project screen, type the path into *Project
folder path* and press **Open project**, or use **Browse…**.

> **Working looks like:** you land on the Scene screen, and the sidebar footer
> reads `PROJECT kart-dash-3d-v2` with an object and prefab count. If you are
> still on Project afterwards, the path is wrong.

**2. Look at the scene.** Three panes: OUTLINER (left), a 3D viewport with a grid
floor and four coloured karts, INSPECTOR (right).

> **Working looks like:** 5 instances listed, karts rendered in distinct colours,
> and a `PROBLEMS (4)` bar at the bottom.
>
> **Four rows is correct, and there are only two distinct causes** — which is the
> thing worth understanding here. The `hazardCrate` prefab throws on purpose (it
> is a SPEC R9 fixture, **not** a broken asset: its `create()` is a literal
> `throw`), and `scene.json` has one instance with `width: -10`. Each cause
> produces two rows: a project-level one and a per-instance one, so the developer
> can jump from the panel to the object.
>
> A *clean* Problems panel here would mean the checks are not running.

**3. Open the Problems panel.** Click the `PROBLEMS (4)` bar.

> **Working looks like:** **one** header, a count, and a list of rows. Each row
> says what is wrong and which instance it belongs to, with a link to jump to it.
> If you see two headers with different numbers, that is a bug — see D44.

**4. Browse the graph.** Click **Graph** in the sidebar.

> **Working looks like:** `29 files · 38 edges · 4 unreferenced`, and a node per
> file. Labels sit on two alternating rows so they do not overlap; **hover any node
> to read its full name**, which is how you see the handful too long to draw
> (`scene-manager.js`, `prefabs.js`). A node with no label is not missing — hover it.
> Click a node to see only its neighbourhood — the toolbar then offers a
> **Depth** selector (1 or 2) and a **Show all files** button. Open
> **Unreferenced (4)** for the drawer: each row says *why* it is flagged
> (`entry point` vs `unreferenced`), because an entry point is unreferenced by
> construction and is not dead code.
>
> **Also expect an "8 missing files" line** under the header, collapsed. All
> eight are screenshot filenames in `capture-game.mjs` that resolve to nowhere
> inside the game, so they are **not** in the graph — the graph only contains
> files that exist. Click it to see each one and which file referenced it.
>
> **Why 29 and not 37:** the eight missing files were once drawn as if they
> existed. A reference to a file that is not on disk now produces a warning
> instead of a node, because a graph node is a claim that the file exists.

**5. Apply a patch.** On the **Patch** screen, paste this into the AI reply box.
It edits a real file in the project, so the FIND text below matches exactly:

```
### EDIT: src/settings.js
<<<<<<< FIND
  music: 0.55,
=======
  music: 0.4,
>>>>>>> REPLACE
```

**Preview** shows the diff **without writing anything**. **Apply patch** writes
it and reports which files it touched.

> **Working looks like:** an `APPLIED` banner reading *"Wrote 1 file:
> src/settings.js as one undo step (‹patchId›)."* — with the path repeated as a
> bullet under it — plus a History entry, and `music: 0.4` in the file on disk.
>
> **Ctrl+Z** reverts it as one step. The banner's heading becomes `Undone` and the
> line reads *"Reverted 1 file: src/settings.js (‹patchId›)."*
>
> **Try the refusal too:** change `0.55` in the FIND block to something else and
> preview again. You get an amber line naming the block that failed — *"1 of the
> 1 blocks in this reply could not be resolved, so nothing will be written. In
> "src/settings.js" (edit block 1): …"* — and no byte on disk changes. A patch
> that fails on one block writes none of them.

Ctrl+Z does **not** fire while a text field has focus, so click the viewport
first.

### Reference: keyboard

| | |
| --- | --- |
| `Ctrl+Z` | undo one step across all files |
| `Ctrl+Shift+Z` or `Ctrl+Y` | redo |
| `Ctrl+S` | save `scene.json` (re-validates before writing) |

`Cmd` is treated as `Ctrl` on macOS.

---

## Troubleshooting

### `npm ci` fails with ERESOLVE

Your lockfile is missing or out of date. Either restore it, or:

```bash
npm install --legacy-peer-deps
```

### Electron: missing binary, or the sandbox error

Both are the same root cause — run step 1 of the install. If Electron still
refuses, the `chrome-sandbox` helper lost its permissions:

```bash
ls -l node_modules/electron/dist/chrome-sandbox   # expect -rwxr-xr-x
node node_modules/electron/install.js            # re-fetch
```

Always pass `--no-sandbox`.

### `npm run start` fails immediately

Known gap: that script omits `--no-sandbox`. Use the full command from
[Run the app](#run-the-app).

### No GUI on a headless machine

The app needs a display. On a machine with neither X11 nor Wayland, nothing
will open and no error is printed.

With **Xvfb**:

```bash
sudo apt install xvfb
xvfb-run -a ./node_modules/.bin/electron --no-sandbox packages/app/dist/electron/main.js
```

Note that `DISPLAY=:0` can be *set* on a machine that is actually using
**Wayland**, in which case an X11-only probe (`xprop -root _NET_CLIENT_LIST`)
reports no windows even though the app is running fine. Check
`echo $XDG_SESSION_TYPE` before concluding anything.

### The 3D viewport is blank

Usually software rendering. Chromium falls back to llvmpipe with no GPU, which
does render, but slowly. Check `chrome://gpu` if you need the detail.

### The AppImage builds but the app exits at once

A packaging mistake, not a code one, and it has a recognisable shape: the app
starts and dies in the main process with `ERR_MODULE_NOT_FOUND`. That means the
asar is missing a file that the built code imports. Two that this packaging setup
needs and that a default `files` list leaves out:

| Missing | Imported as | Symptom |
| --- | --- | --- |
| `dist/ipc.js` | `../ipc.js` from `dist/electron/ipcHandlers.js` | `Cannot find module '.../app.asar/dist/ipc.js'` |
| `node_modules/node-gyp-build` | `require('node-gyp-build')` in each tree-sitter package's `index.js` | `Cannot find module 'node-gyp-build'` |

`tsc` emits `src/ipc.ts` to `dist/ipc.js`, *beside* `dist/electron/` rather than
inside it, so a rule that lists only `dist/electron/**` silently drops it. Check
the archive directly:

```bash
npx asar list dist/linux-unpacked/resources/app.asar | grep -E 'dist/ipc.js|node-gyp-build'
```

### The launcher installs but nothing happens when clicked

Check the `Exec=` line. If it names an AppImage under a path containing a space
and is not quoted, it will fail — and `desktop-file-validate` will **not** warn
you, because it does not check that. `scripts/install-launcher.sh` avoids the
problem entirely by pointing `Exec` at `contextforge`, a single word.

### `install-launcher.sh` says "no built AppImage found"

Nothing to point at yet. Run `npm run dist:appimage` first. The message lists
every directory it searched.

### A gate fails and you did not change anything

`check:three` compares against the game's `package.json`. If you moved or
renamed the game project, set `CF_GAME_ROOT`.

---

## Where things are

| | |
| --- | --- |
| `packages/core` | the engine. No DOM, no Electron, no UI. |
| `packages/app` | the Electron + Svelte shell over it. |
| `build/` | packaging assets: `icon.svg` (source) and its generated PNGs, `contextforge.desktop`. |
| `dist/` | build output. Holds `linux-unpacked/` and the `.AppImage` after packaging. Ignored by git. |
| `scripts/install-launcher.sh` | installs / removes the per-user launcher entry. |
| `docs/DECISIONS.md` | every design decision, with its reasoning. D1–D47, with no D17–D19 (those numbers were never written; `package.json` still references "D17") |
| `docs/OVERNIGHT.md` | the Step 5 build log, with what is proven and what is not |
| `screenshots/` | proof screenshots, by iteration |
| `SPEC.md` | the rules the code is held to |