import { describe, expect, it } from 'vitest';
import { hasMouth, mouthAt, mouthBox, mouthFor, MOUTHS, OWN_MOUTH } from './mouth';

describe('a day\'s busyness in the corners of the pup\'s mouth', () => {
  it('goes from a wide smile to a wide frown as the day gets busier', () => {
    expect(MOUTHS).toEqual(['wide-smile', 'smile', 'level', 'own', 'wide-frown']);
    const at = (level: number) => MOUTHS[mouthFor(level)];
    // The morning, or a day off.
    expect(at(0)).toBe('wide-smile');
    expect(at(0.1)).toBe('wide-smile');
    expect(at(0.15)).toBe('smile');
    expect(at(0.35)).toBe('smile');
    expect(at(0.4)).toBe('level');
    // A usual day ends near two thirds: neither up nor down.
    expect(at(0.65)).toBe('level');
    // Busier than usual: the artwork's own mouth, corners down; then the wide frown.
    expect(at(0.7)).toBe('own');
    expect(at(0.85)).toBe('own');
    expect(at(0.9)).toBe('wide-frown');
    expect(at(1)).toBe('wide-frown');
    // It never goes back up as the level rises, and a broken level is a quiet day.
    const mouths = Array.from({ length: 21 }, (_, step) => mouthFor(step / 20));
    expect([...mouths].sort((a, b) => a - b)).toEqual(mouths);
    expect(at(Number.NaN)).toBe('wide-smile');
    expect(MOUTHS[OWN_MOUTH]).toBe('own');
  });

  it('knows where the mouth is in every frame at the desk, and nowhere else', () => {
    // The working pup's head never moves: the box as drawn.
    for (const desk of ['work-code', 'work-web', 'work-ai-stress']) {
      for (let frame = 0; frame < 4; frame++) expect(mouthAt(desk, frame)).toEqual([0, 0]);
    }
    // In a meeting it nods: the mouth goes with it, a few pixels.
    const nods = Array.from({ length: 24 }, (_, frame) => mouthAt('meeting', frame)!);
    expect(nods.every(Boolean)).toBe(true);
    expect(new Set(nods.map(([, dy]) => dy)).size).toBeGreaterThan(1);
    expect(nods.every(([dx, dy]) => Math.abs(dx) <= 2 && Math.abs(dy) <= 4)).toBe(true);
    // Putting the headset on in place keeps it; leaving for bed only has it while the pup still sits there.
    expect(mouthAt('transition-work-meeting', 31)).toBeTruthy();
    expect(mouthAt('transition-work-rest', 0)).toEqual([0, 0]);
    expect(mouthAt('transition-work-rest', 20)).toBeUndefined();
    // Asleep, at a meal or away it has that scene's own face; hugs are their own sheets.
    for (const scene of ['rest', 'meal', 'idle', 'hug-walker', 'hug-visit-work']) expect(hasMouth(scene)).toBe(false);
    expect(mouthAt('work-code', 9)).toBeUndefined();
    expect(mouthBox.width).toBeGreaterThan(0);
  });
});
