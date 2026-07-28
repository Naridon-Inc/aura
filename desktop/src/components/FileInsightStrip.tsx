// Aura-aware metadata strip mounted above the DiffView when a file is
// opened from the right-rail Changes panel. Surfaces what plain `git
// diff` can't see: which AST symbols were touched, which intent-log
// entries explain the changes, how many snapshots Aura has saved, and
// quick-action buttons (Rewind, Log Intent, Snapshot now).
//
// Collapsible — defaults open, persists per-session via localStorage.

import { useEffect, useState } from "react";
import { useFileInsight } from "../lib/useFileInsight";
import { SymbolContextMenu } from "./SymbolContextMenu";
import { Churn } from "./diff/Churn";

const COLLAPSE_KEY = "aura.fileInsight.open";

type Props = {
  repoRoot: string;
  /** Absolute file path. The hook normalises to a repo-relative form. */
  absPath: string;
  /** Display name (basename or short relative path) — caller already
   *  computes one for the breadcrumb so we just consume it. */
  fileLabel: string;
  /** Quick-action wires the callers still pass. Rewind / Log-intent /
   *  Snapshot are reachable from the command palette; the insight strip no
   *  longer surfaces them as an Actions column (it's a read-only what/why
   *  strip now), so these are accepted for callsite compatibility but unused
   *  here. */
  onOpenRewind?: () => void;
  onLogIntent?: () => void;
  onSnapshot?: () => void;
};

export function FileInsightStrip({
  repoRoot,
  absPath,
  fileLabel,
}: Props) {
  const [open, setOpen] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) !== "0",
  );
  const [showTech, setShowTech] = useState<boolean>(false);
  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, open ? "1" : "0");
  }, [open]);

  const insight = useFileInsight(repoRoot, absPath);

  const touchedSymbols = insight.symbols.filter((s) => s.touched);
  const intentCount = insight.relatedIntents.length;
  const changedLines = insight.additions + insight.deletions;
  // Plain-language lead. Prefer the model/deterministic sentence; while it's
  // still loading fall back to an immediate line-count so the panel is never
  // blank and never shows a symbol name as the headline.
  const whatText =
    insight.whatSummary?.summary?.trim() ||
    (changedLines > 0
      ? `${changedLines} line${changedLines === 1 ? "" : "s"} edited`
      : "");

  return (
    <div className="border-b border-line-soft bg-bg-1/40 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-7 px-3 flex items-center gap-2 text-left hover:bg-bg-2/40 transition-colors"
      >
        <ChevronGlyph open={open} />
        <span className="text-text-3 text-[10.5px] uppercase tracking-wider font-medium">
          Aura insight
        </span>
        <span className="text-text-1 text-[11px] truncate">{fileLabel}</span>
        <span className="ml-auto flex items-center gap-2 text-[10.5px] font-mono">
          <Churn
            additions={insight.additions}
            deletions={insight.deletions}
            className="text-[10.5px]"
          />
          {touchedSymbols.length > 0 && (
            <Pill label={`${touchedSymbols.length} changed`} />
          )}
          {intentCount > 0 && (
            <Pill label={`${intentCount} note${intentCount === 1 ? "" : "s"}`} />
          )}
          {insight.snapshotCount > 0 && (
            <Pill label={`${insight.snapshotCount} snapshot${insight.snapshotCount === 1 ? "" : "s"}`} />
          )}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1 grid grid-cols-2 gap-3">
          <Section title="What changed" count={0}>
            {whatText ? (
              <div className="text-[11px] text-text-1 leading-snug">
                {whatText}
              </div>
            ) : insight.loading ? (
              <Muted>reading the change…</Muted>
            ) : (
              <Muted>no changes vs last saved</Muted>
            )}

            {/* Symbol-level detail is real but it's jargon — demote it behind a
                toggle so the plain-language line above stays the headline. */}
            {touchedSymbols.length > 0 && (
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={() => setShowTech((v) => !v)}
                  className="flex items-center gap-1 text-[10px] text-text-4 hover:text-text-2 transition-colors"
                >
                  <ChevronGlyph open={showTech} />
                  Technical details
                  <span className="tabular-nums">({touchedSymbols.length})</span>
                </button>
                {showTech && (
                  <ul className="space-y-0.5 mt-1">
                    {touchedSymbols.slice(0, 6).map((s, i) => (
                      <SymbolContextMenu
                        key={`${s.line}-${s.name}-${i}`}
                        identifier={s.name}
                        filePath={absPath}
                        kind={s.kind}
                      >
                        <li
                          className="flex items-center gap-1.5 text-[11px] truncate cursor-default rounded px-1 -mx-1 hover:bg-bg-2/50"
                          title={`${s.kind} · line ${s.line} · right-click for actions`}
                        >
                          <KindBadge kind={s.kind} />
                          <span className="text-text-1 font-mono truncate">
                            {s.name}
                          </span>
                          <span className="ml-auto text-text-4 tabular-nums shrink-0">
                            L{s.line}
                          </span>
                        </li>
                      </SymbolContextMenu>
                    ))}
                    {touchedSymbols.length > 6 && (
                      <li className="text-text-4 text-[10.5px]">
                        +{touchedSymbols.length - 6} more
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </Section>

          {/* Why it changed — always populated, never a dead-end. Prefer notes
              bound to THIS file (the edited reason, in the agent's own words);
              fall back to the current session's stated reason (session
              context); and, only if nothing is logged at all, the plain-language
              read of the change itself. */}
          <Section title="Why it changed" count={intentCount}>
            {intentCount > 0 ? (
              <ul className="space-y-1">
                {insight.relatedIntents.slice(0, 3).map((i) => (
                  <li key={i.id} className="text-[11px]">
                    <div className="flex items-center gap-1.5 text-text-3 text-[10px]">
                      <span className="font-mono">{i.agent}</span>
                      <span>·</span>
                      <span>{relTime(i.timestamp)}</span>
                    </div>
                    <div className="text-text-1 line-clamp-2 leading-snug">
                      {i.intent}
                    </div>
                  </li>
                ))}
              </ul>
            ) : insight.sessionIntent ? (
              <div className="text-[11px]">
                <div className="flex items-center gap-1.5 text-text-3 text-[10px]">
                  <span className="uppercase tracking-wider">From this session</span>
                  <span>·</span>
                  <span className="font-mono">{insight.sessionIntent.agent}</span>
                  <span>·</span>
                  <span>{relTime(insight.sessionIntent.timestamp)}</span>
                </div>
                <div className="text-text-1 line-clamp-3 leading-snug">
                  {insight.sessionIntent.intent}
                </div>
              </div>
            ) : whatText ? (
              <div className="text-[11px]">
                <div className="text-text-3 text-[10px] uppercase tracking-wider mb-0.5">
                  Inferred from the change
                </div>
                <div className="text-text-1 leading-snug">{whatText}</div>
              </div>
            ) : insight.loading ? (
              <Muted>scanning…</Muted>
            ) : (
              <Muted>reading the change…</Muted>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <header className="flex items-center gap-1.5 mb-1.5">
        <span className="text-text-3 text-[10px] uppercase tracking-wider font-medium">
          {title}
        </span>
        {count > 0 && (
          <span className="text-text-4 text-[10px] tabular-nums">{count}</span>
        )}
      </header>
      {children}
    </div>
  );
}

/** A quiet count chip. These are categories, not warnings — three different
 *  hues here made the strip above every diff read like a legend, so they all
 *  sit on the neutral ramp and let the diff itself carry the eye. */
function Pill({ label }: { label: string }) {
  return (
    <span className="rounded bg-bg-2 px-1.5 py-px text-[10px] font-medium text-text-3">
      {label}
    </span>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-3 shrink-0 transition-transform ${
        open ? "rotate-90" : ""
      }`}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="w-6 shrink-0 text-[9px] uppercase tracking-wider text-text-4">
      {kind}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="text-text-4 text-[10.5px] py-1">{children}</div>;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
