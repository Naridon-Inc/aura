// The workspace's terminal panel, the lower half of the right column (⌘J
// collapses it to its header). It's a self-contained surface over the shared
// `editorStore.terminalTabs` list: a header of Setup, Run and terminal tabs
// with the Run controls, the active terminal GROUP (a solo terminal or a
// split tree) filling the body, and an optional side-list of every group on
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
import { toast } from "../../lib/toast";
import { pickPath } from "../../lib/nativeDialog";
import {
  folderLabel,
  persistFolders,
  readFolders,
  rememberFolder,
} from "../../lib/terminalFolders";
import { TerminalPanelActions } from "./TerminalPanelToolbar";
import { DetailsTerminal } from "../ui/details-terminal";
import { useTerminalStrip } from "./useTerminalStrip";
import { TerminalTabsList } from "./TerminalTabsList";
import { TerminalFindWidget } from "./TerminalFindWidget";
import { isTerminalFocused } from "../../lib/terminalKeymap";
import { openPopout } from "../../lib/popout";
import {
  focusRun,
  liveRunTermId,
  runProject,
  stopRun,
  type RunDeps,
} from "../../lib/runPane";
import { promptForRunCommand } from "./runPrompt";
import { claimRunRequest, onRunRequested } from "../../lib/runRequest";
import { RunControls, runControlsState } from "./RunControls";
import { MAX_TERMINALS } from "./terminalStrip";
import { openRepoScriptsSettings } from "./useTerminalStrip";

// The side-list starts closed now the panel sits in the narrow right column;
// a new key so the old default-open answer doesn't carry over.
const SIDE_LIST_KEY = "aura.terminal.sideList.v2";
const TOGGLE_SHORTCUT = "⌘J";
const RUN_SHORTCUT = "⌘R";

/** Ask for a folder to open a shell in. A cancelled panel — and the nil-panel
 *  degradation `nativeDialog` turns into one — reads as "no folder", which
 *  opens nothing rather than falling back to the project root. */
async function pickFolder(startIn: string): Promise<string | null> {
  const picked = await pickPath({
    directory: true,
    title: "Open a terminal in this folder",
    defaultPath: startIn,
  });
  return typeof picked === "string" && picked ? picked : null;
}

type Props = {
  repoRoot: string;
  /** False while the panel is collapsed to its header. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  maximized: boolean;
  onToggleMaximize: () => void;
};

export function TerminalPanel({ repoRoot, open, onOpenChange, maximized, onToggleMaximize }: Props) {
  const store = useEditorStore();
  const { terminalTabs, panelActiveTermId, panelActiveGroupId, terminalGroups } = store;

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [sideListOpen, setSideListOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDE_LIST_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [findOpen, setFindOpen] = useState(false);
  const [recentFolders, setRecentFolders] = useState<string[]>(() => readFolders());

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
    // A collapsed panel shows no terminal, so it opens none.
    if (!open) return;
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
  }, [open, panelActiveTermId, terminalGroups, repoRoot]);

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

  function handleNewTerminal(profileId?: string) {
    if (strip.terminalCount >= MAX_TERMINALS) {
      toast.danger(`Maximum ${MAX_TERMINALS} terminals allowed`);
      return;
    }
    const p = profileId ? profiles.find((x) => x.id === profileId) : undefined;
    store.openPanelTerminal(repoRoot, { profileId: p?.id, shell: p?.path });
  }

  // A shell anywhere on disk, not only in the open project. The folder comes
  // from the native picker (or a row the user opened before), the shell from
  // the same menu, and the tab is named after the folder — a terminal sitting
  // in a different place has to say so, or the panel lies about where your
  // next command will run.
  async function handleNewTerminalInFolder(profileId?: string, folder?: string) {
    const dir = folder ?? (await pickFolder(activeTab?.cwd ?? repoRoot));
    if (!dir) return;
    const p = profileId ? profiles.find((x) => x.id === profileId) : undefined;
    store.openPanelTerminal(dir, {
      profileId: p?.id,
      shell: p?.path,
      label: folderLabel(dir),
    });
    setRecentFolders((prev) => {
      const next = rememberFolder(prev, dir);
      persistFolders(next);
      return next;
    });
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

  // Run — the one reserved terminal per project. The store surface it needs is
  // built here and passed down rather than imported inside `runPane`, so that
  // logic stays exercisable without a React tree or a live store.
  const runDeps = useMemo<RunDeps>(
    () => ({
      openPanelTerminal: (cwd, opts) => store.openPanelTerminal(cwd, opts),
      selectPanelTerminal: (id) => store.selectPanelTerminal(id),
      closeTerminal: (id) => store.closeTerminal(id),
      terminals: terminalTabs,
    }),
    // `store` is a fresh object each render but its actions mutate a
    // singleton, so the captured ref stays valid. Only the terminal list
    // changes what these answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalTabs],
  );
  const runTermId = useMemo(
    () => liveRunTermId(repoRoot, runDeps),
    [repoRoot, runDeps],
  );

  async function handleRun() {
    const outcome = await runProject(repoRoot, runDeps);
    if (outcome.ok) return;
    if (outcome.reason === "no-place") {
      // The project stands in a machine that could not be opened. Say so;
      // running its command on this laptop instead would start the wrong
      // thing on the wrong computer.
      toast.warning("Run couldn't start on the machine", outcome.message);
      return;
    }
    // The repo justified no command and none was pinned. Ask — in the same
    // dialog the row's pencil opens — and run the answer. A cancelled prompt
    // runs nothing; it does not fall back to a hopeful guess.
    const chosen = await promptForRunCommand(repoRoot);
    if (chosen) await runProject(repoRoot, runDeps);
  }

  function handleFocusRun() {
    // The row only asks for focus when it believes Run is open. If it isn't
    // (it was killed from the toolbar a moment ago), start it rather than
    // doing nothing — the click meant "show me the thing running".
    if (!focusRun(repoRoot, runDeps)) void handleRun();
  }

  function handleStopRun() {
    stopRun(repoRoot, runDeps);
  }

  const strip = useTerminalStrip({
    repoRoot,
    terminalTabs,
    terminalGroups,
    panelActiveTermId,
    panelActiveGroupId,
    runDeps,
    runTermId,
    onRun: () => void handleRun(),
    selectPanelTerminal: store.selectPanelTerminal,
    selectPanelGroup: store.selectPanelGroup,
    openPanelTerminal: store.openPanelTerminal,
    closeTerminal: store.closeTerminal,
    runShortcut: RUN_SHORTCUT,
  });

  useEffect(() => {
    return onRunRequested(() => {
      if (claimRunRequest()) void handleRun();
    });
    // `handleRun` is re-made every render; the values it closes over are the
    // two below, so re-binding on those keeps the listener current without
    // churning on every render. Re-subscribing can't double-run: the claim is
    // gone after the first one takes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, runDeps]);

  // Terminal-scoped shortcuts. All gate on `isTerminalFocused()` so they never
  // hijack the editor: ⌘F opens find (the widget then owns Esc/Enter), ⌘K
  // clears, ⌘A selects the whole buffer, ⌘\ splits the active terminal.
  //
  // The letter chords take ⌘ on macOS and Ctrl+Shift elsewhere, never bare
  // Ctrl: Ctrl+F, Ctrl+K and Ctrl+A are forward-char, kill-line and
  // beginning-of-line in readline. Ctrl+F used to open find *and* reach the
  // shell, because preventing the default on the pane does not stop the
  // keydown reaching this window listener.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !isTerminalFocused()) return;
      const key = e.key.toLowerCase();
      // ⌘<letter>, or Ctrl+Shift+<letter> on Linux/Windows.
      const emulatorChord = e.metaKey || e.shiftKey;
      if (key === "f" && emulatorChord && panelActiveTermId) {
        e.preventDefault();
        setFindOpen(true);
      } else if (key === "k" && emulatorChord && panelActiveTermId) {
        e.preventDefault();
        clearTerminalSession(panelActiveTermId);
      } else if (key === "a" && emulatorChord && panelActiveTermId) {
        e.preventDefault();
        selectAllTerminal(panelActiveTermId);
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
    onNewTerminalInFolder: (profileId?: string, folder?: string) =>
      void handleNewTerminalInFolder(profileId, folder),
    recentFolders,
    onSelectDefaultProfile: handleSelectDefaultProfile,
    onConfigureSettings: openTerminalSettings,
  };

  return (
    <DetailsTerminal
      tabs={strip.tabs}
      value={strip.value}
      onValueChange={strip.select}
      open={open}
      onOpenChange={onOpenChange}
      toggleShortcut={TOGGLE_SHORTCUT}
      onNewTerminal={() => handleNewTerminal()}
      terminalCount={strip.terminalCount}
      maxTerminals={MAX_TERMINALS}
      actions={
        <>
        <RunControls
          state={runControlsState(!!runTermId, strip.tasks)}
          tasks={strip.tasks}
          shortcut={RUN_SHORTCUT}
          onRun={strip.runTask}
          onStop={handleStopRun}
          onAddAction={() => void promptForRunCommand(repoRoot)}
          onConfigure={() => openRepoScriptsSettings(repoRoot)}
        />
        <TerminalPanelActions
          hasSelection
          maximized={maximized}
          sideListOpen={sideListOpen}
          hasActive={!!panelActiveTermId}
          onSplit={() => handleSplit()}
          onKill={killActive}
          onClear={() => panelActiveTermId && clearTerminalSession(panelActiveTermId)}
          onCopy={() => panelActiveTermId && void copyTerminalSelection(panelActiveTermId)}
          onPaste={() => panelActiveTermId && void pasteIntoTerminal(panelActiveTermId)}
          onSelectAll={() => panelActiveTermId && selectAllTerminal(panelActiveTermId)}
          onFind={() => panelActiveTermId && setFindOpen(true)}
          onToggleMaximize={onToggleMaximize}
          onOpenInEditor={() =>
            panelActiveTermId && store.promoteTerminalToEditor(panelActiveTermId)
          }
          onToggleSideList={toggleSideList}
          shellMenu={{
            ...sharedMenuProps,
            onSplit: (pid) => handleSplit(pid),
            onNewWindow: handleNewWindow,
          }}
        />
        </>
      }
    >
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 relative">
          {strip.idle ?? (
          <TerminalBody
            tabs={byId}
            layout={activeLayout}
            soloTermId={panelActiveTermId}
            activeTermId={panelActiveTermId}
            repoRoot={repoRoot}
            onFocus={store.selectPanelTerminal}
            onSessionOpened={store.setTerminalDaemonSession}
          />
          )}
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
            runTermId={runTermId}
            onRun={() => void handleRun()}
            onFocusRun={handleFocusRun}
            onStopRun={handleStopRun}
            {...sharedMenuProps}
          />
        )}
      </div>
    </DetailsTerminal>
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
      <div className="h-full w-full grid place-items-center text-text-5 text-xs">
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
