// The right-hand side-list of the terminal panel — VS Code's terminal
// tabs column. One row per group: a solo terminal is a single row; a
// split group folds its panes under tree-connector glyphs (┌ ├ └). The
// active terminal carries the arctic-blue accent (green is reserved for
// the live status dot). Rows can be carried — dropping a terminal onto
// another group tiles it into that group's split (VS Code parity, "use
// an existing terminal as part of the split"). Rows carry hover actions
// (split / kill) and double-click-to-rename via the shared
// tab-customization store, so a rename survives reopen and is keyed to
// the project. Deliberately dense: this is a daily-driver surface.

import { useState } from "react";
import { Plus, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import type {
  TerminalGroup,
  TerminalTab,
  WorkSplitDirection,
} from "../../lib/editorStore";
import {
  useTabCustomizationMap,
  setTabCustomization,
  tabIdFor,
} from "../../lib/useTabCustomization";
import { panelGroupViews } from "./grouping";
import { SplitIcon, TerminalGlyph } from "./icons";
import { TerminalNewMenu } from "./TerminalNewMenu";
import { RunRow } from "./RunRow";
import { EmptyState } from "../ui/state";
import type { TerminalProfile } from "../../lib/api";
import { usePointerDrag, type PointerDrag } from "../ui/use-pointer-drag";
import { TAB_DRAG_SCOPE, tabDropAction, tabDropKey, type TabDrag } from "../../lib/workTabDrag";

type Props = {
  repoRoot: string;
  terminals: TerminalTab[];
  groups: TerminalGroup[];
  activeTermId: string | null;
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  onSelect: (termId: string) => void;
  onSplit: (termId: string, direction: WorkSplitDirection) => void;
  onMerge: (termId: string, targetGroupId: string, direction?: WorkSplitDirection) => void;
  /** Drop a terminal onto empty list space → re-home it as its own group.
   *  Used to drag a terminal that's living as an editor tab back into the
   *  panel (the inverse of "open in editor"). */
  onDemote: (termId: string) => void;
  onKill: (termId: string) => void;
  onNewTerminal: (profileId?: string) => void;
  onNewWindow?: () => void;
  /** Open a terminal in a folder the user picks. */
  onNewTerminalInFolder?: (profileId?: string, folder?: string) => void;
  /** Folders already opened that way, newest first. */
  recentFolders?: string[];
  onSelectDefaultProfile: (profileId: string) => void;
  onConfigureSettings: () => void;
  /** Run — the reserved row above the terminals you opened yourself. It is a
   *  terminal like any other underneath, so `runTermId` is just the one the
   *  project's Run is currently living in (null when it isn't running). */
  runTermId: string | null;
  onRun: () => void;
  onFocusRun: () => void;
  onStopRun: () => void;
};

/** Box-drawing connector for a pane at `index` within a split of `count`
 *  panes — top `┌`, middle `├`, bottom `└`. Solo groups get none. */
function connectorFor(index: number, count: number): string | null {
  if (count <= 1) return null;
  if (index === 0) return "┌";
  if (index === count - 1) return "└";
  return "├";
}

export function TerminalTabsList({
  repoRoot,
  terminals,
  groups,
  activeTermId,
  profiles,
  defaultProfileId,
  onSelect,
  onSplit,
  onMerge,
  onDemote,
  onKill,
  onNewTerminal,
  onNewWindow,
  onNewTerminalInFolder,
  recentFolders,
  onSelectDefaultProfile,
  onConfigureSettings,
  runTermId,
  onRun,
  onFocusRun,
  onStopRun,
}: Props) {
  const customMap = useTabCustomizationMap(repoRoot);
  // Run has its own pinned row, so its terminal must not also show up as an
  // ordinary one — the same thing listed twice reads as two things. Only a
  // solo Run is folded away: split it and the group is no longer just Run,
  // so it goes back to being a group like any other.
  const views = panelGroupViews(groups, terminals).filter(
    (v) => !(v.panes.length === 1 && v.panes[0].termId === runTermId),
  );
  // Terminals are carried with a pointer drag shared with the editor area's
  // tabs (lib/workTabDrag.ts), so an editor terminal tab lands here too. A
  // group lights up while a terminal is over it; the list's empty space
  // lights up when the terminal would become a group of its own.
  const carry = usePointerDrag<TabDrag>(
    (item, key) => {
      const action = tabDropAction(item, key);
      if (action?.kind === "merge") onMerge(action.termId, action.groupId, "row");
      else if (action?.kind === "demote") onDemote(action.termId);
    },
    { scope: TAB_DRAG_SCOPE },
  );
  const landing = tabDropAction(carry.dragged, carry.over);
  const dropGroupId = landing?.kind === "merge" ? landing.groupId : null;
  const dropToNew = landing?.kind === "demote";

  function nameFor(tab: TerminalTab, fallbackIndex: number): string {
    const custom = customMap[tabIdFor("term", tab.termId)]?.name;
    return custom || tab.label || `Terminal ${fallbackIndex + 1}`;
  }

  return (
    <div className="h-full w-[168px] flex-shrink-0 flex flex-col border-l border-line-soft bg-bg-chrome">
      <div className="h-6 px-2 flex items-center justify-between border-b border-line-soft">
        <span className="section-label">
          Terminals
        </span>
        <TerminalNewMenu
          trigger={
            <button
              type="button"
              title="New Terminal"
              className="h-4 w-4 grid place-items-center rounded text-text-4 transition-colors hover:text-text-2 hover:bg-state-hover"
            >
              <Plus className="h-3 w-3" />
            </button>
          }
          profiles={profiles}
          defaultProfileId={defaultProfileId}
          onNewTerminal={onNewTerminal}
          onSplit={() => {
            if (activeTermId) onSplit(activeTermId, "row");
          }}
          onNewWindow={onNewWindow}
          onNewTerminalInFolder={onNewTerminalInFolder}
          recentFolders={recentFolders}
          onSelectDefaultProfile={onSelectDefaultProfile}
          onConfigureSettings={onConfigureSettings}
          align="end"
        />
      </div>
      <RunRow
        repoRoot={repoRoot}
        // AURA-1294 — Run's pty, so the row can notice a localhost URL it prints
        runPtyId={terminals.find((t) => t.termId === runTermId)?.daemonSessionId ?? null}
        active={runTermId !== null && runTermId === activeTermId}
        open={runTermId !== null}
        onRun={onRun}
        onFocus={onFocusRun}
        onStop={onStopRun}
      />
      <div
        className={[
          "flex-1 min-h-0 overflow-y-auto py-0.5",
          dropToNew ? "ring-1 ring-inset ring-accent/50 bg-accent/10" : "",
        ].join(" ")}
        // Empty-space drop target: a terminal dropped here (not on a group
        // row — the nearest marked place wins) becomes its own new group.
        // This is how an editor terminal tab is dragged back into the panel.
        {...carry.target(tabDropKey.panel)}
      >
        {views.map((view) => (
          <div
            key={view.groupId}
            className={[
              "mb-px rounded-sm transition-colors",
              dropGroupId === view.groupId
                ? "ring-1 ring-inset ring-accent/50 bg-accent/10"
                : "",
            ].join(" ")}
            {...carry.target(tabDropKey.group(view.groupId))}
          >
            {view.panes.map((tab, pi) => {
              const idx = terminals.findIndex((t) => t.termId === tab.termId);
              return (
                <TermRow
                  key={tab.termId}
                  repoRoot={repoRoot}
                  tab={tab}
                  name={nameFor(tab, idx)}
                  active={tab.termId === activeTermId}
                  connector={connectorFor(pi, view.panes.length)}
                  carry={carry}
                  onSelect={() => onSelect(tab.termId)}
                  onSplit={() => onSplit(tab.termId, "row")}
                  onKill={() => onKill(tab.termId)}
                />
              );
            })}
          </div>
        ))}
        {views.length === 0 && runTermId === null && (
          <EmptyState
            icon={TerminalIcon}
            title="No terminals open"
            body="A terminal is a direct line to your machine. The same one your agents use. Open one to run something yourself."
            action={{
              label: "New terminal",
              onClick: () => onNewTerminal(),
              icon: Plus,
            }}
            size="sm"
          />
        )}
      </div>
    </div>
  );
}

function TermRow({
  repoRoot,
  tab,
  name,
  active,
  connector,
  carry,
  onSelect,
  onSplit,
  onKill,
}: {
  repoRoot: string;
  tab: TerminalTab;
  name: string;
  active: boolean;
  connector: string | null;
  /** The list's drag, so this row can be picked up. */
  carry: PointerDrag<TabDrag>;
  onSelect: () => void;
  onSplit: () => void;
  onKill: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    setTabCustomization(repoRoot, tabIdFor("term", tab.termId), {
      name: trimmed,
    });
  }

  return (
    <div
      role="button"
      tabIndex={0}
      {...(editing ? {} : carry.source({ termId: tab.termId }))}
      // Select on press (left button), as the editor area's tabs do: the same
      // press may go on to carry the row, and the row carried is then the one
      // showing. (It once had to be: while rows were HTML5-draggable the web
      // view dropped their `click`.) The onDoubleClick rename still fires as
      // its own event.
      onMouseDown={(e) => {
        if (e.button === 0) onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(name);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        "group relative flex items-center gap-1.5 h-[22px] min-w-0 pl-2 pr-1 cursor-pointer select-none transition-colors",
        active
          ? "bg-accent/10 text-text-1 hover:bg-accent/15"
          : "text-text-3 hover:bg-state-hover hover:text-text-2",
      ].join(" ")}
    >
      {active && (
        <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />
      )}
      {connector && (
        <span className="font-mono text-xs leading-none text-text-5 flex-shrink-0 select-none">
          {connector}
        </span>
      )}
      <TerminalGlyph className="h-3 w-3 flex-shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1 bg-bg-content border border-accent rounded px-1 text-xs text-text-1 outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
      )}
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          title="Split Terminal"
          onClick={(e) => {
            e.stopPropagation();
            onSplit();
          }}
          className="h-4 w-4 grid place-items-center rounded text-text-4 transition-colors hover:text-text-2 hover:bg-state-hover"
        >
          <SplitIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="Close Terminal"
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="h-4 w-4 grid place-items-center rounded text-text-4 transition-colors hover:text-red hover:bg-state-hover"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
