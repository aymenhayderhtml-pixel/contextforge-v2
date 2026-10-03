#!/usr/bin/env python3
"""
scripts/redact-screenshots.py — publish-safe copies of the README screenshots.

Some captures show error text that contains the absolute path of the machine
that took them, e.g.

    Prefab hazardCrate (<project-path>/
    prefabs/index.ts): Corrupted GLTF buffer: failed to decode geometry ...

That path is not a secret, but it is a personal directory name and identifies
the author, so it does not belong in a public repository. The surrounding text
is *also* correct behaviour worth showing — the app names the file it failed on
rather than saying "something broke" — so the shot is redacted rather than
dropped: the personal prefix becomes a neutral placeholder and the rest of the
message is redrawn in the panel's own colours.

This script is the record of what was edited. The boxes are literal
coordinates in ORIGINAL image pixels, so re-running it against a freshly
captured screenshot reproduces the same result, and a diff against the
unredacted original is the check.

    python3 scripts/redact-screenshots.py

Requires Pillow. Not part of `npm run verify` — it is a publishing step, not a
gate.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
IMAGES = REPO / "docs" / "images"

# Original size of the captures this was measured against.
EXPECTED_SIZE = (1838, 929)

# Sampled from the rendered Problems panel, not guessed.
FG = (200, 206, 218)
ROW_BG = (43, 38, 44)
PANEL_BG = (32, 34, 42)
LEFT = 384
RIGHT = 1810
TEXT_X = 398

ROWS: list[tuple[int, int, str]] = [
    # Row 1 — no path in it, redrawn only so the band height stays consistent.
    (757, 802, "hazardCrate failed to load: Corrupted GLTF buffer: failed to decode geometry — Error: Corrupted GLTF buffer: failed to decode geometry | at Object.…"),
    # Row 2 — the leaking one. The path becomes /path/to/kart-dash-3d-v2/...
    (803, 847, 'Prefab hazardCrate (/path/to/kart-dash-3d-v2/prefabs/index.ts): Corrupted GLTF buffer: failed to decode geometry — Error: Co…'),
    # Row 3 — no path in it.
    (848, 886, 'scene.json: instances[1].prefab: no registered prefab named "hazardCrate" — registered prefabs: kart, trackSegment'),
]

# Row 4 carries the same absolute path but the panel's own scrolling viewport
# clips it mid-glyph, leaving a readable strip above the status bar. Painting the
# strip in the panel background is the only way to remove it without inventing
# text for a row that is mostly cut off.
CLIP_STRIP = (384, 887, 1838, 906)

# Both captures share the Problems-panel layout at identical pixel offsets —
# verified by locating the row accent bars in each — so one set of boxes covers
# both. `inspector-three-axes.png` leaks the same path in its panel.
TARGETS = ["problems-panel.png", "inspector-three-axes.png"]


def load_font(size: int = 14):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def redact(path: Path) -> None:
    im = Image.open(path).convert("RGB")
    if im.size != EXPECTED_SIZE:
        raise SystemExit(
            f"{path.name} is {im.size}, not {EXPECTED_SIZE}. The boxes below were "
            "measured against the v04e capture at that size; re-measure before "
            "redrawing, or the overlay lands in the wrong place."
        )

    draw = ImageDraw.Draw(im)
    font = load_font()

    for y0, y1, text in ROWS:
        draw.rectangle([LEFT, y0, RIGHT, y1], fill=ROW_BG)
        draw.text((TEXT_X, y0 + 7), text, fill=FG, font=font)

    draw.rectangle(list(CLIP_STRIP), fill=PANEL_BG)

    im.save(path)
    print(f"redacted {path.name}: {len(ROWS)} row(s) + 1 clipped strip")


def main() -> None:
    for name in TARGETS:
        redact(IMAGES / name)


if __name__ == "__main__":
    main()