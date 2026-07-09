// ChangesSummaryPane — the right side of the Changes tab before a file is
// picked: a calm "here's where your uncommitted work stands" read. It answers
// the non-engineer's three quiet questions — how much have I changed, where do
// I stand vs. the shared copy, and is any of this one-way? — and reassures that
// saving (committing) records the why and stays recoverable. Real numbers from
// git; no mockups.

import { useEffect, useState } from "react";
import { GitCommitHorizontal, RotateCcw, ShieldCheck } from "lucide-react";

import { api, type AheadBehind, type DiffStats } from "../../lib/api";

export function ChangesSummaryPane({ repoRoot }: { repoRoot: string }) {
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [ab, setAb] = useState<AheadBehind | null>(null);

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void api
        .gitDiffStats(repoRoot)
        .then((s) => alive && setStats(s))
        .catch(() => {});
      void api
        .gitAheadBehind(repoRoot)
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

  const changed = stats?.changed_files ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[560px] px-8 py-12">
        <div className="text-[17px] font-semibold text-text-1">
          Your uncommitted work
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-3">
          {changed === 0
            ? "Nothing is changed right now — your working copy matches the last saved version."
            : `You've changed ${changed} file${changed === 1 ? "" : "s"} since your last save. Pick one on the left to see exactly what changed and why.`}
        </p>

        {/* The numbers, plain. */}
        {changed > 0 && (
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
          <div className="mt-3 rounded-lg border border-line-soft bg-bg-1/40 px-4 py-3 text-[12px] text-text-3">
            {!ab.has_upstream
              ? "This branch only lives on your machine. Publish it from the top bar to share it."
              : ab.ahead === 0 && ab.behind === 0
                ? "You're in step with the shared copy — nothing waiting either way."
                : `${ab.ahead} change${ab.ahead === 1 ? "" : "s"} to send · ${ab.behind} to receive. Use Sync in the top bar.`}
          </div>
        )}

        {/* The Aura reassurance — this is Git + Aura, not bare git. */}
        <div className="mt-7 space-y-3">
          <Reassure
            icon={<GitCommitHorizontal size={15} />}
            title="Saving records the why"
            body="When you save (commit), Aura keeps the reason alongside the change — so months later you, or a teammate, can read back what this was for."
          />
          <Reassure
            icon={<RotateCcw size={15} />}
            title="Nothing here is one-way"
            body="Every saved change can be rewound — surgically, one function at a time — without untangling the rest. You can always get back to a known-good state."
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
        className="text-[18px] font-semibold tabular-nums"
        style={tone ? { color: tone } : { color: "var(--color-text-1)" }}
      >
        {value}
      </span>
      <span className="text-[10.5px] text-text-4">{label}</span>
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
        <div className="text-[12.5px] font-medium text-text-1">{title}</div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-4">{body}</p>
      </div>
    </div>
  );
}
