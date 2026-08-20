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

import { Copy, Moon, SearchX } from "lucide-react";
import * as Icons from "../../Icons";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";
import { api, type WorktreePlane } from "../../../lib/api";
import { peekCache, writeCache } from "../../../lib/resourceCache";
import { useWorktreeBadges } from "../../../lib/useWorktreeBadges";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import { WorkspaceRow } from "./WorkspaceRow";
import { PublishRepoDialog } from "./PublishRepoDialog";
import { SayToWorktreeDialog } from "./SayToWorktreeDialog";
import { bucketByActivity, isQuiet, matchesQuery, toRows } from "./model";
import { useWorkspaceCustomization } from "../../../lib/workspaceCustomization";

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
      fix: "Update Aura. If you also installed the command line separately, that older copy is being found first. Remove it and reopen the app.",
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
  /** Show the copies that are sitting quiet. Supply this (with `onQuietToggle`)
   *  and the host owns the control: this pane then draws NO filter row of its
   *  own. Embedded, that row had shrunk to a caption plus one button sitting
   *  directly under the host's own search row — two bands, each mostly empty,
   *  for one toggle. Omit both and the pane keeps its own state and row, which
   *  is what the standalone mount needs. */
  showQuiet?: boolean;
  onQuietToggle?: () => void;
  /** How many copies are currently hidden as quiet, reported up so the host's
   *  toggle can name the number it is hiding. */
  onQuietCount?: (n: number) => void;
};

export function WorkspacesPane({
  repoRoot,
  onOpenWorktree,
  query: hostQuery,
  embedded = false,
  showQuiet: hostShowQuiet,
  onQuietToggle,
  onQuietCount,
}: Props) {
  // Coming back to Workspaces re-discovered every checkout from scratch, so
  // the page you had open a moment ago started blank again. Seed from the last
  // full read and correct it behind the paint.
  //
  // Only a FULL plane is ever cached — see `painted` below for why the fast
  // pass must not be treated as an answer.
  const planeKey = `workspaces:${repoRoot}`;
  const [plane, setPlane] = useState<WorktreePlane | null>(
    () => peekCache<WorktreePlane>(planeKey) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(
    () => peekCache<WorktreePlane>(planeKey) === undefined,
  );
  const [ownQuery, setOwnQuery] = useState("");
  const query = embedded ? (hostQuery ?? "") : ownQuery;
  // Own the quiet filter only when the host hasn't. See `showQuiet` in Props.
  const [ownShowQuiet, setOwnShowQuiet] = useState(false);
  const hostOwnsQuiet = hostShowQuiet !== undefined;
  const showQuiet = hostShowQuiet ?? ownShowQuiet;
  const toggleQuiet = onQuietToggle ?? (() => setOwnShowQuiet((v) => !v));
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
  const painted = useRef(peekCache<WorktreePlane>(planeKey) !== undefined);

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
      writeCache(`workspaces:${target}`, full);
    } catch (e) {
      if (wanted.current !== target) return;
      setError(String(e));
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    const known = peekCache<WorktreePlane>(planeKey);
    // Blanking here is what made every visit start empty. Show the last full
    // read for this project if we have one; only a project we have never read
    // gets the spinner and the fast pass.
    setPlane(known ?? null);
    setLoading(known === undefined);
    painted.current = known !== undefined;
    load();
  }, [load, planeKey]);

  // A board nobody is looking at doesn't need to re-walk forty working trees.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      setNow(Date.now());
      load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [visible, load]);

  // Subscribed so a rename repaints these rows immediately — `toRows`
  // resolves titles through the customisation store (see WorkspacesSurface).
  const naming = useWorkspaceCustomization();
  const rows = useMemo(() => (plane ? toRows(plane) : []), [plane, naming]);

  const visibleRows = useMemo(
    () => rows.filter((r) => matchesQuery(r, query) && (showQuiet || !isQuiet(r))),
    [rows, query, showQuiet],
  );

  const quietCount = useMemo(() => rows.filter(isQuiet).length, [rows]);

  // Report it up when the host draws the toggle — it can't count what it
  // doesn't load.
  useEffect(() => {
    onQuietCount?.(quietCount);
  }, [quietCount, onQuietCount]);
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
            <h1 className="text-lg font-semibold" style={{ color: "var(--color-text-1)" }}>
              {rows.length || ""} {rows.length === 1 ? "copy" : "copies"}
            </h1>
            <span className="text-sm" style={{ color: "var(--color-text-4)" }}>
              {plane ? `measured against ${plane.trunk}` : "reading…"}
              {liveAgents > 0 && ` · ${liveAgents} agent${liveAgents === 1 ? "" : "s"} working`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onOpenWorktree(repoRoot)}
            className="rounded-sm px-2.5 py-1 text-sm font-medium transition-colors"
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
          className="mx-4 mb-2 flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm"
          style={{
            background: "color-mix(in srgb, var(--color-red) 10%, transparent)",
            color: "var(--color-red)",
          }}
        >
          <Icons.Impacts size={12} />
          <span>
            {crossCollisions} {crossCollisions === 1 ? "function is" : "functions are"} being
            changed in two copies at once. Whoever saves second will lose the other's work.
          </span>
        </div>
      )}

      {/* Filter row — only when this pane owns the quiet control.
          Embedded in the Workspaces page it no longer does, and this row is
          gone with it. What stood here was a caption ("measured against main")
          and one button, in a band directly beneath the host's own search row:
          two stacked bars, each with a single item at one end, before the
          first copy. The button moved up beside the scope the host already
          shows, and the caption became unnecessary the moment each row started
          naming the branch its counts are measured against. */}
      {!hostOwnsQuiet && (
        <div className="flex items-center gap-2 px-4 pb-2">
          {embedded ? (
            <span className="flex-1 text-sm" style={{ color: "var(--color-text-4)" }}>
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
                className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-text-4)]"
                style={{ color: "var(--color-text-1)" }}
              />
            </div>
          )}
          <QuietToggle
            showing={showQuiet}
            hidden={quietCount}
            onToggle={toggleQuiet}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {loading && !plane && (
          <LoadingState label="Reading every copy of this project…" />
        )}

        {explained && error && !plane && (
          <ErrorState
            title={explained.headline}
            message={
              <>
                {explained.fix && <span className="block">{explained.fix}</span>}
                {/* The raw line, kept and demoted. When the guess above is
                    wrong this is the only thing that helps, so it must not be
                    swallowed — it just stops being what greets you. */}
                <span className="mt-2.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-text-5">
                  {error}
                </span>
              </>
            }
            onRetry={() => void load()}
            size="sm"
          />
        )}

        {/* Only when the read actually succeeded. A failed read leaves zero
            rows too, and saying "No copies yet" then states as fact the one
            thing the page just failed to find out. */}
        {!loading && !error && visibleRows.length === 0 && (
          query ? (
            <EmptyState
              icon={SearchX}
              title="Nothing matches what you typed"
              body={`No copy of this project has “${query}” in its branch, its folder or the agent working in it.`}
              size="sm"
            />
          ) : quietCount > 0 ? (
            // Not empty — hidden. Offer to show, never to create.
            <EmptyState
              icon={Moon}
              title="Nothing happening right now"
              body={`${quietCount} ${quietCount === 1 ? "copy is" : "copies are"} sitting quiet. No agent working, nothing unsaved, nothing waiting to be sent.`}
              action={{ label: "Show them anyway", onClick: toggleQuiet }}
              size="sm"
            />
          ) : (
            <EmptyState
              icon={Copy}
              title="Only one copy of this project"
              body="A copy is a separate checkout of the same project, so an agent can work on one thing while you work on another, and neither treads on the other. You’re working in the only one there is."
              size="sm"
            />
          )
        )}

        {buckets.map((bucket) => (
          <div key={bucket.key} className="mt-2">
            {/* Sentence case, on the same measurements the fleet list beside
                it uses for the same idea. It was the last ALL-CAPS label on
                the Workspaces page, and it sat one tab away from "Open now"
                and "Earlier this week" set in ordinary words. */}
            <div className="flex items-baseline gap-1.5 px-2 pb-1 pt-2">
              <h3 className="text-xs font-medium text-text-4">{bucket.label}</h3>
              <span className="text-xs tabular-nums text-text-5">
                {bucket.rows.length}
              </span>
            </div>
            {bucket.rows.map((row) => (
              <WorkspaceRow
                key={row.card.path}
                row={row}
                badge={badges[row.card.path]}
                now={now}
                selected={row.card.is_here}
                trunk={plane?.trunk ?? ""}
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

/** "Hiding N quiet" / "Showing all".
 *
 *  Exported because two surfaces draw it: this pane when it stands alone, and
 *  the Workspaces page's own header row when it embeds this pane. One
 *  component so the two can't drift into two spellings of the same control —
 *  and so the sentence explaining what "quiet" means is written once.
 *
 *  That sentence used to define quiet in git's terms ("nothing uncommitted,
 *  nothing ahead"), which is exactly the vocabulary this surface has stopped
 *  printing on its rows. */
export function QuietToggle({
  showing,
  hidden,
  onToggle,
}: {
  showing: boolean;
  hidden: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex flex-none items-center gap-1.5 rounded-sm px-2 py-1 text-sm transition-colors"
      style={{
        background: showing ? "var(--color-bg-2)" : "transparent",
        color: showing ? "var(--color-text-2)" : "var(--color-text-4)",
      }}
      title="A quiet copy has no agent working in it, nothing unsaved, nothing waiting to go to the main line, and no unread messages."
    >
      <Icons.Folder size={12} />
      {showing ? "Showing all" : `Hiding ${hidden} quiet`}
    </button>
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
      <div className="text-md font-medium" style={{ color: "var(--color-text-1)" }}>
        This folder isn&rsquo;t tracked yet
      </div>
      <p className="max-w-[380px] text-sm leading-relaxed" style={{ color: "var(--color-text-3)" }}>
        Aura keeps its record (what changed, why, and who was working where) against a
        repository. Set one up and you can run several copies of this project side by side.
      </p>
      <button
        type="button"
        onClick={onPublish}
        className="mt-1 rounded-sm px-3 py-1.5 text-sm font-medium"
        // Same as "New copy" above — the one action on an empty state is a
        // button, so it wears the button slot.
        style={{
          background: "var(--color-primary)",
          color: "var(--color-primary-foreground)",
        }}
      >
        Set up a repository
      </button>
      <div className="font-mono text-xs" style={{ color: "var(--color-text-5)" }}>
        {dir}
      </div>
    </div>
  );
}
