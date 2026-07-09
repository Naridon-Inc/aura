// Aura-aware metadata strip mounted above the DiffView when a file is
// opened from the right-rail Changes panel. Surfaces what plain `git
// diff` can't see: which AST symbols were touched, which intent-log
// entries explain the changes, how many snapshots Aura has saved, and
// quick-action buttons (Rewind, Log Intent, Snapshot now).
//
// Collapsible — defaults open, persists per-session via localStorage.

import { useEffect, useState } from "react";
import { useFileInsight } from "../lib/useFileInsight";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { SymbolContextMenu } from "./SymbolContextMenu";

const COLLAPSE_KEY = "aura.fileInsight.open";

type Props = {
  repoRoot: string;
  /** Absolute file path. The hook normalises to a repo-relative form. */
  absPath: string;
  /** Display name (basename or short relative path) — caller already
   *  computes one for the breadcrumb so we just consume it. */
  fileLabel: string;
  /** Quick-action wires. App.tsx passes its existing dialog openers. */
  onOpenRewind?: () => void;
  onLogIntent?: () => void;
  onSnapshot?: () => void;
};

export function FileInsightStrip({
  repoRoot,
  absPath,
  fileLabel,
  onOpenRewind,
  onLogIntent,
  onSnapshot,
}: Props) {
  const [open, setOpen] = useState<boolean>(
    () => localStorage.getItem(COLLAPSE_KEY) !== "0",
  );
  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, open ? "1" : "0");
  }, [open]);

  const insight = useFileInsight(repoRoot, absPath);

  const touchedSymbols = insight.symbols.filter((s) => s.touched);
  const intentCount = insight.relatedIntents.length;

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
          {(insight.additions > 0 || insight.deletions > 0) && (
            <span className="flex items-center gap-1">
              {insight.additions > 0 && (
                <span className="text-green font-medium">+{insight.additions}</span>
              )}
              {insight.deletions > 0 && (
                <span className="text-red font-medium">−{insight.deletions}</span>
              )}
            </span>
          )}
          {touchedSymbols.length > 0 && (
            <Pill tone="amber" label={`${touchedSymbols.length} changed`} />
          )}
          {intentCount > 0 && (
            <Pill tone="blue" label={`${intentCount} note${intentCount === 1 ? "" : "s"}`} />
          )}
          {insight.snapshotCount > 0 && (
            <Pill tone="violet" label={`${insight.snapshotCount} snapshot${insight.snapshotCount === 1 ? "" : "s"}`} />
          )}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-2.5 pt-1 grid grid-cols-3 gap-3">
          <Section title="What changed" count={touchedSymbols.length}>
            {insight.loading && touchedSymbols.length === 0 ? (
              <Muted>scanning…</Muted>
            ) : touchedSymbols.length === 0 ? (
              <Muted>nothing flagged here</Muted>
            ) : (
              <ul className="space-y-0.5">
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
          </Section>

          <Section title="Why it changed" count={intentCount}>
            {insight.loading && intentCount === 0 ? (
              <Muted>scanning…</Muted>
            ) : intentCount === 0 ? (
              <Muted>no notes mention this file</Muted>
            ) : (
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
            )}
          </Section>

          <div>
            <header className="flex items-center gap-1.5 mb-1.5">
              <span className="text-text-3 text-[10px] uppercase tracking-wider font-medium">
                Actions
              </span>
            </header>
            <div className="flex flex-col gap-1">
              <ActionLine
                label={`Time machine${insight.snapshotCount > 0 ? ` · ${insight.snapshotCount} saved` : ""}`}
                disabled={insight.snapshotCount === 0 || !onOpenRewind}
                onClick={onOpenRewind}
                hint="Bring back an earlier version of this file"
              />
              <ActionLine
                label="Add a reason"
                onClick={onLogIntent}
                hint="Record why these changes were made"
              />
              <ActionLine
                label="Save a point now"
                onClick={onSnapshot}
                hint="Save a point you can always come back to"
              />
            </div>
          </div>
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

function Pill({
  tone,
  label,
}: {
  tone: "amber" | "blue" | "violet";
  label: string;
}) {
  const cls =
    tone === "amber"
      ? "text-amber bg-amber/10"
      : tone === "blue"
        ? "text-blue bg-blue/10"
        : "text-violet bg-violet/10";
  return (
    <span className={`px-1.5 py-px rounded text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function ActionLine({
  label,
  hint,
  onClick,
  disabled,
}: {
  label: string;
  hint: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  if (disabled || !onClick) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-text-4 text-[11px] cursor-default truncate">
            · {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">{hint}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="text-text-2 hover:text-text-1 text-[11px] text-left truncate hover:underline underline-offset-2"
        >
          → {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{hint}</TooltipContent>
    </Tooltip>
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
  const tone =
    kind === "fn"
      ? "text-green"
      : kind === "class"
        ? "text-violet"
        : kind === "type"
          ? "text-amber"
          : "text-text-4";
  return (
    <span className={`text-[9px] uppercase tracking-wider w-6 shrink-0 ${tone}`}>
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
