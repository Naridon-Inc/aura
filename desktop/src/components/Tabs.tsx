// Editor tab strip — same visual recipe as aura-term/proto/superset_tabs.rs:
// height matches the TopBar (44px → 11 row units), active tab gets a 1px
// near-white underline at the bottom edge, dirty tabs gain a small dot in
// place of their close × until you hover (then × is back so you can close
// without saving).
//
// Tabs are rendered as buttons with onMouseDown→activate so the click
// feels instant; close is a separate button with stopPropagation so it
// doesn't trigger the parent activation.
//
// Two tab kinds in the strip:
//   - File tabs: dirty-aware close button, close calls onCloseFile.
//   - Agent tabs: monogram badge instead of plain text, close calls
//     onCloseAgent (which the host wires to agent_pty_close + store
//     cleanup; we don't tear down the PTY here).

import { useRef, useState } from "react";
import type {
  OpenFile,
  AgentTab,
  TerminalTab,
  ManagerTab,
  PrTab,
  TraceToolKind,
  WorkSplitDirection,
} from "../lib/editorStore";
import type { ZoneRule } from "../lib/api";
import { matchesAnyGlob } from "../lib/glob";
import {
  setTabCustomization,
  tabIdFor,
  useTabCustomizationMap,
} from "../lib/useTabCustomization";
import { useAgents, type Agent } from "../lib/agents";
import {
  presenceForFile,
  useRadarPresence,
  type FilePresence,
} from "../lib/radarPresenceStore";
import { agoFromTs, kindLabel } from "./rightrail/radar/radarFormat";
import { useManagerSession } from "../lib/managerStore";
import { useAgentEvent } from "../lib/agentEventStore";
import { AgentIcon } from "./agent/AgentIcon";
import { buildAgentTabMenuItems } from "./agent/AgentSurface";
import { buildManagerTabMenuItems } from "./manager/ManagerSurface";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";

// ── Shared tab context menu ──────────────────────────────────────────
//
// Every tab kind (file / agent / terminal / manager / PR) gets the SAME
// right-click menu: Split right / Split down, Rename, Close, plus any
// kind-specific items (agents/managers prepend their pane-action items
// from the live surface bridge). One declarative item list, one renderer.

type TabMenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      tone?: "danger";
    };

function TabMenuList({ items }: { items: TabMenuItem[] }) {
  return (
    <ContextMenuContent className="min-w-[12rem]">
      {items.map((item, i) =>
        item.kind === "separator" ? (
          <ContextMenuSeparator key={`sep-${i}`} />
        ) : (
          <ContextMenuItem
            key={item.label}
            disabled={item.disabled}
            variant={item.tone === "danger" ? "destructive" : "default"}
            onSelect={item.onSelect}
          >
            {item.label}
          </ContextMenuItem>
        ),
      )}
    </ContextMenuContent>
  );
}

/** Build the shared menu for tabs that have no surface-specific items
 *  of their own (file / terminal / PR). Each split / rename action is
 *  optional — only the ones the caller wires up show. Close is always
 *  present and always last. */
function buildCommonTabMenu(opts: {
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onAddToSplit?: () => void;
  onRename?: () => void;
  onClose: () => void;
  closeLabel?: string;
}): TabMenuItem[] {
  const items: TabMenuItem[] = [];
  if (opts.onSplitRight)
    items.push({ kind: "item", label: "Split right", onSelect: opts.onSplitRight });
  if (opts.onSplitDown)
    items.push({ kind: "item", label: "Split down", onSelect: opts.onSplitDown });
  if (opts.onAddToSplit)
    items.push({
      kind: "item",
      label: "Add to current split",
      onSelect: opts.onAddToSplit,
    });
  if (opts.onRename) {
    if (items.length) items.push({ kind: "separator" });
    items.push({ kind: "item", label: "Rename tab…", onSelect: opts.onRename });
  }
  if (items.length) items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: opts.closeLabel ?? "Close",
    onSelect: opts.onClose,
    tone: "danger",
  });
  return items;
}

/** Controls for the inline rename of a single tab. `active` toggles the
 *  in-place input; `start` opens it; `commit`/`cancel` close it. The
 *  strip owns the "which tab is renaming" state so only one is editable
 *  at a time. */
type RenameControls = {
  active: boolean;
  start: () => void;
  commit: (name: string) => void;
  cancel: () => void;
};

/** In-place tab rename field. Commits on Enter or blur, cancels on
 *  Escape. A `done` latch keeps the Escape-triggered blur from also
 *  committing (Escape fires keydown → blur in the same tick). */
function TabRenameInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  const finish = (commit: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      defaultValue={defaultValue}
      onFocus={(e) => e.currentTarget.select()}
      // The row's onMouseDown activates / drag-starts the tab; keep those
      // from stealing focus or text-selection while editing.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, "");
        }
      }}
      onBlur={(e) => finish(true, e.currentTarget.value)}
      className="min-w-0 flex-1 bg-bg-1 border border-line-soft rounded px-1 py-0 text-[12px] text-text-1 outline-none"
      style={{ maxWidth: 140 }}
    />
  );
}

type TabsProps = {
  files: OpenFile[];
  agentTabs: AgentTab[];
  terminalTabs: TerminalTab[];
  managerTabs: ManagerTab[];
  /** Stage 8N — PR tabs in the unified strip. */
  prTabs?: PrTab[];
  activePrTabId?: string | null;
  onActivatePr?: (tabId: string) => void;
  onClosePr?: (tabId: string) => void;
  /** Review Changes is a singleton — at most one tab. `inspectorOpen`
   *  controls whether the strip renders the entry; `inspectorActive`
   *  paints the active underline. */
  inspectorOpen?: boolean;
  inspectorActive?: boolean;
  /** Same shape as Review Changes for the Audit Trail pane. */
  replayOpen?: boolean;
  replayActive?: boolean;
  /** Singleton Plan Work wizard — same pattern. */
  planBuilderOpen?: boolean;
  planBuilderActive?: boolean;
  /** Singleton Verify Requirement pane. */
  proveOpen?: boolean;
  proveActive?: boolean;
  /** Singleton Code Map pane — project graph / graphify port. */
  graphOpen?: boolean;
  graphActive?: boolean;
  /** Singleton "PR View" — Inbox landing for PRs. Same pill pattern. */
  inboxOpen?: boolean;
  inboxActive?: boolean;
  /** Singleton Trace verify tool page (Review / Rewind / Attestations /
   *  Doctor). One pill at a time; the kind decides its label + glyph. */
  traceToolOpen?: boolean;
  traceToolKind?: TraceToolKind | null;
  /** Always-rendered first tab — the Aura dashboard. Permanent fixture
   *  with no close button. `dashboardActive` paints the underline when
   *  the dashboard surface is the one being shown in the work pane. */
  dashboardActive?: boolean;
  onActivateDashboard?: () => void;
  activePath: string | null;
  activeAgentId: string | null;
  activeTermId: string | null;
  activeManagerId: string | null;
  isDirty: (path: string) => boolean;
  onActivateFile: (path: string) => void;
  onActivateAgent: (sessionId: string) => void;
  onActivateTerminal: (termId: string) => void;
  onActivateManager: (sessionId: string) => void;
  onActivateInspector?: () => void;
  onActivateReplay?: () => void;
  onActivatePlanBuilder?: () => void;
  onActivateProve?: () => void;
  onActivateGraph?: () => void;
  onActivateInbox?: () => void;
  onActivateTraceTool?: () => void;
  onCloseFile: (path: string) => void;
  onCloseAgent: (sessionId: string) => void;
  onCloseTerminal: (termId: string) => void;
  onCloseManager: (sessionId: string) => void;
  onCloseInspector?: () => void;
  onCloseReplay?: () => void;
  onClosePlanBuilder?: () => void;
  onCloseProve?: () => void;
  onCloseGraph?: () => void;
  onCloseInbox?: () => void;
  onCloseTraceTool?: () => void;
  /** Split a tab into a new pane beside ("row") or below ("column") the
   *  active surface. Wired in WorkSurface to `store.splitWithEmpty`. File
   *  and terminal tabs drive their own split from here; agent and manager
   *  tabs keep firing splits through their surface-action bridge. */
  onSplitTab?: (
    ref:
      | { kind: "agent"; id: string }
      | { kind: "terminal"; id: string }
      | { kind: "manager"; id: string }
      | { kind: "file"; path: string },
    direction: WorkSplitDirection,
  ) => void;
  /** "+ Terminal" affordance at the right edge of the tab strip. */
  onNewTerminal?: () => void;
  /** Spawn an agent PTY tab. When set, the `+` button becomes a popover
   *  with "Terminal" + the discovered agent list, and an optional
   *  preset bar above the strip surfaces one-click agent launchers. */
  onLaunchAgent?: (agentId: string, label: string) => void;
  /** Repo root + zone list let each FileTab evaluate ownership of its
   *  file path against active zone rules. When the matching zone is
   *  owned by another agent's session, the tab shows an "owned: …"
   *  pill so the user can't blindly clobber another agent's work. */
  repoRoot?: string;
  zones?: ZoneRule[];
  /** Stage 9C — when a split is active, each non-member tab gets a
   *  small + button on hover that calls this with the tab's pane ref.
   *  Lets the user mix any agents / terminals / files (across
   *  workspaces) into one split layout from the tab strip. */
  splitActive?: boolean;
  onAddToSplit?: (
    ref:
      | { kind: "agent"; id: string }
      | { kind: "terminal"; id: string }
      | { kind: "manager"; id: string }
      | { kind: "file"; path: string },
  ) => void;
  /** Predicate: is this tab already part of the active split? Used to
   *  hide the + button on member tabs and to draw a member pip. */
  isInSplit?: (
    ref:
      | { kind: "agent"; id: string }
      | { kind: "terminal"; id: string }
      | { kind: "manager"; id: string }
      | { kind: "file"; path: string },
  ) => boolean;
  /** Active split member count + clear callback. When set the tab strip
   *  renders a "Split: N" chip on the left edge. */
  splitMemberCount?: number;
  onClearSplit?: () => void;
  /** Stage 9H — drag-reorder per strip. Each callback splices the source
   *  index into the destination index in its respective array. Tabs only
   *  fires the request; the store owns the array mutation. */
  onReorderFile?: (srcIndex: number, dstIndex: number) => void;
  onReorderAgent?: (srcIndex: number, dstIndex: number) => void;
  onReorderTerminal?: (srcIndex: number, dstIndex: number) => void;
  onReorderManager?: (srcIndex: number, dstIndex: number) => void;
};

export function Tabs({
  files,
  agentTabs,
  terminalTabs,
  managerTabs,
  prTabs,
  activePrTabId,
  onActivatePr,
  onClosePr,
  inspectorOpen,
  inspectorActive,
  replayOpen,
  replayActive,
  planBuilderOpen,
  planBuilderActive,
  proveOpen,
  proveActive,
  graphOpen,
  graphActive,
  inboxOpen,
  inboxActive,
  traceToolOpen,
  traceToolKind,
  dashboardActive: _dashboardActive,
  onActivateDashboard: _onActivateDashboard,
  activePath,
  activeAgentId,
  activeTermId,
  activeManagerId,
  isDirty,
  onActivateFile,
  onActivateAgent,
  onActivateTerminal,
  onActivateManager,
  onActivateInspector,
  onActivateReplay,
  onActivatePlanBuilder,
  onActivateProve,
  onActivateGraph,
  onActivateInbox,
  onActivateTraceTool,
  onCloseFile,
  onCloseAgent,
  onCloseTerminal,
  onCloseManager,
  onCloseInspector,
  onCloseReplay,
  onClosePlanBuilder,
  onCloseProve,
  onCloseGraph,
  onCloseInbox,
  onCloseTraceTool,
  onSplitTab,
  onNewTerminal,
  onLaunchAgent,
  repoRoot,
  zones,
  splitActive,
  onAddToSplit,
  isInSplit,
  splitMemberCount,
  onClearSplit,
  onReorderFile,
  onReorderAgent,
  onReorderTerminal,
  onReorderManager,
}: TabsProps) {
  const customMap = useTabCustomizationMap(repoRoot);
  // Inline tab rename — one tab editable at a time. The strip owns "which
  // id is renaming"; each row gets a RenameControls scoped to its id.
  // commit() reuses the same `setTabCustomization(..., { name })` channel
  // the deleted customize dialog used, so the persisted name is identical.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const makeRename = (id: string): RenameControls => ({
    active: renamingId === id,
    start: () => setRenamingId(id),
    commit: (name: string) => {
      if (repoRoot) setTabCustomization(repoRoot, id, { name });
      setRenamingId(null);
    },
    cancel: () => setRenamingId(null),
  });
  // Discovery is module-cached, safe to call here even though Tabs may
  // mount in multiple WorkSurface branches — only one is alive at a time.
  const { agents } = useAgents();
  // AURA-19 — live radar presence: peers (humans on other machines, agents
  // anywhere) currently editing a file show as small colored pips on that
  // file's tab. Shared refcounted poll; self-authored events excluded in
  // the store.
  const radarPresence = useRadarPresence(repoRoot);
  // Preset bar retired in v0.2.13 — the "+" tab button already lists
  // every discovered agent in a dropdown, so the redundant top strip
  // was pure visual noise. localStorage key kept around so older clients
  // don't error reading a missing key.
  return (
    <div className="flex flex-col">
      {/* `no-scrollbar`: tabs overflow horizontally and scroll with the wheel /
          trackpad, but the scrollbar itself is hidden — a visible bar across the
          tab strip breaks the chrome. Same pattern as the Tasks views bar. */}
      <div className="flex items-stretch h-9 bg-bg-chrome border-b border-line-soft overflow-x-auto no-scrollbar">
      {(splitMemberCount ?? 0) >= 2 && onClearSplit && (
        <SplitGroupChip count={splitMemberCount!} onClear={onClearSplit} />
      )}
      {/* Aura dashboard tab retired — empty/no-tab state is owned by
          WorkSurfaceEmpty, and the Manager surface lives in the
          right-rail AuraRailPanel. Keep the DashboardTabRow component
          definition for now (still imported by some callers), but stop
          rendering it from the strip. */}
      {files.map((f, i) => {
        const id = tabIdFor("file", f.path);
        const ref = { kind: "file" as const, path: f.path };
        const canAdd =
          splitActive && onAddToSplit && isInSplit && !isInSplit(ref);
        return (
          <DragSlot
            key={`f:${f.path}`}
            stripKey="file"
            index={i}
            sourceRoot={repoRoot}
            onReorder={onReorderFile}
          >
          <FileTab
            file={f}
            active={f.path === activePath}
            dirty={isDirty(f.path)}
            owner={ownerForFile(f.path, repoRoot, zones)}
            presence={presenceForFile(radarPresence, repoRoot ?? "", f.path)}
            custom={customMap[id]}
            rename={repoRoot ? makeRename(id) : undefined}
            onSplitRight={onSplitTab ? () => onSplitTab(ref, "row") : undefined}
            onSplitDown={onSplitTab ? () => onSplitTab(ref, "column") : undefined}
            onAddToSplit={canAdd ? () => onAddToSplit!(ref) : undefined}
            onActivate={() => onActivateFile(f.path)}
            onClose={() => onCloseFile(f.path)}
          />
          </DragSlot>
        );
      })}
      {agentTabs.map((t, i) => {
        // Workspace-exclusive strip: an agent anchored to another workspace
        // (a sibling worktree or a different project) doesn't belong in this
        // workspace's tab strip — it stays reachable from the left worktree
        // rail and reappears when you switch to its workspace. We keep
        // rendering it only when it's the *active* pane, so the surface never
        // shows agent content with no matching tab. `i` stays the full-array
        // index so drag-reorder (reorderAgentTabs splices state.agentTabs by
        // index) and split membership keep working unchanged.
        const foreign = !!repoRoot && t.repoRoot !== repoRoot;
        if (foreign && t.sessionId !== activeAgentId) return null;
        const id = tabIdFor("agent", t.sessionId);
        const ref = { kind: "agent" as const, id: t.sessionId };
        const member = !!(splitActive && isInSplit && isInSplit(ref));
        const canAdd =
          splitActive && onAddToSplit && isInSplit && !isInSplit(ref);
        return (
          <DragSlot
            key={`a:${t.sessionId}`}
            stripKey="agent"
            index={i}
            sourceRoot={t.repoRoot}
            onReorder={onReorderAgent}
          >
          <AgentTabRow
            tab={t}
            active={t.sessionId === activeAgentId}
            custom={customMap[id]}
            foreign={foreign}
            inSplit={member}
            onAddToSplit={canAdd ? () => onAddToSplit!(ref) : undefined}
            onSplitRight={onSplitTab ? () => onSplitTab(ref, "row") : undefined}
            onSplitDown={onSplitTab ? () => onSplitTab(ref, "column") : undefined}
            onActivate={() => onActivateAgent(t.sessionId)}
            onClose={() => onCloseAgent(t.sessionId)}
            rename={repoRoot ? makeRename(id) : undefined}
          />
          </DragSlot>
        );
      })}
      {terminalTabs.map((t, i) => {
        // Same workspace-exclusive rule as agent tabs: a terminal whose cwd
        // is another workspace is hidden here (reachable from that
        // workspace), but kept visible while it's the active terminal so the
        // surface always has a matching tab. `i` stays the full-array index
        // so reorderTerminalTabs keeps addressing the right slot.
        const foreign = !!repoRoot && t.cwd !== repoRoot;
        if (foreign && t.termId !== activeTermId) return null;
        const id = tabIdFor("term", t.termId);
        const ref = { kind: "terminal" as const, id: t.termId };
        const member = !!(splitActive && isInSplit && isInSplit(ref));
        const canAdd =
          splitActive && onAddToSplit && isInSplit && !isInSplit(ref);
        return (
          <DragSlot
            key={`t:${t.termId}`}
            stripKey="terminal"
            index={i}
            sourceRoot={t.cwd}
            onReorder={onReorderTerminal}
          >
          <TerminalTabRow
            tab={t}
            index={i}
            active={t.termId === activeTermId}
            custom={customMap[id]}
            foreign={foreign}
            inSplit={member}
            onAddToSplit={canAdd ? () => onAddToSplit!(ref) : undefined}
            onActivate={() => onActivateTerminal(t.termId)}
            onClose={() => onCloseTerminal(t.termId)}
            rename={repoRoot ? makeRename(id) : undefined}
            onSplitRight={onSplitTab ? () => onSplitTab(ref, "row") : undefined}
            onSplitDown={onSplitTab ? () => onSplitTab(ref, "column") : undefined}
          />
          </DragSlot>
        );
      })}
      {/* Aura Manager chat sessions — first-class tabs alongside agents
          (ADE re-homes them here from the old right-rail). Picking "Aura
          Manager" from the + launcher opens one of these, so it reads like
          a Claude/Codex agent tab. */}
      {managerTabs.map((t, i) => {
        const id = tabIdFor("manager", t.sessionId);
        const ref = { kind: "manager" as const, id: t.sessionId };
        const member = !!(splitActive && isInSplit && isInSplit(ref));
        const canAdd =
          splitActive && onAddToSplit && isInSplit && !isInSplit(ref);
        return (
          <DragSlot
            key={`m:${t.sessionId}`}
            stripKey="manager"
            index={i}
            sourceRoot={repoRoot ?? undefined}
            onReorder={onReorderManager}
          >
          <ManagerTabRow
            tab={t}
            active={t.sessionId === activeManagerId}
            custom={customMap[id]}
            inSplit={member}
            onAddToSplit={canAdd ? () => onAddToSplit!(ref) : undefined}
            onSplitRight={onSplitTab ? () => onSplitTab(ref, "row") : undefined}
            onSplitDown={onSplitTab ? () => onSplitTab(ref, "column") : undefined}
            onActivate={() => onActivateManager?.(t.sessionId)}
            onClose={() => onCloseManager?.(t.sessionId)}
            rename={repoRoot ? makeRename(id) : undefined}
          />
          </DragSlot>
        );
      })}
      {(prTabs ?? []).map((t) => (
        <PrTabRow
          key={`p:${t.tabId}`}
          tab={t}
          active={t.tabId === activePrTabId}
          onActivate={() => onActivatePr?.(t.tabId)}
          onClose={() => onClosePr?.(t.tabId)}
        />
      ))}
      {inspectorOpen && onActivateInspector && onCloseInspector && (
        <InspectorTabRow
          active={!!inspectorActive}
          onActivate={onActivateInspector}
          onClose={onCloseInspector}
        />
      )}
      {replayOpen && onActivateReplay && onCloseReplay && (
        <ReplayTabRow
          active={!!replayActive}
          onActivate={onActivateReplay}
          onClose={onCloseReplay}
        />
      )}
      {planBuilderOpen && onActivatePlanBuilder && onClosePlanBuilder && (
        <PlanBuilderTabRow
          active={!!planBuilderActive}
          onActivate={onActivatePlanBuilder}
          onClose={onClosePlanBuilder}
        />
      )}
      {proveOpen && onActivateProve && onCloseProve && (
        <ProveTabRow
          active={!!proveActive}
          onActivate={onActivateProve}
          onClose={onCloseProve}
        />
      )}
      {graphOpen && onActivateGraph && onCloseGraph && (
        <GraphTabRow
          active={!!graphActive}
          onActivate={onActivateGraph}
          onClose={onCloseGraph}
        />
      )}
      {inboxOpen && onActivateInbox && onCloseInbox && (
        <InboxTabRow
          active={!!inboxActive}
          onActivate={onActivateInbox}
          onClose={onCloseInbox}
        />
      )}
      {traceToolOpen && traceToolKind && onActivateTraceTool && onCloseTraceTool && (
        <TraceToolTabRow
          kind={traceToolKind}
          onActivate={onActivateTraceTool}
          onClose={onCloseTraceTool}
        />
      )}
      {(onNewTerminal || onLaunchAgent) && (
        <NewTabButton
          agents={agents}
          onNewTerminal={onNewTerminal}
          onLaunchAgent={onLaunchAgent}
        />
      )}
      </div>
    </div>
  );
}

function NewTabButton({
  agents,
  onNewTerminal,
  onLaunchAgent,
}: {
  agents: Agent[];
  onNewTerminal?: () => void;
  onLaunchAgent?: (id: string, label: string) => void;
}) {
  // Radix DropdownMenu portals to document.body, so overflow:auto on
  // the tab strip can no longer clip the menu — the previous fixed-
  // position workaround (resize + scroll listeners + manual rect math)
  // is gone. @floating-ui handles flip + collision detection too.
  const launch = (a: Agent) => {
    if (!a.available || !onLaunchAgent) return;
    onLaunchAgent(a.id, a.label);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="New tab"
          className="px-2 text-text-4 hover:text-text-1 hover:bg-bg-1 text-[14px] flex items-center flex-shrink-0 outline-none"
        >
          +
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px] text-[12px]">
        {onNewTerminal && (
          <DropdownMenuItem onSelect={onNewTerminal} className="gap-2.5">
            <span className="text-text-3 font-mono text-[11px] w-4 text-center">{">_"}</span>
            <span className="flex-1">Terminal</span>
            <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {onLaunchAgent && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Chat</DropdownMenuLabel>
            {agents.length === 0 ? (
              <div className="px-2 py-1.5 text-text-4 text-[11px]">
                no agents discovered
              </div>
            ) : (
              agents.map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  disabled={!a.available}
                  onSelect={() => launch(a)}
                  className="gap-2.5"
                >
                  <span className="w-4 flex items-center justify-center">
                    <AgentIcon agentId={a.id} label={a.label} size={14} />
                  </span>
                  <span className="flex-1 truncate">{a.label}</span>
                  {!a.available && (
                    <DropdownMenuShortcut>missing</DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              ))
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// PresetBar removed in v0.2.13 — the "+" tab button's dropdown already
// surfaces every discovered agent.

// DashboardTabRow removed — the Aura dashboard tab is retired now that
// WorkSurfaceEmpty owns the no-tab state and the Manager lives in the
// right-rail AuraRailPanel.

function InspectorTabRow({
  active,
  onActivate,
  onClose,
}: {
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title="Review Changes — check whether a commit matched the task (middle-click to close)"
      className={`group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft transition-colors ${
        active
          ? "bg-bg-content text-text-1"
          : "text-text-3 hover:text-text-2 hover:bg-bg-1"
      }`}
      style={{ minWidth: 140, maxWidth: 220 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="flex-shrink-0"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="truncate">Review Changes</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      {active && (
        <span
          className="absolute left-0 right-0 bottom-0"
          style={{ height: 1, background: "var(--color-accent)" }}
        />
      )}
    </div>
  );
}

function PlanBuilderTabRow({
  active,
  onActivate,
  onClose,
}: {
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title="Plan Work — turn a goal into a task plan (middle-click to close)"
      className={`group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft transition-colors ${
        active
          ? "bg-bg-content text-text-1"
          : "text-text-3 hover:text-text-2 hover:bg-bg-1"
      }`}
      style={{ minWidth: 140, maxWidth: 220 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="flex-shrink-0"
      >
        <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2" />
        <line x1="5" y1="9" x2="11" y2="9" stroke="currentColor" strokeWidth="1.2" />
        <line x1="5" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span className="truncate">Plan Work</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      {active && (
        <span
          className="absolute left-0 right-0 bottom-0"
          style={{ height: 1, background: "var(--color-accent)" }}
        />
      )}
    </div>
  );
}

function ReplayTabRow({
  active,
  onActivate,
  onClose,
}: {
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title="Proof trail — proof that every change is genuine and hasn't been tampered with (middle-click to close)"
      className={`group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft transition-colors ${
        active
          ? "bg-bg-content text-text-1"
          : "text-text-3 hover:text-text-2 hover:bg-bg-1"
      }`}
      style={{ minWidth: 140, maxWidth: 220 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="flex-shrink-0"
      >
        <path d="M3 8 L13 8" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="3" cy="8" r="1.6" fill="currentColor" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        <circle cx="13" cy="8" r="1.6" fill="currentColor" />
        <path d="M5.5 4 L5.5 12" stroke="currentColor" strokeWidth="0.9" strokeDasharray="1.5 1.5" />
      </svg>
      <span className="truncate">Proof trail</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      {active && (
        <span
          className="absolute left-0 right-0 bottom-0"
          style={{ height: 1, background: "var(--color-accent)" }}
        />
      )}
    </div>
  );
}

function ProveTabRow({
  active,
  onActivate,
  onClose,
}: {
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title="Check it's built — see whether a feature is actually wired into the code (middle-click to close)"
      className={`group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft transition-colors ${
        active
          ? "bg-bg-content text-text-1"
          : "text-text-3 hover:text-text-2 hover:bg-bg-1"
      }`}
      style={{ minWidth: 120, maxWidth: 200 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="flex-shrink-0"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M5 8.5l2 2 4-4"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="truncate">Verify</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      {active && (
        <span
          className="absolute left-0 right-0 bottom-0"
          style={{ height: 1, background: "var(--color-accent)" }}
        />
      )}
    </div>
  );
}

function TraceToolTabRow({
  kind,
  onActivate,
  onClose,
}: {
  kind: TraceToolKind;
  onActivate: () => void;
  onClose: () => void;
}) {
  // Navigating away closes the tool, so the pill is only ever shown for
  // the active page — paint it active.
  const label =
    kind === "review"
      ? "Safety check"
      : kind === "rewind"
        ? "Time machine"
        : kind === "attest"
          ? "Genuine record"
          : kind === "memory"
            ? "Memory"
            : "Repo health";
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title={`${label} (middle-click to close)`}
      className="group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft bg-bg-content text-text-1"
      style={{ minWidth: 120, maxWidth: 220 }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
        <path
          d="M8 1.5l5 2v3.2c0 3-2.1 5.6-5 6.8-2.9-1.2-5-3.8-5-6.8V3.5l5-2z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      <span className="truncate">{label}</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      <span
        className="absolute left-0 right-0 bottom-0"
        style={{ height: 1, background: "var(--color-accent)" }}
      />
    </div>
  );
}

function GraphTabRow({
  active,
  onActivate,
  onClose,
}: {
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title="Code Map — files, pieces, and the links between them (middle-click to close)"
      className={`group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft transition-colors ${
        active
          ? "bg-bg-content text-text-1"
          : "text-text-3 hover:text-text-2 hover:bg-bg-1"
      }`}
      style={{ minWidth: 128, maxWidth: 220 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="flex-shrink-0"
      >
        <circle cx="4" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="11.5" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="9" cy="11.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5.7 4.8 9.8 4.2M5.1 6.4 7.7 10M10.2 10.2 11 5.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
      <span className="truncate">Code Map</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      {active && (
        <span
          className="absolute left-0 right-0 bottom-0"
          style={{ height: 1, background: "var(--color-accent)" }}
        />
      )}
    </div>
  );
}

function InboxTabRow({
  active,
  onActivate,
  onClose,
}: {
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={onActivate}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title="PR View — pull request inbox (middle-click to close)"
      className={`group relative flex items-center gap-2 px-3 cursor-pointer text-[12px] border-r border-line-soft transition-colors ${
        active
          ? "bg-bg-content text-text-1"
          : "text-text-3 hover:text-text-2 hover:bg-bg-1"
      }`}
      style={{ minWidth: 128, maxWidth: 200 }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="flex-shrink-0"
      >
        <path d="M2 4h12v8H2z" stroke="currentColor" strokeWidth="1.2" />
        <path d="M2 8l3-2h6l3 2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
        <circle cx="11.5" cy="4.5" r="1.8" fill="currentColor" />
      </svg>
      <span className="truncate">PR View</span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-auto w-4 h-4 flex items-center justify-center rounded hover:bg-bg-hover text-text-4 hover:text-text-1"
        title="Close"
      >
        ×
      </button>
      {active && (
        <span
          className="absolute left-0 right-0 bottom-0"
          style={{ height: 1, background: "var(--color-accent)" }}
        />
      )}
    </div>
  );
}

// ManagerTabRow removed — Manager sessions live in the right-rail
// AuraRailPanel chat surface, never in the work-tab strip.

function PrTabRow({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: PrTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const label = `#${tab.number} · ${tab.title}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onMouseDown={onActivate}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose();
            }
          }}
          title={`PR #${tab.number} — ${tab.title}`}
          className={`group relative flex items-center gap-2 pl-2.5 pr-1.5 cursor-pointer text-[12px] select-none transition-colors ${
            active
              ? "bg-bg-card text-text-1"
              : "text-text-3 hover:text-text-2 hover:bg-bg-hover/60"
          }`}
          style={{ maxWidth: 240 }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M4 6v4M6 12h4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span className="truncate">{label}</span>
          <button
            type="button"
            onMouseDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="ml-1 w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover opacity-0 group-hover:opacity-100"
            title="Close"
          >
            ×
          </button>
        </div>
      </ContextMenuTrigger>
      <TabMenuList items={buildCommonTabMenu({ onClose })} />
    </ContextMenu>
  );
}

function FileTab({
  file,
  active,
  dirty,
  owner,
  presence,
  custom,
  rename,
  onSplitRight,
  onSplitDown,
  onAddToSplit,
  onActivate,
  onClose,
}: {
  file: OpenFile;
  active: boolean;
  dirty: boolean;
  /** Short owner id when the file lives inside a zone owned by another
   *  agent's session. Empty/undefined when self-owned or unzoned. */
  owner?: string;
  /** AURA-19 — live radar presence entries scoped to this file (newest
   *  first). Rendered as ≤2 stacked colored pips after the label; the
   *  hover title lists every peer with kind + age. */
  presence?: FilePresence[];
  custom?: { name?: string };
  /** Inline-rename controls for this tab (undefined off-repo). */
  rename?: RenameControls;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onAddToSplit?: () => void;
  onActivate: () => void;
  onClose: () => void;
}) {
  const label = custom?.name?.trim() || file.name;
  const items = buildCommonTabMenu({
    onSplitRight,
    onSplitDown,
    onAddToSplit,
    onRename: rename?.start,
    onClose,
    closeLabel: dirty ? "Close (unsaved)" : "Close",
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onMouseDown={onActivate}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
          title={[
            file.path,
            owner ? `zone owned by ${owner} — edits will conflict` : null,
            ...(presence ?? []).map(
              (p) =>
                `${p.actor} · ${kindLabel(p.kind)}${p.symbol ? ` ${p.symbol}` : ""} · ${agoFromTs(p.ts)}`,
            ),
          ]
            .filter(Boolean)
            .join("\n")}
          className={`group relative flex items-center gap-2 pl-2.5 pr-1.5 cursor-pointer text-[12px] select-none transition-colors ${
            active
              ? "bg-bg-card text-text-1"
              : "text-text-3 hover:text-text-2 hover:bg-bg-hover/60"
          }`}
          style={{ maxWidth: 200 }}
        >
          {rename?.active ? (
            <TabRenameInput
              defaultValue={label}
              onCommit={rename.commit}
              onCancel={rename.cancel}
            />
          ) : (
            <span className="truncate">{label}</span>
          )}
          {presence && presence.length > 0 && (
            <span className="flex items-center flex-shrink-0 -space-x-0.5">
              {presence.slice(0, 2).map((p) => (
                <span
                  key={p.actor}
                  className="block w-1.5 h-1.5 rounded-full ring-1 ring-bg-chrome"
                  style={{ background: p.color }}
                />
              ))}
            </span>
          )}
          {owner && (
            <span
              className="text-[9.5px] font-mono px-1 rounded uppercase tracking-wider flex-shrink-0"
              style={{
                background: "color-mix(in oklab, var(--color-amber, #d4a017) 18%, transparent)",
                color: "var(--color-amber, #d4a017)",
              }}
            >
              {owner}
            </span>
          )}

          <TabMoreButton items={items} />

          {/* close × hidden until hover unless dirty (then a dot) */}
          <button
            type="button"
            onMouseDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={`ml-1 w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover ${
              dirty ? "" : "opacity-0 group-hover:opacity-100"
            }`}
            title={dirty ? "Close (unsaved)" : "Close"}
          >
            {dirty ? (
              <>
                <span className="block w-1.5 h-1.5 rounded-full bg-text-2 group-hover:hidden" />
                <span className="hidden group-hover:inline">×</span>
              </>
            ) : (
              <span>×</span>
            )}
          </button>
        </div>
      </ContextMenuTrigger>
      <TabMenuList items={items} />
    </ContextMenu>
  );
}

/** Pick an owner label for a file's tab when an active zone covers it.
 *  Returns null when self-owned (`agent_id === "aura-shell"` per the
 *  desktop's intent-log convention) or when no zone matches. The label
 *  prefers the human-friendly session id prefix; the full id is
 *  available in the tab's hover title. */
function ownerForFile(
  filePath: string,
  repoRoot: string | undefined,
  zones: ZoneRule[] | undefined,
): string | undefined {
  if (!repoRoot || !zones || zones.length === 0) return undefined;
  // Normalize to repo-relative path for glob matching.
  const rel =
    filePath.startsWith(repoRoot + "/")
      ? filePath.slice(repoRoot.length + 1)
      : filePath.replace(/^\//, "");
  const SELF = "aura-shell";
  for (const z of zones) {
    if (!z.patterns?.length) continue;
    if (!matchesAnyGlob(z.patterns, rel)) continue;
    if (z.session_id === SELF) continue;
    return z.session_id.slice(0, 8) || z.zone_id.slice(0, 8);
  }
  return undefined;
}

function AgentTabRow({
  tab,
  active,
  custom,
  foreign,
  inSplit,
  onAddToSplit,
  onSplitRight,
  onSplitDown,
  onActivate,
  onClose,
  rename,
}: {
  tab: AgentTab;
  active: boolean;
  custom?: { name?: string };
  /** True when the tab's repoRoot ≠ the current workspace. Renders a
   *  project chip + dims the row so the user can tell at a glance that
   *  this agent is anchored to another workspace. Stage 9C. */
  foreign?: boolean;
  /** Stage 9G — true when this tab is a member of the active split.
   *  Renders a small dot before the icon so the user can see at a
   *  glance which tabs participate in the layout. */
  inSplit?: boolean;
  /** Present when a split is active and this tab isn't already a
   *  member. Folds into the split-button menu as "Add to current split". */
  onAddToSplit?: () => void;
  /** Split this agent into a new pane beside / below it. */
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onActivate: () => void;
  onClose: () => void;
  /** Inline-rename controls for this tab. */
  rename?: RenameControls;
}) {
  const label = custom?.name?.trim() || tab.agentLabel;

  // Live work status, surfaced as a small dot on the tab now that the
  // agent header bar (which carried the AgentStatusChip) is gone. The
  // attention (rose) dot already covers "waiting for your input"; this
  // dot covers "is it working / done" at a glance. Status colors only —
  // sky for in-flight, amber for blocked, emerald for done — never the
  // arctic-blue primary accent.
  const { status } = useAgentEvent(tab.sessionId);
  const statusDot = agentStatusDot(status.kind);

  // The right-click menu carries every control the old header bar held:
  // the pane actions (splits / detach / close pane / leave split / story /
  // blocks / restart / stop) come from buildAgentTabMenuItems (which fires
  // them at the live AgentSurface), and a "Rename tab…" item keeps the
  // existing customize-dialog channel.
  const menuItems = buildAgentTabMenuItems({
    sessionId: tab.sessionId,
    inSplit: !!inSplit,
    // The global strip's tab isn't scoped to a specific split pane, so
    // there's no single "this pane" to drop — leaving the split covers it.
    canClosePane: false,
  });
  // One menu, two triggers (⋯ click + right-click): reliable store-level
  // split, the live pane actions, then Rename.
  const moreItems = buildMoreItems({
    onSplitRight,
    onSplitDown,
    onAddToSplit,
    bridge: menuItems,
    onRename: rename?.start,
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onMouseDown={(e) => { if (e.button === 0) onActivate(); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
          title={`${tab.agentLabel} · ${tab.sessionId.slice(0, 8)}`}
          className={`group relative flex items-center gap-2 pl-2.5 pr-1.5 cursor-pointer text-[12px] select-none transition-colors ${
            active
              ? "bg-bg-card text-text-1"
              : "text-text-3 hover:text-text-2 hover:bg-bg-hover/60"
          }`}
          style={{ maxWidth: 200 }}
        >
          {inSplit && <SplitMemberPip />}
          <AgentIcon agentId={tab.agentId} label={tab.agentLabel} size={14} />
          {rename?.active ? (
            <TabRenameInput
              defaultValue={label}
              onCommit={rename.commit}
              onCancel={rename.cancel}
            />
          ) : (
            <span
              className={`truncate ${
                tab.attention
                  ? "font-semibold text-text-1"
                  : foreign
                    ? "text-text-4"
                    : ""
              }`}
            >
              {label}
            </span>
          )}
          {tab.attention ? (
            <span
              title="Agent is waiting for your input"
              className="w-1.5 h-1.5 rounded-full bg-rose-400 flex-shrink-0"
              style={{ boxShadow: "0 0 6px rgba(244, 63, 94, 0.7)" }}
            />
          ) : (
            statusDot && (
              <span
                title={statusDot.title}
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  background: statusDot.color,
                  boxShadow: `0 0 5px ${statusDot.glow}`,
                }}
              />
            )
          )}
          {foreign && <ProjectChip repoRoot={tab.repoRoot} />}
          <TabMoreButton items={moreItems} />

          <button
            type="button"
            onMouseDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="ml-1 w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover opacity-0 group-hover:opacity-100"
            title="Close tab (session keeps running)"
          >
            ×
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[12rem]">
        {moreItems.map((item, i) =>
          item.kind === "separator" ? (
            <ContextMenuSeparator key={`sep-${i}`} />
          ) : (
            <ContextMenuItem
              key={item.label}
              disabled={item.disabled}
              variant={item.tone === "danger" ? "destructive" : "default"}
              onSelect={item.onSelect}
            >
              {item.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Map the live agent status to a tiny tab dot. Status palette only
 *  (sky / amber / emerald) — never the arctic-blue primary accent.
 *  Returns null for idle so a fresh tab carries no noise. */
function agentStatusDot(
  kind: "idle" | "in_progress" | "blocked" | "success",
): { color: string; glow: string; title: string } | null {
  switch (kind) {
    case "in_progress":
      return { color: "#38bdf8", glow: "rgba(56,189,248,0.6)", title: "Working" };
    case "blocked":
      return { color: "#fbbf24", glow: "rgba(251,191,36,0.6)", title: "Waiting" };
    case "success":
      return { color: "#34d399", glow: "rgba(52,211,153,0.55)", title: "Done" };
    default:
      return null;
  }
}

// Aura Manager chat tab. Simpler than AgentTabRow — a manager session is
// just { sessionId, label }, with no foreign-project chip or attention
// dot — but it carries the same Manager icon + close affordance so it
// sits in the strip as a peer of the agent tabs.
function ManagerTabRow({
  tab,
  active,
  custom,
  inSplit,
  onAddToSplit,
  onSplitRight,
  onSplitDown,
  onActivate,
  onClose,
  rename,
}: {
  tab: ManagerTab;
  active: boolean;
  custom?: { name?: string };
  inSplit?: boolean;
  onAddToSplit?: () => void;
  /** Split this chat into a new pane beside / below it. */
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onActivate: () => void;
  onClose: () => void;
  /** Inline-rename controls for this tab. */
  rename?: RenameControls;
}) {
  const label = custom?.name?.trim() || tab.label;
  // The native brain awaits a human just like a CLI agent does — when it has
  // raised a question (AskUserQuestion) or a plan is parked for review. Mirror
  // the CLI tab's bold-on-await cue so a backgrounded Manager tab signals it
  // needs you, even with no terminal BEL to ride on.
  const session = useManagerSession(tab.sessionId);
  const awaiting = !!(session?.pending_question || session?.pending_plan);
  // Suppress "Cancel session" once the chat has finished or been cancelled.
  const isTerminal =
    session?.status === "completed" || session?.status === "cancelled";
  // The chat tab carries the controls the old `.p-tabs` header bar held —
  // history / memory / split / details / loop / compare / cancel — fired at
  // the live ManagerSurface via the pane-action bridge (mirrors the agent tab).
  const menuItems = buildManagerTabMenuItems({
    sessionId: tab.sessionId,
    isTerminal,
  });
  // One menu, two triggers (⋯ click + right-click): reliable store-level
  // split, the live pane actions, then Rename.
  const moreItems = buildMoreItems({
    onSplitRight,
    onSplitDown,
    onAddToSplit,
    bridge: menuItems,
    onRename: rename?.start,
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onMouseDown={(e) => { if (e.button === 0) onActivate(); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
          title={`${tab.label} · ${tab.sessionId.slice(0, 8)}`}
          className={`group relative flex items-center gap-2 pl-2.5 pr-1.5 cursor-pointer text-[12px] select-none transition-colors ${
            active
              ? "bg-bg-card text-text-1"
              : "text-text-3 hover:text-text-2 hover:bg-bg-hover/60"
          }`}
          style={{ maxWidth: 200 }}
        >
          {inSplit && <SplitMemberPip />}
          <AgentIcon agentId="aura-manager" label={tab.label} size={14} />
          {rename?.active ? (
            <TabRenameInput
              defaultValue={label}
              onCommit={rename.commit}
              onCancel={rename.cancel}
            />
          ) : (
            <span className={`truncate ${awaiting ? "font-semibold text-text-1" : ""}`}>
              {label}
            </span>
          )}
          {awaiting && (
            <span
              title="Aura is waiting for your input"
              className="w-1.5 h-1.5 rounded-full bg-rose-400 flex-shrink-0"
              style={{ boxShadow: "0 0 6px rgba(244, 63, 94, 0.7)" }}
            />
          )}
          <TabMoreButton items={moreItems} />
          <button
            type="button"
            onMouseDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="ml-1 w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover opacity-0 group-hover:opacity-100"
            title="Close tab (session keeps running)"
          >
            ×
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[12rem]">
        {moreItems.map((item, i) =>
          item.kind === "separator" ? (
            <ContextMenuSeparator key={`sep-${i}`} />
          ) : (
            <ContextMenuItem
              key={item.label}
              disabled={item.disabled}
              variant={item.tone === "danger" ? "destructive" : "default"}
              onSelect={item.onSelect}
            >
              {item.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Visible per-tab "⋯ more" button. Sits just before the tab's close ×
 *  (hover-revealed, same as the ×) and opens the tab's FULL action menu
 *  on CLICK — Split right / Split down / Add to split / rename / the
 *  agent·manager pane actions / close.
 *
 *  Why a click button and not just right-click: the pane header bar that
 *  used to carry these was dropped (bccf3b49), leaving the right-click
 *  context menu as the only path — and that menu can be swallowed by the
 *  draggable tab wrapper / webview, so it's both invisible AND unreliable.
 *  This button is the dependable, discoverable way in; it renders the
 *  exact same item list the right-click menu uses.
 *
 *  Stops propagation on mousedown so opening it never activates / drags
 *  the tab. Renders nothing when the only action would be Close (the ×
 *  already covers that). */
function TabMoreButton({ items }: { items: TabMenuItem[] }) {
  // A lone Close is already served by the × — don't add a redundant ⋯.
  if (items.filter((it) => it.kind === "item").length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          className="w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          title="Tab actions — split, rename, close"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="4" cy="8" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="12" cy="8" r="1.3" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {items.map((item, i) =>
          item.kind === "separator" ? (
            <DropdownMenuSeparator key={`sep-${i}`} />
          ) : (
            <DropdownMenuItem
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={
                item.tone === "danger"
                  ? "text-rose-400 focus:text-rose-300"
                  : undefined
              }
            >
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compose an agent / manager tab's full menu (used by both the ⋯ button
 *  and right-click): reliable store-level Split right / Split down first
 *  (these always work — they call splitWithEmpty on the ref, unlike the
 *  bridge's split entries which only fire when that pane's surface is
 *  mounted, so they no-op for a background tab), then the live pane
 *  actions with their own split entries stripped, then Rename. Collapses
 *  stray / doubled separators left by the strip. */
function buildMoreItems(opts: {
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onAddToSplit?: () => void;
  bridge: TabMenuItem[];
  onRename?: () => void;
}): TabMenuItem[] {
  const raw: TabMenuItem[] = [];
  if (opts.onSplitRight)
    raw.push({ kind: "item", label: "Split right", onSelect: opts.onSplitRight });
  if (opts.onSplitDown)
    raw.push({ kind: "item", label: "Split down", onSelect: opts.onSplitDown });
  if (opts.onAddToSplit)
    raw.push({
      kind: "item",
      label: "Add to current split",
      onSelect: opts.onAddToSplit,
    });
  raw.push({ kind: "separator" });
  for (const it of opts.bridge) {
    // Drop the bridge's own (live-surface-fired) split entries — replaced
    // above by the reliable store-level ones.
    if (it.kind === "item" && it.label.startsWith("Split ")) continue;
    raw.push(it);
  }
  if (opts.onRename) {
    raw.push(
      { kind: "separator" },
      { kind: "item", label: "Rename tab…", onSelect: opts.onRename },
    );
  }
  // Collapse leading / trailing / consecutive separators.
  const out: TabMenuItem[] = [];
  for (const it of raw) {
    if (
      it.kind === "separator" &&
      (out.length === 0 || out[out.length - 1].kind === "separator")
    )
      continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

/** Stage 9G — Active split summary pill. Renders at the start of the
 *  tab strip whenever the user has 2+ panes in the work surface. Shows
 *  the member count plus an × to leave the split. The split's actual
 *  members are still shown as their own tabs (with a member dot via
 *  `isInSplit`) — this chip is the at-a-glance reminder that a split is
 *  active. */
function SplitGroupChip({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 h-9 border-r border-line-soft bg-bg-2 text-[11px] text-text-2 select-none"
      title={`Split layout active — ${count} pane${count === 1 ? "" : "s"}`}
    >
      <SplitGlyph />
      <span className="font-mono">Split: {count}</span>
      <button
        type="button"
        onClick={onClear}
        className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover"
        title="Leave split view"
      >
        ×
      </button>
    </div>
  );
}

function SplitGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Tiny dot shown on tabs that are members of the active split. Sits
 *  before the agent icon / label so it doesn't fight with foreign /
 *  customise affordances on the right edge. */
function SplitMemberPip() {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-accent-blue flex-shrink-0"
      title="In split layout"
    />
  );
}

// ── Stage 9H — drag-reorder slot ─────────────────────────────────────
//
// Wraps each tab row in a draggable container. Each strip uses its own
// MIME type (`application/x-aura-tab-<key>`) so a file tab can't be
// dropped into the agent strip — the dragover handler ignores types it
// can't handle. dataTransfer carries only the source index.
//
// Visual cues:
//   - dragging slot: opacity-50
//   - drop target slot: drawn 1px insert-line on the leading edge

type DragStrip = "file" | "agent" | "terminal" | "manager";

function dragMime(strip: DragStrip): string {
  return `application/x-aura-tab-${strip}`;
}

function DragSlot({
  stripKey,
  index,
  sourceRoot,
  onReorder,
  children,
}: {
  stripKey: DragStrip;
  index: number;
  /** Source workspace root for this tab. Set on every drag so the
   *  WorkspaceRail's tile-drop handler can read it and decide whether
   *  to start a club. Independent from the strip-scoped reorder MIME —
   *  multiple types can coexist on one dataTransfer. */
  sourceRoot?: string;
  onReorder?: (srcIndex: number, dstIndex: number) => void;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  if (!onReorder) {
    return <>{children}</>;
  }
  const mime = dragMime(stripKey);
  return (
    <div
      draggable
      onDragStart={(e) => {
        // dataTransfer.setData fires synchronously; we encode src index
        // as a string and the strip key in the MIME type itself.
        e.dataTransfer.setData(mime, String(index));
        if (sourceRoot) {
          e.dataTransfer.setData(
            "application/x-aura-tab-source-root",
            sourceRoot,
          );
        }
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes(mime)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const raw = e.dataTransfer.getData(mime);
        if (raw === "") return;
        const src = parseInt(raw, 10);
        if (Number.isNaN(src)) return;
        if (src === index) return;
        e.preventDefault();
        onReorder(src, index);
      }}
      className={`flex items-stretch ${dragging ? "opacity-50" : ""} ${
        over ? "border-l-2 border-accent-blue" : "border-l-2 border-transparent"
      }`}
    >
      {children}
    </div>
  );
}

/** Tiny chip showing the basename of a tab's repoRoot. Renders only on
 *  foreign tabs (repoRoot ≠ current workspace) so the user can tell
 *  which project an agent / terminal belongs to without hovering. */
function ProjectChip({ repoRoot }: { repoRoot: string }) {
  const name = repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
  return (
    <span
      className="ml-1 px-1.5 h-4 flex items-center rounded text-[9.5px] uppercase tracking-wider bg-bg-2 text-text-4 border border-line-soft flex-shrink-0"
      title={`In project ${repoRoot}`}
    >
      {name}
    </span>
  );
}

function TerminalTabRow({
  tab,
  index,
  active,
  custom,
  foreign,
  inSplit,
  onAddToSplit,
  onActivate,
  onClose,
  rename,
  onSplitRight,
  onSplitDown,
}: {
  tab: TerminalTab;
  index: number;
  active: boolean;
  custom?: { name?: string };
  /** True when the tab's cwd ≠ the current workspace. Stage 9C. */
  foreign?: boolean;
  /** Stage 9G — true when this tab is a member of the active split. */
  inSplit?: boolean;
  /** Stage 9C — hover button that adds the terminal to the active
   *  split layout. Undefined when no split is active or this tab is
   *  already a member. */
  onAddToSplit?: () => void;
  onActivate: () => void;
  onClose: () => void;
  /** Inline-rename controls for this tab. */
  rename?: RenameControls;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
}) {
  const label =
    custom?.name?.trim() ||
    tab.label?.trim() ||
    `Terminal ${index + 1}`;
  const items = buildCommonTabMenu({
    onSplitRight,
    onSplitDown,
    onAddToSplit,
    onRename: rename?.start,
    onClose,
    closeLabel: "Close terminal",
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onMouseDown={onActivate}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
          title={`${label} · ${tab.cwd}`}
          className={`group relative flex items-center gap-2 pl-2.5 pr-1.5 cursor-pointer text-[12px] select-none transition-colors ${
            active
              ? "bg-bg-card text-text-1"
              : "text-text-3 hover:text-text-2 hover:bg-bg-hover/60"
          }`}
          style={{ maxWidth: 200 }}
        >
          {inSplit && <SplitMemberPip />}
          <span
            className="inline-flex items-center justify-center rounded-sm bg-bg-1 text-text-3 flex-shrink-0"
            style={{ width: 14, height: 14, fontSize: 10 }}
          >
            {">_"}
          </span>
          {rename?.active ? (
            <TabRenameInput
              defaultValue={label}
              onCommit={rename.commit}
              onCancel={rename.cancel}
            />
          ) : (
            <span className={`truncate ${foreign ? "text-text-4" : ""}`}>{label}</span>
          )}
          {foreign && <ProjectChip repoRoot={tab.cwd} />}
          <TabMoreButton items={items} />

          <button
            type="button"
            onMouseDown={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="ml-1 w-4 h-4 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover opacity-0 group-hover:opacity-100"
            title="Close terminal"
          >
            ×
          </button>
        </div>
      </ContextMenuTrigger>
      <TabMenuList items={items} />
    </ContextMenu>
  );
}
