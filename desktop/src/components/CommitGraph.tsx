// CommitGraph — the native Source Control commit-graph rail (VS Code
// "Source Control → Graph" parity). A vertical, lane-threaded view of the
// project's branch topology: every branch and merge drawn as coloured
// lanes, one node per commit, with branch/tag/HEAD badges.
//
// It is deliberately a *dumb* renderer: all the topology math lives in the
// pure `computeGraphLayout` (../lib/commitGraphLayout). This file only:
//   1. fetches `git_commit_graph`,
//   2. asks the layout fn where lanes + nodes go,
//   3. draws each row's SVG cell + commit info,
//   4. on click, dispatches the existing `aura:open-commit-diff` event so
//      the commit opens in the same diff surface the History list uses.
//
// Audience note: a non-engineer reading this sees "the story of the
// project" — who branched off, what merged back, where we are now ("You
// are here"). No git jargon in the chrome.

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { api, type GraphCommit } from "../lib/api";
import {
  computeGraphLayout,
  type GraphRowLayout,
} from "../lib/commitGraphLayout";
import { Avatar } from "./team/presentation/Avatar";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { Segment } from "./ui/segment";
import { relativeAgeFromDelta } from "../lib/relativeTime";
import { shortDateFromSecs } from "../lib/calendarDate";

const ROW_H = 32;
const LANE_W = 14;
const GUTTER = 12;
const NODE_R = 4;

// Sentinel sha for the synthetic "your unsaved changes" node we prepend at
// the tip when the working tree is dirty — mirrors VS Code's graph showing
// uncommitted changes as the topmost node, connected down to HEAD. Audience
// note: this is the "you are right now, with edits you haven't saved" dot.
const WORKING_SHA = "__working__";

type Props = {
  repoRoot: string;
  /** How many commits to walk across all branches. */
  limit?: number;
  /** Bump to refetch. The graph has no header of its own — it is always
   *  mounted inside a host that already owns one (HistorySidebar), so the
   *  host owns the Refresh button too and reaches the fetch through here. */
  reloadToken?: number;
};

export function CommitGraph({ repoRoot, limit = 300, reloadToken = 0 }: Props) {
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "all" = every branch (VS Code's default). "branch" = only the line you're
  // on right now (the ancestors of HEAD) — for non-engineers on a busy team
  // repo who just want "show me my own story, not everyone's branches".
  const [scope, setScope] = useState<"all" | "branch">("all");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.gitCommitGraph(repoRoot, limit),
      // Working-tree status is best-effort: a clean tree or a failed read
      // simply hides the "unsaved changes" node — it never breaks the graph.
      api.gitStatus(repoRoot).catch(() => ({}) as Record<string, string>),
    ])
      .then(([c, status]) => {
        if (!alive) return;
        setCommits(c);
        setDirtyCount(Object.keys(status).length);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, limit, reloadToken]);

  // Prepend the synthetic "unsaved changes" node at the tip (parent = the
  // current HEAD commit) so the lane algorithm threads it straight down into
  // HEAD with zero special-casing in the layout math.
  const displayCommits = useMemo<GraphCommit[]>(() => {
    if (dirtyCount > 0 && commits.length > 0) {
      const head = commits.find((c) => c.refs.some((r) => r.kind === "head"));
      if (head) {
        const working: GraphCommit = {
          sha: WORKING_SHA,
          short: "",
          parents: [head.sha],
          author: "",
          author_email: "",
          timestamp: 0,
          subject: `${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"}`,
          refs: [],
        };
        return [working, ...commits];
      }
    }
    return commits;
  }, [commits, dirtyCount]);

  // "This branch" = the transitive ancestry of HEAD (what `git log HEAD`
  // would show), keeping the unsaved-changes node at the tip. Pure graph
  // walk over the already-fetched parent links — no extra round-trip.
  const scopedCommits = useMemo<GraphCommit[]>(() => {
    if (scope === "all") return displayCommits;
    const start =
      displayCommits.find((c) => c.sha === WORKING_SHA) ??
      displayCommits.find((c) => c.refs.some((r) => r.kind === "head")) ??
      displayCommits[0];
    if (!start) return displayCommits;
    const bySha = new Map(displayCommits.map((c) => [c.sha, c]));
    const keep = new Set<string>();
    const stack = [start.sha];
    while (stack.length) {
      const sha = stack.pop()!;
      if (keep.has(sha)) continue;
      keep.add(sha);
      const c = bySha.get(sha);
      if (c) for (const p of c.parents) if (!keep.has(p)) stack.push(p);
    }
    return displayCommits.filter((c) => keep.has(c.sha));
  }, [displayCommits, scope]);

  const layout = useMemo(() => computeGraphLayout(scopedCommits), [scopedCommits]);
  const railWidth = GUTTER * 2 + Math.max(1, layout.laneCount) * LANE_W;

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  return (
    <div className="h-full flex flex-col">
      {!loading && !error && commits.length > 0 && (
        <div className="flex items-center gap-2 h-7 px-3 border-b border-line-soft/60 flex-shrink-0">
          <Segment
            value={scope}
            onChange={setScope}
            size="xs"
            ariaLabel="Which branches to show"
            options={[
              { value: "all", label: "All branches", title: "Show every branch" },
              { value: "branch", label: "This branch", title: "Show only the line you’re on now" },
            ]}
          />
          <span className="text-text-4 text-2xs tabular-nums ml-auto">
            {layout.rows.length} shown
          </span>
        </div>
      )}

      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
        {loading && commits.length === 0 ? (
          <div className="flex items-center gap-1.5 px-4 py-3 text-text-4 text-xs">
            <AsciiSpinner className="text-2xs" />
            <span>Reading the project’s story…</span>
          </div>
        ) : error ? (
          <div className="px-4 py-3 text-text-4 text-xs">
            Couldn’t read history here.
          </div>
        ) : layout.rows.length === 0 ? (
          <div className="px-4 py-6 text-text-4 text-sm leading-relaxed">
            No commits yet. Once you save your first version, the project’s
            story shows up here.
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = layout.rows[vi.index];
              return (
                <div
                  key={row.commit.sha}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_H,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <GraphRow row={row} railWidth={railWidth} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function laneX(col: number): number {
  return GUTTER + col * LANE_W;
}

/** One commit row: the SVG lane cell on the left, commit info on the right.
 *  The synthetic "unsaved changes" tip node renders as a hollow, dashed
 *  arctic-blue dot with plain-language copy and opens the changes view. */
function GraphRow({
  row,
  railWidth,
}: {
  row: GraphRowLayout;
  railWidth: number;
}) {
  const { commit, col, color, segments } = row;
  const isWorking = commit.sha === WORKING_SHA;
  const mid = ROW_H / 2;
  const cx = laneX(col);

  const open = () => {
    if (isWorking) {
      // The uncommitted tip → the working-tree changes / safety review.
      window.dispatchEvent(new CustomEvent("aura:open-edit-view"));
      return;
    }
    window.dispatchEvent(
      new CustomEvent("aura:open-commit-diff", {
        detail: { sha: commit.short, subject: commit.subject },
      }),
    );
  };

  return (
    <button
      type="button"
      onClick={open}
      className="group w-full h-full flex items-stretch text-left hover:bg-state-hover focus:outline-none focus:bg-state-hover"
      title={
        isWorking
          ? "Your unsaved changes. Edits not saved to history yet"
          : `${commit.subject}\n${commit.short} · ${commit.author}`
      }
    >
      <svg
        width={railWidth}
        height={ROW_H}
        className="flex-shrink-0"
        style={{ overflow: "visible" }}
        aria-hidden
      >
        {segments.map((s, i) => {
          const x0 = laneX(s.fromCol);
          const x1 = laneX(s.toCol);
          const [y0, y1] = s.half === "top" ? [0, mid] : [mid, ROW_H];
          const d =
            x0 === x1
              ? `M ${x0} ${y0} L ${x1} ${y1}`
              : `M ${x0} ${y0} C ${x0} ${(y0 + y1) / 2}, ${x1} ${(y0 + y1) / 2}, ${x1} ${y1}`;
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={isWorking && s.half === "bottom" ? "var(--color-amber)" : s.color}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeDasharray={isWorking && s.half === "bottom" ? "2 2.5" : undefined}
              opacity={0.9}
            />
          );
        })}
        {isWorking ? (
          <circle
            cx={cx}
            cy={mid}
            r={NODE_R + 0.5}
            fill="var(--color-bg-0)"
            /* The working row is uncommitted edits — the dirty/modified
               state, which is exactly what `--color-amber` names, and what
               the changed-file glyphs and the unsaved tab dot already use.
               The accent stays on the HEAD pill below ("you are here"), so
               "where I am" and "what I have not saved" stay distinguishable
               inside one graph. */
            stroke="var(--color-amber)"
            strokeWidth={1.5}
            strokeDasharray="2 1.8"
          />
        ) : (
          <circle
            cx={cx}
            cy={mid}
            r={NODE_R}
            fill={color}
            stroke="var(--color-bg-0)"
            strokeWidth={1.5}
          />
        )}
      </svg>

      <div className="flex-1 min-w-0 flex items-center gap-2 pr-3">
        <div className="min-w-0 flex-1">
          {isWorking ? (
            <>
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="text-sm truncate font-medium"
                  style={{ color: "var(--color-amber)" }}
                >
                  Your unsaved changes
                </span>
              </div>
              <div className="text-text-4 text-xs truncate">
                {commit.subject} · not saved to history yet
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 min-w-0">
                {commit.refs.map((r, i) => (
                  <RefBadge key={i} name={r.name} kind={r.kind} laneColor={color} />
                ))}
                <span className="text-text-1 text-sm truncate">
                  {commit.subject || "(no message)"}
                </span>
              </div>
              <div className="text-text-4 text-xs truncate flex items-center gap-1.5">
                <span className="font-mono text-text-3">{commit.short}</span>
                <span>·</span>
                <span className="truncate">{commit.author}</span>
                <span>·</span>
                <span className="tabular-nums">{relTime(commit.timestamp)}</span>
              </div>
            </>
          )}
        </div>
        {!isWorking && commit.author && (
          <Avatar name={commit.author} size={20} title={commit.author} />
        )}
      </div>
    </button>
  );
}

/** A branch tip / tag / HEAD pill. HEAD ("You are here") is the one orientation
 *  cue that earns the accent; tags are a category, so they sit on the neutral
 *  ramp; local/remote stay outlined in their lane colour because that mapping
 *  IS the graph. Kept identical to the History list's badge (CommitList) so the
 *  two views of history read the same. */
function RefBadge({
  name,
  kind,
  laneColor: lc,
}: {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
  laneColor: string;
}) {
  if (kind === "head") {
    return (
      <span
        className="flex-shrink-0 inline-flex items-center gap-1 text-2xs font-medium px-1.5 h-[15px] rounded-full"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-accent-foreground)",
        }}
        title="You are here. The version you’re working from"
      >
        <span
          className="inline-block w-1 h-1 rounded-full"
          style={{ background: "currentColor" }}
        />
        {name}
      </span>
    );
  }
  if (kind === "tag") {
    return (
      <span
        className="flex-shrink-0 inline-flex items-center rounded-full border border-line-soft px-1.5 h-[15px] text-2xs text-text-3"
        title="A named release point"
      >
        ⌖ {name}
      </span>
    );
  }
  // local / remote branch tip — outlined in its lane colour, remote dimmer.
  return (
    <span
      className="flex-shrink-0 inline-flex items-center text-2xs px-1.5 h-[15px] rounded-full border"
      style={{
        borderColor: lc,
        color: lc,
        opacity: kind === "remote" ? 0.7 : 1,
      }}
      title={kind === "remote" ? "A copy that lives on the server" : "A branch"}
    >
      {name}
    </span>
  );
}

/** "2m ago" / "3h ago" / "5d ago" / "2w ago", else a date. */
function relTime(secs: number): string {
  if (!secs) return "";
  // Past a month a commit is history, not news — the date is the useful fact.
  // One ladder for the whole app — see lib/relativeTime.
  const d = Math.floor(Date.now() / 1000) - secs;
  if (d >= 2592000) return shortDateFromSecs(secs);
  return relativeAgeFromDelta(d);
}
