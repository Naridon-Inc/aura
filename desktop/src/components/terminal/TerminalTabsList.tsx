// The right-hand side-list of the terminal panel — VS Code's terminal
// tabs column. One row per group: a solo terminal is a single row; a
// split group folds its panes under tree-connector glyphs (┌ ├ └). The
// active terminal carries the arctic-blue accent (green is reserved for
// the live status dot). Rows are draggable — dropping a terminal onto
// another group tiles it into that group's split (VS Code parity, "use
// an existing terminal as part of the split"). Rows carry hover actions
// (split / kill) and double-click-to-rename via the shared
// tab-customization store, so a rename survives reopen and is keyed to
// the project. Deliberately dense: this is a daily-driver surface.

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
import type { TerminalProfile } from "../../lib/api";

const DRAG_MIME = "application/x-aura-term";

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
  onSelectDefaultProfile: (profileId: string) => void;
  onConfigureSettings: () => void;
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
  onSelectDefaultProfile,
  onConfigureSettings,
}: Props) {
  const customMap = useTabCustomizationMap(repoRoot);
  const views = panelGroupViews(groups, terminals);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [dropToNew, setDropToNew] = useState(false);

  function nameFor(tab: TerminalTab, fallbackIndex: number): string {
    const custom = customMap[tabIdFor("term", tab.termId)]?.name;
    return custom || tab.label || `Terminal ${fallbackIndex + 1}`;
  }

  return (
    <div className="h-full w-[168px] flex-shrink-0 flex flex-col border-l border-line-soft bg-bg-chrome">
      <div className="h-6 px-2 flex items-center justify-between border-b border-line-soft">
        <span className="text-text-5 text-[10px] font-medium uppercase tracking-wide">
          Terminals
        </span>
        <TerminalNewMenu
          trigger={
            <button
              type="button"
              title="New Terminal"
              className="h-4 w-4 grid place-items-center rounded text-text-4 hover:text-text-2 hover:bg-bg-hover"
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
          onSelectDefaultProfile={onSelectDefaultProfile}
          onConfigureSettings={onConfigureSettings}
          align="end"
        />
      </div>
      <div
        className={[
          "flex-1 min-h-0 overflow-y-auto py-0.5",
          dropToNew ? "ring-1 ring-inset ring-[var(--color-accent)]/60 bg-[var(--color-accent)]/5" : "",
        ].join(" ")}
        // Empty-space drop target: a terminal dropped here (not on a group
        // row — those stopPropagation) becomes its own new group. This is
        // how an editor terminal tab is dragged back into the panel.
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!dropToNew) setDropToNew(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropToNew(false);
          }
        }}
        onDrop={(e) => {
          setDropToNew(false);
          const termId = e.dataTransfer.getData(DRAG_MIME);
          if (termId) {
            e.preventDefault();
            onDemote(termId);
          }
        }}
      >
        {views.map((view) => (
          <div
            key={view.groupId}
            className={[
              "mb-px rounded-sm transition-colors",
              dropGroupId === view.groupId
                ? "ring-1 ring-inset ring-[var(--color-accent)] bg-[var(--color-accent)]/8"
                : "",
            ].join(" ")}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropGroupId !== view.groupId) setDropGroupId(view.groupId);
              }
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the wrapper, not crossing children.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDropGroupId((id) => (id === view.groupId ? null : id));
              }
            }}
            onDrop={(e) => {
              const termId = e.dataTransfer.getData(DRAG_MIME);
              setDropGroupId(null);
              if (termId) {
                e.preventDefault();
                e.stopPropagation(); // don't also hit the new-group drop below
                onMerge(termId, view.groupId, "row");
              }
            }}
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
                  onSelect={() => onSelect(tab.termId)}
                  onSplit={() => onSplit(tab.termId, "row")}
                  onKill={() => onKill(tab.termId)}
                />
              );
            })}
          </div>
        ))}
        {views.length === 0 && (
          <div className="px-3 py-2 text-text-5 text-[11px]">No terminals.</div>
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
  onSelect,
  onSplit,
  onKill,
}: {
  repoRoot: string;
  tab: TerminalTab;
  name: string;
  active: boolean;
  connector: string | null;
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
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, tab.termId);
        e.dataTransfer.effectAllowed = "move";
      }}
      // macOS WKWebView drops the synthetic `click` on `draggable=true`
      // elements, so selecting a terminal row was unreliable while it was
      // draggable (i.e. not being renamed). Select on mousedown (left button);
      // the onDoubleClick rename still fires as its own event.
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
        "group relative flex items-center gap-1.5 h-[22px] pl-2 pr-1 cursor-pointer select-none",
        active
          ? "bg-[var(--color-accent)]/12 text-text-1"
          : "text-text-3 hover:bg-bg-hover hover:text-text-2",
      ].join(" ")}
    >
      {active && (
        <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--color-accent)]" />
      )}
      {connector && (
        <span className="font-mono text-[11px] leading-none text-text-5 flex-shrink-0 select-none">
          {connector}
        </span>
      )}
      <TerminalGlyph className="h-3 w-3 flex-shrink-0 opacity-70" />
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
          className="min-w-0 flex-1 bg-bg-content border border-[var(--color-accent)] rounded px-1 text-[11px] text-text-1 outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
      )}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          title="Split terminal"
          onClick={(e) => {
            e.stopPropagation();
            onSplit();
          }}
          className="h-4 w-4 grid place-items-center rounded text-text-4 hover:text-text-2 hover:bg-bg-hover"
        >
          <SplitIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="Kill terminal"
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="h-4 w-4 grid place-items-center rounded text-text-4 hover:text-red-400 hover:bg-bg-hover"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
