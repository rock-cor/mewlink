import { activityKinds, workVisuals, type ActivityKind, type OperationBatch, type OperationPoint, type WorkVisual } from '../domain/types';
import type { InputSignal } from '../platform/activity';

export const MAX_OPERATION_POINTS = 256;
const MAX_OPERATION_COUNT = 1_000_000;
export const OPERATION_BATCH_MS = 10_000;
// Input is recorded as counts per quarter-second window (the same as live
// typing), never as the instant of each key press: the rhythm of single keys
// can give away what was typed.
export const OPERATION_WINDOW_MS = 250;
// The native ratchet refuses plaintext over 8,000 bytes. Points plus the event
// envelope must fit, so a batch also closes once its points reach this size.
export const MAX_OPERATION_POINT_BYTES = 6_000;

export function validOperationBatch(value: unknown): value is OperationBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as OperationBatch;
  if (batch.format !== 1 || !Number.isFinite(Date.parse(batch.startedAt)) || !Array.isArray(batch.points)
    || !batch.points.length || batch.points.length > MAX_OPERATION_POINTS) return false;
  let previous = -1;
  return batch.points.every(point => {
    if (!Array.isArray(point) || point.length !== 6 || !point.every(Number.isSafeInteger)
      || point[0] < previous || point[0] < 0 || point[0] > 60_000
      || point.slice(1, 4).some(value => value < 0 || value > MAX_OPERATION_COUNT)
      || point[3] > point[2] || !activityKinds[point[4]] || !workVisuals[point[5]]) return false;
    previous = point[0];
    return true;
  });
}

const windowStart = (ms: number) => Math.floor(Math.max(0, ms) / OPERATION_WINDOW_MS) * OPERATION_WINDOW_MS;
/** A count the receiver accepts (validOperationBatch), however many events a window had. */
const count = (value: number) => Math.min(MAX_OPERATION_COUNT, Math.max(0, Math.round(value)));

export class OperationRecorder {
  private points: OperationPoint[] = [];
  private pointBytes = 0;
  private startedAt = 0;
  constructor(private readonly emit: (batch: OperationBatch) => void) {}
  push(at: number, activity: ActivityKind, visual: WorkVisual, counts = { keyboard: 0, pointer: 0, clicks: 0 }) {
    if (this.points.length && (at - this.startedAt >= OPERATION_BATCH_MS || at < this.startedAt
      || this.points.length >= MAX_OPERATION_POINTS)) this.flush();
    // A batch starts on a window's edge, not at the instant of its first key press.
    if (!this.points.length) this.startedAt = windowStart(at);
    const window = windowStart(at - this.startedAt);
    let point: OperationPoint = [window, count(counts.keyboard), count(counts.pointer), count(counts.clicks),
      activityKinds.indexOf(activity), workVisuals.indexOf(visual)];
    // More input in the same window, in the same state: one point, counts added.
    const last = this.points.at(-1);
    if (last && last[0] === window && last[4] === point[4] && last[5] === point[5]) {
      this.pointBytes -= JSON.stringify(last).length;
      for (const index of [1, 2, 3] as const) last[index] = count(last[index] + point[index]);
      this.pointBytes += JSON.stringify(last).length;
      return;
    }
    if (this.points.length && this.pointBytes + JSON.stringify(point).length + 1 > MAX_OPERATION_POINT_BYTES) {
      this.flush();
      this.startedAt = windowStart(at);
      point = [0, ...point.slice(1)] as OperationPoint;
    }
    this.points.push(point);
    this.pointBytes += JSON.stringify(point).length + 1;
  }
  input(previous: InputSignal, current: InputSignal, at: number, activity: ActivityKind, visual: WorkVisual) {
    const keyboard = Math.max(0, current.keyboardSequence - previous.keyboardSequence);
    const pointer = Math.max(0, current.pointerSequence - previous.pointerSequence);
    const clicks = Math.max(0, current.pointerClickSequence - previous.pointerClickSequence);
    if (keyboard || pointer || clicks) this.push(at, activity, visual, { keyboard, pointer: Math.max(pointer, clicks), clicks });
  }
  snapshot(): OperationBatch | undefined {
    return this.points.length ? { format: 1, startedAt: new Date(this.startedAt).toISOString(), points: this.points.map(point => [...point]) } : undefined;
  }
  flush() {
    const batch = this.snapshot();
    this.points = [];
    this.pointBytes = 0;
    if (batch) this.emit(batch);
  }
}
