// The frame rate limit of a live socket, apart from the Worker runtime so it
// can be tested on its own (test/limiter.test.mjs).
//
// A client sends at most four pulses a second. Frames beyond the rate are
// dropped; a socket that keeps sending over it is closed, and the room then
// refuses that device for a while, so a flood costs its sender a new
// connection for every few hundred frames instead of running for free.

export const RATE_PER_SECOND = 8;
export const RATE_BURST = 16;
/** Dropped frames a socket may have in one over-the-rate spell before it is closed (a backlog after a stalled connection stays under it). */
export const OVER_LIMIT_DROPS = 400;
/** A spell this long is closed even if it never reached that many drops. */
export const OVER_LIMIT_CLOSE_MS = 10_000;
/** A spell ends only after this long without a dropped frame. */
export const OVER_LIMIT_CLEAR_MS = 2_000;
/** How long the room refuses a device it closed for flooding. */
export const FLOOD_REFUSAL_MS = 60_000;

export interface Bucket {
  tokens: number;
  refilledAt: number;
  /** When the current over-the-rate spell began. */
  overSince?: number;
  /** Its last dropped frame, and how many it has dropped. */
  droppedAt?: number;
  dropped?: number;
}

/**
 * Accounts for one frame at `now`: 'pass' forwards it, 'drop' ignores it, and
 * 'close' ends a socket that has stayed over the rate. One frame getting
 * through as the bucket refills does not end a spell; only a quiet spell does.
 */
export function admit(bucket: Bucket, now: number): 'pass' | 'drop' | 'close' {
  bucket.tokens = Math.min(RATE_BURST, bucket.tokens + Math.max(0, now - bucket.refilledAt) / 1000 * RATE_PER_SECOND);
  bucket.refilledAt = now;
  if (bucket.overSince !== undefined && now - (bucket.droppedAt ?? bucket.overSince) > OVER_LIMIT_CLEAR_MS) {
    bucket.overSince = bucket.droppedAt = bucket.dropped = undefined;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 'pass';
  }
  bucket.overSince ??= now;
  bucket.droppedAt = now;
  bucket.dropped = (bucket.dropped ?? 0) + 1;
  return bucket.dropped > OVER_LIMIT_DROPS || now - bucket.overSince > OVER_LIMIT_CLOSE_MS ? 'close' : 'drop';
}
