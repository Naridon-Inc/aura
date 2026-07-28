// PR Checks tab — Conductor-parity surface. Flattens GitHub's
// statusCheckRollup (already fetched summarized on the PR card) into one
// row per check so the reviewer can see *which* run failed, jump to its
// logs, and — the Aura twist — hand the whole failing set to the ambient
// brain to fix, without leaving the app or touching a CLI.
//
// Data seam: `api.prChecks(repoRoot, number)` → PrCheck[] where each row
// carries a plain `bucket` ("success" | "failure" | "pending") we group +
// color by, `raw` (GitHub's own word) for the tooltip, and `url` to the
// run's logs. No new gh call shape — same rollup `pr_list` reads.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  SquareArrowOutUpRight,
  Wand2,
  RefreshCw,
  Triangle,
} from "lucide-react";
import { api, type PrCheck, type VercelDeployment } from "../../lib/api";
import { openExternal } from "../../lib/openExternal";
import { sendToAmbientManager } from "../../lib/focusManager";
import { Button } from "../ui/button";
import { GhErrorNotice } from "../github/GhErrorNotice";

type Props = {
  repoRoot: string;
  prNumber: number;
};

type Bucket = "failure" | "pending" | "success";

const BUCKET_ORDER: Bucket[] = ["failure", "pending", "success"];

const BUCKET_META: Record<
  Bucket,
  { label: string; Icon: typeof CheckCircle2; tone: string; ring: string }
> = {
  failure: {
    label: "Failing",
    Icon: XCircle,
    tone: "text-red",
    ring: "border-red/25 bg-red/[0.05]",
  },
  pending: {
    label: "In progress",
    Icon: Loader2,
    tone: "text-amber",
    ring: "border-amber/25 bg-amber/[0.05]",
  },
  // A passing check doesn't need you — the tick carries the good news and the
  // card stays quiet, so the failing ones are the only tinted rows on screen.
  success: {
    label: "Passing",
    Icon: CheckCircle2,
    tone: "text-accent-green",
    ring: "border-line-soft bg-bg-1/40",
  },
};

function bucketOf(c: PrCheck): Bucket {
  if (c.bucket === "failure") return "failure";
  if (c.bucket === "success") return "success";
  return "pending";
}

export function PrChecksTab({ repoRoot, prNumber }: Props) {
  const [rows, setRows] = useState<PrCheck[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Guards the "Ask an agent" button so a double-tap can't fan out two
  // manager sessions; cleared once the message lands (or fails).
  const [dispatching, setDispatching] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  // Vercel deploy for this PR's head commit — null when Vercel isn't
  // configured or has no deploy for the commit yet. Loaded independently
  // of the GH checks so a missing/slow Vercel never blocks the list.
  const [deploy, setDeploy] = useState<VercelDeployment | null>(null);

  const load = useCallback(
    async (bg: boolean) => {
      if (bg) setRefreshing(true);
      else setLoading(true);
      try {
        const list = await api.prChecks(repoRoot, prNumber);
        setRows(list);
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [repoRoot, prNumber],
  );

  const loadDeploy = useCallback(async () => {
    try {
      setDeploy(await api.prVercelStatus(repoRoot, prNumber));
    } catch {
      // Soft: an unconfigured or unreachable Vercel simply shows no chip.
      setDeploy(null);
    }
  }, [repoRoot, prNumber]);

  useEffect(() => {
    setDispatched(false);
    void load(false);
    void loadDeploy();
  }, [load, loadDeploy]);

  const grouped = useMemo(() => {
    const g: Record<Bucket, PrCheck[]> = { failure: [], pending: [], success: [] };
    for (const c of rows ?? []) g[bucketOf(c)].push(c);
    return g;
  }, [rows]);

  const failing = grouped.failure;

  const askAgentToFix = useCallback(async () => {
    if (failing.length === 0 || dispatching) return;
    setDispatching(true);
    try {
      const names = failing
        .map((c) => `• ${c.name}${c.workflow ? ` (${c.workflow})` : ""}`)
        .join("\n");
      const prompt =
        `PR #${prNumber} has ${failing.length} failing check${
          failing.length === 1 ? "" : "s"
        }:\n${names}\n\n` +
        `Please investigate why each is failing (pull the run logs if you need them), ` +
        `fix the underlying cause in this branch, and push so the checks go green. ` +
        `Explain what was wrong before you change anything.`;
      await sendToAmbientManager(repoRoot, prompt);
      setDispatched(true);
    } catch {
      // sendToAmbientManager already focuses/surfaces failure paths; swallow
      // here so a transient error doesn't wedge the button disabled.
    } finally {
      setDispatching(false);
    }
  }, [failing, dispatching, prNumber, repoRoot]);

  if (loading && !rows) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-4 text-[12px] gap-2">
        <AsciiSpinner />
        Loading checks…
      </div>
    );
  }

  if (error) {
    return (
      <GhErrorNotice error={error} align="center" onRetry={() => void load(false)} />
    );
  }

  const total = rows?.length ?? 0;
  if (total === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
        {deploy && (
          <div className="w-full max-w-[360px] text-left">
            <VercelDeployCard deploy={deploy} />
          </div>
        )}
        <CheckCircle2 className="text-text-4" size={22} aria-hidden />
        <div className="text-text-2 text-[13px]">No checks on this PR.</div>
        <div className="text-text-4 text-[11.5px] max-w-[320px]">
          Nothing is configured to run against this branch on GitHub yet — no CI,
          no required status checks.
        </div>
      </div>
    );
  }

  const passCount = grouped.success.length;
  const failCount = grouped.failure.length;
  const pendCount = grouped.pending.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Summary header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-line-soft">
        <div className="flex items-center gap-3 text-[12px]">
          <Summary Icon={CheckCircle2} tone="text-accent-green" n={passCount} word="passing" />
          <Summary Icon={XCircle} tone="text-red" n={failCount} word="failing" />
          <Summary Icon={Loader2} tone="text-amber" n={pendCount} word="in progress" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {failCount > 0 && (
            <Button
              variant="default"
              size="xs"
              onClick={askAgentToFix}
              disabled={dispatching || dispatched}
              title="Hand the failing checks to the Aura brain to fix in this branch"
            >
              {dispatching ? (
                <AsciiSpinner className="text-[11px]" />
              ) : (
                <Wand2 strokeWidth={1.75} size={13} aria-hidden />
              )}
              {dispatched ? "Sent to agent" : "Ask an agent to fix"}
            </Button>
          )}
          <Button
            variant="subtle"
            size="xs"
            onClick={() => {
              void load(true);
              void loadDeploy();
            }}
            disabled={refreshing}
            title="Refresh checks from GitHub"
          >
            <RefreshCw
              strokeWidth={1.75}
              size={13}
              aria-hidden
              className={refreshing ? "animate-spin" : ""}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Grouped rows */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {deploy && <VercelDeployCard deploy={deploy} />}
        {BUCKET_ORDER.map((b) => {
          const items = grouped[b];
          if (items.length === 0) return null;
          const meta = BUCKET_META[b];
          return (
            <section key={b}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <meta.Icon size={13} className={meta.tone} aria-hidden />
                <span className="text-[11px] uppercase tracking-wider text-text-3">
                  {meta.label}
                </span>
                <span className="text-[11px] text-text-4">· {items.length}</span>
              </div>
              <div className="space-y-1.5">
                {items.map((c, i) => (
                  <CheckRow key={`${c.name}-${i}`} check={c} bucket={b} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Summary({
  Icon,
  tone,
  n,
  word,
}: {
  Icon: typeof CheckCircle2;
  tone: string;
  n: number;
  word: string;
}) {
  return (
    <span className={`flex items-center gap-1 ${n === 0 ? "text-text-4" : "text-text-2"}`}>
      <Icon size={13} className={n === 0 ? "text-text-5" : tone} aria-hidden />
      <span className="tabular-nums">{n}</span>
      <span className="text-text-4">{word}</span>
    </span>
  );
}

function CheckRow({ check, bucket }: { check: PrCheck; bucket: Bucket }) {
  const meta = BUCKET_META[bucket];
  const hasUrl = check.url.length > 0;
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md border px-3 py-2 ${meta.ring}`}
    >
      <meta.Icon size={15} className={`${meta.tone} shrink-0`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] text-text-1 truncate">{check.name}</span>
          {check.workflow && check.workflow !== check.name && (
            <span className="text-[10.5px] text-text-4 truncate">{check.workflow}</span>
          )}
        </div>
        {check.description && (
          <div className="text-[11px] text-text-4 truncate mt-0.5">{check.description}</div>
        )}
      </div>
      <span
        className="text-[10.5px] uppercase tracking-wide text-text-4 tabular-nums shrink-0"
        title={`GitHub status: ${check.raw}`}
      >
        {check.raw}
      </span>
      {hasUrl && (
        <button
          type="button"
          onClick={() => void openExternal(check.url)}
          className="text-text-4 hover:text-text-1 transition-colors shrink-0"
          title="View logs on GitHub"
          aria-label="View logs on GitHub"
        >
          <SquareArrowOutUpRight size={13} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  );
}

// Plain-language mapping of Vercel's readyState. The card leads with what a
// non-engineer needs — "is it live, still going, or broken" — not the raw
// enum. `spin` marks the in-flight states so the icon animates.
const VERCEL_STATE: Record<
  string,
  { label: string; tone: string; ring: string; spin?: boolean }
> = {
  READY: {
    label: "Deployed",
    tone: "text-accent-green",
    ring: "border-line-soft bg-bg-1/40",
  },
  BUILDING: {
    label: "Building",
    tone: "text-amber",
    ring: "border-amber/25 bg-amber/[0.05]",
    spin: true,
  },
  INITIALIZING: {
    label: "Starting",
    tone: "text-amber",
    ring: "border-amber/25 bg-amber/[0.05]",
    spin: true,
  },
  QUEUED: {
    label: "Queued",
    tone: "text-amber",
    ring: "border-amber/25 bg-amber/[0.05]",
    spin: true,
  },
  ERROR: {
    label: "Deploy failed",
    tone: "text-red",
    ring: "border-red/25 bg-red/[0.05]",
  },
  CANCELED: {
    label: "Canceled",
    tone: "text-text-4",
    ring: "border-line-soft bg-bg-1/40",
  },
};

const VERCEL_FALLBACK = {
  label: "Deploy",
  tone: "text-text-3",
  ring: "border-line-soft bg-bg-1/40",
};

function VercelDeployCard({ deploy }: { deploy: VercelDeployment }) {
  const meta = VERCEL_STATE[deploy.state] ?? VERCEL_FALLBACK;
  const isProd = deploy.target === "production";
  const envLabel = isProd ? "Production" : "Preview";
  const previewUrl = deploy.url ? `https://${deploy.url}` : null;

  return (
    <div className={`flex items-center gap-2.5 rounded-md border px-3 py-2 ${meta.ring}`}>
      <Triangle
        size={14}
        strokeWidth={2}
        className={`${meta.tone} shrink-0 ${meta.spin ? "animate-pulse" : ""}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] text-text-1">Vercel</span>
          <span className={`text-[11px] ${meta.tone}`}>{meta.label}</span>
          <span className="text-[10px] uppercase tracking-wide text-text-4 border border-line-soft rounded px-1 py-px">
            {envLabel}
          </span>
        </div>
        {previewUrl && (
          <div className="text-[11px] text-text-4 truncate mt-0.5">{deploy.url}</div>
        )}
      </div>
      {previewUrl && (
        <button
          type="button"
          onClick={() => void openExternal(previewUrl)}
          className="text-[11px] text-accent hover:underline shrink-0"
          title="Open the deployed preview"
        >
          Open
        </button>
      )}
      {deploy.inspector_url && (
        <button
          type="button"
          onClick={() => void openExternal(deploy.inspector_url!)}
          className="text-text-4 hover:text-text-1 transition-colors shrink-0"
          title="View the build on Vercel"
          aria-label="View the build on Vercel"
        >
          <SquareArrowOutUpRight size={13} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  );
}
