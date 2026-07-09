// CreateFromPicker — the "Create from… ▾" popover for the new-workspace
// composer. Conductor-style: a single search box that filters BOTH the open
// pull requests ("Check out a PR") and the branches you can start new work
// from ("Start new work from…"), with a DEFAULT badge on the repo's default
// branch. Picking a row resolves to a concrete START POINT for the new
// worktree — a PR's head_ref, or a branch name.
//
// Real data only: branches from `api.gitBranchesRich(repoRoot)`, PRs from the
// cached `prList` wrapper (`lib/prsCache`) so opening the popover never blocks
// on a cold `gh pr list`. Row styling mirrors BranchSwitcherModal.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, GitPullRequest, Search } from "lucide-react";

import { api, type GitBranchRich, type PrSummary } from "../../lib/api";
import { fetchPrList, getPrListCached } from "../../lib/prsCache";

/** What the picker resolves to — the worktree's start point plus a
 *  human label for the chip and the kind so the chip can show the right
 *  glyph. `ref` is the git start point (branch name or PR head_ref). */
export type CreateFromSelection = {
  kind: "branch" | "pr";
  /** Git start point for the new worktree — branch name or PR head_ref. */
  ref: string;
  /** Chip label, e.g. "main" or "#36 feat: …". */
  label: string;
};

type Props = {
  repoRoot: string;
  /** Currently-resolved selection (drives the checkmark), or null for the
   *  implicit default (current/default branch). */
  value: CreateFromSelection | null;
  onPick: (sel: CreateFromSelection) => void;
  onClose: () => void;
};

/** Is this the branch a new worktree would start from by default — the
 *  current branch, falling back to a conventional default name? */
function isDefaultBranch(b: GitBranchRich, branches: GitBranchRich[]): boolean {
  if (b.isRemote) return false;
  const hasCurrent = branches.some((x) => x.isCurrent && !x.isRemote);
  if (hasCurrent) return b.isCurrent;
  // No current branch flagged (detached/odd state) — fall back to the
  // conventional default-branch names.
  return b.name === "main" || b.name === "master";
}

export function CreateFromPicker({ repoRoot, value, onPick, onClose }: Props) {
  const [branches, setBranches] = useState<GitBranchRich[]>([]);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load branches once on open. Best-effort — an unreadable repo just shows
  // no branches rather than blanking the whole composer.
  useEffect(() => {
    let alive = true;
    setLoadingBranches(true);
    api
      .gitBranchesRich(repoRoot)
      .then((rows) => {
        if (alive) setBranches(rows);
      })
      .catch(() => {
        if (alive) setBranches([]);
      })
      .finally(() => {
        if (alive) setLoadingBranches(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // PRs through the cache: instant from `getPrListCached`, then SWR-refresh.
  // No `gh` hammering — the cache owns backoff.
  useEffect(() => {
    let alive = true;
    fetchPrList(repoRoot)
      .then((list) => {
        if (alive) setPrs(list);
      })
      .catch(() => {
        /* offline / no gh — leave whatever the cache handed us */
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Focus the filter the moment the popover mounts.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Click-away + Esc close the popover (the parent composer owns its own
  // outer Esc; here we just dismiss this layer).
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (rootRef.current && t && !rootRef.current.contains(t)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const q = query.trim().toLowerCase();

  // Only open PRs are checkout targets. Filter by number/title/branch.
  const filteredPrs = useMemo(() => {
    const open = prs.filter((p) => p.state.toLowerCase() === "open");
    if (!q) return open;
    return open.filter(
      (p) =>
        String(p.number).includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.head_ref.toLowerCase().includes(q),
    );
  }, [prs, q]);

  // Local branches only for "start new work from" — current first, then the
  // backend's committerdate order (already sorted).
  const filteredBranches = useMemo(() => {
    const locals = branches.filter((b) => !b.isRemote);
    const rows = q ? locals.filter((b) => b.name.toLowerCase().includes(q)) : locals;
    return [...rows].sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return 0;
    });
  }, [branches, q]);

  function pickPr(pr: PrSummary) {
    onPick({ kind: "pr", ref: pr.head_ref, label: `#${pr.number} ${pr.title}` });
    onClose();
  }

  function pickBranch(b: GitBranchRich) {
    onPick({ kind: "branch", ref: b.name, label: b.name });
    onClose();
  }

  const isSelected = (kind: "branch" | "pr", ref: string) =>
    value != null && value.kind === kind && value.ref === ref;

  return (
    <div
      ref={rootRef}
      className="absolute left-0 top-8 z-40 w-[340px] overflow-hidden rounded-lg shadow-xl"
      style={{ background: "var(--color-bg-1)", border: "1px solid var(--color-line)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Search */}
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <Search size={13} className="shrink-0 text-text-4" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search branches and pull requests…"
          className="flex-1 bg-transparent text-[12.5px] text-text-1 placeholder:text-text-4 focus:outline-none"
        />
      </div>

      <div className="max-h-[46vh] overflow-y-auto py-1">
        {/* Check out a PR */}
        {filteredPrs.length > 0 && (
          <>
            <SectionLabel>Check out a PR</SectionLabel>
            {filteredPrs.map((pr) => (
              <button
                key={`pr-${pr.number}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickPr(pr);
                }}
                className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-bg-2"
              >
                <GitPullRequest size={13} className="mt-0.5 shrink-0 text-text-4" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[11px] text-text-3 tabular-nums">
                      #{pr.number}
                    </span>
                    <span className="truncate text-[12.5px] text-text-1">{pr.title}</span>
                    {pr.is_draft && (
                      <span className="shrink-0 rounded border border-line-soft bg-bg-2 px-1 py-px text-[8.5px] uppercase tracking-wider text-text-4">
                        draft
                      </span>
                    )}
                  </span>
                  <span className="truncate font-mono text-[10px] text-text-4">
                    {pr.head_ref}
                  </span>
                </span>
                {isSelected("pr", pr.head_ref) && (
                  <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                )}
              </button>
            ))}
          </>
        )}

        {/* Start new work from… */}
        <SectionLabel>Start new work from…</SectionLabel>
        {loadingBranches && filteredBranches.length === 0 ? (
          <div className="px-3 py-2 text-[11.5px] text-text-4">Loading branches…</div>
        ) : filteredBranches.length === 0 ? (
          <div className="px-3 py-2 text-[11.5px] text-text-4">No branches match.</div>
        ) : (
          filteredBranches.map((b) => (
            <button
              key={`br-${b.name}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pickBranch(b);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-bg-2"
            >
              <GitBranch size={13} className="shrink-0 text-text-4" />
              <span className="truncate font-mono text-[12.5px] text-text-1">{b.name}</span>
              {isDefaultBranch(b, branches) && (
                <span className="shrink-0 rounded border border-line-soft bg-bg-2 px-1 py-px text-[8.5px] uppercase tracking-wider text-text-3">
                  default
                </span>
              )}
              {isSelected("branch", b.name) && (
                <Check size={13} className="ml-auto shrink-0 text-accent" />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-wider text-text-4">
      {children}
    </div>
  );
}
