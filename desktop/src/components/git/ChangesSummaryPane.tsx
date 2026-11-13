// ChangesSummaryPane — the right side of the Changes tab before a file is
// picked: a calm "here's where your uncommitted work stands" read. It answers
// the non-engineer's three quiet questions — how much have I changed, where do
// I stand vs. the shared copy, and is any of this one-way? — and reassures that
// saving (committing) records the why and stays recoverable.
//
// Real numbers from git; no mockups — and, since a number Aura doesn't have yet
// is not a zero, no answer at all until git has actually answered. See
// `summaryLine`.

import { Fragment, useEffect, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";

import { type AheadBehind, type DiffStats } from "../../lib/api";
import { fetchAheadBehind, fetchDiffStats } from "../../lib/gitStateCache";
import { DiffCount } from "../ui/sidebar";
import { EmptyState, LoadingState } from "../ui/state";

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
  // An answer without a count can't be printed as one ("changed undefined
  // files"), so it reads the way a failed read does.
  if (failed || (stats && typeof stats.changed_files !== "number"))
    return {
      text: "Aura couldn't read this repository's changes just now. Nothing is wrong with your work. Reopen this tab to try again.",
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

  if (!stats && !statsFailed) {
    return <LoadingState label={line.text} size="md" />;
  }

  // The quiet lines under the sentence: the numbers, only once there are real
  // ones to print; where you stand against the shared copy; and that saving
  // keeps the why and can be undone.
  const notes: React.ReactNode[] = [];
  if (stats && changed > 0) {
    notes.push(
      <>
        <DiffCount added={stats.added} removed={stats.removed} /> across {changed} file
        {changed === 1 ? "" : "s"}
      </>,
    );
  }
  if (ab) notes.push(standing(ab));
  notes.push(
    "Saving keeps the reason with the change, and any saved change can be rewound one function at a time.",
  );

  return (
    <EmptyState
      icon={GitCommitHorizontal}
      title="Your uncommitted work"
      body={line.text}
      footnote={notes.map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {n}
        </Fragment>
      ))}
    />
  );
}

/** Where this branch stands against the shared copy, in one sentence. */
function standing(ab: AheadBehind): string {
  if (!ab.has_upstream)
    return "This branch only lives on your machine. Publish it from the top bar to share it.";
  if (ab.ahead === 0 && ab.behind === 0)
    return "You're in step with the shared copy. Nothing waiting either way.";
  return `${ab.ahead} change${ab.ahead === 1 ? "" : "s"} to send · ${ab.behind} to receive. Use Sync in the top bar.`;
}
