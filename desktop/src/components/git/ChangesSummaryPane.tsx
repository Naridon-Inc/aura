// ChangesSummaryPane — the right side of the Changes tab before a file is
// picked: a calm "here's where your uncommitted work stands" read. It answers
// the non-engineer's three quiet questions — how much have I changed, where do
// I stand vs. the shared copy, and is any of this one-way? — and reassures that
// saving (committing) records the why and stays recoverable.
//
// Real numbers from git; no mockups — and, since a number Aura doesn't have yet
// is not a zero, no answer at all until git has actually answered. See
// `summaryLine`.

import { useEffect, useState } from "react";
import { GitCommitHorizontal, RotateCcw, ShieldCheck } from "lucide-react";

import { type AheadBehind, type DiffStats } from "../../lib/api";
import { fetchAheadBehind, fetchDiffStats } from "../../lib/gitStateCache";
import { AsciiSpinner } from "../ui/ascii-spinner";

/** What this pane is allowed to say, given what it actually knows.
 *
 *  `stats` is null both before the git read returns and forever after one
 *  fails, so `stats?.changed_files ?? 0` made those two states indistinguishable
 *  from a genuine clean tree — and the sentence a clean tree gets is "your
 *  working copy matches the last saved version". That is the single most
 *  reassuring line on this surface, it was the first frame every time the
 *  Changes tab opened, and it was permanent whenever the read threw. Somebody
 *  with unsaved work was told they had none. */
export function summaryLine(
  stats: DiffStats | null,
  failed: boolean,
): { text: string; tone: "known" | "waiting" } {
  if (failed)
    return {
      text: "Aura couldn't read this project's changes just now. Nothing is wrong with your work. Reopen this tab to try again.",
      tone: "waiting",
    };
  if (!stats)
    return { text: "Counting up what you've changed…", tone: "waiting" };
  const n = stats.changed_files;
  if (n === 0)
    return {
      text: "Nothing is changed right now. Your working copy matches the last saved version.",
      tone: "known",
    };
  return {
    text: `You've changed ${n} file${n === 1 ? "" : "s"} since your last save. Pick one on the left to see exactly what changed and why.`,
    tone: "known",
  };
}

export function ChangesSummaryPane({ repoRoot }: { repoRoot: string }) {
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [ab, setAb] = useState<AheadBehind | null>(null);

  useEffect(() => {
    let alive = true;
    // Both reads go through gitStateCache. The header cluster and the commit
    // box ask git these same two questions about this same repo at the same
    // moment, and each call shells out twice — so asking directly here made a
    // tab open cost six git spawns for two answers. The cache's window is
    // shorter than any caller's poll, and it drops everything on
    // `aura:git-changed`; that listener is registered at import, before this
    // effect's, so the reload below still reads a real number after a commit.
    const reload = () => {
      void fetchDiffStats(repoRoot)
        .then((s) => {
          if (!alive) return;
          setStats(s);
          setStatsFailed(false);
        })
        // Swallowing this left `stats` null, which read as a clean tree. A
        // failed read is its own state and has to be one on screen too.
        .catch(() => alive && setStatsFailed(true));
      void fetchAheadBehind(repoRoot)
        .then((a) => alive && setAb(a))
        .catch(() => {});
    };
    reload();
    // Re-read after a commit / checkout lands elsewhere so the "where things
    // stand" numbers don't go stale under the user.
    window.addEventListener("aura:git-changed", reload);
    return () => {
      alive = false;
      window.removeEventListener("aura:git-changed", reload);
    };
  }, [repoRoot]);

  const line = summaryLine(stats, statsFailed);
  const changed = stats?.changed_files ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[560px] px-8 py-12">
        <div className="text-lg font-semibold text-text-1">
          Your uncommitted work
        </div>
        <p className="mt-1.5 flex items-start gap-2 text-base leading-relaxed text-text-3">
          {line.tone === "waiting" && !statsFailed && (
            <AsciiSpinner className="mt-1 shrink-0" />
          )}
          <span>{line.text}</span>
        </p>

        {/* The numbers, plain — only once there are real ones to print. */}
        {stats && changed > 0 && (
          <div className="mt-5 flex items-center gap-5 rounded-lg border border-line-soft bg-bg-1/40 px-4 py-3">
            <Stat label="files" value={String(changed)} />
            <Stat
              label="lines added"
              value={`+${stats?.added ?? 0}`}
              tone="var(--color-green)"
            />
            <Stat
              label="lines removed"
              value={`−${stats?.removed ?? 0}`}
              tone="var(--color-red)"
            />
          </div>
        )}

        {/* Where you stand vs. the shared copy. */}
        {ab && (
          <div className="mt-3 rounded-lg border border-line-soft bg-bg-1/40 px-4 py-3 text-sm text-text-3">
            {!ab.has_upstream
              ? "This branch only lives on your machine. Publish it from the top bar to share it."
              : ab.ahead === 0 && ab.behind === 0
                ? "You're in step with the shared copy. Nothing waiting either way."
                : `${ab.ahead} change${ab.ahead === 1 ? "" : "s"} to send · ${ab.behind} to receive. Use Sync in the top bar.`}
          </div>
        )}

        {/* The Aura reassurance — this is Git + Aura, not bare git. */}
        <div className="mt-7 space-y-3">
          <Reassure
            icon={<GitCommitHorizontal size={15} />}
            title="Saving records the why"
            body="When you save (commit), Aura keeps the reason alongside the change, so months later you, or a teammate, can read back what this was for."
          />
          <Reassure
            icon={<RotateCcw size={15} />}
            title="Nothing here is one-way"
            body="Every saved change can be rewound (surgically, one function at a time) without untangling the rest. You can always get back to a known-good state."
          />
          <Reassure
            icon={<ShieldCheck size={15} />}
            title="It stays yours"
            body="This all happens on your machine. Sharing is a deliberate step you take, never something that just happens."
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col">
      <span
        className="text-xl font-semibold tabular-nums"
        style={tone ? { color: tone } : { color: "var(--color-text-1)" }}
      >
        {value}
      </span>
      <span className="text-xs text-text-4">{label}</span>
    </div>
  );
}

function Reassure({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-base font-medium text-text-1">{title}</div>
        <p className="mt-0.5 text-sm leading-relaxed text-text-4">{body}</p>
      </div>
    </div>
  );
}
