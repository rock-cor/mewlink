import { describe, expect, it } from 'vitest';
import type { HistoryRef } from '../storage/events';
import { addLiveSpan, dayInstant, dayKey, dayProgress, daySpanMs, firstUnseen, formatDuration, groupReplayDays, liveBarSpans, liveSpanAt, partnerClock, REST_GAP_MS, restingAt, restSpans, unseenMs, unseenWorkMs } from './days';

const LONDON = 60;
const iso = (h: number, m = 0, day = 8) => new Date(Date.UTC(2026, 9, day, h, m)).toISOString();
const batch = (at: string, id = at): HistoryRef => ({ id, at, kind: 'operation.batch' });
/** Batches every 10 s from `from` (UTC hours) for `minutes`. */
function work(day: number, hour: number, minute: number, minutes: number) {
  return Array.from({ length: minutes * 6 }, (_, i) => batch(new Date(Date.UTC(2026, 9, day, hour, minute) + i * 10_000).toISOString()));
}

describe('replay days', () => {
  it('ends a day at the partner\'s own midnight', () => {
    // 22:30 UTC is 23:30 in London (still the 8th); 23:30 UTC is 00:30 on the 9th there.
    expect(dayKey(Date.parse(iso(22, 30)), LONDON)).toBe('2026-10-08');
    expect(dayKey(Date.parse(iso(23, 30)), LONDON)).toBe('2026-10-09');
    const days = groupReplayDays([batch(iso(22, 30)), batch(iso(23, 30))], LONDON);
    expect(days.map(day => day.key)).toEqual(['2026-10-08', '2026-10-09']);
  });

  it('keeps interrupted work in one day and shows the pauses as rest', () => {
    // 09:00-11:00, a 2-minute pause, 11:02-12:00, lunch, 13:00-16:10 (London, UTC+1).
    const refs = [...work(8, 8, 0, 120), ...work(8, 10, 2, 58), ...work(8, 12, 0, 190)];
    const [day] = groupReplayDays(refs, LONDON);
    // The short pause belongs to the morning; lunch is rest.
    expect(day.sessions).toHaveLength(2);
    expect(Math.round(daySpanMs(day) / 60_000)).toBe(430);
    expect(Math.round(day.activeMs / 60_000)).toBe(370);
    expect(formatDuration(daySpanMs(day), 'zh')).toBe('7 小时 10 分');
    expect(formatDuration(day.activeMs, 'zh-Hant')).toBe('6 小時 10 分');
    expect(formatDuration(day.activeMs, 'en')).toBe('6 h 10 min');
    const [lunch] = restSpans(day);
    expect(restSpans(day)).toHaveLength(1);
    expect((lunch.to - lunch.from) * daySpanMs(day) / 60_000).toBeCloseTo(60, 0); // its true length
  });

  it('maps bar positions to the partner\'s real time, rest included', () => {
    const refs = [...work(8, 8, 0, 60), ...work(8, 12, 0, 60)];
    const [day] = groupReplayDays(refs, LONDON);
    expect(dayInstant(day, 0)).toBe(day.start);
    expect(dayInstant(day, 1)).toBe(day.end);
    expect(restingAt(day, Date.parse(iso(10)))).toBe(true); // during the break
    expect(restingAt(day, Date.parse(iso(8, 30)))).toBe(false);
    for (const fraction of [0, 0.1, 0.37, 0.75, 1]) expect(dayProgress(day, dayInstant(day, fraction))).toBeCloseTo(fraction, 6);
  });

  it('measures what is still unseen, rest included', () => {
    const [day] = groupReplayDays([...work(8, 8, 0, 60), ...work(8, 12, 0, 60)], LONDON);
    expect(unseenMs(day, 0)).toBe(daySpanMs(day));
    expect(unseenWorkMs(day, 0)).toBe(day.activeMs);
    expect(Math.round(unseenMs(day, Date.parse(iso(10))) / 60_000)).toBe(180);
    expect(Math.round(unseenWorkMs(day, Date.parse(iso(10))) / 60_000)).toBe(60);
    expect(unseenMs(day, day.end)).toBe(0);
  });

  it('never offers what was seen live while both apps were online', () => {
    // 08:00-09:00 London: I was away. 09:00-12:00: both online. 12:00-14:00: away again.
    const [day] = groupReplayDays(work(8, 7, 0, 6 * 60), LONDON);
    const live = addLiveSpan([], Date.parse(iso(8)), Date.parse(iso(11)));
    expect(Math.round(unseenMs(day, 0, live) / 60_000)).toBe(180);
    expect(Math.round(unseenWorkMs(day, 0, live) / 60_000)).toBe(180);
    // Watched up to 08:30: the rest of the morning and the afternoon are left.
    expect(Math.round(unseenMs(day, Date.parse(iso(7, 30)), live) / 60_000)).toBe(150);
    // Starting where the morning ends jumps to where the live stretch ends.
    expect(firstUnseen(day, Date.parse(iso(8)), live)).toBe(Date.parse(iso(11)));
    expect(firstUnseen(day, Date.parse(iso(7, 30)), live)).toBe(Date.parse(iso(7, 30)));
    expect(liveSpanAt(live, Date.parse(iso(10)))).toEqual([Date.parse(iso(8)), Date.parse(iso(11))]);
    expect(liveSpanAt(live, Date.parse(iso(11)))).toBeUndefined();
    const [bar] = liveBarSpans(day, live);
    expect(bar.from).toBeCloseTo(1 / 6, 6);
    expect(bar.to).toBeCloseTo(4 / 6, 6);
    // Seen live from the first record to now: nothing to offer.
    expect(unseenMs(day, 0, addLiveSpan([], day.start - 1, day.end + 1))).toBe(0);
  });

  it('keeps live stretches merged, in order, and only as long as replay itself', () => {
    let live = addLiveSpan([], 100, 200);
    live = addLiveSpan(live, 150, 260);
    live = addLiveSpan(live, 500, 600);
    live = addLiveSpan(live, 10, 20);
    expect(live).toEqual([[10, 20], [100, 260], [500, 600]]);
    expect(addLiveSpan(live, 260, 300)).toEqual([[10, 20], [100, 300], [500, 600]]);
    expect(addLiveSpan(live, 700, 700, 250)).toEqual([[100, 260], [500, 600]]);
  });

  it('short gaps are still work, longer ones are rest', () => {
    const at = Date.parse(iso(9));
    const near = [batch(new Date(at).toISOString()), batch(new Date(at + 10_000 + REST_GAP_MS).toISOString())];
    const far = [batch(new Date(at).toISOString()), batch(new Date(at + 10_000 + REST_GAP_MS + 1).toISOString())];
    expect(groupReplayDays(near, 0)[0].sessions).toHaveLength(1);
    expect(groupReplayDays(far, 0)[0].sessions).toHaveLength(2);
  });

  it('ends each day at the midnight the partner had when recording (daylight saving, travel)', () => {
    // London leaves summer time on 25 Oct 2026. 23:30 UTC on the 24th is 00:30 BST on the 25th.
    const beforeChange = { ...batch(iso(23, 30, 24)), offset: 60 };
    const afterChange = { ...batch(iso(12, 0, 25)), offset: 0 };
    // Grouped with today's (winter) offset alone, the 00:30 record would land on the 24th.
    const days = groupReplayDays([beforeChange, afterChange], 0);
    expect(days.map(day => day.key)).toEqual(['2026-10-25']);
    expect(days[0].refs).toHaveLength(2);
    // The bar's clock uses the offset the day ended with.
    expect(days[0].offset).toBe(0);
    // Records without an offset (older versions) use the partner's current one.
    expect(groupReplayDays([batch(iso(23, 30, 24))], 0)[0].key).toBe('2026-10-24');
  });

  it('shows the bar time in the partner\'s own clock', () => {
    expect(partnerClock(Date.parse(iso(13, 5)), LONDON)).toBe('10/08 14:05');
    expect(partnerClock(Date.parse(iso(23, 30)), LONDON)).toBe('10/09 00:30');
  });

  it('formats short durations', () => {
    expect(formatDuration(40 * 60_000, 'zh')).toBe('40 分钟');
    expect(formatDuration(20_000, 'zh')).toBe('不到 1 分钟');
    expect(formatDuration(2 * 3_600_000, 'en')).toBe('2 h');
    expect(formatDuration(5 * 60_000, 'en')).toBe('5 min');
  });
});
