// Workspaces — every copy of this project, on one page.
//
// Working on several things at once means several checkouts of the same
// repository, each with its own branch and often its own agent. Until this
// page the app could only ever show the one it was opened on, so the honest
// answer to "what is everything doing?" was to open a terminal.
//
// The layout follows the shape people already know from Conductor — a search
// row, a scope selector, then rows grouped by when they last moved, each row
// carrying its diff and its age. What it shows underneath is the part only
// Aura can answer, because only Aura keeps one shared record across all the
// copies:
//
//   • which agent is standing in each copy, right now;
//   • when two copies have taken hold of the SAME function — the failure that
//     is invisible to git, because neither copy's status mentions the other;
//   • messages one copy has sent another that nobody has read yet.
//
// Two paints, because the cost is in git, not in the plane: the first call
// skips per-checkout git work and returns in milliseconds so every row is on
// screen immediately; the second fills in the counts. A repo with forty
// checkouts never shows a spinner.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as Icons from "../../Icons";
import { AsciiSpinner } from "../../AsciiSpinner";
import { api, type WorktreePlane } from "../../../lib/api";
import { useWorktreeBadges } from "../../../lib/useWorktreeBadges";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { WorkspaceRow } from "./WorkspaceRow";
import { PublishRepoDialog } from "./PublishRepoDialog";
import { SayToWorktreeDialog } from "./SayToWorktreeDialog";
import { bucketByActivity, isQuiet, matchesQuery, toRows } from "./model";

const REFRESH_MS = 20_000;

/** What went wrong, said to the person looking at it.
 *
 *  This page is drawn by the app but its data comes from the `aura` command
 *  line, resolved off PATH — so the common failure is not "something broke",
 *  it is "the app found an older command line than the one this page needs".
 *  The raw text for that is `unrecognized subcommand 'worktrees'` followed by
 *  a usage dump, which tells someone who does not write Rust exactly nothing.
 *
 *  Each branch names the situation and the one thing that fixes it. The raw
 *  line is still returned, because when the guess is wrong it is the only
 *  thing that helps — it is just no longer the headline. */
function explainPlaneError(raw: string): { headline: string; fix: string | null } {
  if (/unrecognized subcommand|unexpected argument/i.test(raw)) {
    return {
      headline: "The Aura command line on this machine is older than this page needs.",
      fix: "Update Aura. If you also installed the command line separately, that older copy is being found first — remove it and reopen the app.",
    };
  }
  if (/failed to spawn|No such file|not found/i.test(raw)) {
    return {
      headline: "The app could not find Aura's command line.",
      fix: "Reinstall Aura, or reopen the app if you have just moved it.",
    };
  }
  if (/^parse |parse `/i.test(raw)) {
    return {
      headline: "Aura's command line replied with something this page could not read.",
      fix: "This usually means the app and the command line are different versions. Updating both fixes it.",
    };
  }
  return { headline: "This project's copies could not be read.", fix: null };
}

type Props = {
  repoRoot: string;
  /** Open a checkout as the active project. */
  onOpenWorktree: (path: string) => void;
  /** Filter text supplied by a host surface. Only read when `embedded`. */
  query?: string;
  /** Rendered inside a surface that already draws a header and a search box
   *  (the Workspaces overlay). Drawing our own on top would give the page two
   *  titles and two search fields, so the chrome is suppressed and the filter
   *  text comes in through `query` instead. */
  embedded?: boolean;
};

export function WorkspacesPane({
  repoRoot,
  onOpenWorktree,
  query: hostQuery,
  embedded = false,
}: Props) {
  const [plane, setPlane] = useState<WorktreePlane | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownQuery, setOwnQuery] = useState("");
  const query = embedded ? (hostQuery ?? "") : ownQuery;
  const [showQuiet, setShowQuiet] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [messageTarget, setMessageTarget] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const visible = useDocumentVisibility();

  // Guards a slow full-status reply from overwriting a newer fast reply after
  // the user switched projects.
  const wanted = useRef(repoRoot);
  wanted.current = repoRoot;

  // Whether a plane WITH git status is already on screen for this project.
  //
  // The fast pass is a first-paint device and nothing else. It comes back from
  // `list()` rather than `list_with_status()`, so every checkout reports
  // dirty_files = 0 and ahead = 0 — and isQuiet() is written in terms of
  // exactly those two fields. Committing it on the 20s refresh therefore did
  // not merely blank the counts on each row: every checkout that was active
  // *only* because it was dirty or ahead turned quiet, and quiet rows are
  // hidden by default, so they dropped out of the list and came back a moment
  // later. Once the real numbers are on screen, we go straight to the full
  // pass and leave them there.
  const painted = useRef(false);

  const load = useCallback(async () => {
    if (!repoRoot) return;
    const target = repoRoot;
    try {
      // First paint only — every row on screen before git is touched, so a
      // repo with forty checkouts never shows a spinner.
      if (!painted.current) {
        const quick = await api.worktreePlane(target, false);
        if (wanted.current !== target) return;
        setPlane(quick);
        setError(quick.error ?? null);
        setLoading(false);
      }

      const full = await api.worktreePlane(target, true);
      if (wanted.current !== target) return;
      setPlane(full);
      setError(full.error ?? null);
      setLoading(false);
      painted.current = true;
    } catch (e) {
      if (wanted.current !== target) return;
      setError(String(e));
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    setLoading(true);
    setPlane(null);
    // A different project has its own checkouts to discover, so it earns the
    // fast pass again.
    painted.current = false;
    load();
  }, [load]);

  // A board nobody is looking at doesn't need to re-walk forty working trees.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      setNow(Date.now());
      load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [visible, load]);

  const rows = useMemo(() => (plane ? toRows(plane) : []), [plane]);

  const visibleRows = useMemo(
    () => rows.filter((r) => matchesQuery(r, query) && (showQuiet || !isQuiet(r))),
    [rows, query, showQuiet],
  );

  const quietCount = useMemo(() => rows.filter(isQuiet).length, [rows]);
  const buckets = useMemo(() => bucketByActivity(visibleRows, now), [visibleRows, now]);

  // Reuse the roster's badge hook so the page and the sidebar agree on the
  // numbers and share one refresh cycle, rather than each running its own
  // `git diff` over the same checkouts.
  const badgeGroups = useMemo(
    () =>
      plane
        ? [
            {
              root: plane.root,
              worktrees: plane.worktrees
                .filter((w) => !w.missing)
                .map((w) => ({ path: w.path, branch: w.branch ?? "" })),
            },
          ]
        : [],
    [plane],
  );
  const badges = useWorktreeBadges(badgeGroups);

  const crossCollisions = plane?.contention.filter((c) => c.cross_worktree).length ?? 0;
  const liveAgents = rows.reduce((n, r) => n + r.liveAgents.length, 0);
  const explained = error ? explainPlaneError(error) : null;

  // Not a repository — nothing here can mean anything until it is one, so the
  // page hands over to the gate rather than rendering an empty board.
  if (plane?.error) {
    return (
      <>
        <NotARepo dir={repoRoot} onPublish={() => setPublishOpen(true)} />
        {publishOpen && (
          <PublishRepoDialog
            dir={repoRoot}
            onClose={() => setPublishOpen(false)}
            onPublished={() => {
              setPublishOpen(false);
              load();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--color-bg-0)" }}>
      {/* Header — the count is the headline, not the word "Workspaces": the
          tab already says where you are. Suppressed when a host surface is
          already drawing a header above us. */}
      {!embedded && (
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold" style={{ color: "var(--color-text-1)" }}>
              {rows.length || ""} {rows.length === 1 ? "copy" : "copies"}
            </h1>
            <span className="text-[11.5px]" style={{ color: "var(--color-text-4)" }}>
              {plane ? `measured against ${plane.trunk}` : "reading…"}
              {liveAgents > 0 && ` · ${liveAgents} agent${liveAgents === 1 ? "" : "s"} working`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onOpenWorktree(repoRoot)}
            className="rounded-sm px-2.5 py-1 text-[11.5px] font-medium transition-colors"
            // The thing you press → the primary slot, not the accent. The
            // accent is a tint (focus, active marker, selection); a filled
            // accent button competed with every selected row on the page. The
            // ink was a literal near-black left over from the emerald pack, so
            // it could not follow a light ground either.
            style={{
              background: "var(--color-primary)",
              color: "var(--color-primary-foreground)",
            }}
          >
            New copy
          </button>
        </div>
      )}

      {/* One shared warning line, above the list, when two copies have taken
          hold of the same function. It sits here and not only on the rows so
          it is unmissable — this is the failure the whole plane exists for. */}
      {crossCollisions > 0 && (
        <div
          className="mx-4 mb-2 flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-[11.5px]"
          style={{
            background: "color-mix(in srgb, var(--color-red) 10%, transparent)",
            color: "var(--color-red)",
          }}
        >
          <Icons.Impacts size={12} />
          <span>
            {crossCollisions} {crossCollisions === 1 ? "function is" : "functions are"} being
            changed in two copies at once — whoever saves second will lose the other's work.
          </span>
        </div>
      )}

      {/* Filter row. Embedded, the host owns the search box — all that is left
          is the one control it can't provide, plus the trunk/agent context
          that would otherwise be lost with the header. */}
      <div className="flex items-center gap-2 px-4 pb-2">
        {embedded ? (
          <span className="flex-1 text-[11.5px]" style={{ color: "var(--color-text-4)" }}>
            {plane ? `measured against ${plane.trunk}` : "reading…"}
            {liveAgents > 0 && ` · ${liveAgents} agent${liveAgents === 1 ? "" : "s"} working`}
          </span>
        ) : (
          <div
            className="flex flex-1 items-center gap-2 rounded-sm px-2 py-1"
            style={{ background: "var(--color-bg-2)" }}
          >
            <span style={{ color: "var(--color-text-4)" }}>
              <Icons.Search size={12} />
            </span>
            <input
              value={ownQuery}
              onChange={(e) => setOwnQuery(e.target.value)}
              placeholder="Search branches, folders, agents"
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-[var(--color-text-4)]"
              style={{ color: "var(--color-text-1)" }}
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowQuiet((v) => !v)}
          className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11.5px] transition-colors"
          style={{
            background: showQuiet ? "var(--color-bg-2)" : "transparent",
            color: showQuiet ? "var(--color-text-2)" : "var(--color-text-4)",
          }}
          title="A quiet copy has no agent, nothing uncommitted, nothing ahead, and no unread messages"
        >
          <Icons.Folder size={12} />
          {showQuiet ? "Showing all" : `Hiding ${quietCount} quiet`}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {loading && !plane && (
          <div className="flex items-center gap-2 px-2 py-6 text-[12px]" style={{ color: "var(--color-text-4)" }}>
            <AsciiSpinner /> Reading every copy of this project…
          </div>
        )}

        {explained && error && !plane && (
          <div className="px-2 py-6">
            <div className="text-[12px]" style={{ color: "var(--color-text-2)" }}>
              {explained.headline}
            </div>
            {explained.fix && (
              <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-4)" }}>
                {explained.fix}
              </div>
            )}
            {/* The raw line, kept and demoted. When the guess above is wrong
                this is the only thing that helps, so it must not be swallowed
                — it just stops being what greets you. */}
            <div
              className="mt-2.5 whitespace-pre-wrap break-words text-[10.5px] leading-relaxed"
              style={{ color: "var(--color-text-5)" }}
            >
              {error}
            </div>
          </div>
        )}

        {/* Only when the read actually succeeded. A failed read leaves zero
            rows too, and saying "No copies yet" then states as fact the one
            thing the page just failed to find out. */}
        {!loading && !error && visibleRows.length === 0 && (
          <div className="px-2 py-6 text-[12px]" style={{ color: "var(--color-text-4)" }}>
            {query
              ? `Nothing matches “${query}”.`
              : quietCount > 0
                ? `Nothing active. ${quietCount} quiet ${quietCount === 1 ? "copy is" : "copies are"} hidden.`
                : "No copies yet."}
          </div>
        )}

        {buckets.map((bucket) => (
          <div key={bucket.key} className="mt-2">
            <div
              className="flex items-baseline gap-1.5 px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-4)" }}
            >
              {bucket.label}
              <span style={{ color: "var(--color-text-5)" }}>{bucket.rows.length}</span>
            </div>
            {bucket.rows.map((row) => (
              <WorkspaceRow
                key={row.card.path}
                row={row}
                repoRoot={plane?.root ?? repoRoot}
                badge={badges[row.card.path]}
                now={now}
                selected={row.card.is_here}
                onOpen={() => onOpenWorktree(row.card.path)}
                onMessage={() => setMessageTarget(row.token)}
              />
            ))}
          </div>
        ))}
      </div>

      {messageTarget && plane && (
        <SayToWorktreeDialog
          repoRoot={repoRoot}
          toWorktree={messageTarget}
          onClose={() => setMessageTarget(null)}
        />
      )}
    </div>
  );
}

/** The folder isn't a repository yet — offer to make it one instead of
 *  showing a board that can never have anything on it. */
function NotARepo({ dir, onPublish }: { dir: string; onPublish: () => void }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
      style={{ background: "var(--color-bg-0)" }}
    >
      <span style={{ color: "var(--color-text-4)" }}>
        <Icons.GitBranch size={22} />
      </span>
      <div className="text-[13.5px] font-medium" style={{ color: "var(--color-text-1)" }}>
        This folder isn&rsquo;t tracked yet
      </div>
      <p className="max-w-[380px] text-[12px] leading-relaxed" style={{ color: "var(--color-text-3)" }}>
        Aura keeps its record — what changed, why, and who was working where — against a
        repository. Set one up and you can run several copies of this project side by side.
      </p>
      <button
        type="button"
        onClick={onPublish}
        className="mt-1 rounded-sm px-3 py-1.5 text-[12px] font-medium"
        // Same as "New copy" above — the one action on an empty state is a
        // button, so it wears the button slot.
        style={{
          background: "var(--color-primary)",
          color: "var(--color-primary-foreground)",
        }}
      >
        Set up a repository
      </button>
      <div className="font-mono text-[10.5px]" style={{ color: "var(--color-text-5)" }}>
        {dir}
      </div>
    </div>
  );
}
