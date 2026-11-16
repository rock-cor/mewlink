"""The pup's mouth at its desk, by how busy its day has been.

The approved artwork has one mouth at the desk: a short line with both
corners turned down. A busier day used to make the pup bigger; now it shows
in the corners of its mouth instead. Five mouths, from a quiet day to a very
busy one: a wide smile, a smile, a level line, the artwork's own mouth, and a
wide frown. Each is drawn in the frame's own pixels with the artwork's line
weight, over the fur colour that covers the mouth underneath.

The strip is only the box round the mouth. The app paints a mouth over the
pup's own wherever a frame has that mouth (pet/SpriteCanvas.tsx), so this
script also finds it in every exported strip and writes where
(src/pet/mouth.json): the desk loops, and the frames of changes between
scenes in which the pup still sits (or already sits) at its desk. Run it
again after any strip is exported anew (pnpm test:animations checks that
each place still has the artwork's mouth).

  python3 art/aseprite/rig/mouth.py --out /tmp/mewlink-mouth
  aseprite -b --script-param root=$PWD --script-param build=/tmp/mewlink-mouth \\
    --script-param project=mewlink-mouth-master --script art/aseprite/build-hug-master.lua
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from palette import palette, snap

ROOT = Path(__file__).resolve().parents[3]
SHEETS = ROOT / "public" / "pets" / "animations"
FRAME_W, FRAME_H = 384, 256
# The box round the mouth in the working pup's frame (work-code, frame 0).
BOX = (216, 104, 38, 24)  # x, y, width, height
LINE = (63, 5, 59, 255)
FUR = (253, 237, 212, 255)
MOUTHS = ["wide-smile", "smile", "level", "own", "wide-frown"]
OWN = MOUTHS.index("own")


def rects(*boxes):
    """A mask of the box from inclusive frame rectangles (x0, y0, x1, y1)."""
    x, y, width, height = BOX
    mask = np.zeros((height, width), bool)
    for x0, y0, x1, y1 in boxes:
        mask[y0 - y:y1 - y + 1, x0 - x:x1 - x + 1] = True
    return mask


def own_mouth():
    """The artwork's mouth: the box's pixels, see-through where there is only fur."""
    strip = np.asarray(Image.open(SHEETS / "work-code.png").convert("RGBA"))
    x, y, width, height = BOX
    box = strip[y:y + height, x:x + width].copy()
    box[~ink(box)] = 0
    return box


def ink(rgba):
    """What is drawn on the fur: the mouth's line and its softer edge pixels."""
    r, g, b, a = (rgba[:, :, k].astype(int) for k in range(4))
    return (a > 0) & ((r < 235) | (g < 215) | (b < 185))


def strip_of():
    """The mouths side by side: fur over the artwork's mouth, then the new line."""
    own = own_mouth()
    drawn = own[:, :, 3] > 0
    rows = np.nonzero(drawn.any(axis=1))[0]
    # A smile is the artwork's mouth upside down, in the same rows.
    smile = own.copy()
    smile[rows.min():rows.max() + 1] = own[rows.min():rows.max() + 1][::-1]
    # A wide arch in three steps, and the same upside down.
    frown = rects((229, 109, 238, 113), (224, 113, 229, 117), (238, 113, 244, 117), (220, 117, 224, 122), (244, 117, 249, 122))
    top, bottom = 109 - BOX[1], 122 - BOX[1]
    wide_smile = frown.copy()
    wide_smile[top:bottom + 1] = frown[top:bottom + 1][::-1]
    lines = {"wide-smile": wide_smile, "level": rects((226, 113, 243, 117)), "wide-frown": frown}
    frames = []
    for name in MOUTHS:
        frame = np.zeros((BOX[3], BOX[2], 4), np.uint8)
        if name != "own":
            frame[drawn] = FUR
        if name == "smile":
            frame[smile[:, :, 3] > 0] = smile[smile[:, :, 3] > 0]
        elif name == "own":
            frame[drawn] = own[drawn]
        else:
            frame[lines[name]] = LINE
        frames.append(frame)
    return np.concatenate(frames, axis=1)


def anchors():
    """For every strip, per frame, where the artwork's mouth is (its offset from the desk's), if it is there."""
    x, y, width, height = BOX
    reference = np.asarray(Image.open(SHEETS / "work-code.png").convert("RGBA"))[:, :FRAME_W]
    template = ink(reference[y:y + height, x:x + width]).astype(np.uint8)
    found = {}
    for path in sorted(SHEETS.glob("*.png")):
        strip = np.asarray(Image.open(path).convert("RGBA"))
        # One pup a frame, painted by the sprite canvas: not the hug sheets (two pups, or the walker).
        if strip.shape[0] != FRAME_H or strip.shape[1] % FRAME_W or path.stem.startswith("hug"):
            continue
        per_frame = []
        for index in range(strip.shape[1] // FRAME_W):
            frame = strip[:, index * FRAME_W:(index + 1) * FRAME_W]
            # Fur is 0, anything drawn on it 1, see-through 2: the box must be the mouth on fur and nothing else.
            mask = np.where(frame[:, :, 3] == 255, ink(frame).astype(np.uint8), 2).astype(np.uint8)
            score = cv2.matchTemplate(mask, template, cv2.TM_SQDIFF)
            ys, xs = np.nonzero(score < 0.5)
            spots = sorted(zip(ys, xs), key=lambda p: abs(p[1] - x) + abs(p[0] - y))
            per_frame.append([int(spots[0][1] - x), int(spots[0][0] - y)] if spots else None)
        if any(per_frame):
            found[path.stem] = per_frame
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path, help="build directory for build-hug-master.lua")
    parser.add_argument("--preview", type=Path, help="also write the five faces, enlarged, to this PNG")
    args = parser.parse_args()
    (args.out / "mouth").mkdir(parents=True, exist_ok=True)
    strip = snap(strip_of())
    Image.fromarray(strip).save(args.out / "mouth" / "mouth.png", optimize=True)
    sheets = [{"name": "mouth", "frames": len(MOUTHS), "duration": 1000, "layers": ["mouth"]}]
    (args.out / "manifest.json").write_text(json.dumps({"width": BOX[2], "height": BOX[3], "palette": palette().tolist(), "sheets": sheets}))
    where = anchors()
    layout = {"x": BOX[0], "y": BOX[1], "width": BOX[2], "height": BOX[3], "mouths": MOUTHS, "own": OWN, "anchors": where}
    text = json.dumps(layout, indent=1)
    # One strip a line: the anchors are long lists of small pairs.
    compact = json.dumps(where, separators=(",", ":")).replace('],"', '],\n  "').replace('{"', '{\n  "', 1)
    text = text[:text.index('"anchors"')] + '"anchors": ' + compact[:-1] + "\n }\n}\n"
    json.loads(text)
    (ROOT / "src" / "pet" / "mouth.json").write_text(text)
    for name, frames in where.items():
        hits = [spot for spot in frames if spot]
        print(f"{name}: {len(hits)}/{len(frames)} frames, dx {min(s[0] for s in hits)}..{max(s[0] for s in hits)}, dy {min(s[1] for s in hits)}..{max(s[1] for s in hits)}")
    if args.preview:
        face = np.asarray(Image.open(SHEETS / "work-code.png").convert("RGBA"))[:, :FRAME_W].copy()
        x, y, width, height = BOX
        tiles = []
        for index in range(len(MOUTHS)):
            tile = Image.fromarray(face).copy()
            tile.alpha_composite(Image.fromarray(strip[:, index * width:(index + 1) * width]), (x, y))
            tiles.append(tile.crop((130, 20, 340, 160)))
        sheet = Image.new("RGBA", (210 * len(tiles), 140), (242, 230, 219, 255))
        for index, tile in enumerate(tiles):
            sheet.alpha_composite(tile, (210 * index, 0))
        sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(args.preview)


if __name__ == "__main__":
    main()
