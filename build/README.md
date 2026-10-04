# build/ — packaging assets

Everything electron-builder reads for a Linux package lives here. It did not
exist before `lane-packaging`; the directory and its contents are new.

## What is here

| File | Read by | Why |
| --- | --- | --- |
| `icon.svg` | `scripts/install-launcher.sh` (source of truth) | The icon as a reviewable vector. A binary PNG in git cannot be diffed or corrected by hand. |
| `contextforge.desktop` | `scripts/install-launcher.sh` → `~/.local/share/applications/` | The launcher entry. electron-builder also embeds this in the AppImage's own `.desktop`, so the installed app and the standalone launcher declare the same thing. |
| `icon-512.png` | electron-builder (`"build": "linux.icon"`) | The AppImage window icon. **Generated** from `icon.svg`. |
| `icon-256.png` | electron-builder fallback | Generated. |
| `icon-64.png` | electron-builder fallback | Generated. |
| `icon-512x512.png` | electron-builder (`"icon"` legacy lookup) | Generated. electron-builder looks for this name first for AppImage. |

**The `icon-*.png` files are generated.** Run
`scripts/install-launcher.sh --render-icons` (or just `npm run icons`) to
rebuild them from `icon.svg`. They are committed so a clean checkout can be
packaged without ImageMagick installed — see the `convert is missing` note in
`scripts/install-launcher.sh`.

## Requirements for regenerating icons

`scripts/install-launcher.sh` prefers ImageMagick `convert`. Where that is not
installed (it is **not** on this machine — `convert` is absent, and
`rsvg-convert` is used instead when present) it falls back to `rsvg-convert`.
With neither available it reuses the committed PNGs and says so out loud rather
than failing silently or producing a blank icon.