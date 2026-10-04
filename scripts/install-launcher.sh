#!/usr/bin/env bash
#
# scripts/install-launcher.sh — install (or remove) the ContextForge launcher.
#
# Creates, for the *current user*:
#   ~/.local/share/applications/contextforge.desktop   the launcher entry
#   ~/.local/share/icons/hicolor/512x512/apps/contextforge.png
#   ~/.local/bin/contextforge                          the command it invokes
#   ~/.local/share/applications/contextforge.desktop   scanned into the menu
#
# No root, no system directories, nothing outside $HOME. That is a deliberate
# choice: the app is a local developer tool, and a user-level install cannot
# break the machine or collide with another user's copy.
#
# Two jobs, kept separate because they fail for different reasons:
#   default              install the launcher, or remove it with --uninstall
#   --render-icons       regenerate build/icon-*.png from build/icon.svg
#
# `--render-icons` is split out because the AppImage build needs those PNGs and
# has no way to call this script's converter chain itself (see build/README.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/build"
SVG="$BUILD_DIR/icon.svg"
DESKTOP_SRC="$BUILD_DIR/contextforge.desktop"

APP_NAME="ContextForge"
DESKTOP_ID="contextforge.desktop"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/contextforge"
ICON_SIZES=(512 256 64)

# The directories searched for a built app, and the name stem it must have.
# `dist/` is searched before the app package's own, which is where
# `npm run dist:appimage` writes.
SEARCH_DIRS=("$REPO_ROOT/dist" "$REPO_ROOT/packages/app/dist")

die() { printf 'install-launcher: %s\n' "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }

# The one renderer, in preference order.
#
# `resvg` is an inline Node script rather than a call to ImageMagick because
# this machine has no `convert` and no `rsvg-convert`, so a script that
# required either could not regenerate its own icon here. `@resvg/resvg-js` is
# a prebuilt native binding with no system libraries to install and already in
# devDependencies, so a clean checkout produces its icons with only `npm ci`.
# It is MPL-2.0.
render_png_resvg() {
  command -v node >/dev/null 2>&1 || return 1
  [ -d "$REPO_ROOT/node_modules/@resvg/resvg-js" ] || return 1
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const { Resvg } = await import("@resvg/resvg-js");
    const [svgPath, outPath, size] = process.argv.slice(1);
    const png = new Resvg(readFileSync(svgPath), {
      fitTo: { mode: "width", value: Number(size) },
      font: { loadSystemFonts: false },
    }).render().asPng();
    // PNG magic number. Verified rather than assumed: a script that reports
    // success while writing nothing produces a package with a blank icon.
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!png.subarray(0, 8).equals(Buffer.from(magic))) {
      console.error("render_png_resvg: output is not a PNG");
      process.exit(1);
    }
    writeFileSync(outPath, png);
  ' "$1" "$2" "$3"
}

render_png() {
  local svg="$1" out="$2" size="$3" tmp
  render_png_resvg "$svg" "$out" "$size" && return 0
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$svg" -o "$out" && return 0
  fi
  if command -v convert >/dev/null 2>&1; then
    convert -background none -resize "${size}x${size}" "$svg" "$out" && return 0
  fi
  if command -v inkscape >/dev/null 2>&1; then
    tmp="$(mktemp --suffix=.png)"
    if inkscape "$svg" --export-type=png --export-filename="$tmp" -w "$size" -h "$size" >/dev/null 2>&1; then
      mv "$tmp" "$out"; return 0
    fi
    rm -f "$tmp"
  fi
  return 1
}

render_icons() {
  [ -f "$SVG" ] || die "no source icon at $SVG"
  for size in "${ICON_SIZES[@]}"; do
    # electron-builder looks for this exact name first for AppImage.
    for name in "icon-${size}x${size}.png" "icon-${size}.png"; do
      local out="$BUILD_DIR/$name"
      if render_png "$SVG" "$out" "$size"; then
        info "rendered build/$name"
      else
        printf 'install-launcher: no SVG renderer found (rsvg-convert, convert, inkscape)\n' >&2
        printf 'install-launcher: keeping the committed build/icon-%s.png instead\n' "$size" >&2
        [ -f "$out" ] || die "build/$name is missing AND cannot be rendered"
      fi
    done
  done
}

# Find the built app: the newest *.AppImage in the first search directory that
# has one. Prints its path, or dies naming every directory it looked in.
#
# The path is printed by a child process rather than globbed with `( $pattern )`.
# Two separate bugs lived in that older form and neither is obvious:
#   - word-splitting the glob in place breaks on this repo path, which contains
#     a space: `dark matter` became two arguments and `ls` was asked for a
#     directory called `dark`;
#   - splitting on newlines inside a process substitution broke the SAME space,
#     because the while-loop ran with the default IFS and split on it.
# `[ -f "$dir/"*.AppImage ]` expands in place, in the current shell, with every
# component quoted, so the space is preserved and a directory with no match
# collapses to the literal pattern, which the `-f` test then rejects.
find_app() {
  local dir
  for dir in "${SEARCH_DIRS[@]}"; do
    if [ -f "$dir/"*.AppImage ]; then
      ls -t -- "$dir/"*.AppImage | head -1
      return 0
    fi
  done
  local looked=()
  for dir in "${SEARCH_DIRS[@]}"; do looked+=( "  $dir" ); done
  die "no built AppImage found. Build one first:  npm run dist:appimage
Looked for *.AppImage in:
${looked[*]}"
}

# Write the ~/.local/bin/contextforge wrapper that execs the AppImage.
#
# ## Why this is more than `exec "$app" "$@"`
#
# An AppImage is a squashfs image that mounts itself through FUSE, and it needs
# `libfuse.so.2` to do it. Where that library is missing, running the file
# directly dies before any of our code runs:
#
#     dlopen(): error loading libfuse.so.2
#
# So a wrapper that just execs the AppImage works on a machine with libfuse2 and
# fails on one without it — which made docs/RUNNING.md's claim that "the launcher
# still works" false, since the launcher does nothing but exec the file.
#
# The wrapper therefore checks for the library and, when it is absent, adds
# `--appimage-extract-and-run`. That flag makes the runtime unpack the image to a
# temp directory and run it from there, bypassing FUSE entirely, so the same
# launcher works either way.
#
# The check is `ldconfig -p` first (authoritative, covers every library path) and
# falls back to probing the usual directories, because `ldconfig` may be absent in
# a minimal environment. Detection is done at RUN time, not install time: a user
# can install libfuse2 after installing the launcher, and the wrapper must then
# take the fast path.
#
# FUSE-free extraction is slower to start and uses temp disk, so it is only used
# when it is actually needed.
write_launcher() {
  local path="$1" app="$2"
  # Unquoted heredoc: `$app` must interpolate to the real path (it contains a
  # space) while `\$` keeps the wrapper's own runtime variables literal.
  cat > "$path" <<LAUNCHER_EOF
#!/usr/bin/env bash
# Generated by scripts/install-launcher.sh — do not edit; re-run the installer.
#
# Runs the ContextForge AppImage, with or without FUSE.
#
# An AppImage mounts itself via FUSE and needs libfuse.so.2 for that. Without the
# library it dies with "dlopen(): error loading libfuse.so.2" before any of the
# app's own code runs, so this wrapper checks for the library and falls back to
# --appimage-extract-and-run, which unpacks the image instead of mounting it.
#
# The check runs every launch, not once at install time, because the library can
# be installed after the launcher is.

have_fuse2() {
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    return 0
  fi
  # No ldconfig, or it does not list it: probe the usual directories directly.
  for path in /lib/libfuse.so.2 /lib64/libfuse.so.2 /usr/lib/libfuse.so.2 \\
              /usr/lib64/libfuse.so.2 /usr/local/lib/libfuse.so.2 \\
              /lib/*/libfuse.so.2 /usr/lib/*/libfuse.so.2; do
    [ -e "\$path" ] && return 0
  done
  return 1
}

app="$app"

if have_fuse2; then
  exec "\$app" "\$@"
fi

# No FUSE: unpack and run from a temp directory instead. --appimage-extract-and-run
# handles the extraction; --no-sandbox is appended only when the caller has not
# already asked for a sandbox setting, because passing both is an error.
args=( --appimage-extract-and-run )
for arg in "\$@"; do
  case "\$arg" in
    --no-sandbox|--disable-gpu-sandbox) sandbox_given=1 ;;
  esac
done
if [ "\${sandbox_given:-0}" = "1" ]; then
  exec "\$app" "\$@"
fi

echo "contextforge: libfuse.so.2 not found — extracting the AppImage to run it without FUSE." >&2
exec "\$app" "\${args[@]}" --no-sandbox "\$@"
LAUNCHER_EOF
  chmod 755 "$path"
}

install_launcher() {
  local app appimage_rel launcher_body

  [ -f "$DESKTOP_SRC" ] || die "no desktop entry at $DESKTOP_SRC"
  app="$(find_app)"
  [ -x "$app" ] || chmod +x "$app" || die "cannot make $app executable"

  appimage_rel="${app#"$REPO_ROOT"/}"
  launcher_body="$(sed "s|^Exec=contextforge %f|Exec=contextforge|" "$DESKTOP_SRC")"

  mkdir -p "$DESKTOP_DIR" "$ICON_DIR" "$BIN_DIR"

  # The wrapper is written first: the .desktop entry points at it, so the entry
  # must never exist without a command behind it.
  #
  # Exec names the wrapper, not the AppImage. The desktop-entry spec says a path
  # containing a space must have that space escaped, and not every desktop
  # environment gets that right — and `desktop-file-validate` does not flag it
  # either, so an unquoted Exec naming the AppImage passes validation and then
  # silently runs the wrong command. `contextforge` is a single word, which
  # removes the whole class of problem instead of escaping one instance of it.
  #
  # (The same wrapper used to be written twice, identically; the second write is
  # gone and only this one remains.)
  write_launcher "$LAUNCHER" "$app"

  printf '%s\n' "$launcher_body" > "$DESKTOP_DIR/$DESKTOP_ID"
  chmod 644 "$DESKTOP_DIR/$DESKTOP_ID"

  for size in "${ICON_SIZES[@]}"; do
    local src="$BUILD_DIR/icon-${size}.png"
    [ -f "$src" ] || continue
    mkdir -p "$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
    cp "$src" "$HOME/.local/share/icons/hicolor/${size}x${size}/apps/contextforge.png"
  done

  # Rebuilds the menu cache so the entry appears without a logout. Scoped to
  # the user's own applications dir, so it never needs root.
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || \
      info "warning: update-desktop-database failed; the launcher is installed anyway"
  fi

  # Fail here, not later, if the file we just wrote is not a valid entry.
  if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$DESKTOP_DIR/$DESKTOP_ID" \
      || die "the launcher this script just wrote does not validate; nothing was installed cleanly"
    info "desktop-file-validate: the installed entry is valid"
  else
    info "desktop-file-validate not installed; skipped validating the entry"
  fi

  cat <<EOF
$APP_NAME launcher installed.

  entry    $DESKTOP_DIR/$DESKTOP_ID
  command  $LAUNCHER
  app      $appimage_rel

It should be in your application menu now ("$APP_NAME").
Note: $DESKTOP_ID carries StartupWMClass=ContextForge, and the running window
must actually report that class or the icon will not match while it is open.
EOF
}

uninstall_launcher() {
  local removed=0 p
  for p in "$DESKTOP_DIR/$DESKTOP_ID" "$LAUNCHER"; do
    if [ -e "$p" ]; then rm -f "$p"; info "removed $p"; removed=1; fi
  done
  for size in "${ICON_SIZES[@]}"; do
    local ic="$HOME/.local/share/icons/hicolor/${size}x${size}/apps/contextforge.png"
    if [ -e "$ic" ]; then rm -f "$ic"; info "removed $ic"; removed=1; fi
  done
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  [ "$removed" -eq 1 ] || info "nothing was installed"
}

usage() {
  cat <<EOF
usage: scripts/install-launcher.sh [--uninstall] [--render-icons]

  (no argument)     install the launcher for the current user, pointing at the
                    newest built AppImage
  --uninstall       remove the launcher, the command and the icons
  --render-icons    regenerate build/icon-*.png from build/icon.svg
  -h, --help        this text
EOF
}

case "${1:-}" in
  "")             install_launcher ;;
  --uninstall)    uninstall_launcher ;;
  --render-icons) render_icons ;;
  -h|--help)      usage ;;
  *)              usage; die "unknown option: $1" ;;
esac