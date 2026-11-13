import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { liveBarSpans, restSpans, type LiveSpan, type ReplayDay } from '../history/days';
import { PixelIcon } from './PixelIcon';

interface NoticeProps {
  label: string;
  detail: string;
  onPlay: () => void;
  /** Shown with the pets' menu, not all the time; over it, the menu stays open. */
  shown?: boolean;
  onReveal?: () => void;
  onHide?: () => void;
}

/** "TA 的回放 · 5 小时": offered under the partner's pup instead of starting by itself. */
export function ReplayNotice({ label, detail, onPlay, shown = true, onReveal, onHide }: NoticeProps) {
  return <button type="button" className={`replay-notice with-menu ${shown ? 'menu-visible' : ''}`} title={detail}
    onPointerDown={event => event.stopPropagation()} onClick={onPlay}
    onPointerEnter={onReveal} onPointerLeave={onHide} onFocus={onReveal} onBlur={onHide}>
    <PixelIcon name="replay" /><span>{label}</span>
  </button>;
}

interface ScrubberProps {
  day: ReplayDay;
  /** 0..1 of the day, rest included. */
  progress: number;
  /** Stretches seen live (both apps online): marked, and skipped when playing. */
  live?: readonly LiveSpan[];
  /** Where the replay is, in the partner's own time. */
  timeLabel: string;
  positionLabel: string;
  closeLabel: string;
  onSeek: (fraction: number) => void;
  onClose: () => void;
  /** Shown with the pets' menu, not all the time (TA's mirrored pup already says it is a replay); over it, the menu stays open. */
  shown?: boolean;
  onReveal?: () => void;
  onHide?: () => void;
  /** Dragging the thumb begins and ends: the bar must stay while it is held. */
  onScrub?: (active: boolean) => void;
}

/** A video-style bar for one day: rest is dotted, what was seen live is pale, click or drag to jump, arrows step 5%. */
export function ReplayScrubber({ day, progress, live = [], timeLabel, positionLabel, closeLabel, onSeek, onClose,
  shown: visible = true, onReveal, onHide, onScrub }: ScrubberProps) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number>();
  const scrub = useRef(onScrub);
  scrub.current = onScrub;
  // A replay that ends while the thumb is held must not leave the bar marked as held.
  useEffect(() => () => scrub.current?.(false), []);
  // Arrow presses add up even before the seek they started has caught up.
  const pendingKey = useRef<{ at: number; fraction: number }>(undefined);
  const fractionAt = (event: PointerEvent) => {
    const box = track.current?.getBoundingClientRect();
    return box && box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0;
  };
  const shown = dragging ?? progress;
  const step = (event: KeyboardEvent) => {
    const delta = event.key === 'ArrowRight' ? 0.05 : event.key === 'ArrowLeft' ? -0.05 : 0;
    if (!delta) return;
    event.preventDefault();
    const recent = pendingKey.current && performance.now() - pendingKey.current.at < 600 ? pendingKey.current.fraction : progress;
    const fraction = Math.min(1, Math.max(0, recent + delta));
    pendingKey.current = { at: performance.now(), fraction };
    onSeek(fraction);
  };
  return <div className={`replay-scrubber with-menu ${visible ? 'menu-visible' : ''}`} onPointerDown={event => event.stopPropagation()}
    onPointerEnter={onReveal} onPointerLeave={onHide} onFocus={onReveal} onBlur={onHide}>
    <span className="replay-time">{timeLabel}</span>
    <div ref={track} className="replay-track" role="slider" tabIndex={0} aria-label={positionLabel}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)} aria-valuetext={timeLabel}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(fractionAt(event)); onScrub?.(true); }}
      onPointerMove={event => { if (dragging !== undefined) setDragging(fractionAt(event)); }}
      onPointerUp={event => { if (dragging === undefined) return; setDragging(undefined); onScrub?.(false); onSeek(fractionAt(event)); }}
      onPointerCancel={() => { setDragging(undefined); onScrub?.(false); }}
      onKeyDown={step}>
      <span className="replay-fill" style={{ width: `${shown * 100}%` }} />
      {restSpans(day).map(rest => <i key={rest.from} className="replay-rest"
        style={{ left: `${rest.from * 100}%`, width: `${(rest.to - rest.from) * 100}%` }} />)}
      {liveBarSpans(day, live).map(span => <i key={span.from} className="replay-live"
        style={{ left: `${span.from * 100}%`, width: `${(span.to - span.from) * 100}%` }} />)}
      <span className="replay-thumb" style={{ left: `${shown * 100}%` }} />
    </div>
    <button type="button" className="replay-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}><PixelIcon name="close" /></button>
  </div>;
}
