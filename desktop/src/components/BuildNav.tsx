// ADE Build-section nav — the labeled rows that sit above the workspace
// roster: "Workspaces" (the resting context, the roster below it) and "Crew"
// (the autonomous work loop). Deliberately minimal — the footer section
// switcher still owns Build / Team / Plan / Trace. (Automations re-homed to
// the Plan section, next to Tasks & Pages. "Agents & extensions" re-homed to
// an icon button at the end of the top header.)

import { useEffect, useState } from "react";

import { Button } from "./ui/button";
import { api } from "../lib/api";

type BuildNavProps = {
  /** Opens the folder picker to add a workspace. The compact "+ New"
   *  affordance lives on the Workspaces row itself — the action sits with
   *  its label instead of a full-width button below the roster. */
  onAddWorkspace?: () => void;
  /** Returns the center surface to the workspace roster (the resting Build
   *  context). Workspaces is always the selected row now that Automations has
   *  moved to Plan. */
  onSelectWorkspaces?: () => void;
  /** Opens "Mission Control" — the single full-screen command center for the
   *  autonomous work loop: the live Activity overview, the Kanban Board, the
   *  Queue (hand agents a stack of work and they do it in the right order),
   *  Automations (the triggers), and Control (the Runner). One door for all of
   *  it; the engine always existed (`aura crew run`). */
  onOpenCrew?: () => void;
  /** The active workspace root — needed so the Crew row can show live overall
   *  progress (done / total) read straight from the shared crew graph. */
  repoRoot?: string;
};

/** What the Crew nav row shows: how much of the crew's work is finished, and
 *  whether anything is being worked right now. Read from the same ready_view
 *  the Crew surface and `aura crew run` consume, so the badge never drifts. */
type CrewProgress = {
  done: number;
  total: number;
  working: number;
};

export function BuildNav({
  onAddWorkspace,
  onSelectWorkspaces,
  onOpenCrew,
  repoRoot,
}: BuildNavProps) {
  const crew = useCrewProgress(repoRoot);
  return (
    <div className="ade-build-nav">
      <div className="ade-bnav-row active">
        <button
          type="button"
          className="ade-bnav-rowmain"
          onClick={onSelectWorkspaces}
          aria-current="true"
          title="Workspaces"
        >
          <LayersGlyph />
          <span className="nm">Workspaces</span>
        </button>
        {onAddWorkspace && (
          <Button
            variant="accentSoft"
            size="xs"
            className="ade-bnav-new"
            onClick={onAddWorkspace}
            title="New workspace (⌘N)"
            aria-label="New workspace"
          >
            <PlusGlyph />
            New
          </Button>
        )}
      </div>
      {onOpenCrew && (
        <div className="ade-bnav-row">
          <button
            type="button"
            className="ade-bnav-rowmain"
            onClick={onOpenCrew}
            title="Mission Control — one full-screen place for the work loop: live Activity, the Board, the Queue (hand agents a stack of work and they do it in the right order), Automations, and the Runner"
          >
            <MissionGlyph />
            <span className="nm">Mission Control</span>
            <CrewProgressBadge crew={crew} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Polls the shared crew graph for overall progress so the Crew nav row can
 *  carry a calm "{done}/{total}" count — the same way Conductor surfaces its
 *  progress on its own menu item. Light cadence (~10s) plus a read on mount;
 *  any error just leaves the badge hidden (we never invent numbers). */
function useCrewProgress(repoRoot?: string): CrewProgress | null {
  const [crew, setCrew] = useState<CrewProgress | null>(null);
  useEffect(() => {
    if (!repoRoot) {
      setCrew(null);
      return;
    }
    let live = true;
    const read = async () => {
      try {
        const view = await api.loopReadyView(repoRoot);
        if (!live) return;
        const c = view?.counts;
        if (!c) {
          setCrew(null);
          return;
        }
        const total =
          c.ready + c.blocked + c.working + c.done + c.paused + c.other;
        setCrew({ done: c.done, total, working: c.working });
      } catch {
        // Crew graph not initialised (or transient read error) — leave the
        // badge off rather than show a fake count.
        if (live) setCrew(null);
      }
    };
    read();
    const id = window.setInterval(read, 10000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [repoRoot]);
  return crew;
}

/** The small trailing badge on the Crew row. Hidden until there's a graph
 *  with work in it. Amber dot when something is actively being worked;
 *  otherwise the count rests muted (green-status tint once everything's done). */
function CrewProgressBadge({ crew }: { crew: CrewProgress | null }) {
  if (!crew || crew.total === 0) return null;
  const allDone = crew.done >= crew.total;
  const color = allDone
    ? "var(--color-success, #22c55e)"
    : "var(--color-text-3)";
  return (
    <span
      className="ade-bnav-crew-badge"
      title={`${crew.done} of ${crew.total} done${
        crew.working > 0 ? ` · ${crew.working} working` : ""
      }`}
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        marginLeft: "4px",
        fontSize: "10px",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.02em",
        color,
      }}
    >
      {crew.working > 0 && (
        <span
          aria-hidden="true"
          style={{
            flex: "none",
            width: "5px",
            height: "5px",
            borderRadius: "999px",
            background: "var(--color-warning, #f59e0b)",
          }}
        />
      )}
      {crew.done}/{crew.total}
    </span>
  );
}

function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function LayersGlyph() {
  return (
    <svg
      className="ade-bnav-glyph"
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

function MissionGlyph() {
  // A gauge / mission-control mark — one dial watching everything at once.
  return (
    <svg
      className="ade-bnav-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 21a9 9 0 1 0-9-9" />
      <path d="M3 12h2M12 3v2M19 5l-1.5 1.5" />
      <path d="m12 12 4-2.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

