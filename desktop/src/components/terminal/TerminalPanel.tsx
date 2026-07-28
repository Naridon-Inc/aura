// The VS Code-style terminal panel that fills the ⌘J bottom slot. It's a
// self-contained surface over the shared `editorStore.terminalTabs` list:
// a toolbar on top, the active terminal GROUP (a solo terminal or a split
// tree) filling the body, and a collapsible side-list of every group on
// the right. The side-list is `terminalGroups` — each row owns its own
// split tree, so adding a terminal or splitting one group never disturbs
// another (the "groups detach" fix). Its focus (`panelActiveGroupId` /
// `panelActiveTermId`) is independent of the editor's, so working in the
// panel never blanks an open file.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal } from "../Terminal";
import {
  clearTerminalSession,
  copyTerminalSelection,
  pasteIntoTerminal,
  selectAllTerminal,
} from "../Terminal";
import {
  useEditorStore,
  treeContains,
  type TerminalTab,
  type WorkSplitTree,
} from "../../lib/editorStore";
import { api, type TerminalProfile } from "../../lib/api";
import { TerminalPanelToolbar } from "./TerminalPanelToolbar";
import { TerminalTabsList } from "./TerminalTabsList";
import { TerminalFindWidget } from "./TerminalFindWidget";
import { isTerminalFocused } from "../../lib/terminalKeymap";
import { openPopout } from "../../lib/popout";

const SIDE_LIST_KEY = "aura.terminal.sideListOpen";

type Props = {
  repoRoot: string;
  maximized: boolean;
  onToggleMaximize: () => void;
  onClosePanel: () => void;
};

export function TerminalPanel({ repoRoot, maximized, onToggleMaximize, onClosePanel }: Props) {
  const store = useEditorStore();
  const { terminalTabs, panelActiveTermId, panelActiveGroupId, terminalGroups } = store;

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [sideListOpen, setSideListOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDE_LIST_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [findOpen, setFindOpen] = useState(false);

  // Load the terminal profiles once (auto-seeded backend-side from
  // `/etc/shells` + `$SHELL` when the user hasn't configured any). The
  // default-profile radio reflects + writes the persisted choice.
  useEffect(() => {
    let alive = true;
    Promise.all([api.terminalProfileList(), api.terminalProfileDefault()])
      .then(([list, def]) => {
        if (!alive) return;
        setProfiles(list);
        setDefaultProfileId(def ?? list[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // GC cold-restore scrollback files for terminals that no longer exist
  // in this workspace's tab set, so a one-off shell doesn't leave its
  // history on disk forever. Runs once per workspace mount.
  useEffect(() => {
    if (!repoRoot) return;
    const keep = terminalTabs.map((t) => t.termId);
    api.ptyScrollbackPrune(repoRoot, keep).catch(() => {});
    // Intentionally mount-only: pruning reacts to the rehydrated set, not
    // every tab open/close (those are pruned on the next launch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  function toggleSideList() {
    setSideListOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDE_LIST_KEY, next ? "1" : "0");
      } catch {
        /* best-effort */
      }
      return next;
    });
  }

  // The panel always shows a terminal: adopt the most-recent existing GROUP
  // when nothing is focused, or spawn a fresh shell when the panel is empty.
  // Keys off `terminalGroups` (panel-resident terminals), NOT `terminalTabs`
  // (the shared registry, which also holds editor-promoted terminals). A
  // terminal moved into the editor via "Open terminal in editor" still lives
  // in `terminalTabs` but in no panel group — it must not be re-adopted here
  // or it would mount twice (panel + editor). Guard with a ref so an in-flight
  // spawn doesn't double-fire across the store updates it triggers.
  const ensuring = useRef(false);
  useEffect(() => {
    const panelHasActive =
      !!panelActiveTermId &&
      terminalGroups.some((g) =>
        treeContains(g.layout, { kind: "terminal", id: panelActiveTermId }),
      );
    if (panelHasActive) {
      ensuring.current = false;
      return;
    }
    if (terminalGroups.length > 0) {
      store.selectPanelGroup(terminalGroups[terminalGroups.length - 1].groupId);
      return;
    }
    if (ensuring.current) return;
    ensuring.current = true;
    store.openPanelTerminal(repoRoot);
    // `store` is intentionally excluded — it's a fresh object each render
    // and the store actions mutate a module singleton, so a captured ref
    // stays valid. Re-running only on the real inputs avoids per-render
    // churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelActiveTermId, terminalGroups, repoRoot]);

  const byId = useMemo(
    () => new Map(terminalTabs.map((t) => [t.termId, t])),
    [terminalTabs],
  );
  const activeTab = panelActiveTermId ? byId.get(panelActiveTermId) ?? null : null;
  // The body shows the ACTIVE group's split tree (a solo group is a single
  // leaf; a split group is a `split` node). Other groups stay mounted only
  // via the Terminal module session map, not the DOM — switching groups
  // re-renders the body but keeps each PTY alive.
  const activeLayout = useMemo(() => {
    const g = panelActiveGroupId
      ? terminalGroups.find((x) => x.groupId === panelActiveGroupId)
      : null;
    return g?.layout ?? null;
  }, [panelActiveGroupId, terminalGroups]);

  function profileName(tab: TerminalTab | null): string {
    if (tab?.profileId) {
      const p = profiles.find((x) => x.id === tab.profileId);
      if (p) return p.name;
    }
    if (tab?.shell) return tab.shell.split("/").pop() || tab.shell;
    const def = defaultProfileId ? profiles.find((p) => p.id === defaultProfileId) : null;
    return def?.name ?? "Default";
  }

  function handleNewTerminal(profileId?: string) {
    const p = profileId ? profiles.find((x) => x.id === profileId) : undefined;
    store.openPanelTerminal(repoRoot, { profileId: p?.id, shell: p?.path });
  }

  function handleSplit(profileId?: string, direction: "row" | "column" = "row") {
    if (!panelActiveTermId) {
      handleNewTerminal(profileId);
      return;
    }
    store.splitPanelTerminal(direction);
  }

  function handleSelectDefaultProfile(id: string) {
    setDefaultProfileId(id);
    api.terminalProfileSetDefault(id).catch(() => {});
  }

  // "New Terminal Window" — spin a standalone terminal into its own OS
  // window, opening in the active terminal's cwd (else the workspace root).
  // In daemon mode it would reconnect a popped-out live session; here it's a
  // fresh shell, so no reconnectId. The popout `pty_close`s on window close.
  function handleNewWindow() {
    void openPopout({
      kind: "terminal",
      root: repoRoot,
      cwd: activeTab?.cwd ?? repoRoot,
    });
  }

  function openTerminalSettings() {
    window.dispatchEvent(
      new CustomEvent("aura:open-settings", { detail: { pane: "terminal" } }),
    );
  }

  function killActive() {
    if (panelActiveTermId) store.closeTerminal(panelActiveTermId);
  }

  // Terminal-scoped shortcuts. Both gate on `isTerminalFocused()` so they
  // never hijack the editor: ⌘F opens find (the widget then owns
  // Esc/Enter); ⌘\ splits the active terminal in the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !isTerminalFocused()) return;
      const key = e.key.toLowerCase();
      if (key === "f" && !e.shiftKey && panelActiveTermId) {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "\\" && panelActiveTermId) {
        e.preventDefault();
        store.splitPanelTerminal("row");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `store` is a fresh object each render but its actions mutate a
    // singleton, so the captured ref stays valid; re-bind only on the
    // active-terminal change that gates the handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelActiveTermId]);

  // A find session is bound to one terminal; switching the active
  // terminal closes it so the highlight doesn't linger on a hidden pane.
  useEffect(() => {
    setFindOpen(false);
  }, [panelActiveTermId]);

  const sharedMenuProps = {
    profiles,
    defaultProfileId,
    onNewTerminal: handleNewTerminal,
    onSelectDefaultProfile: handleSelectDefaultProfile,
    onConfigureSettings: openTerminalSettings,
  };

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <TerminalPanelToolbar
        activeProfileName={profileName(activeTab)}
        hasSelection
        maximized={maximized}
        sideListOpen={sideListOpen}
        hasActive={!!panelActiveTermId}
        onSplit={(pid) => handleSplit(pid)}
        onNewWindow={handleNewWindow}
        onKill={killActive}
        onClear={() => panelActiveTermId && clearTerminalSession(panelActiveTermId)}
        onCopy={() => panelActiveTermId && copyTerminalSelection(panelActiveTermId)}
        onPaste={() => panelActiveTermId && void pasteIntoTerminal(panelActiveTermId)}
        onSelectAll={() => panelActiveTermId && selectAllTerminal(panelActiveTermId)}
        onFind={() => panelActiveTermId && setFindOpen(true)}
        onToggleMaximize={onToggleMaximize}
        onOpenInEditor={() =>
          panelActiveTermId && store.promoteTerminalToEditor(panelActiveTermId)
        }
        onToggleSideList={toggleSideList}
        onClosePanel={onClosePanel}
        {...sharedMenuProps}
      />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 relative">
          <TerminalBody
            tabs={byId}
            layout={activeLayout}
            soloTermId={panelActiveTermId}
            activeTermId={panelActiveTermId}
            repoRoot={repoRoot}
            onFocus={store.selectPanelTerminal}
            onSessionOpened={store.setTerminalDaemonSession}
          />
          {findOpen && (
            <TerminalFindWidget
              termId={panelActiveTermId}
              onClose={() => setFindOpen(false)}
            />
          )}
        </div>
        {sideListOpen && (
          <TerminalTabsList
            repoRoot={repoRoot}
            terminals={terminalTabs}
            groups={terminalGroups}
            activeTermId={panelActiveTermId}
            onSelect={store.selectPanelTerminal}
            // Split the terminal the row belongs to, not whatever happens to
            // be focused. The row's split button stopPropagation()s so it never
            // selects first — focus it here, then split (setState is a sync
            // singleton, so splitPanelTerminal reads the freshly-focused pane).
            onSplit={(id, dir) => {
              store.selectPanelTerminal(id);
              store.splitPanelTerminal(dir);
            }}
            onMerge={store.mergeTerminalIntoGroup}
            onDemote={store.demoteTerminalToPanel}
            onKill={store.closeTerminal}
            {...sharedMenuProps}
          />
        )}
      </div>
    </div>
  );
}

/** Renders either the solo active terminal or the panel's split tree. A
 *  terminal session persists across remounts via the module-level map in
 *  `Terminal.tsx` keyed by `instanceId`, so focus changes don't tear down
 *  the PTY. */
function TerminalBody({
  tabs,
  layout,
  soloTermId,
  activeTermId,
  repoRoot,
  onFocus,
  onSessionOpened,
}: {
  tabs: Map<string, TerminalTab>;
  layout: WorkSplitTree | null;
  soloTermId: string | null;
  activeTermId: string | null;
  repoRoot: string;
  onFocus: (termId: string) => void;
  onSessionOpened: (termId: string, daemonSessionId: string) => void;
}) {
  if (layout) {
    // The focus outline only earns its keep when there is more than one pane
    // to tell apart. A single pane renders completely flush — terminal output
    // is never boxed in by chrome.
    const multi = countCells(layout) > 1;
    return (
      <div className="h-full w-full">
        {renderTree(layout, tabs, activeTermId, repoRoot, onFocus, onSessionOpened, multi)}
      </div>
    );
  }
  const tab = soloTermId ? tabs.get(soloTermId) : null;
  if (!tab) {
    return (
      <div className="h-full w-full grid place-items-center text-text-5 text-[11px]">
        No terminals.
      </div>
    );
  }
  return (
    <TermCell
      tab={tab}
      active={false}
      repoRoot={repoRoot}
      onFocus={onFocus}
      onSessionOpened={onSessionOpened}
    />
  );
}

/** How many terminal cells a split tree renders. Drives whether the active
 *  pane needs a focus outline at all. */
function countCells(tree: WorkSplitTree): number {
  if (tree.kind === "leaf") return 1;
  return tree.children.reduce((n, child) => n + countCells(child), 0);
}

function renderTree(
  tree: WorkSplitTree,
  tabs: Map<string, TerminalTab>,
  activeTermId: string | null,
  repoRoot: string,
  onFocus: (termId: string) => void,
  onSessionOpened: (termId: string, daemonSessionId: string) => void,
  multi: boolean,
): ReactNode {
  if (tree.kind === "leaf") {
    const ref = tree.tabs[tree.activeIndex] ?? tree.tabs[0];
    if (!ref || ref.kind !== "terminal") return null;
    const tab = tabs.get(ref.id);
    if (!tab) return null;
    return (
      <TermCell
        tab={tab}
        active={multi && tab.termId === activeTermId}
        repoRoot={repoRoot}
        onFocus={onFocus}
        onSessionOpened={onSessionOpened}
      />
    );
  }
  const flexDir = tree.direction === "row" ? "flex-row" : "flex-col";
  return (
    <div className={`h-full w-full flex ${flexDir} gap-px bg-line-soft`}>
      {tree.children.map((child, i) => (
        <div key={i} className="flex-1 min-w-0 min-h-0 bg-bg-content">
          {renderTree(child, tabs, activeTermId, repoRoot, onFocus, onSessionOpened, multi)}
        </div>
      ))}
    </div>
  );
}

function TermCell({
  tab,
  active,
  repoRoot,
  onFocus,
  onSessionOpened,
}: {
  tab: TerminalTab;
  active: boolean;
  repoRoot: string;
  onFocus: (termId: string) => void;
  onSessionOpened: (termId: string, daemonSessionId: string) => void;
}) {
  return (
    <div
      onMouseDownCapture={() => onFocus(tab.termId)}
      className={[
        "h-full w-full relative",
        active ? "ring-1 ring-inset ring-accent/50" : "",
      ].join(" ")}
    >
      <Terminal
        key={tab.termId}
        cwd={tab.cwd}
        instanceId={tab.termId}
        bootCommand={tab.bootCommand}
        shell={tab.shell}
        profile={tab.profileId}
        repoRoot={repoRoot}
        reconnectId={tab.daemonSessionId ?? null}
        onOpened={(ptyId) => onSessionOpened(tab.termId, ptyId)}
      />
    </div>
  );
}
