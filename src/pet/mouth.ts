import layout from './mouth.json';

// How busy a pup's day has been shows in the corners of its mouth while it
// sits at its desk (art/aseprite/rig/mouth.py): a wide smile on a quiet day,
// through a level line by the evening of a usual one, to a wide frown on a
// very busy one. The pup keeps its size. The sprite canvas paints the mouth
// over the artwork's own wherever a frame has it (work, meetings, and the
// frames of changes between scenes in which it is at its desk); asleep, at a
// meal or away it has the face of that scene.

/** A mouth of the strip (public/pets/animations/mouth.png), from 'wide-smile' to 'wide-frown'. */
export type Mouth = number;
export const MOUTHS: readonly string[] = layout.mouths;
/** The artwork's own mouth: nothing is painted for it. */
export const OWN_MOUTH: Mouth = layout.own;
export const mouthBox = { x: layout.x, y: layout.y, width: layout.width, height: layout.height };

/** The mouth for a day's busyness (statistics/growth.ts: 0..1, where a usual day ends near two thirds). */
export function mouthFor(level: number): Mouth {
  if (!(level >= 0.15)) return 0;
  if (level < 0.4) return 1;
  // A usual day's evening: neither up nor down.
  if (level < 0.7) return 2;
  if (level < 0.9) return 3;
  return 4;
}

const anchors = layout.anchors as unknown as Record<string, readonly (readonly [number, number] | null)[]>;
/** Where a frame's mouth is, as an offset from the working pup's, if the pup's own mouth is in that frame. */
export const mouthAt = (asset: string, frame: number) => anchors[asset]?.[frame] ?? undefined;
export const hasMouth = (asset: string) => asset in anchors;

let strip: Promise<HTMLImageElement | undefined> | undefined;
/** The mouths, decoded once; undefined if they cannot be loaded (the pup then keeps its own mouth). */
export function mouthStrip() {
  strip ??= (async () => {
    const image = new Image();
    try {
      image.src = '/pets/animations/mouth.png';
      await image.decode();
      return image.width === mouthBox.width * MOUTHS.length && image.height === mouthBox.height ? image : undefined;
    } catch {
      return undefined;
    }
  })();
  return strip;
}
