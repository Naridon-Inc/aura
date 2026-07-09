// InboxPane — Stage 8A. Graphite-style PR triage list.
//
// Borrowed from `aura/dashboard/src/pages/ReviewList.tsx` (FilterItem
// + Section + Row pattern) and adapted from PRs to PR-triage buckets
// keyed by viewer relationship. The viewer login comes from
// `pr_whoami` (cached at mount); each PR carries `is_authored_by_me`
// and `is_review_requested_for_me` populated server-side in
// `cmd_prs::pr_list`.
//
// Layout: 240px filter rail (left) + scrollable bucket list (right).
// Sections are ordered by urgency:
//   Needs your review     — viewer was requested as a reviewer
//   Returned to you       — your PR, reviewer wants changes
//   Approved              — your PR, approved, ready to merge
//   Waiting for reviewers — your PR, no decision yet
//   Drafts                — your draft PRs
//   Merging / merged      — your PR, recently merged
//   Waiting for author    — you reviewed someone else's PR (returned)
//
// Click a row → opens the singleton PRDetailPane via
// `editor.openPrDetail`. The Inbox stays mounted (singleton), so the
// user pops back without re-fetch.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { api, type PrSummary } from "../../lib/api";
import {
  fetchPrList,
  getPrListCached,
  invalidatePrList,
  subscribePrList,
} from "../../lib/prsCache";
import { useEditorStore } from "../../lib/editorStore";
import { Button } from "../ui/button";

// Shared filter state — the InboxPane's bucket list and the
// InboxSidebar (mounted in the app's left sidebar slot when PR surface
// is active) both read/write this. Module-level instead of context so
// either component can mount independently without a provider.
let _activeFilter: Bucket | null = null;
const _filterSubs = new Set<() => void>();
function setActiveFilterShared(next: Bucket | null) {
  _activeFilter = next;
  for (const fn of _filterSubs) fn();
}
function useActiveFilter(): Bucket | null {
  return useSyncExternalStore(
    (cb) => {
      _filterSubs.add(cb);
      return () => _filterSubs.delete(cb);
    },
    () => _activeFilter,
    () => null,
  );
}

export type Bucket =
  | "needs_review"
  | "returned"
  | "approved"
  | "waiting_reviewers"
  | "drafts"
  | "merged"
  | "waiting_author";

export const BUCKET_LABEL: Record<Bucket, string> = {
  needs_review: "Needs your review",
  returned: "Returned to you",
  approved: "Approved",
  waiting_reviewers: "Waiting for reviewers",
  drafts: "Drafts",
  merged: "Merging and recently merged",
  waiting_author: "Waiting for author",
};

export const BUCKET_DOT: Record<Bucket, string> = {
  needs_review: "bg-accent-violet",
  returned: "bg-yellow-500",
  approved: "bg-green-500",
  waiting_reviewers: "bg-text-3",
  drafts: "bg-text-4",
  merged: "bg-blue-400",
  waiting_author: "bg-text-3",
};

export const BUCKET_ORDER: Bucket[] = [
  "needs_review",
  "returned",
  "approved",
  "waiting_reviewers",
  "drafts",
  "merged",
  "waiting_author",
];

type Props = {
  repoRoot: string;
  onClose?: () => void;
};

export function InboxPane({ repoRoot, onClose }: Props) {
  const editor = useEditorStore();
  // Stage 8I — paint cached PR list immediately if any. Triage is the
  // hottest navigation in the desktop; refetching from zero on every
  // NavRail click made the Inbox feel sluggish.
  const cached = getPrListCached(repoRoot);
  const [prs, setPrs] = useState<PrSummary[]>(cached ?? []);
  const [viewer, setViewer] = useState<string>("");
  const [loading, setLoading] = useState(cached == null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<Bucket>>(
    new Set<Bucket>(BUCKET_ORDER),
  );
  // Filter selection lives in the module-level store so the InboxSidebar
  // (rendered in the app's left sidebar slot) drives it.
  const activeFilter = useActiveFilter();

  const refresh = useCallback(
    async (force = false) => {
      const hasCache = getPrListCached(repoRoot) != null;
      if (!hasCache) setLoading(true);
      setError(null);
      try {
        const listP = force
          ? invalidatePrList(repoRoot)
          : fetchPrList(repoRoot);
        const [list, who] = await Promise.all([
          listP,
          api.prWhoami(repoRoot).catch(() => ""),
        ]);
        setPrs(list);
        setViewer(who);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Background refreshes from other panes (e.g. label edit, approve)
  // push the new list into our state without a manual refetch.
  useEffect(() => {
    return subscribePrList(repoRoot, (list) => {
      setPrs(list);
    });
  }, [repoRoot]);

  const buckets = useMemo(() => bucketize(prs), [prs]);

  const total = prs.length;

  const toggle = (b: Bucket) => {
    const next = new Set(expanded);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    setExpanded(next);
  };

  const onSelect = (p: PrSummary) => {
    editor.openPrDetail(repoRoot, p.number, p.title);
  };

  const visibleBuckets = activeFilter
    ? BUCKET_ORDER.filter((b) => b === activeFilter)
    : BUCKET_ORDER;

  // Filter rail moved out — see `InboxSidebar` below. It mounts in the
  // app's left sidebar slot when the PR surface is active, so the Inbox
  // never renders two side-by-side rails again. Viewer login + refresh
  // controls move with it.
  void viewer;
  void onClose;
  void refresh;
  return (
    <div className="h-full w-full bg-bg-content">
      {/* Scrollable bucket list */}
      <div className="h-full overflow-y-auto">
        <header className="flex items-center h-10 px-5 border-b border-line-soft sticky top-0 bg-bg-content z-10">
          <span className="text-text-1 text-[13px] font-semibold">
            {activeFilter ? BUCKET_LABEL[activeFilter] : "All pull requests"}
          </span>
          <span className="ml-2 text-text-4 text-[11px] tabular-nums">
            {activeFilter ? buckets[activeFilter].length : total}
          </span>
        </header>

        {loading ? (
          <Hint>loading PRs…</Hint>
        ) : error ? (
          <ErrorHint message={error} />
        ) : total === 0 ? (
          <Hint>
            no open PRs in this repo. (uses{" "}
            <span className="font-mono">gh pr list</span> — log in with{" "}
            <span className="font-mono">gh auth login</span> if this looks
            wrong.)
          </Hint>
        ) : (
          visibleBuckets.map((b) =>
            buckets[b].length > 0 ? (
              <Section
                key={b}
                title={BUCKET_LABEL[b]}
                dot={BUCKET_DOT[b]}
                count={buckets[b].length}
                expanded={expanded.has(b)}
                onToggle={() => toggle(b)}
                rows={buckets[b]}
                onSelect={onSelect}
                activePrNumber={
                  editor.selectedPr?.repoRoot === repoRoot
                    ? editor.selectedPr.number
                    : null
                }
              />
            ) : null,
          )
        )}
      </div>
    </div>
  );
}

export function bucketize(prs: PrSummary[]): Record<Bucket, PrSummary[]> {
  const out: Record<Bucket, PrSummary[]> = {
    needs_review: [],
    returned: [],
    approved: [],
    waiting_reviewers: [],
    drafts: [],
    merged: [],
    waiting_author: [],
  };
  for (const p of prs) {
    // Merged / merging — surface even if state changes; gh only returns
    // open PRs by default but the field exists in case the proxy ever
    // includes recently-merged.
    if (p.state.toLowerCase() === "merged") {
      out.merged.push(p);
      continue;
    }
    // Drafts authored by the viewer.
    if (p.is_draft && p.is_authored_by_me) {
      out.drafts.push(p);
      continue;
    }
    // Reviewer requested on you — top priority bucket.
    if (p.is_review_requested_for_me) {
      out.needs_review.push(p);
      continue;
    }
    // Your PR with active state.
    if (p.is_authored_by_me) {
      if (p.review_decision === "CHANGES_REQUESTED") {
        out.returned.push(p);
      } else if (p.review_decision === "APPROVED") {
        out.approved.push(p);
      } else {
        out.waiting_reviewers.push(p);
      }
      continue;
    }
    // You're neither author nor reviewer-requested — likely a PR you
    // already reviewed. Bucket as Waiting-for-author to keep it visible
    // without burying the high-priority lists.
    out.waiting_author.push(p);
  }
  // Drafts not authored by viewer fall through to waiting_author too;
  // suppress them to avoid noise.
  out.waiting_author = out.waiting_author.filter((p) => !p.is_draft);
  return out;
}

// ── Inbox sidebar — the filter rail mounted in the app's left sidebar
//    slot when the PR surface is active. Owns the activeFilter writes;
//    the InboxPane (work pane) reads the same module-level store. Data
//    is shared via prsCache so neither component re-fetches on its own.

export function InboxSidebar({
  repoRoot,
  onClose,
}: {
  repoRoot: string;
  onClose?: () => void;
}) {
  const cached = getPrListCached(repoRoot);
  const [prs, setPrs] = useState<PrSummary[]>(cached ?? []);
  const [viewer, setViewer] = useState<string>("");
  const [loading, setLoading] = useState(cached == null);
  const activeFilter = useActiveFilter();

  const refresh = useCallback(
    async (force = false) => {
      const hasCache = getPrListCached(repoRoot) != null;
      if (!hasCache) setLoading(true);
      try {
        const listP = force
          ? invalidatePrList(repoRoot)
          : fetchPrList(repoRoot);
        const [list, who] = await Promise.all([
          listP,
          api.prWhoami(repoRoot).catch(() => ""),
        ]);
        setPrs(list);
        setViewer(who);
      } catch {
        /* the work pane surfaces fetch errors; sidebar stays quiet */
      } finally {
        setLoading(false);
      }
    },
    [repoRoot],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribePrList(repoRoot, (list) => setPrs(list));
  }, [repoRoot]);

  const buckets = useMemo(() => bucketize(prs), [prs]);
  const total = prs.length;

  return (
    <aside className="h-full w-full flex flex-col bg-bg-content">
      <div className="p-3">
        <h3 className="text-text-1 text-[13px] font-semibold mb-1">Inbox</h3>
        <p className="text-text-4 text-[11px] leading-relaxed">
          Pull requests grouped by your relationship to them.{" "}
          {viewer ? (
            <>
              Signed in as <span className="font-mono">{viewer}</span>.
            </>
          ) : (
            <>
              Run <span className="font-mono">gh auth login</span> to enable
              Yours / Reviewing buckets.
            </>
          )}
        </p>
      </div>
      <nav className="px-2 space-y-0.5">
        <FilterItem
          label="All"
          count={total}
          dot={null}
          active={activeFilter === null}
          onClick={() => setActiveFilterShared(null)}
        />
        {BUCKET_ORDER.map((b) => (
          <FilterItem
            key={b}
            label={BUCKET_LABEL[b]}
            count={buckets[b].length}
            dot={BUCKET_DOT[b]}
            active={activeFilter === b}
            onClick={() =>
              setActiveFilterShared(activeFilter === b ? null : b)
            }
          />
        ))}
      </nav>
      <div className="mt-auto p-3 border-t border-line-soft flex items-center gap-2">
        <Button
          type="button"
          variant="subtle"
          onClick={() => void refresh(true)}
          disabled={loading}
          className="flex-1"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            title="Close"
            className="text-text-4 hover:text-text-1"
          >
            ✕
          </Button>
        )}
      </div>
    </aside>
  );
}

// ── UI atoms ──────────────────────────────────────────────────────

function FilterItem({
  label,
  count,
  dot,
  active,
  onClick,
}: {
  label: string;
  count: number;
  dot: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-colors ${
        active
          ? "bg-bg-2 text-text-1"
          : "text-text-3 hover:bg-bg-2 hover:text-text-1"
      }`}
    >
      {dot !== null && (
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      )}
      <span className="flex-1 text-left truncate">{label}</span>
      <span className="text-[11px] text-text-4 tabular-nums">{count}</span>
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-text-4 text-[12px] px-5 py-4 max-w-prose">
      {children}
    </div>
  );
}

function ErrorHint({ message }: { message: string }) {
  // Friendly empty-state when the project isn't a git repo at all.
  // Recognises git2 / gh / git error phrasings; keeps the raw message
  // available for everything else (network, etc).
  const m = message.toLowerCase();
  const notGitRepo =
    m.includes("not a git repository") ||
    m.includes("could not find repository") ||
    m.includes("no such file or directory: .git");
  if (notGitRepo) {
    return (
      <div className="px-5 py-10 text-[12.5px] space-y-3 max-w-prose">
        <div className="text-text-1 font-medium">Not a git repository yet</div>
        <p className="text-text-3 leading-relaxed">
          Pull requests live on top of a git history. Initialise this folder
          as a git repo and add a remote, then come back — Aura will pick up
          the PRs automatically.
        </p>
        <pre className="bg-bg-2 text-text-2 font-mono text-[11.5px] px-3 py-2 rounded-md whitespace-pre-wrap">
{`git init
git remote add origin <your-remote-url>
git fetch
`}
        </pre>
        <p className="text-text-4 text-[11.5px]">
          You'll also need{" "}
          <span className="font-mono">gh auth login</span> from{" "}
          <span className="font-mono">cli.github.com</span> for Inbox to see
          PRs.
        </p>
      </div>
    );
  }
  // Switched gh accounts, signed out, no token, or hit a 401/403 — the
  // raw stderr is hostile here ("HTTP 401: Bad credentials", "gh: To
  // authenticate, please run gh auth login.", "could not read Username
  // for 'https://github.com'"). Surface the same empty-state shape as
  // "no PRs" with a sign-in CTA instead of a red font-mono dump.
  const isAuth =
    m.includes("gh auth") ||
    m.includes("authenticate") ||
    m.includes("credentials") ||
    m.includes("401") ||
    m.includes("403") ||
    m.includes("could not read username") ||
    m.includes("no such command") ||
    m.includes("gh: command not found") ||
    m.includes("permission denied") ||
    m.includes("login required") ||
    m.includes("not logged in") ||
    m.includes("token");
  // "Could not resolve to a Repository with the name X" — gh's GraphQL
  // returns this when the authenticated account can't see the repo
  // (renamed/deleted, private repo with no access on the active gh
  // account, or you just switched gh accounts to one without org
  // access). Same empty-state shape as the auth case but worded for
  // the access angle.
  const isNoAccess =
    m.includes("could not resolve to a repository") ||
    m.includes("repository not found") ||
    m.includes("no such repository") ||
    (m.includes("graphql") && m.includes("repository"));
  if (isAuth) {
    return (
      <div className="px-5 py-10 text-[12.5px] space-y-3 max-w-prose">
        <div className="text-text-1 font-medium">Sign in to GitHub to see PRs</div>
        <p className="text-text-3 leading-relaxed">
          Aura uses the GitHub CLI for pull requests. Sign in (or re-sign in
          if you switched accounts) and the inbox will populate automatically.
        </p>
        <pre className="bg-bg-2 text-text-2 font-mono text-[11.5px] px-3 py-2 rounded-md whitespace-pre-wrap">{`gh auth login`}</pre>
        <p className="text-text-4 text-[11.5px]">
          Then click Refresh, or wait a few seconds for the inbox to retry.
        </p>
      </div>
    );
  }
  if (isNoAccess) {
    return (
      <div className="px-5 py-10 text-[12.5px] space-y-3 max-w-prose">
        <div className="text-text-1 font-medium">No PRs to show</div>
        <p className="text-text-3 leading-relaxed">
          The active GitHub account can't see this repository — it may be
          private and only visible to a different account you signed into,
          or the repo was renamed/transferred. Re-sign in with the account
          that has access:
        </p>
        <pre className="bg-bg-2 text-text-2 font-mono text-[11.5px] px-3 py-2 rounded-md whitespace-pre-wrap">{`gh auth switch
# or
gh auth login`}</pre>
        <p className="text-text-4 text-[11.5px]">
          Then click Refresh.
        </p>
      </div>
    );
  }
  return (
    <div className="px-5 py-4 text-[12px] space-y-2 max-w-prose">
      <div className="text-red-400 font-mono whitespace-pre-wrap">
        {message}
      </div>
      <div className="text-text-4">
        Install GitHub CLI from{" "}
        <span className="font-mono">https://cli.github.com/</span> and run{" "}
        <span className="font-mono">gh auth login</span> in this repo, then
        click Refresh.
      </div>
    </div>
  );
}

function Section({
  title,
  dot,
  count,
  expanded,
  onToggle,
  rows,
  onSelect,
  activePrNumber,
}: {
  title: string;
  dot: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  rows: PrSummary[];
  onSelect: (p: PrSummary) => void;
  activePrNumber: number | null;
}) {
  return (
    <div className="border-b border-line-soft">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-5 py-2.5 hover:bg-bg-2 transition-colors"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 10 10"
          className={`text-text-4 transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
        >
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
        </svg>
        <span className="text-[11px] text-text-4 tabular-nums">{count}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        <span className="text-[12px] text-text-1 font-semibold">{title}</span>
      </button>

      {expanded && rows.length > 0 && (
        <div>
          {/* column header */}
          <div className="flex items-center px-5 py-1.5 text-[10px] font-medium text-text-4 uppercase tracking-wider border-t border-line-soft/40 bg-bg-1/30">
            <div className="w-6" />
            <div className="flex-1 pl-2">Title</div>
            <div className="w-24 text-right">Status</div>
            <div className="w-24 text-right">Changes</div>
            <div className="w-16 text-right">Updated</div>
          </div>
          {rows.map((p) => (
            <Row
              key={p.number}
              row={p}
              selected={p.number === activePrNumber}
              onSelect={() => onSelect(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  selected,
  onSelect,
}: {
  row: PrSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const auraDot =
    row.aura_risk_score === null
      ? null
      : row.aura_risk_score > 60
        ? "bg-red-500"
        : row.aura_risk_score > 0
          ? "bg-yellow-500"
          : "bg-green-500";
  const decisionTone =
    row.review_decision === "APPROVED"
      ? "text-green-400"
      : row.review_decision === "CHANGES_REQUESTED"
        ? "text-red-400"
        : "text-text-4";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left flex items-center px-5 py-2.5 hover:bg-bg-2 transition-colors border-t border-line-soft/40 ${
        selected ? "bg-bg-2" : ""
      }`}
    >
      <div className="w-6 flex justify-center">
        {auraDot ? (
          <span
            className={`w-2 h-2 rounded-full ${auraDot}`}
            title={`aura risk ${row.aura_risk_score}`}
          />
        ) : (
          <span className="w-2 h-2 rounded-full bg-text-4/40" />
        )}
      </div>

      <div className="flex-1 pl-2 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[11px] text-text-4 tabular-nums flex-shrink-0">
            #{row.number}
          </span>
          <span className="text-[12.5px] text-text-1 truncate">
            {row.title}
          </span>
        </div>
        <div className="text-[11px] text-text-4 mt-0.5 flex items-center gap-2 tabular-nums min-w-0">
          <span className="truncate">{row.author}</span>
          <span>·</span>
          <span className="font-mono truncate">{row.head_ref}</span>
          <span>→</span>
          <span className="font-mono truncate">{row.base_ref}</span>
        </div>
      </div>

      <div className="w-24 flex items-center justify-end gap-1.5">
        {row.review_decision ? (
          <span className={`text-[11px] ${decisionTone}`}>
            {humanReviewDecision(row.review_decision)}
          </span>
        ) : (
          <span className="text-[11px] text-text-4">—</span>
        )}
        {row.checks_state && (
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              row.checks_state === "success"
                ? "bg-green-500"
                : row.checks_state === "failure"
                  ? "bg-red-500"
                  : "bg-yellow-500"
            }`}
            title={`CI ${row.checks_state}: ${row.checks_passing}✓ ${row.checks_failing}✗ ${row.checks_pending}…`}
          />
        )}
      </div>

      <div className="w-24 text-right text-[11px] tabular-nums">
        <span className="text-green-400">+{row.additions}</span>
        <span className="text-text-4"> / </span>
        <span className="text-red-400">−{row.deletions}</span>
      </div>

      <div className="w-16 text-right text-[11px] text-text-4 tabular-nums">
        {formatAge(row.updated_at)}
      </div>
    </button>
  );
}

function humanReviewDecision(d: string): string {
  return d
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatAge(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}
