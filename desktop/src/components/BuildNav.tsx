// The Build family of destinations — "Aura" (the orchestrator you talk to),
// "Workspaces" (the fleet page, and the roster below it) and "Tasks" (the
// work). These render as the HEAD of the sidebar's one
// nav list, above Team / Pages / Trace, in the same `.ade-nav-row` markup: they
// are destinations exactly like those three, and drawing them as a second band
// — its own hairline, its own row height, its own accent-tint active state
// against the section rows' surface fill — made the top of the sidebar two
// navigation systems stacked on each other, seven rows over two treatments,
// with no rule a reader could infer for which idea went in which band.
//
// The word "Build" went with the band. It was the section row that revealed
// this list plus the project roster, so it captioned a group whose first row
// already said the same thing in plainer words — and "Build", as a place, is
// engine-speak on a rail read by people who don't write code.
//
//
// Aura sits at the top because it is the one row that is a *who* rather than a
// *where*: the orchestrator that fans work out to the CLI agents and chains
// their results. It had no permanent door in the ADE sidebar — the right rail's
// "Aura" tab is not built in this layout (see RightRail's `!adeMode` guard), so
// reaching the chat meant going through a status pill or waiting for something
// else to focus it. The row opens the workspace's current conversation, or
// starts one when there isn't a conversation yet.
//
// The Workspaces row IS the door to the full Workspaces view — clicking the
// label opens it. It used to only re-select the roster below, with a separate
// expand arrow beside it for the real view; that split made the fleet look
// like a side trip off the roster rather than the page it is. One target now.
// It carries no "+ New" of its own: that button opened the folder picker, and
// the "+" in the Projects header eight pixels below it called the very same
// `pickAndOpenFolder` — one action wearing two controls, one of them the only
// solid-green button in the rail.
//
// All three rows lead to PAGES that fill the content area beside this sidebar,
// which is why each can be the current one and paints as such. They used to
// open as modals over the whole shell — where "which row am I on?" had no
// answer, because you weren't on a row, you were in a dialog.

import { useEffect, useState } from "react";

import { AgentIcon } from "./agent/AgentIcon";
import { fetchReadyView } from "../lib/loopCache";
import {
  loadTasksForRoots,
  rootsForScope,
  rootsKeyOf,
  useKnownProjects,
  useProjectScope,
} from "../lib/projectRoots";
import { AURA_MANAGER_ENABLED } from "../lib/featureFlags";

/** Which nav row is the surface the user is currently standing in. Only one
 *  can be it, which is the whole reason this is a prop: the Workspaces row used
 *  to hard-code `active`, so once a second row existed it would have kept
 *  claiming to be current while the user sat in the other one. */
export type BuildNavRow = "aura" | "workspaces" | "work";

type BuildNavProps = {
  /** Opens the workspace's Aura conversation — the existing one if there is
   *  one, a fresh one if there isn't. Omitted (or with the native manager
   *  gated off in featureFlags) the row is not rendered at all. */
  onOpenAura?: () => void;
  /** The row to paint as current, or null when the reader is standing in none
   *  of them (an editor tab, a terminal). This used to default to Workspaces,
   *  so the rail claimed you were on the Workspaces page whenever no page was
   *  up — which is most of the time, since the resting state of this app is a
   *  file open in the middle. */
  activeRow?: BuildNavRow | null;
  /** Returns the center surface to the workspace roster (the resting Build
   *  context). Only the fallback for a host that doesn't wire
   *  `onOpenWorkspaces`. */
  onSelectWorkspaces?: () => void;
  /** Opens the Workspaces view — every parallel copy across every open
   *  project, seen three ways (All / Board / Live). This is what the row's
   *  label does; `onSelectWorkspaces` is only the fallback for a host that
   *  doesn't wire it. */
  onOpenWorkspaces?: () => void;
  /** Opens Tasks — the one place the work lives, seen five ways: List, Board
   *  and Sprint over the backlog, Plan and Graph over what the agents are
   *  doing about it.
   *
   *  This row used to say "Mission Control" and open a second board. That
   *  board was a projection of this one — a crew node carries `board_task_id`
   *  straight back to the card it came from — so the rail was offering two
   *  doors onto one set of work, in two vocabularies, and asking the reader to
   *  work out the difference. See lib/workRoute. */
  onOpenWork?: () => void;
  /** The active workspace root — needed so the Crew row can show live overall
   *  progress (done / total) read straight from the shared crew graph. */
  repoRoot?: string;
};

/** What the Tasks row shows: how much of the work is finished, and whether
 *  anything is being worked right now.
 *
 *  The count is the BOARD's — every task in `.aura/tasks/`, and how many of
 *  them are done. It used to be the crew graph's, back when this row said
 *  "Mission Control" and a crew run was the only thing it could have meant.
 *  Beside a row that says "Tasks" that number was answering a different
 *  question from the one the word asks: 984 crew nodes against 1,149 board
 *  cards, the two sets overlapping but neither containing the other.
 *
 *  `working` still comes from the crew, because "an agent is on something
 *  right now" is a fact only the crew graph holds — and it is drawn as a dot,
 *  not folded into the ratio. */
type WorkProgress = {
  done: number;
  total: number;
  working: number;
};

export function BuildNav({
  onOpenAura,
  activeRow = null,
  onSelectWorkspaces,
  onOpenWorkspaces,
  onOpenWork,
  repoRoot,
}: BuildNavProps) {
  const crew = useWorkProgress(repoRoot);
  const wsActive = activeRow === "workspaces";
  // No wrapper element: these rows are siblings of Team / Pages / Trace inside
  // the one `.ade-nav`, not a group of their own.
  return (
    <>
      {AURA_MANAGER_ENABLED && onOpenAura && (
        <button
          type="button"
          className={`ade-nav-row${activeRow === "aura" ? " active" : ""}`}
          onClick={onOpenAura}
          aria-current={activeRow === "aura" ? "page" : undefined}
          title="Aura. The orchestrator: give it the goal and it hands work to your agents and pulls their results together"
        >
          {/* The same mark the agent surfaces use for the orchestrator, so
              one identity carries across the app rather than a nav-only
              glyph. It brings its own colour — the row adds none. */}
          <AgentIcon agentId="aura-manager" size={16} />
          <span className="nm">Aura</span>
        </button>
      )}
      <button
        type="button"
        className={`ade-nav-row${wsActive ? " active" : ""}`}
        onClick={onOpenWorkspaces ?? onSelectWorkspaces}
        aria-current={wsActive ? "page" : undefined}
        title="Workspaces. Every parallel copy across every open project (⌘⇧W)"
      >
        <LayersGlyph />
        <span className="nm">Workspaces</span>
      </button>
      {onOpenWork && (
        <button
          type="button"
          className={`ade-nav-row${activeRow === "work" ? " active" : ""}`}
          onClick={onOpenWork}
          aria-current={activeRow === "work" ? "page" : undefined}
          title="Tasks. Everything that needs doing, and what the agents are working through"
        >
          <TasksGlyph />
          <span className="nm">Tasks</span>
          <CrewProgressBadge crew={crew} />
        </button>
      )}
    </>
  );
}

/** Polls for overall progress so the Tasks row can carry a calm
 *  "{done}/{total}" count — the same way Conductor surfaces its progress on
 *  its own menu item. Light cadence (~10s) plus a read on mount; any error
 *  just leaves the badge hidden (we never invent numbers).
 *
 *  The two reads are settled independently: a repo with a task board and no
 *  crew graph is the common case, and one missing must not blank the other. */
function useWorkProgress(repoRoot?: string): WorkProgress | null {
  const [crew, setCrew] = useState<WorkProgress | null>(null);
  // The same scope the Tasks rail's picker writes and the board reads. Without
  // it the row would say 1,149 while the board beside it drew every project's
  // — the row and the page disagreeing about the word they both print.
  const scope = useProjectScope();
  const known = useKnownProjects(repoRoot ?? "");
  const roots = rootsForScope(scope, repoRoot ?? "", known);
  const rootsKey = rootsKeyOf(roots);
  useEffect(() => {
    if (roots.length === 0) {
      setCrew(null);
      return;
    }
    let live = true;
    const read = async () => {
      // The ratio is a plain count of the board — the same rows the Board and
      // List lenses draw, so the number in the rail and the cards on the page
      // are the same claim. This used to project the crew graph through
      // `readyViewToMission` and read the whole proof ledger on every tick,
      // ten seconds apart, to answer a question the board answers by looking
      // at itself.
      const [board, graph] = await Promise.allSettled([
        loadTasksForRoots(roots),
        // "An agent is on it right now" is the open project's answer — the crew
        // graph the user is standing in, not a sum across projects they aren't
        // looking at.
        fetchReadyView(roots[0]!),
      ]);
      if (!live) return;
      if (board.status !== "fulfilled" || !Array.isArray(board.value)) {
        // No board (or a transient read error) — leave the badge off rather
        // than show a fake count.
        setCrew(null);
        return;
      }
      const tasks = board.value;
      const working =
        graph.status === "fulfilled" ? (graph.value?.working?.length ?? 0) : 0;
      setCrew({
        done: tasks.filter((t) => t.status === "done").length,
        total: tasks.length,
        working,
      });
    };
    read();
    const id = window.setInterval(read, 10000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
    // `rootsKey` stands in for `roots` — a fresh array each render would
    // restart the 10s poll constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey]);
  return crew;
}

/** The small trailing badge on the Tasks row. Hidden until there's work in
 *  the board. A dot marks work actively in flight — the one thing
 *  here that is happening right now; the count itself stays quiet, including
 *  when everything is finished (a finished run is not asking for anything).
 *
 *  It reads as progress, not as an ask: the amber pill beside Team and Trace
 *  means "N things are waiting for you", and how much of a crew's plan has
 *  landed is not that. Same tier, no fill — `.prog` in styles.css. */
function CrewProgressBadge({ crew }: { crew: WorkProgress | null }) {
  if (!crew || crew.total === 0) return null;
  return (
    <span
      className="prog"
      title={`${crew.done} of ${crew.total} tasks done${
        crew.working > 0
          ? ` · ${crew.working} being worked by an agent right now`
          : ""
      }`}
    >
      {crew.working > 0 && (
        // Work actually in flight — amber, the pack's "an agent is on it"
        // slot, matching CrewCanvas's STATUS_DOT.working and the Automations
        // run dot.
        <span className="dot" aria-hidden="true" />
      )}
      {crew.done}/{crew.total}
    </span>
  );
}

function LayersGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    >
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}

function TasksGlyph() {
  // A checklist — the plainest possible mark for "things that need doing".
  // It replaced a gauge dial, which drew the old name (a control room you
  // watch) rather than the thing the row is about.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 6 2 2 3.5-3.5" />
      <path d="m3 14 2 2 3.5-3.5" />
      <path d="M12 6.5h9M12 15.5h9" />
    </svg>
  );
}

