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
import { EmptyState, ErrorState, LoadingState } from "../ui/state";

import {
  metaPlaneLog,
  metaPlaneVerify,
  type MetaLogEntry,
  type MetaVerifyReport,
} from "../../lib/metaPlane";
import { verifyBanner, type VerifyTone } from "../../lib/metaVerifyBanner";
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
          <div className="text-base font-semibold leading-tight text-text-1">
            Why &amp; proof
          </div>
          <div className="text-xs leading-tight text-text-3">
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
        {state === "loading" && <LoadingState label="Reading the record…" size="md" />}
        {state === "error" && (
          <ErrorState
            title="Couldn’t read the record"
            message={error}
            onRetry={() => void load()}
          />
        )}
        {state === "ready" && (
          <>
            {report && <VerifyBanner report={report} />}
            {entries.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="Nothing recorded yet"
                body="This is where the reason behind each change is kept, so anyone can see why it was made, not just what moved. Make a change and the first entry appears."
              />
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

// Green is earned by a verdict, never by a file being present — the fold in
// `metaVerifyBanner` is the one place that decides which of the three states
// this report has earned, so the wording and the number can't drift apart.
function VerifyBanner({ report }: { report: MetaVerifyReport }) {
  const banner = verifyBanner(report);
  const Icon =
    banner.tone === "ok"
      ? ShieldCheck
      : banner.tone === "warn"
        ? AlertTriangle
        : CheckCircle2;

  return (
    <BannerShell tone={banner.tone}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          size={15}
          className={cn(
            "shrink-0",
            banner.tone === "ok" && "text-accent-green",
            banner.tone === "warn" && "text-amber",
            banner.tone === "calm" && "text-text-3",
          )}
        />
        <span
          className={cn(
            "shrink-0 text-sm font-medium",
            banner.tone === "calm" ? "text-text-2" : "text-text-1",
          )}
        >
          {banner.title}
        </span>
        {banner.detail && (
          <span
            className="truncate text-sm text-text-3"
            title={report.issues.length > 0 ? report.issues.join("\n") : undefined}
          >
            {banner.detail}
          </span>
        )}
      </div>
      {banner.scope && (
        <span className="mt-0.5 text-xs text-text-4">{banner.scope}</span>
      )}
    </BannerShell>
  );
}

function BannerShell({
  tone,
  children,
}: {
  tone: VerifyTone;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col border-b border-line-soft px-4 py-2.5",
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
          expandable && "hover:bg-state-hover",
        )}
      >
        <code className="shrink-0 font-mono text-xs text-text-4">
          {entry.short}
        </code>
        <span className="min-w-0 flex-1 truncate text-base text-text-1" title={entry.summary}>
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
              <div className="section-label">
                Why
              </div>
              {entry.rows.map((row, i) => (
                <div key={`${row.ts}-${i}`} className="flex flex-col">
                  <p className="text-sm leading-relaxed text-text-2">{row.intent}</p>
                  <span className="text-xs text-text-4">{row.agent_id}</span>
                </div>
              ))}
            </div>
          )}

          {entry.proof && entry.proof.goals.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="section-label">
                What was checked
              </div>
              {entry.proof.goals.map((goal) => (
                <div key={goal.id} className="flex items-start gap-2">
                  <GoalDot verdict={goal.verdict} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-text-2">{goal.text}</p>
                    <span className="text-xs text-text-4">
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
      <span className="shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium text-text-4">
        Not checked
      </span>
    );
  }
  const proven = proof.verdict === "verified" || (proof.total > 0 && proof.ok === proof.total);
  if (proven) {
    return (
      <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-accent-green)_14%,transparent)] px-2 py-0.5 text-2xs font-medium text-accent-green">
        Proven · {proof.ok}/{proof.total}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-amber)_14%,transparent)] px-2 py-0.5 text-2xs font-medium text-amber">
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

