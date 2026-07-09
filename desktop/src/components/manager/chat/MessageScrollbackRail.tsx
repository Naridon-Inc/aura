//! Scrollback rail — a slim minimap of the chat on the right edge.
//!
//! A long conversation is hard to navigate by scrolling alone. This rail
//! mirrors the scroll container: each message becomes a tick positioned by its
//! relative offset in the scroll height, a moving thumb tracks the viewport,
//! and clicking a tick (or the track) jumps straight to that message. Hovering
//! a tick shows a HoverCard with a short preview so the user can find a
//! specific turn without reading every bubble.
//!
//! Pure DOM positioning — no charting lib. A ResizeObserver on the scroll
//! content keeps tick + thumb positions correct as content grows mid-stream;
//! scroll updates are throttled to one rAF so a streaming reply (which mutates
//! height many times a second) doesn't thrash layout.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** One navigable anchor in the scrollback. `el` is resolved lazily from the
 *  scroll container at measure time (anchors are keyed by a stable id the
 *  parent stamps as a `data-rail-id` on the message wrapper). */
export type RailAnchor = {
  id: string;
  /** Short preview shown on hover — the first line of the message / a tool name. */
  preview: string;
  /** Author tint for the tick — "user" | "agent" | "system". */
  role: "user" | "agent" | "system";
};

type Tick = {
  id: string;
  preview: string;
  role: RailAnchor["role"];
  /** 0..1 position down the track. */
  frac: number;
  /** Pixel scrollTop that lands this message at the top of the viewport. */
  top: number;
};

/** The rail. Mounts absolutely inside the scroll container's parent and reads
 *  positions off the live DOM, so it stays in sync with whatever the parent
 *  renders without the parent threading offsets through. */
export function MessageScrollbackRail({
  scrollRef,
  anchors,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  anchors: RailAnchor[];
}) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
  const [hover, setHover] = useState<{ id: string; y: number; preview: string } | null>(null);
  const rafRef = useRef<number | null>(null);

  // Recompute tick fractions + the per-anchor scrollTop targets from the live
  // DOM. Cheap enough to run on resize/scroll once coalesced into a rAF.
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const total = el.scrollHeight;
    const viewport = el.clientHeight;
    if (total <= 0) {
      setTicks([]);
      setThumb(null);
      return;
    }
    const next: Tick[] = [];
    for (const a of anchors) {
      const node = el.querySelector<HTMLElement>(`[data-rail-id="${cssEscape(a.id)}"]`);
      if (!node) continue;
      const offsetTop = node.offsetTop;
      next.push({
        id: a.id,
        preview: a.preview,
        role: a.role,
        frac: Math.max(0, Math.min(1, offsetTop / total)),
        top: offsetTop,
      });
    }
    setTicks(next);
    // Thumb: viewport-as-fraction-of-content, positioned by scrollTop.
    const thumbFrac = Math.min(1, viewport / total);
    const posFrac = total > viewport ? el.scrollTop / (total - viewport) : 0;
    const trackPad = thumbFrac; // thumb can't exceed the track
    setThumb({
      top: posFrac * (1 - trackPad),
      height: thumbFrac,
    });
  }, [scrollRef, anchors]);

  const schedule = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  // Initial + on-anchor-change measure.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Track scroll + content resize.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // Observe the first child (the content column) too — its height grows as
    // messages stream in even when the scroller's box stays fixed.
    const content = el.firstElementChild;
    if (content) ro.observe(content);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scrollRef, schedule]);

  const jumpTo = useCallback(
    (top: number) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
    },
    [scrollRef],
  );

  // Fewer than two anchors → nothing worth navigating; hide the rail.
  if (ticks.length < 2) return null;

  return (
    <div
      className="absolute top-2 bottom-2 right-1 z-10 select-none"
      style={{ width: 8 }}
      onMouseLeave={() => setHover(null)}
    >
      {/* Track — click anywhere to jump proportionally. */}
      <div
        className="relative h-full mx-auto rounded-full cursor-pointer"
        style={{ width: 4, background: "var(--color-bg-2)" }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
          const el = scrollRef.current;
          if (el) jumpTo(frac * (el.scrollHeight - el.clientHeight));
        }}
      >
        {/* Viewport thumb. */}
        {thumb && (
          <div
            className="absolute left-1/2 -translate-x-1/2 rounded-full pointer-events-none"
            style={{
              top: `${thumb.top * 100}%`,
              height: `${Math.max(thumb.height * 100, 6)}%`,
              width: 4,
              // Neutral thumb — a quiet viewport marker, no accent colour.
              background: "color-mix(in srgb, var(--color-text-4) 70%, transparent)",
            }}
          />
        )}
        {/* Per-message ticks. */}
        {ticks.map((t) => (
          <button
            key={t.id}
            type="button"
            className="absolute left-1/2 -translate-x-1/2 rounded-full transition-transform hover:scale-150"
            style={{
              top: `${t.frac * 100}%`,
              width: 5,
              height: 5,
              marginTop: -2.5,
              background: tickColor(t.role),
            }}
            onClick={(e) => {
              e.stopPropagation();
              jumpTo(t.top);
            }}
            onMouseEnter={(e) =>
              setHover({
                id: t.id,
                y: e.currentTarget.offsetTop,
                preview: t.preview,
              })
            }
            aria-label={`Jump to: ${t.preview}`}
          />
        ))}
      </div>
      {/* Hover preview label — floats left of the rail. */}
      {hover && (
        <div
          className="absolute right-4 -translate-y-1/2 max-w-[220px] truncate px-2 py-1 t-2xs pointer-events-none shadow-lg"
          style={{
            top: hover.y,
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-text-2)",
          }}
        >
          {hover.preview}
        </div>
      )}
    </div>
  );
}

function tickColor(role: RailAnchor["role"]): string {
  // Monochrome rail — no accent green. Author is conveyed by a faint
  // weight difference (user ticks read a touch stronger), nothing more.
  switch (role) {
    case "user":
      return "color-mix(in srgb, var(--color-text-3) 80%, transparent)";
    case "system":
      return "color-mix(in srgb, var(--color-text-4) 60%, transparent)";
    default:
      return "color-mix(in srgb, var(--color-text-4) 80%, transparent)";
  }
}

/** Minimal CSS.escape shim — only the chars our rail ids can contain (the
 *  parent uses `t-<index>` / persisted turn ids), but be safe for quotes. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}
