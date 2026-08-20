// Workspaces — the full-screen "cool view" for the whole fleet of parallel
// copies, so the Build sidebar stays a curated few. Three ways to look at the
// same fleet: a time-grouped list ("All"), a status board ("Board"), and the
// control plane ("Live"). Opened from the roster's "…other parallel copies"
// disclosure and from the Workspaces nav.
//
// "All" and "Board" are read-only over data App already has (worktrees +
// diff/PR badges + live agent tabs). "Live" is the one that costs a backend
// call, because it answers what none of that data can: which agent is standing
// in each copy right now, whether two copies have taken hold of the same
// function, and what messages are waiting unread between them. It is scoped to
// the active project, since that record is kept per repository.
//
// Every control on this page is a shared primitive, on purpose: the lens strip
// is `ViewTabs`, the strip every surface header wears, the action is `Button`,
// and the scope picker is the app's `DropdownMenu`. This surface is new; the
// language it speaks is not.

import { useEffect, useMemo, useState } from "react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { PageFrame } from "../ui/PageFrame";
import { FleetLensTabs, type Lens } from "./FleetLensTabs";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ChevronDown, Search } from "../Icons";
import { useEditorStore } from "../../lib/editorStore";
import { agentsOnCopy } from "../../lib/agentsOnCopy";
import { useLivePtySessionIds } from "../../lib/useLiveAgentSessions";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import { useWorkspaceCustomization } from "../../lib/workspaceCustomization";
import { useCloudJobs } from "../../lib/useCloudJobs";
import {
  buildCopies,
  type CopyAgent,
  type ProjectMeta,
} from "./workspacesModel";
import { FLEET_COLUMN } from "./WorkspacesBits";
import { WorkspacesAllTab } from "./WorkspacesAllTab";
import { WorkspacesBoardTab } from "./WorkspacesBoardTab";
import { QuietToggle, WorkspacesPane } from "../workpanes/workspaces/WorkspacesPane";

/** The sentinel the scope menu uses for "don't filter" — a radio group needs a
 *  real string, and `projectFilter` wants null. */
const ALL_PROJECTS = "__all__";

export type WorkspacesSurfaceProps = {
  onClose: () => void;
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  activePath: string;
  /** When opened from a single project's disclosure, scope the view to it
   *  (a removable chip); null = every open project. */
  initialProjectId?: string | null;
  /** Jump into a copy (checkout path). Closes the surface. */
  onOpen: (path: string) => void;
  /** Open the folder picker to add a workspace. */
  onAddWorkspace?: () => void;
  /** Render as a PAGE in the content area (no backdrop, no floating panel, no
   *  esc chip) rather than as a modal above the shell. The fleet is somewhere
   *  you go and stay, so this is how the app mounts it; the modal form is kept
   *  for popped-out windows and anywhere the surface has to sit above a repo. */
  asPage?: boolean;
};

export function WorkspacesSurface({
  onClose,
  projects,
  worktreesByRoot,
  badgeByPath,
  activePath,
  initialProjectId = null,
  onOpen,
  onAddWorkspace,
  asPage = false,
}: WorkspacesSurfaceProps) {
  const editor = useEditorStore();
  const [lens, setLens] = useState<Lens>("all");
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(
    initialProjectId,
  );

  // Keep relative stamps fresh without thrashing — one tick a minute.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Which PTY sessions are actually still running, across every project.
  // This is what lets a backgrounded workspace claim an agent — and what
  // stops a workspace you left in June from claiming one. See `agentsOnCopy`.
  const livePtyIds = useLivePtySessionIds(true);

  // Every agent parked on any worktree path — the same rule the sidebar
  // roster lane uses, so the two can't disagree about who's working where.
  const agentsByPath = useMemo(() => {
    const paths = new Set<string>();
    for (const p of projects) {
      const wts = worktreesByRoot[p.id] ?? [];
      if (wts.length) wts.forEach((w) => paths.add(w.path));
      else paths.add(p.id);
    }
    const map = new Map<string, CopyAgent[]>();
    for (const path of paths) {
      const merged: CopyAgent[] = agentsOnCopy(
        path,
        editor.agentTabs,
        livePtyIds,
      ).map((a) => ({
        agentId: a.agentId,
        label: a.agentLabel,
        attention: a.attention,
      }));
      if (merged.length) map.set(path, merged);
    }
    return map;
  }, [projects, worktreesByRoot, editor.agentTabs, livePtyIds]);

  // Renaming a workspace has to repaint this list. `buildCopies` is pure and
  // resolves each title through the customisation store, so the store has to
  // be a dependency of the memo — subscribing is what makes a rename land here
  // the moment it's typed rather than on the next git poll.
  const naming = useWorkspaceCustomization();
  const allCopies = useMemo(
    () =>
      buildCopies({
        projects,
        worktreesByRoot,
        badgeByPath,
        agentsByPath,
        activePath,
      }),
    [projects, worktreesByRoot, badgeByPath, agentsByPath, activePath, naming],
  );

  const copies = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allCopies.filter((c) => {
      if (projectFilter && c.root !== projectFilter) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.branch.toLowerCase().includes(q) ||
        c.projectName.toLowerCase().includes(q)
      );
    });
  }, [allCopies, query, projectFilter]);

  // Which project the Live lens is standing in. It reads a record kept per
  // repository, so it can only ever show one — and the strip above it was
  // announcing "108 · In all projects" over twenty rows from a single repo.
  const liveProject = useMemo(() => {
    for (const p of projects) {
      if (p.id === activePath) return p;
      if ((worktreesByRoot[p.id] ?? []).some((w) => w.path === activePath))
        return p;
    }
    return null;
  }, [projects, worktreesByRoot, activePath]);

  // Work sent to a machine that isn't this one. Without this the fleet page can
  // only ever show work that has a copy on this disk, which is every kind of
  // work except the cloud kind.
  //
  // It follows the same scope as the list it sits above: one project when the
  // chip narrows it, and otherwise the whole account — not a fan-out over the
  // open roster. A cloud job belongs to whoever sent it, not to whichever
  // projects happen to be open today, so asking per open project would drop the
  // work you sent from a project you have since closed. Reading only the project
  // you are standing in, which is what the Live lens does because a live record
  // is kept per repo, would be narrower still and sit under an "In all projects"
  // label showing one repo's work.
  const cloudRoots = useMemo(
    () => (projectFilter ? [projectFilter] : null),
    [projectFilter],
  );
  const { jobs: cloudJobs } = useCloudJobs(cloudRoots);

  // Live's quiet filter lives up here so its control can sit in the header row
  // beside the scope, instead of in a band of its own beneath it. The pane
  // below owns the definition of "quiet" and reports how many it is hiding.
  const [showQuiet, setShowQuiet] = useState(false);
  const [quietCount, setQuietCount] = useState(0);

  const open = (path: string) => {
    onOpen(path);
    onClose();
  };

  // Page or modal — identical header/body, different frame. Both take the same
  // onClose/tabs/actions props, so the surface below doesn't branch.
  const Frame = asPage ? PageFrame : FullscreenOverlay;

  return (
    <Frame
      onClose={onClose}
      // Header = the lens on the left, the one primary action on the right,
      // and nothing else. Conductor's Home puts its name where the lens sits;
      // here the lens IS the name — the surface never prints a title (the nav
      // row you clicked is still lit), so "All" reading as the heading and its
      // siblings reading as quiet alternatives says the same thing with one
      // fewer word on screen.
      //
      // `FleetLensTabs` is `ViewTabs` — the same control Trace and Tasks put
      // here. This used to hand-roll `.ade-seg--row`, the right rail's
      // segmented track, which is
      // the wrong half of the split: a track is for a toggle sitting INSIDE a
      // page, where it has to look like a control on any ground. A lens switch
      // in a surface header is answering "which page", and the header's own
      // bottom hairline is the line it belongs on — so a track here drew a box
      // inside a bar, one hairline nested a few pixels inside another. Going
      // through the shared strip also means this bar can't drift to a
      // different height than Trace's, which is exactly what happened last
      // time the same control was written out twice.
      tabs={<FleetLensTabs lens={lens} onLens={setLens} />}
      actions={
        onAddWorkspace ? (
          <Button
            variant="accentSoft"
            onClick={() => {
              onAddWorkspace();
              onClose();
            }}
            title="Open a project folder (⌘O)"
          >
            New workspace
          </Button>
        ) : undefined
      }
    >
      {/* Filter strip — one borderless row under the header. The search has no
          box of its own: the strip it sits in is the control, and a bordered
          field inside a bordered header is a frame around a frame. Scope and
          count sit quiet at the right; a single hairline closes it off. It
          lives in the body rather than the header because all three lenses
          read the same filtered fleet.

          The hairline runs the full width and so do the controls: the search
          caret starts where the first row's branch mark does, and where the
          board's first lane does. */}
      <div className="flex-shrink-0 border-b border-line-soft px-2">
        <div className={`flex h-10 items-center gap-2.5 px-2 ${FLEET_COLUMN}`}>
          <Search size={13} className="flex-none text-text-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-base text-text-1 placeholder:text-text-5 outline-none"
          />
          {/* The count and the scope belong to the two lenses that read the
              whole fleet. Live reads one repository — leaving them up said
              "108" and "In all projects" over one project's twenty rows, which
              is not a smaller truth but a different one. */}
          {lens === "live" ? (
            <>
              {/* Live's one filter, drawn here rather than in the pane below.
                  It used to sit in a band of its own directly under this row,
                  beside a caption explaining what "behind" was measured
                  against — two stacked bars before the first copy, for one
                  toggle. The rows name their own reference point now, so the
                  caption went and the button came up here, next to the scope
                  the other two lenses put in the same place. */}
              {quietCount > 0 && (
                <QuietToggle
                  showing={showQuiet}
                  hidden={quietCount}
                  onToggle={() => setShowQuiet((v) => !v)}
                />
              )}
              <span
                className="flex-none text-sm text-text-4"
                title="Live reads the record of who is standing where, which Aura keeps per repository, so it shows one project at a time."
              >
                {liveProject ? `In ${liveProject.name}` : "In this project"}
              </span>
            </>
          ) : (
            <>
              <span className="flex-none text-xs tabular-nums text-text-4">
                {copies.length}
              </span>
              <ScopeMenu
                projects={projects}
                value={projectFilter}
                onChange={setProjectFilter}
              />
            </>
          )}
        </div>
      </div>
      {lens === "all" && (
        <WorkspacesAllTab
          copies={copies}
          cloudJobs={cloudJobs}
          nowMs={nowMs}
          activePath={activePath}
          onOpen={open}
        />
      )}
      {lens === "board" && (
        <WorkspacesBoardTab copies={copies} nowMs={nowMs} onOpen={open} />
      )}
      {/* Scoped to the active project: the shared record that knows who is
          standing where, and which functions two copies are both holding, is
          kept per repository — there is no cross-project version of it to
          show, and inventing one would be a lie. */}
      {lens === "live" && (
        // Live is a list of who is standing where, so it reads in the same
        // column as All. The wrapper carries the flex sizing the pane needs to
        // fill the page; the column only narrows it.
        <div className={`flex min-h-0 flex-1 flex-col ${FLEET_COLUMN}`}>
          <WorkspacesPane
            repoRoot={activePath}
            query={query}
            embedded
            showQuiet={showQuiet}
            onQuietToggle={() => setShowQuiet((v) => !v)}
            onQuietCount={setQuietCount}
            onOpenWorktree={open}
          />
        </div>
      )}
    </Frame>
  );
}

// "In all projects ▾" — the scope control. It replaces the removable chip the
// header used to grow when the surface was opened from one project's
// disclosure: same state, but you can now also *change* the scope from here
// rather than only clear it. A radio group, because the scope is exactly one
// of these — and the app's DropdownMenu already owns the focus trap, the
// keyboard walk and the Escape that must not reach the page behind it.
function ScopeMenu({
  projects,
  value,
  onChange,
}: {
  projects: ProjectMeta[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const current = value ? projects.find((p) => p.id === value) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 flex-none items-center gap-1 rounded-md px-1.5 text-sm text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
        >
          <span className="max-w-[160px] truncate">
            {current ? `In ${current.name}` : "In all projects"}
          </span>
          <ChevronDown size={11} className="flex-none" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value ?? ALL_PROJECTS}
          onValueChange={(v) => onChange(v === ALL_PROJECTS ? null : v)}
        >
          <DropdownMenuRadioItem value={ALL_PROJECTS}>
            <span className="min-w-0 truncate">All projects</span>
          </DropdownMenuRadioItem>
          {projects.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              <span className="min-w-0 truncate">{p.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
