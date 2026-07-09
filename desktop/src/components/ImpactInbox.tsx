// Top-bar Impact Inbox — Linear-style badge + dropdown that surfaces
// every unresolved cross-branch impact alert in the current repo. The
// AuraImpactsBanner still ships as the loud "don't miss it" strip;
// this is the *always-visible*, scannable panel.
//
// One badge in TopBar. Click → flyout with one row per alert: severity
// dot, function name, severity label, source branch, age. Two actions
// per row: "open" (jumps to the file) and "✓" (acks via auraResolveImpact).
//
// Source: same `auraReadImpacts` poll as the banner. Badge count = live
// unresolved alerts that haven't been dismissed in this session.

import { useEffect, useRef, useState } from "react";
import { api, type ImpactAlert } from "../lib/api";
import { useDocumentVisibility } from "../lib/useDocumentVisibility";

const POLL_MS = 20_000;

type Props = {
  repoRoot: string;
  /** Open the file at the impacted function. */
  onOpenFile?: (path: string) => void;
  /** Pivot user to the full ImpactsPane sidebar tab. */
  onOpenAll?: () => void;
};

export function ImpactInbox({ repoRoot, onOpenFile, onOpenAll }: Props) {
  const [alerts, setAlerts] = useState<ImpactAlert[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const visible = useDocumentVisibility();

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    async function tick() {
      try {
        const list = await api.auraReadImpacts(repoRoot);
        if (!cancelled) setAlerts(list);
      } catch {
        /* ignore */
      }
    }
    void tick();
    if (!visible) return () => {
      cancelled = true;
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoRoot, visible]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const live = alerts.filter((a) => !a.resolved);
  const count = live.length;
  const ranked = [...live].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const topTone = count > 0 ? severityTone(ranked[0].severity) : null;

  async function ack(id: string) {
    setBusyId(id);
    try {
      await api.auraResolveImpact(repoRoot, id);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      /* ignore — next tick will re-show if it's still live */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        title={
          count > 0
            ? `${count} unresolved cross-branch impact${count === 1 ? "" : "s"}`
            : "Cross-branch impacts (none)"
        }
        onClick={() => setOpen((v) => !v)}
        className={`w-[22px] h-[22px] rounded flex items-center justify-center transition-colors relative ${
          open
            ? "bg-bg-card text-text-1"
            : "hover:bg-bg-hover hover:text-text-1 text-text-3"
        }`}
      >
        <BellGlyph />
        {count > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center"
            style={{
              background: topTone?.dot ?? "var(--color-red)",
              color: "white",
              border: "1.5px solid var(--color-bg-0, #0c0d10)",
            }}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-[26px] z-50 bg-bg-1 border border-line rounded-lg shadow-xl"
          style={{ width: 360, maxHeight: 460 }}
        >
          <div className="flex items-center px-3 h-8 border-b border-line-soft">
            <span className="text-[11px] uppercase tracking-wider text-text-3">
              Impact inbox
            </span>
            <span className="ml-auto text-[10.5px] tabular-nums text-text-4">
              {count} unresolved
            </span>
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: 380 }}>
            {count === 0 ? (
              <div className="px-3 py-6 text-center text-text-4 text-[11.5px]">
                No cross-branch impacts.
                <div className="mt-1 text-[10.5px] text-text-4 opacity-70">
                  Aura watches functions you depend on across active branches.
                </div>
              </div>
            ) : (
              <ul>
                {ranked.map((a) => {
                  const tone = severityTone(a.severity);
                  return (
                    <li
                      key={a.id}
                      className="group flex items-start gap-2 px-3 py-2 border-b border-line-soft last:border-b-0 hover:bg-bg-2"
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
                        style={{ background: tone.dot }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-[11.5px]">
                          <span className="font-mono text-text-1 truncate">
                            {a.function || "(unknown)"}
                          </span>
                          <span
                            className="text-[9.5px] uppercase tracking-wider px-1 rounded"
                            style={{
                              background: `color-mix(in oklab, ${tone.dot} 18%, transparent)`,
                              color: tone.text,
                            }}
                          >
                            {a.severity}
                          </span>
                        </div>
                        <div className="text-text-3 text-[11px] truncate mt-0.5">
                          {a.message || "impact alert"}
                        </div>
                        <div className="text-text-4 text-[10.5px] mt-0.5 flex items-center gap-1.5">
                          <span className="font-mono truncate">{a.branch}</span>
                          {a.file && (
                            <>
                              <span>·</span>
                              <span className="truncate">{a.file}</span>
                            </>
                          )}
                          <span className="ml-auto tabular-nums">
                            {relAge(a.timestamp)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {a.file && onOpenFile && (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenFile(a.file);
                              setOpen(false);
                            }}
                            title="Open file"
                            className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-1"
                          >
                            <OpenGlyph />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => ack(a.id)}
                          disabled={busyId === a.id}
                          title="Acknowledge"
                          className="size-5 rounded flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-1 disabled:opacity-40"
                        >
                          <CheckGlyph />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {onOpenAll && count > 0 && (
            <button
              type="button"
              onClick={() => {
                onOpenAll();
                setOpen(false);
              }}
              className="w-full h-8 border-t border-line-soft text-[11px] text-text-2 hover:text-text-1 hover:bg-bg-2 transition-colors"
            >
              Open Impacts pane →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BellGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2v1M4 7a4 4 0 0 1 8 0v3l1 2H3l1-2V7zM6.5 13a1.5 1.5 0 0 0 3 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OpenGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
      <path
        d="M9.5 3H13v3.5M13 3l-6 6M6.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function severityRank(s: string): number {
  switch (s) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function severityTone(s: string): { dot: string; text: string } {
  if (s === "critical" || s === "high")
    return { dot: "var(--color-red)", text: "var(--color-red)" };
  if (s === "medium")
    return {
      dot: "var(--color-amber, #d4a017)",
      text: "var(--color-amber, #d4a017)",
    };
  return {
    dot: "var(--color-blue, #4a8cff)",
    text: "var(--color-blue, #4a8cff)",
  };
}

function relAge(unixSecs: number): string {
  const ageS = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (ageS < 60) return `${ageS}s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h`;
  return `${Math.floor(ageS / 86400)}d`;
}
