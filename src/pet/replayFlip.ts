import { useEffect, useRef, useState } from 'react';

// TA's pup has two sides, like a card: its front is TA now, its back (drawn
// mirrored) is the replay of TA's day. A click on it turns it over, and so
// does anything else that starts or ends a replay. The turn squeezes the pup
// to a line and opens it again mirrored (styles.css .partner-pet.replay-side);
// what it shows changes at the middle of the turn, while it is edge-on.

/** How long the turn takes, before the animation speed setting. */
export const FLIP_MS = 460;

export function useReplayFlip(playing: boolean, reducedMotion = false, scale = 1) {
  /** The side it is on or turning to. Set together with `flipping`, so the turn runs at its own pace from the start. */
  const [mirrored, setMirrored] = useState(playing);
  /** Which side's scene shows: it follows half a turn later. */
  const [replayShown, setReplayShown] = useState(playing);
  const [flipping, setFlipping] = useState(false);
  const before = useRef(playing);
  // Read when a turn begins: a turn under way is never restarted by a change of settings.
  const pace = useRef({ reducedMotion, scale });
  pace.current = { reducedMotion, scale };
  useEffect(() => {
    if (before.current === playing) return;
    before.current = playing;
    setMirrored(playing);
    if (pace.current.reducedMotion) { setReplayShown(playing); return; }
    const duration = FLIP_MS * pace.current.scale;
    setFlipping(true);
    const half = window.setTimeout(() => setReplayShown(playing), duration / 2);
    const done = window.setTimeout(() => setFlipping(false), duration + 80);
    return () => { window.clearTimeout(half); window.clearTimeout(done); };
  }, [playing]);
  return {
    /** The pup is on (or turning to) its replay side. */
    mirrored,
    /** It is turning: scenes change at once, without walking from one to the other. */
    flipping,
    replayShown,
  };
}
