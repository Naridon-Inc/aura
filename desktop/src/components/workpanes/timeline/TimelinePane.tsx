// TimelinePane — the Project Timeline experience: relive how the project came
// to be. It reads the real intent log (the same feed Sessions reads), folds it
// into a time-ordered narrative (timelineModel), and lays it out as:
//
//   • a left rail of CHAPTERS (sessions/runs) you can jump between,
//   • a center DETAIL of the moment the playhead is parked on (the "why" + the
//     code it touched + how far the build had come), and
//   • a bottom SCRUBBER — a churn sparkline you drag, with play/step transport,
//     so the project's history plays back like a film.
//
// It owns the selected moment + playback; the scrubber and detail are
// presentational. Pure data shaping lives in timelineModel, so this file is
// just load + layout + transport.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type IntentRow } from "../../../lib/api";
import { fetchIntentRows, peekIntentRows } from "../../../lib/intentCache";
import {
  buildTimelineModel,
  dayLabelOf,
  type TimelineModel,
} from "../../../lib/timelineModel";
import { requestOpenSessionDetail } from "../../../lib/traceNav";
import { TimelineScrubber } from "./TimelineScrubber";
import { TimelineMomentDetail } from "./TimelineMomentDetail";
import { Button } from "../../ui/button";

// How long each beat lingers during playback. Slow enough to read the headline,
// brisk enough that a long history doesn't drag.
const PLAY_INTERVAL_MS = 1100;

export function TimelinePane({ repoRoot }: { repoRoot: string }) {
  // Seed from the per-repo cache so re-opening the Timeline paints instantly
  // instead of replaying the "Reading the project's history…" screen.
  const [rows, setRows] = useState<IntentRow[] | null>(
    () => peekIntentRows(repoRoot) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Load resilience: a manual retry nonce so the user is never stranded on a
  // stuck read, and a "this is slow" flag so a long load reads as *working*,
  // not frozen. (The engine occasionally saturates the async runtime; without
  // an escape hatch the calm "Reading…" line looks like a hung app.)
  const [loadNonce, setLoadNonce] = useState(0);
  const [slow, setSlow] = useState(false);

  // Chapters rail collapse — persisted, like the app's other side panels.
  const [chaptersOpen, setChaptersOpen] = useState(
    () => readLocal("aura.timeline.chaptersOpen") !== "0",
  );
  const toggleChapters = useCallback(() => {
    setChaptersOpen((o) => {
      writeLocal("aura.timeline.chaptersOpen", o ? "0" : "1");
      return !o;
    });
  }, []);

  // One clock read for the whole pane (relative stamps don't need to tick).
  const [nowSecs] = useState(() => Math.floor(Date.now() / 1000));

  // Load the full history. A generous cap so even long-lived repos show their
  // whole arc; the model collapses the noise. We paint cached rows immediately
  // (older history never changes — the log is append-only) and refresh in the
  // background, so the slow read only blocks a true cold open.
  useEffect(() => {
    let alive = true;
    const cached = peekIntentRows(repoRoot);
    if (cached) {
      setRows(cached);
      setSlow(false);
    } else {
      setRows(null);
      setSlow(false);
    }
    setError(null);
    // If a COLD read hasn't returned in a few seconds, surface a gentle "still
    // working + Try again" so the screen never just sits there silently. With
    // cached rows already on screen there's nothing to wait on visibly.
    const slowTimer = cached
      ? null
      : window.setTimeout(() => {
          if (alive) setSlow(true);
        }, 6000);
    fetchIntentRows(repoRoot, 4000)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        // A background refresh that fails leaves the cached rows in place; only
        // a cold open with nothing to show surfaces the error.
        if (alive && !cached) setError(String(e));
      })
      .finally(() => {
        if (slowTimer) window.clearTimeout(slowTimer);
      });
    return () => {
      alive = false;
      if (slowTimer) window.clearTimeout(slowTimer);
    };
  }, [repoRoot, loadNonce]);

  const model: TimelineModel | null = useMemo(
    () => (rows ? buildTimelineModel(rows) : null),
    [rows],
  );

  // Land the playhead on the most recent moment when the model first loads —
  // "where the project is now" is the natural starting frame.
  const settledRef = useRef(false);
  useEffect(() => {
    if (model && model.moments.length > 0 && !settledRef.current) {
      settledRef.current = true;
      setSelectedIndex(model.moments.length - 1);
    }
  }, [model]);

  const count = model?.moments.length ?? 0;

  const step = useCallback(
    (delta: number) => {
      setSelectedIndex((i) => Math.max(0, Math.min(count - 1, i + delta)));
    },
    [count],
  );

  const restart = useCallback(() => {
    setPlaying(false);
    setSelectedIndex(0);
  }, []);

  // Playback: advance one beat per tick; stop at the end.
  useEffect(() => {
    if (!playing || count === 0) return;
    const id = window.setInterval(() => {
      setSelectedIndex((i) => {
        if (i >= count - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, count]);

  // Keyboard transport — the wizard owns the whole window, so window-level keys
  // are safe (mirrors FullscreenOverlay's own Esc handling). Esc is left to the
  // overlay; we take ←/→ (step) and space (play/pause).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        step(1);
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const onSelectMoment = useCallback((idx: number) => {
    setPlaying(false);
    setSelectedIndex(idx);
  }, []);

  // ── States ──────────────────────────────────────────────────────────────

  if (error) {
    return (
      <Centered>
        <div className="text-[13px] text-text-2">
          Couldn’t read this project’s history.
        </div>
        <div className="mt-1 max-w-md text-[11px] text-text-4">{error}</div>
      </Centered>
    );
  }

  if (!model) {
    return (
      <Centered>
        <ScrubberSkeleton />
        <div className="mt-4 text-[12px] text-text-3">
          Reading the project’s history…
        </div>
        {slow && (
          <div className="mt-4 flex flex-col items-center gap-2.5">
            <div className="max-w-xs text-[11px] leading-relaxed text-text-4">
              Taking longer than usual — a large history or a busy engine. It’ll
              appear as soon as it’s ready.
            </div>
            <button
              type="button"
              onClick={() => setLoadNonce((n) => n + 1)}
              className="rounded-md border border-line px-3 py-1.5 text-[11px] text-text-2 transition-colors hover:bg-bg-2 hover:text-text-1"
            >
              Try again
            </button>
          </div>
        )}
      </Centered>
    );
  }

  if (model.moments.length === 0) {
    return (
      <Centered>
        <div className="text-[14px] font-medium text-text-1">
          No history to replay yet
        </div>
        <div className="mt-1.5 max-w-md text-[12px] leading-relaxed text-text-3">
          As you and your agents log reasons for changes, this timeline fills
          itself — every moment, who made it, and the code it touched. Come back
          after a few sessions to watch the project evolve.
        </div>
      </Centered>
    );
  }

  const activeChapter = model.moments[selectedIndex]?.sessionIndex ?? 0;

  // Jump from the parked moment to its full Session detail. Defined here (not a
  // hook) so it can close over the now-resolved model after the early returns.
  const onOpenSession = () => {
    const m = model.moments[selectedIndex];
    if (m) requestOpenSessionDetail(m.row);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg-content">
      {/* Body — chapter rail + moment detail. The overlay carries the context,
          so the pane shows no masthead of its own. The scrubber floats over the
          bottom of this body (no footer container), so the body fills the whole
          pane and the playhead spine can rise unbroken through the detail. */}
      <div className="flex min-h-0 flex-1">
        {/* Chapters: the project's runs, chronological. Collapsible to a thin
            rail so the story gets the full width when you want it. */}
        {chaptersOpen ? (
          <aside className="hidden w-[232px] flex-shrink-0 flex-col overflow-hidden border-r border-line bg-bg-1 md:flex">
            <div className="sticky top-0 z-10 flex items-center justify-between bg-bg-1/95 py-2.5 pl-4 pr-2 text-[10px] uppercase tracking-wider text-text-4 backdrop-blur">
              <span>Chapters</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={toggleChapters}
                title="Collapse chapters"
                aria-label="Collapse chapters"
                className="text-text-4 hover:text-text-1"
              >
                <CollapseIcon />
              </Button>
            </div>
            <ul className="flex-1 overflow-auto px-2 pb-3">
              {model.sessions.map((s, si) => {
                const active = si === activeChapter;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onSelectMoment(s.momentIndices[0])}
                      className={`group mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                        active
                          ? "bg-[color-mix(in_oklab,var(--color-accent)_14%,transparent)]"
                          : "hover:bg-bg-2"
                      }`}
                    >
                      <div className="flex w-full items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{
                            background: active
                              ? "var(--color-accent)"
                              : "var(--color-line)",
                          }}
                        />
                        <span
                          className={`min-w-0 flex-1 truncate text-[12px] ${
                            active ? "text-text-1" : "text-text-2"
                          }`}
                        >
                          {s.title}
                        </span>
                      </div>
                      <div className="pl-3 text-[10px] tabular-nums text-text-4">
                        {dayLabelOf(s.startTs)} · {s.momentIndices.length} step
                        {s.momentIndices.length === 1 ? "" : "s"}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        ) : (
          <button
            type="button"
            onClick={toggleChapters}
            title="Show chapters"
            aria-label="Show chapters"
            className="hidden w-10 flex-shrink-0 flex-col items-center gap-2 border-r border-line bg-bg-1 pt-3 text-text-4 transition-colors hover:text-text-1 md:flex"
          >
            <ExpandIcon />
            <span className="[writing-mode:vertical-rl] text-[10px] uppercase tracking-wider">
              Chapters
            </span>
          </button>
        )}

        {/* The moment the playhead is on. The bottom padding clears the floating
            scrubber so the "project so far" stats are never hidden under it. */}
        <div className="min-h-0 flex-1 overflow-auto">
          <TimelineMomentDetail
            model={model}
            index={selectedIndex}
            nowSecs={nowSecs}
            onOpenSession={onOpenSession}
          />
          <div className="h-44" aria-hidden />
        </div>
      </div>

      {/* Transport + scrubber — the headline bottom timeline, FLOATING over the
          body (no footer container). A top-fading scrim lets the detail text
          behind dissolve cleanly into it, and the scrubber runs full-bleed so
          the playhead spine that climbs up through the detail stays aligned. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="pointer-events-auto bg-gradient-to-t from-bg-content via-bg-content/95 to-transparent px-5 pb-4 pt-10">
          <div className="mb-2.5 flex items-center gap-3">
            <TransportButton label="Restart" onClick={restart}>
              <RestartIcon />
            </TransportButton>
            <TransportButton label="Step back (←)" onClick={() => { setPlaying(false); step(-1); }}>
              <PrevIcon />
            </TransportButton>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              title={playing ? "Pause (space)" : "Play (space)"}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#05140b] transition-transform hover:scale-105"
              style={{ background: "var(--color-accent)" }}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <TransportButton label="Step forward (→)" onClick={() => { setPlaying(false); step(1); }}>
              <NextIcon />
            </TransportButton>

            <div className="ml-1 text-[11px] tabular-nums text-text-3">
              <span className="text-text-1">{selectedIndex + 1}</span>
              <span className="text-text-4"> / {model.moments.length}</span>
            </div>

            <div className="ml-auto truncate text-[11px] text-text-4">
              {model.moments[selectedIndex] &&
                dayLabelOf(model.moments[selectedIndex].ts)}
            </div>
          </div>

          <TimelineScrubber
            model={model}
            selectedIndex={selectedIndex}
            onSelectMoment={onSelectMoment}
            playing={playing}
          />
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg-content px-6 text-center">
      {children}
    </div>
  );
}

// A calm churn-sparkline placeholder that gently pulses while the history
// loads — so the wait reads as *working*, not a frozen pane. The bars echo the
// real scrubber that lands here once the model resolves.
function ScrubberSkeleton() {
  const heights = [8, 14, 10, 20, 13, 24, 16, 11, 19, 9, 22, 12, 17, 26, 14];
  return (
    <div className="flex h-7 animate-pulse items-end gap-1 opacity-60" aria-hidden>
      {heights.map((h, i) => (
        <span
          key={i}
          className="w-1.5 rounded-sm bg-text-4"
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-bg-2 hover:text-text-1"
    >
      {children}
    </button>
  );
}

// ── Inline transport glyphs (1.6 stroke, match the app's icon weight) ───────

function PlayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="4" y="3.5" width="3" height="9" rx="1" />
      <rect x="9" y="3.5" width="3" height="9" rx="1" />
    </svg>
  );
}
function PrevIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11 3.5v9l-6-4.5z" />
      <rect x="4" y="3.5" width="1.6" height="9" rx="0.8" />
    </svg>
  );
}
function NextIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5 3.5v9l6-4.5z" />
      <rect x="10.4" y="3.5" width="1.6" height="9" rx="0.8" />
    </svg>
  );
}
function RestartIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
      <path d="M3.5 2.5v3h3" />
    </svg>
  );
}

// Chapters-rail collapse (chevron-into-edge) and expand (chevron-out) glyphs.
function CollapseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 4L6 8l4 4" />
      <path d="M3 3v10" />
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4l4 4-4 4" />
      <path d="M13 3v10" />
    </svg>
  );
}

// localStorage, defensively (private mode / quota can throw).
function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
