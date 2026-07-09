// MeaningPlanePanel — the calm, read-only home for Aura's portable
// "why + proof" record (M4, sovereign substrate). For our non-engineer
// audience the promise is simple: every change here carries the reason it was
// made, and Aura checks whether what was promised actually happened — and
// because that record travels with the repo on ANY git host, it stays
// verifiable on this very copy you cloned. No terminal, no jargon.
//
// Two reads on mount:
//   • `metaPlaneVerify` → the top banner ("Verified on this clone", or "N
//     things need a look").
//   • `metaPlaneLog`    → the recent commits, each with its proof pill and an
//     expandable "Why" (the recorded reasons + the goals that were checked).
//
// We never invent a datum. If a proof or a reason isn't recorded, the row
// simply omits it — nothing is faked to look complete. Arctic-blue is reserved
// for the one primary affordance (Refresh); green means "good", amber means
// "needs a look".

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import {
  metaPlaneLog,
  metaPlaneVerify,
  type MetaLogEntry,
  type MetaVerifyReport,
} from "../../lib/metaPlane";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type Props = {
  repoRoot: string;
};

type LoadState = "loading" | "ready" | "error";

export function MeaningPlanePanel({ repoRoot }: Props) {
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>("");
  const [report, setReport] = useState<MetaVerifyReport | null>(null);
  const [entries, setEntries] = useState<MetaLogEntry[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    let alive = true;
    setState("loading");
    setError("");
    Promise.all([metaPlaneVerify(repoRoot), metaPlaneLog(repoRoot)])
      .then(([verify, log]) => {
        if (!alive) return;
        setReport(verify);
        setEntries(log);
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setError(typeof e === "string" ? e : String(e));
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  useEffect(() => load(), [load]);

  const toggle = (sha: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0">
      <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-line-soft px-4">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-tight text-text-1">
            Why &amp; proof
          </div>
          <div className="text-[10.5px] leading-tight text-text-3">
            The reason behind each change, checked on this copy
          </div>
        </div>
        <Button
          variant="subtle"
          size="xs"
          onClick={() => load()}
          disabled={state === "loading"}
          className="ml-auto gap-1.5 text-text-2"
        >
          <RefreshCw
            size={12}
            className={cn(state === "loading" && "animate-spin")}
          />
          Refresh
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state === "loading" && <LoadingState />}
        {state === "error" && <ErrorState message={error} onRetry={() => load()} />}
        {state === "ready" && (
          <>
            {report && <VerifyBanner report={report} />}
            {entries.length === 0 ? (
              <EmptyState />
            ) : (
              <ul className="flex flex-col gap-1.5 p-3">
                {entries.map((entry) => (
                  <CommitRow
                    key={entry.sha}
                    entry={entry}
                    open={open.has(entry.sha)}
                    onToggle={() => toggle(entry.sha)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Top banner ─────────────────────────────────────────────────────────────

function VerifyBanner({ report }: { report: MetaVerifyReport }) {
  // Green only when something is actually proven and nothing needs a look.
  if (report.ok && report.proven > 0) {
    return (
      <BannerShell tone="ok">
        <ShieldCheck size={15} className="shrink-0 text-accent-green" />
        <span className="text-[12px] font-medium text-text-1">
          Verified on this clone
        </span>
        <span className="text-[11.5px] text-text-3">
          {report.proven} of {report.commits} change
          {report.commits === 1 ? "" : "s"} proven
        </span>
      </BannerShell>
    );
  }

  // Amber when the engine flagged things that need a look.
  if (!report.ok) {
    const n = report.issues.length;
    return (
      <BannerShell tone="warn">
        <AlertTriangle size={15} className="shrink-0 text-amber" />
        <span className="text-[12px] font-medium text-text-1">
          {n} thing{n === 1 ? "" : "s"} need a look
        </span>
        {report.issues[0] && (
          <span className="truncate text-[11.5px] text-text-3" title={report.issues.join("\n")}>
            {report.issues[0]}
          </span>
        )}
      </BannerShell>
    );
  }

  // Calm neutral — nothing's wrong, but there's nothing proven yet either.
  return (
    <BannerShell tone="calm">
      <CheckCircle2 size={15} className="shrink-0 text-text-3" />
      <span className="text-[12px] font-medium text-text-2">
        Nothing needs a look
      </span>
      <span className="text-[11.5px] text-text-3">
        {report.intent_covered} of {report.commits} change
        {report.commits === 1 ? "" : "s"} carry a reason
      </span>
    </BannerShell>
  );
}

function BannerShell({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "calm";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-line-soft px-4 py-2.5",
        tone === "ok" && "bg-[color-mix(in_srgb,var(--color-accent-green)_8%,transparent)]",
        tone === "warn" && "bg-[color-mix(in_srgb,var(--color-amber)_8%,transparent)]",
        tone === "calm" && "bg-bg-1/40",
      )}
    >
      {children}
    </div>
  );
}

// ── One commit ──────────────────────────────────────────────────────────────

function CommitRow({
  entry,
  open,
  onToggle,
}: {
  entry: MetaLogEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const hasWhy = entry.rows.length > 0;
  const hasProof = !!entry.proof;
  const expandable = hasWhy || hasProof;

  return (
    <li className="overflow-hidden rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)]">
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left",
          expandable && "hover:bg-bg-2/50",
        )}
      >
        <code className="shrink-0 font-mono text-[10.5px] text-text-4">
          {entry.short}
        </code>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-1" title={entry.summary}>
          {entry.summary}
        </span>
        <ProofPill proof={entry.proof} />
        {expandable &&
          (open ? (
            <ChevronDown size={13} className="shrink-0 text-text-4" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-text-4" />
          ))}
      </button>

      {open && expandable && (
        <div className="flex flex-col gap-2.5 border-t border-line-soft px-3 py-2.5">
          {hasWhy && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-text-4">
                Why
              </div>
              {entry.rows.map((row, i) => (
                <div key={`${row.ts}-${i}`} className="flex flex-col">
                  <p className="text-[11.5px] leading-relaxed text-text-2">{row.intent}</p>
                  <span className="text-[10.5px] text-text-4">{row.agent_id}</span>
                </div>
              ))}
            </div>
          )}

          {entry.proof && entry.proof.goals.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-text-4">
                What was checked
              </div>
              {entry.proof.goals.map((goal) => (
                <div key={goal.id} className="flex items-start gap-2">
                  <GoalDot verdict={goal.verdict} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] leading-relaxed text-text-2">{goal.text}</p>
                    <span className="text-[10.5px] text-text-4">
                      {goalLabel(goal.verdict)} · {goal.ok}/{goal.total}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ProofPill({ proof }: { proof?: MetaLogEntry["proof"] }) {
  if (!proof) {
    return (
      <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-text-4">
        Not checked
      </span>
    );
  }
  const proven = proof.verdict === "verified" || (proof.total > 0 && proof.ok === proof.total);
  if (proven) {
    return (
      <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-accent-green)_14%,transparent)] px-2 py-0.5 text-[10px] font-medium text-accent-green">
        Proven · {proof.ok}/{proof.total}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-amber)_14%,transparent)] px-2 py-0.5 text-[10px] font-medium text-amber">
      Almost · {proof.ok}/{proof.total}
    </span>
  );
}

function GoalDot({ verdict }: { verdict: string }) {
  const ok = verdict === "verified";
  const partial = verdict === "partial";
  return (
    <span
      className={cn(
        "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
        ok && "bg-accent-green",
        partial && "bg-amber",
        !ok && !partial && "bg-text-5",
      )}
    />
  );
}

function goalLabel(verdict: string): string {
  switch (verdict) {
    case "verified":
      return "Proven";
    case "partial":
      return "Partly proven";
    case "not_wired":
      return "Not connected yet";
    default:
      return "Not checked";
  }
}

// ── Loading / empty / error ─────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <RefreshCw size={16} className="animate-spin text-text-4" />
      <p className="text-[12px] text-text-3">Reading the record…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <ShieldCheck size={20} className="text-text-4" />
      <p className="text-[12.5px] font-medium text-text-2">Nothing recorded yet</p>
      <p className="max-w-[280px] text-[11.5px] leading-relaxed text-text-4">
        Run <code className="font-mono text-text-3">aura meta push</code> to capture why each
        change was made.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center">
      <AlertTriangle size={18} className="text-amber" />
      <p className="text-[12.5px] font-medium text-text-2">Couldn’t read the record</p>
      <p className="max-w-[300px] text-[11.5px] leading-relaxed text-text-4">{message}</p>
      <Button variant="subtle" size="xs" onClick={onRetry} className="mt-1 gap-1.5 text-text-2">
        <RefreshCw size={12} />
        Try again
      </Button>
    </div>
  );
}
