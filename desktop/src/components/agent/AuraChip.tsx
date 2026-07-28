// Compact Aura activity chip for the agent tab header. Shows
// intents-today / snapshots-today / unacked-audit counts so a user
// running claude / gemini / codex / cursor in a bare PTY tab still
// sees the Aura semantic engine ticking in the background — no need
// to open the History sidebar to know whether intents are landing,
// snapshots are taken, or audit events have piled up.
//
// Click the chip → small popover with the last 3 intents this agent
// logged. Each row is a button — click → fires `aura:open-history` so
// the user lands on the full timeline. Closing happens on outside
// click or Escape.
//
// Polling is gated to "this tab is currently visible" because the
// counts require disk I/O on every refresh and an inactive tab has no
// reason to spend it.

import { useEffect, useRef, useState } from "react";
import { api, type IntentEntry } from "../../lib/api";

type Counts = {
  intents: number;
  snapshots: number;
  audit: number;
};

const ZERO: Counts = { intents: 0, snapshots: 0, audit: 0 };

export function AuraChip({
  repoRoot,
  agentId,
  visible,
}: {
  repoRoot: string;
  agentId: string;
  visible: boolean;
}) {
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<IntentEntry[]>([]);
  const inflight = useRef(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible || !repoRoot) return;
    let cancelled = false;
    async function tick() {
      if (inflight.current) return;
      inflight.current = true;
      try {
        const [intents, snapshots, audit] = await Promise.all([
          api.auraCountIntentsToday(repoRoot, agentId).catch(() => 0),
          api.auraCountSnapshotsToday(repoRoot).catch(() => 0),
          api.auraCountAuditUnacked(repoRoot).catch(() => 0),
        ]);
        if (!cancelled) setCounts({ intents, snapshots, audit });
      } finally {
        inflight.current = false;
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [repoRoot, agentId, visible]);

  // Load recent intents on popover open. Cheap re-fetch each open so
  // the user sees the latest entries without a manual refresh.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .auraReadIntentLogV2(repoRoot, 3, undefined, agentId)
      .then((page) => {
        if (!cancelled) setRecent(page.entries);
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoRoot, agentId]);

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dirty = counts.audit > 0;
  const tone = dirty ? "text-red" : "text-text-5";
  const title =
    `Aura activity (today): ${counts.intents} intents · ${counts.snapshots} snapshots` +
    (dirty ? ` · ${counts.audit} unacked audit` : "");

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={`inline-flex items-center gap-1 h-6 px-2 rounded font-mono text-[10.5px] border border-line-soft bg-bg-1 hover:bg-bg-2 transition-colors ${tone}`}
      >
        <span>◐</span>
        <span className="tabular-nums">{counts.intents}</span>
        <span className="text-text-5">·</span>
        <span className="tabular-nums">{counts.snapshots}</span>
        {dirty && (
          <>
            <span className="text-text-5">·</span>
            <span className="tabular-nums text-red">!{counts.audit}</span>
          </>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-80 rounded-lg border border-line-soft bg-bg-1 shadow-[var(--shadow-flyout)] py-1.5"
          role="menu"
        >
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wide text-text-5 font-mono border-b border-line-soft">
            Recent intents · {agentId}
          </div>
          {recent.length === 0 ? (
            <div className="px-3 py-3 text-[11.5px] text-text-5">
              No intents logged today.
            </div>
          ) : (
            recent.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new Event("aura:open-history"));
                }}
                className="block w-full text-left px-3 py-1.5 hover:bg-bg-2 transition-colors"
                title={e.intent}
              >
                <div className="text-[11.5px] text-text-1 truncate">
                  {e.intent}
                </div>
                <div className="text-[10px] text-text-5 font-mono mt-0.5 flex items-center gap-2">
                  <span>{relativeTime(e.timestamp)}</span>
                  {e.commit && (
                    <span className="opacity-70">{e.commit.slice(0, 7)}</span>
                  )}
                  {e.branch && (
                    <span className="opacity-70 truncate">{e.branch}</span>
                  )}
                </div>
              </button>
            ))
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event("aura:open-history"));
            }}
            className="block w-full text-center px-3 py-1.5 text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1 border-t border-line-soft transition-colors"
          >
            Open History sidebar →
          </button>
        </div>
      )}
    </div>
  );
}

function relativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
