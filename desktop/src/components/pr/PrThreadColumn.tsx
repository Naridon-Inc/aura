// PrThreadColumn — SS.3. Floating speech-bubble pattern (Graphite /
// Image #9 parity). Each registered diff-row anchor positions a
// FloatingThreadCard at the EXACT line-top, not stacked into a
// vertical overflow column. The active card lifts (z-index + ring +
// solid bg), so when several threads cluster on adjacent lines the
// user can still focus on one. Non-active cards remain visible at
// their line heights as faint cards behind, so the user perceives
// "this code has threads here" without needing a separate list.
//
// Anchors are registered by per-file diff cards via context. A single
// raf-coalesced measurement pass computes each thread's top relative
// to this column (which sits at the very top of the aside, so its
// own top === aside's top). Threads scroll naturally with the page
// because the aside flows with content.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PrComment } from "../../lib/api";
import { FloatingThreadCard, type ThreadGroup } from "./PrDiffBody";

type AnchorEntry = {
  rowEl: HTMLElement;
  thread: ThreadGroup;
};

type Registry = {
  anchors: Map<string, AnchorEntry>;
  listeners: Set<() => void>;
};

type CtxShape = {
  register: (
    key: string,
    rowEl: HTMLElement | null,
    thread: ThreadGroup | null,
  ) => void;
  registry: Registry;
  repoRoot: string;
  prNumber: number;
  onPosted?: (c: PrComment) => void;
  /** Stage 8L — comment ↔ code highlight. The currently-focused
   *  thread anchor key (`${file.path}@${rightLine}`). When set, the
   *  matching diff row in the file card draws a teal ring (Graphite
   *  parity) and the corresponding floating thread card lifts onto a
   *  solid background. Clicking a floating card or a thread row in
   *  the right rail mutates this; clicking outside any card clears
   *  it. */
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
};

const Ctx = createContext<CtxShape | null>(null);

type ProviderProps = {
  repoRoot: string;
  prNumber: number;
  onPosted?: (c: PrComment) => void;
  children: React.ReactNode;
};

export function PrThreadProvider({
  repoRoot,
  prNumber,
  onPosted,
  children,
}: ProviderProps) {
  // Single registry shared across all PrFileDiffCards under this
  // provider. Mutating its Map directly + bumping listeners avoids
  // the per-render setState churn that bit us in the inline-overflow
  // approach.
  const registryRef = useRef<Registry>({
    anchors: new Map(),
    listeners: new Set(),
  });

  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const setActiveKey = useCallback((k: string | null) => {
    setActiveKeyState(k);
  }, []);

  // Stage 8M — Esc clears the highlight. Deliberate exit hatch since
  // we no longer auto-clear on stray mousedown.
  useEffect(() => {
    if (!activeKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveKeyState(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeKey]);

  const register = useCallback<CtxShape["register"]>(
    (key, rowEl, thread) => {
      const r = registryRef.current;
      if (!rowEl || !thread) {
        if (r.anchors.has(key)) {
          r.anchors.delete(key);
          for (const l of r.listeners) l();
        }
        return;
      }
      const prev = r.anchors.get(key);
      if (prev && prev.rowEl === rowEl && prev.thread === thread) return;
      r.anchors.set(key, { rowEl, thread });
      for (const l of r.listeners) l();
    },
    [],
  );

  return (
    <Ctx.Provider
      value={{
        register,
        registry: registryRef.current,
        repoRoot,
        prNumber,
        onPosted,
        activeKey,
        setActiveKey,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function usePrThreadRegister() {
  const v = useContext(Ctx);
  return v?.register ?? null;
}

/** Stage 8L — read/write the active highlighted thread anchor. Used
 *  by file cards (to draw the ring on the matching diff row) and by
 *  thread surfaces (to set the key on click). Returns null context
 *  outside the provider so callers can no-op safely. */
export function usePrThreadActive(): {
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
} {
  const v = useContext(Ctx);
  return {
    activeKey: v?.activeKey ?? null,
    setActiveKey: v?.setActiveKey ?? (() => {}),
  };
}

type Placed = {
  key: string;
  thread: ThreadGroup;
  top: number;
};

function samePlaced(a: Placed[], b: Placed[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
    if (a[i].thread !== b[i].thread) return false;
    if (Math.abs(a[i].top - b[i].top) > 0.5) return false;
  }
  return true;
}

export function PrThreadColumn() {
  const v = useContext(Ctx);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const heights = useRef<Map<string, number>>(new Map());
  const cardObserverRef = useRef<ResizeObserver | null>(null);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const rafRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    rafRef.current = null;
    const col = columnRef.current;
    if (!col || !v) return;
    const colRect = col.getBoundingClientRect();
    // SS.3 — position each card at its EXACT anchor line top (no
    // anti-overlap stacking). When several threads cluster, they
    // visually overlap; the active card lifts via z-index/ring so
    // the user can still focus on one without losing the sense that
    // "this region has threads here". Matches Graphite / Image #9.
    const next: Placed[] = [];
    for (const [key, { rowEl, thread }] of v.registry.anchors) {
      const rect = rowEl.getBoundingClientRect();
      next.push({ key, thread, top: rect.top - colRect.top });
    }
    next.sort((a, b) => a.top - b.top);
    setPlaced((prev) => (samePlaced(prev, next) ? prev : next));
  }, [v]);

  const schedule = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  // Stable ref-callback per key so React doesn't churn it; tracks each
  // card element + observes its size for re-layout when content changes
  // (reply expand/collapse, composer open).
  const setCardRef = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      const obs = cardObserverRef.current;
      const prev = cardRefs.current.get(key);
      if (prev && obs) obs.unobserve(prev);
      if (el) {
        cardRefs.current.set(key, el);
        if (obs) obs.observe(el);
      } else {
        cardRefs.current.delete(key);
        heights.current.delete(key);
      }
    },
    [],
  );

  useEffect(() => {
    if (!v) return;
    v.registry.listeners.add(schedule);
    schedule();
    return () => {
      v.registry.listeners.delete(schedule);
    };
  }, [v, schedule]);

  useLayoutEffect(() => {
    schedule();
    const colObs = new ResizeObserver(() => schedule());
    if (columnRef.current) colObs.observe(columnRef.current);

    const cardObs = new ResizeObserver((entries) => {
      let dirty = false;
      for (const e of entries) {
        const el = e.target as HTMLDivElement;
        let entryKey: string | null = null;
        for (const [k, ref] of cardRefs.current) {
          if (ref === el) {
            entryKey = k;
            break;
          }
        }
        if (!entryKey) continue;
        const h = e.contentRect.height;
        const prev = heights.current.get(entryKey);
        if (prev == null || Math.abs(prev - h) > 0.5) {
          heights.current.set(entryKey, h);
          dirty = true;
        }
      }
      if (dirty) schedule();
    });
    cardObserverRef.current = cardObs;
    for (const el of cardRefs.current.values()) cardObs.observe(el);

    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      colObs.disconnect();
      cardObs.disconnect();
      cardObserverRef.current = null;
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [schedule]);

  if (!v) return null;
  // SS.3 — when an active key is set, render *only* that card so
  // overlapping anchors don't compete for attention (Image #9 pattern).
  // When nothing is active, render all cards faintly at their line
  // heights so the user perceives where threads exist. Click activates.
  const visible = v.activeKey
    ? placed.filter((p) => p.key === v.activeKey)
    : placed;
  return (
    <div ref={columnRef} className="absolute inset-0 pointer-events-none">
      {visible.map(({ key, thread, top }) => {
        const active = v.activeKey === key;
        return (
          <div
            key={key}
            ref={setCardRef(key)}
            onClick={(e) => {
              e.stopPropagation();
              v.setActiveKey(active ? null : key);
            }}
            className={`pointer-events-auto absolute left-2 right-2 transition-shadow rounded-lg ${
              active
                ? "z-10 ring-1 ring-accent/70 shadow-[0_0_0_4px_var(--color-accent-soft),0_10px_28px_rgba(0,0,0,0.45)]"
                : "opacity-80 hover:opacity-100"
            }`}
            style={{ top: Math.max(top, 0) }}
          >
            <FloatingThreadCard
              embed
              top={0}
              thread={thread}
              repoRoot={v.repoRoot}
              prNumber={v.prNumber}
              onPosted={v.onPosted}
            />
          </div>
        );
      })}
    </div>
  );
}
