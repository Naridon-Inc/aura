// TimelineScrubber — the horizontal bottom timeline (the headline of the
// Project Timeline wizard). A churn sparkline you can scrub: drag the playhead
// anywhere and it snaps to the nearest real moment, lighting the project's
// history up to that point in the app's accent and ghosting the future.
//
// Visual language (on-brand, single-accent — Aura's green `--color-accent`):
//   • churn bars  — one per bucket, DIVERGING around a centre baseline:
//                   additions rise above (accent), removals drop below (red),
//                   so you see whether a slice mostly added or removed, not just
//                   "lots changed". Bars before the playhead fill solid; after,
//                   they ghost. That "filled-so-far" read is the lit bar.
//   • moment dots — a clickable dot per logged intent along the baseline.
//   • day ticks   — date labels beneath, so the scrub has real calendar anchors.
//   • playhead    — an accent line + knob you can drag (pointer) or step
//                   (the parent owns ←/→/space).
//
// The component is presentational: it owns pointer math (x → fraction → nearest
// moment) and calls `onSelectMoment`; the parent owns the selected index and
// playback. No data shaping here — that's `timelineModel`.

import { useCallback, useRef } from "react";
import type { TimelineModel } from "../../../lib/timelineModel";
import {
  fractionOfTs,
  momentStamp,
  nearestMomentIndex,
  tsAtFraction,
} from "../../../lib/timelineModel";

export function TimelineScrubber({
  model,
  selectedIndex,
  onSelectMoment,
  playing,
}: {
  model: TimelineModel;
  selectedIndex: number;
  onSelectMoment: (index: number) => void;
  playing: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const selectedFrac =
    selectedIndex >= 0 && selectedIndex < model.moments.length
      ? fractionOfTs(model, model.moments[selectedIndex].ts)
      : 0;
  const fillPct = `${(selectedFrac * 100).toFixed(3)}%`;

  // Peak churn → bar heights. The sparkline DIVERGES around a centre baseline:
  // additions grow upward, removals grow downward, so a slice that mostly
  // deleted reads as a downstroke at a glance (not a tall "lots changed" bar
  // that hides whether code came or went). We scale both directions by the same
  // single peak — the larger of the busiest add-slice and the busiest del-slice
  // — so up and down are directly comparable. A faint floor keeps empty
  // stretches legible as "time passed, nothing changed" rather than a gap.
  let peak = 1;
  for (const b of model.buckets) peak = Math.max(peak, b.adds, b.dels);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || model.moments.length === 0) return;
      const rect = el.getBoundingClientRect();
      const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const ts = tsAtFraction(model, frac);
      const idx = nearestMomentIndex(model, ts);
      if (idx >= 0) onSelectMoment(idx);
    },
    [model, onSelectMoment],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      seekToClientX(e.clientX);
    },
    [seekToClientX],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      seekToClientX(e.clientX);
    },
    [seekToClientX],
  );
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  if (model.moments.length === 0) return null;

  return (
    <div className="select-none">
      {/* The scrub track — churn sparkline + dots + playhead. */}
      <div
        ref={trackRef}
        className="relative h-24 cursor-pointer rounded-lg border border-line bg-bg-2/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="slider"
        aria-label="Project timeline"
        aria-valuemin={0}
        aria-valuemax={model.moments.length - 1}
        aria-valuenow={selectedIndex}
      >
        {/* Filled-so-far wash — the accent-lit "you are here" history. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-l-lg"
          style={{
            width: fillPct,
            background:
              "linear-gradient(90deg, color-mix(in oklab, var(--color-accent) 9%, transparent), color-mix(in oklab, var(--color-accent) 16%, transparent))",
          }}
        />

        {/* Diverging churn bars. Each slice splits at a centre baseline:
            additions rise above it (accent), removals drop below it (red).
            Slices left of the playhead read solid; right of it ghost — the
            project's past vs. its not-yet. */}
        <div className="pointer-events-none absolute inset-x-2 bottom-6 top-3 flex items-stretch gap-px">
          {model.buckets.map((b, i) => {
            const aH = b.adds > 0 ? 8 + (b.adds / peak) * 92 : 0;
            const dH = b.dels > 0 ? 8 + (b.dels / peak) * 92 : 0;
            const churn = b.adds + b.dels;
            const bucketFrac = model.buckets.length > 1 ? i / (model.buckets.length - 1) : 0;
            const past = bucketFrac <= selectedFrac;
            const addBg = past
              ? "color-mix(in oklab, var(--color-accent) 78%, transparent)"
              : "color-mix(in oklab, var(--color-accent) 20%, transparent)";
            const delBg = past
              ? "color-mix(in oklab, #f87171 72%, transparent)"
              : "color-mix(in oklab, #f87171 20%, transparent)";
            return (
              <div
                key={i}
                className="flex flex-1 flex-col"
                style={{ minWidth: 1 }}
                title={churn > 0 ? `+${b.adds} −${b.dels} · ${b.count} change${b.count === 1 ? "" : "s"}` : undefined}
              >
                {/* upper half — additions grow up from the centre line */}
                <div className="flex flex-1 items-end">
                  <div
                    className="w-full rounded-t-sm transition-colors"
                    style={{ height: `${aH}%`, background: aH > 0 ? addBg : "transparent" }}
                  />
                </div>
                {/* the centre baseline — a hairline so empty slices still read */}
                <div className="h-px w-full bg-line-soft" />
                {/* lower half — removals grow down from the centre line */}
                <div className="flex flex-1 items-start">
                  <div
                    className="w-full rounded-b-sm transition-colors"
                    style={{ height: `${dH}%`, background: dH > 0 ? delBg : "transparent" }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Moment dots along the baseline — each a clickable beat in the story. */}
        <div className="pointer-events-none absolute inset-x-2 bottom-[18px] h-2">
          {model.moments.map((m, i) => {
            const left = `${(fractionOfTs(model, m.ts) * 100).toFixed(3)}%`;
            const isSel = i === selectedIndex;
            return (
              <span
                key={`${m.ts}-${i}`}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left,
                  width: isSel ? 9 : 5,
                  height: isSel ? 9 : 5,
                  background: isSel
                    ? "var(--color-accent)"
                    : "color-mix(in oklab, var(--color-accent) 45%, var(--color-bg-2))",
                  boxShadow: isSel
                    ? "0 0 0 3px color-mix(in oklab, var(--color-accent) 22%, transparent)"
                    : "none",
                }}
              />
            );
          })}
        </div>

        {/* Playhead — a grabber knob on the track, an accent line through it,
            and a tall SPINE that rises above the track all the way up through
            the moment detail (the "line to everything"): one vertical thread
            ties the bottom timeline to the story it's parked on. A floating
            timestamp pill rides the spine just above the track. Because all of
            this lives in the playhead group at `left: fillPct` (the track's own
            coordinate space), it stays pixel-aligned with the knob for free. */}
        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ left: fillPct }}
        >
          {/* The spine — fades out as it climbs so it never fights the text. */}
          <div
            className="absolute bottom-full left-1/2 -translate-x-1/2 w-px"
            style={{
              height: "82vh",
              background:
                "linear-gradient(to top, color-mix(in oklab, var(--color-accent) 60%, transparent), color-mix(in oklab, var(--color-accent) 4%, transparent))",
            }}
          />
          {/* Floating timestamp pill, parked on the spine just above the track. */}
          {model.moments[selectedIndex] && (
            <div className="absolute bottom-full left-1/2 mb-2.5 -translate-x-1/2 whitespace-nowrap rounded-full border border-line-soft bg-bg-1/95 px-2.5 py-1 text-2xs font-medium tabular-nums text-text-2 shadow-[0_2px_10px_rgba(0,0,0,0.28)] backdrop-blur">
              {momentStamp(model.moments[selectedIndex].ts)}
            </div>
          )}
          <div
            className="absolute inset-y-2 -translate-x-1/2 w-px"
            style={{ background: "var(--color-accent)" }}
          />
          <div
            className={`absolute -top-1 -translate-x-1/2 h-3.5 w-3.5 rounded-full border-2 border-bg-content ${playing ? "animate-pulse" : ""}`}
            style={{
              background: "var(--color-accent)",
              boxShadow: "0 1px 4px color-mix(in oklab, var(--color-accent) 50%, transparent)",
            }}
          />
        </div>
      </div>

      {/* Day ticks — calendar anchors under the track. Collapsed to the first
          handful + last so a long history doesn't crowd; the scrub itself is
          continuous regardless. */}
      <div className="relative mt-1.5 h-4 text-2xs text-text-4">
        {pickDayTicks(model).map((d) => (
          <span
            key={d.key}
            className="absolute -translate-x-1/2 whitespace-nowrap tabular-nums"
            style={{ left: `${(fractionOfTs(model, d.startTs) * 100).toFixed(3)}%` }}
          >
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Thin the day labels so they never overlap: always keep first + last, then
 *  evenly sample the middle to at most ~8 ticks. */
function pickDayTicks(model: TimelineModel) {
  const days = model.days;
  if (days.length <= 8) return days;
  const out = [days[0]];
  const step = (days.length - 1) / 7;
  for (let i = 1; i < 7; i++) out.push(days[Math.round(i * step)]);
  out.push(days[days.length - 1]);
  // De-dup in case rounding collided.
  const seen = new Set<string>();
  return out.filter((d) => {
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
}
