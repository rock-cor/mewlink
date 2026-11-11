// The rate limiter on its own (no Worker runtime). Run: node test/limiter.test.mjs
import assert from 'node:assert/strict';
import { admit, OVER_LIMIT_CLOSE_MS, OVER_LIMIT_DROPS, RATE_BURST } from '../src/limiter.ts';

const fresh = () => ({ tokens: RATE_BURST, refilledAt: 0 });
/** Sends `perSecond` frames a second for `seconds`; returns what happened. */
function run(perSecond, seconds, bucket = fresh(), from = 0) {
  const result = { pass: 0, drop: 0, close: undefined, frames: 0 };
  const step = 1000 / perSecond;
  for (let at = from; at < from + seconds * 1000; at += step) {
    result.frames++;
    const admitted = admit(bucket, at);
    if (admitted === 'close') { result.close = at - from; break; }
    result[admitted]++;
  }
  return result;
}

// A normal client (four pulses a second, with a rekey now and then) never drops.
const normal = run(4, 3_600);
assert.equal(normal.drop, 0);
assert.equal(normal.close, undefined);

// A burst is absorbed, the excess dropped, and the socket stays open.
const burst = run(60, 1);
assert.ok(burst.pass >= RATE_BURST && burst.pass <= RATE_BURST + 8, `passed ${burst.pass}`);
assert.equal(burst.close, undefined);

// A flood is closed after a few hundred dropped frames, not left to run: before
// this fix one frame got through every 125 ms and reset the limit for good.
const flood = run(10_000, 120);
assert.ok(flood.close !== undefined, 'a flood must be closed');
assert.ok(flood.frames <= RATE_BURST + OVER_LIMIT_DROPS + 8, `handled ${flood.frames} frames`);
assert.ok(flood.close < 100, `closed after ${flood.close} ms`);

// Just over the rate, never quiet: closed too, within the time limit.
const steady = run(12, 60);
assert.ok(steady.close !== undefined && steady.close <= OVER_LIMIT_CLOSE_MS + 20_000, `closed after ${steady.close} ms`);

// A short burst followed by quiet is forgiven: later bursts start a new spell.
const bucket = fresh();
for (let round = 0; round < 50; round++) {
  const again = run(40, 1, bucket, round * 30_000);
  assert.equal(again.close, undefined, `round ${round}`);
}

console.log('limiter: ok');
