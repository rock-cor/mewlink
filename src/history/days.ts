import type { HistoryRef } from '../storage/events';
import type { Language } from '../platform/language';
import { OPERATION_BATCH_MS } from './operations';

// Replay is offered per day of the partner's own calendar (a day ends at their
// midnight) and runs on their real clock at its real pace (no fast-forward),
// from the first record of the day to the last. While the app runs, two
// minutes without input are recorded as idle and ten as rest, so a longer
// silence means the app was offline (closed, asleep, recording off): all of it
// is shown as rest, taking its true share of the bar and of the playback time.
// While both apps were online, TA's pup was live here: those stretches were
// seen as they happened, so they are never offered and replay skips them.
export const REST_GAP_MS = 3 * 60_000;
/** Replay plays at the partner's real pace; the user can jump anywhere on the bar. */
export const REPLAY_SPEED = 1;

export interface ReplaySession { start: number; end: number }
export interface ReplayDay {
  key: string;
  refs: HistoryRef[];
  /** Stretches with records; the gaps between them are rest. */
  sessions: ReplaySession[];
  /** Time inside sessions. */
  activeMs: number;
  start: number;
  end: number;
  /** The partner's UTC offset at the end of the day, for the bar's clock. */
  offset: number;
}

/** "10/08 14:05" in the partner's own time, for the replay bar. */
export function partnerClock(at: number, offsetMinutes: number) {
  const local = new Date(at + offsetMinutes * 60_000).toISOString();
  return `${local.slice(5, 7)}/${local.slice(8, 10)} ${local.slice(11, 16)}`;
}

/** The partner's calendar date of an instant, as YYYY-MM-DD. */
export function dayKey(at: number, offsetMinutes: number) {
  return new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

const refSpan = (ref: HistoryRef) => ref.kind === 'operation.batch' ? OPERATION_BATCH_MS : 1_000;

export function groupReplayDays(refs: readonly HistoryRef[], offsetMinutes: number): ReplayDay[] {
  const days = new Map<string, ReplayDay>();
  for (const ref of [...refs].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const at = Date.parse(ref.at);
    if (!Number.isFinite(at)) continue;
    // Each record's own offset, so a daylight-saving change or a trip moves
    // midnight only for the records made after it.
    const offset = ref.offset ?? offsetMinutes;
    const key = dayKey(at, offset);
    let day = days.get(key);
    if (!day) { day = { key, refs: [], sessions: [], activeMs: 0, start: at, end: at, offset }; days.set(key, day); }
    day.offset = offset;
    day.refs.push(ref);
    const end = at + refSpan(ref);
    const last = day.sessions.at(-1);
    if (last && at - last.end <= REST_GAP_MS) last.end = Math.max(last.end, end);
    else day.sessions.push({ start: at, end });
    day.end = Math.max(day.end, end);
  }
  for (const day of days.values()) day.activeMs = day.sessions.reduce((sum, s) => sum + (s.end - s.start), 0);
  return [...days.values()].sort((a, b) => a.start - b.start);
}

/** From the first record to the last, rest included. */
export const daySpanMs = (day: ReplayDay) => day.end - day.start;

/** Share (0..1) of the day that has passed at instant `at`. */
export function dayProgress(day: ReplayDay, at: number) {
  const span = daySpanMs(day);
  return span > 0 ? Math.min(1, Math.max(0, (at - day.start) / span)) : 0;
}

/** The instant at `fraction` of the day. */
export function dayInstant(day: ReplayDay, fraction: number) {
  return day.start + Math.min(1, Math.max(0, fraction)) * daySpanMs(day);
}

/** The rests between sessions, as bar positions (0..1). */
export function restSpans(day: ReplayDay) {
  return day.sessions.slice(1).map((session, index) => ({
    from: dayProgress(day, day.sessions[index].end), to: dayProgress(day, session.start),
  }));
}

/** Whether `at` falls in a rest between two sessions. */
export function restingAt(day: ReplayDay, at: number) {
  return day.sessions.some((session, index) => index > 0 && at < session.start && at >= day.sessions[index - 1].end);
}

/** A stretch [from, to] (ms) when TA's pup was live here. Lists are sorted and never overlap. */
export type LiveSpan = readonly [number, number];

/** Adds a stretch watched live, merged with those it touches; drops those that ended before `keepSince`. */
export function addLiveSpan(spans: readonly LiveSpan[], from: number, to: number, keepSince = -Infinity): LiveSpan[] {
  const all = [...spans, [from, to] as const].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && b >= keepSince)
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of all) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** The stretch watched live that `at` falls in, if any. */
export function liveSpanAt(live: readonly LiveSpan[], at: number) {
  return live.find(([from, to]) => at >= from && at < to);
}

const watchedLiveMs = (from: number, to: number, live: readonly LiveSpan[]) =>
  live.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(to, b) - Math.max(from, a)), 0);

/** Time after `seen` (the replay watermark), rest included, not watched live. */
export function unseenMs(day: ReplayDay, seen: number, live: readonly LiveSpan[] = []) {
  const from = Math.max(day.start, seen);
  return Math.max(0, day.end - from - watchedLiveMs(from, day.end, live));
}

/** Time in sessions after `seen`, not watched live. */
export function unseenWorkMs(day: ReplayDay, seen: number, live: readonly LiveSpan[] = []) {
  return day.sessions.reduce((sum, s) => {
    const from = Math.max(s.start, seen);
    return sum + Math.max(0, s.end - from - watchedLiveMs(from, s.end, live));
  }, 0);
}

/** The first moment from `seen` on that was not watched live (the day's end if none). */
export function firstUnseen(day: ReplayDay, seen: number, live: readonly LiveSpan[] = []) {
  let at = Math.max(day.start, seen);
  for (const [from, to] of live) if (at >= from && at < to) at = to;
  return Math.min(at, day.end);
}

/** The stretches watched live, as bar positions (0..1). */
export function liveBarSpans(day: ReplayDay, live: readonly LiveSpan[]) {
  return live.filter(([from, to]) => to > day.start && from < day.end)
    .map(([from, to]) => ({ from: dayProgress(day, from), to: dayProgress(day, to) }));
}

export function formatDuration(ms: number, language: Language) {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (language === 'en') {
    if (minutes < 1) return 'under 1 min';
    return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${minutes} min`;
  }
  const hour = language === 'zh-Hant' ? '小時' : '小时', minute = language === 'zh-Hant' ? '分鐘' : '分钟';
  if (minutes < 1) return language === 'zh-Hant' ? '不到 1 分鐘' : '不到 1 分钟';
  return hours ? `${hours} ${hour}${rest ? ` ${rest} 分` : ''}` : `${minutes} ${minute}`;
}
