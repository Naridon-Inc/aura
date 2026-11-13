// ⌘K palette — the shared command dialog. A row of tabs under the field
// (All, Workspaces, Repositories, Actions, Settings) chooses what it lists.
// All opens on the recent workspaces and the fixed groups (workspace actions,
// actions, navigation, settings, open in), then Aura's own actions; typing
// ranks the groups by the query and adds repositories, conversations, the
// place's workspaces, definitions, files, code and reasons. The workspaces
// are the place's only: this computer's in the local place, the cloud's in
// the cloud, a machine's on that machine. The ranking is the palette's own,
// so the list draws rows in the order given rather than filtering again.
//
// Prefix scoping (Linear/Raycast pattern):
//   >  — Aura semantic verbs only (prove, intent, rewind, snapshot…)
//   @  — agent picker; pick + free text → dispatch prompt to that agent
//   /  — slash commands only
//   :  — files only
//   ?  — code search only
//   (no prefix) — the tabs

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { api } from "../lib/api";
import type { AppActionId } from "../lib/keymap";
import { usePlaceScope, type PlaceScope } from "../lib/placeScope";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import { useResolvedTheme } from "../lib/themeStore";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import type { WorktreeBadge } from "../lib/useWorktreeBadges";
import type { WorktreeRef } from "../lib/workspaceRef";
import type { CatalogPlace } from "./palette/paletteCatalog";
import { groupHits } from "./palette/paletteGroups";
import { allLaneHits, laneHits } from "./palette/paletteHits";
import { PaletteResultRow, paletteKey } from "./palette/PaletteRows";
import { runCatalogItem, type CatalogRunContext } from "./palette/paletteRun";
import {
  buildPaletteSections,
  sectionKeys,
  type PaletteRepository,
  type PaletteRow,
} from "./palette/paletteSections";
import { PaletteSectionRow } from "./palette/PaletteSectionRow";
import { PaletteTabsRow } from "./palette/PaletteTabsRow";
import { paletteNoMatch, palettePlaceholder, stepPaletteTab, type PaletteTab } from "./palette/paletteTabs";
import {
  CloudWorkspaceFeed,
  EMPTY_FEED,
  LocalWorkspaceFeed,
  MachineWorkspaceFeed,
  type PaletteWorkspaceFeed,
} from "./palette/PaletteWorkspaceFeed";
import { PaletteWorkspaceFilters } from "./palette/PaletteWorkspaceFilters";
import {
  CLEARED_WORKSPACE_FILTERS,
  DEFAULT_WORKSPACE_FILTERS,
  filtersActive,
  repositoriesOf,
  type WorkspaceFilters,
} from "./palette/paletteWorkspaces";
import { usePaletteLanes, type PaletteLaneScope } from "./palette/usePaletteLanes";
import type { ProjectMeta } from "./workspaces/workspacesModel";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandList } from "./ui/command";
import "./ui/command-palette.css";

export type PaletteEntry =
  | { kind: "action"; id: AppActionId; label: string; hint?: string }
  | { kind: "slash"; id: string; label: string; hint?: string }
  | { kind: "file"; id: string; label: string; hint?: string }
  | { kind: "agent"; id: string; label: string; hint?: string; prompt: string }
  | {
      kind: "match";
      id: string;
      label: string;
      hint?: string;
      /** Absolute file path the editor should open. */
      path: string;
      /** 1-based line number to scroll to. */
      line: number;
      column?: number;
    }
  | {
      kind: "symbol";
      id: string;
      label: string;
      hint?: string;
      path: string;
      line: number;
      column?: number;
      symbolKind: string;
    }
  | {
      kind: "intent";
      id: string;
      label: string;
      hint?: string;
      /** Epoch seconds the reason was logged, as the log stamps it — drives
       *  the "open this reason" jump, which matches on that exact stamp. */
      timestamp: number;
      /** First file the reason touched, absolute path — the click target.
       *  Absent when the changeset is empty (open the reason editor instead). */
      path?: string;
      line?: number;
    }
  | {
      kind: "chat";
      id: string;
      label: string;
      hint?: string;
      sessionId: string;
      repoRoot: string | null;
      turnIndex: number | null;
    }
  | {
      kind: "workspace";
      id: string;
      label: string;
      hint?: string;
      /** Absolute workspace root the app switches to via loadProjectAt. */
      root: string;
      /** Epoch-ms this project was last opened — drives recency ordering. */
      lastOpened: number;
    };

export type PaletteAgent = {
  id: string;
  label: string;
  available?: boolean;
};

const APP_ACTIONS: PaletteEntry[] = [
  { kind: "action", id: "open_aura", label: "Open Aura: your command centre" },
  { kind: "action", id: "toggle_sidebar", label: "Toggle Left Sidebar", hint: "⌘B" },
  { kind: "action", id: "toggle_terminal", label: "Toggle Terminal", hint: "⌘J" },
  { kind: "action", id: "run_project", label: "Run this repository", hint: "⌘R" },
  { kind: "action", id: "toggle_review", label: "Toggle Right Sidebar", hint: "⌘⌥B" },
  { kind: "action", id: "save", label: "Save File", hint: "⌘S" },
  { kind: "action", id: "close_tab", label: "Close Tab", hint: "⌘W" },
  { kind: "action", id: "settings", label: "Open Settings", hint: "⌘," },
  { kind: "action", id: "shortcuts", label: "Keyboard Shortcuts", hint: "⌘/" },
  { kind: "action", id: "mobile_waitlist", label: "Aura on your phone: Join the waitlist…" },
  { kind: "action", id: "time_machine", label: "Time machine: Travel back & recover…", hint: "⌘⌥T" },
  { kind: "action", id: "workspaces", label: "Workspaces: See every parallel copy…", hint: "⌘⇧W" },
  { kind: "action", id: "machines", label: "Machines: Computers your agents can run on…" },
  { kind: "action", id: "tasks_board", label: "Open Tasks", hint: "⌘T" },
  { kind: "action", id: "orchestrate", label: "Orchestrate Multi-Step Session…" },
  { kind: "action", id: "notes", label: "Open Team Notes" },
  { kind: "action", id: "open_prs", label: "Open Pull Requests" },
  { kind: "action", id: "aura_ask", label: "Ask Aura about your repository…" },
  { kind: "action", id: "aura_status", label: "Aura: Repository Status" },
  { kind: "action", id: "aura_impacts", label: "Aura: Changes That Touch Your Work" },
  { kind: "action", id: "aura_snapshot", label: "Aura: Save a Point…" },
  { kind: "action", id: "aura_rewind", label: "Aura: Time Machine…" },
  { kind: "action", id: "aura_log_intent", label: "Aura: Add a Reason…", hint: "⌘⇧I" },
  { kind: "action", id: "aura_handover", label: "Aura: Hand Off to a New Chat" },
  { kind: "action", id: "aura_pr_review", label: "Aura: Review PR" },
  { kind: "action", id: "aura_prove", label: "Aura: Check It's Built…" },
];

const SLASH_ENTRIES: PaletteEntry[] = SLASH_COMMANDS.map((c) => ({
  kind: "slash",
  id: c.name,
  label: c.name,
  hint: c.description,
}));

// The fixed groups already carry these; the Aura group leaves them out.
const IN_CATALOG = new Set<AppActionId>(["toggle_sidebar", "toggle_review", "settings", "shortcuts"]);
// The cloud has no folder to save, run, rewind or search: of Aura's own
// actions it keeps the ones that need none.
const CLOUD_ACTIONS = new Set<AppActionId>(["open_aura", "machines", "mobile_waitlist"]);

/** Aura's own actions, below the fixed groups. */
function auraActions(kind: PlaceScope["kind"]): PaletteEntry[] {
  return APP_ACTIONS.filter(
    (e) => e.kind === "action" && !IN_CATALOG.has(e.id) && (kind !== "cloud" || CLOUD_ACTIONS.has(e.id)),
  );
}

const NO_RECENT: Array<{ path: string; name: string }> = [];
const NO_AGENTS: PaletteAgent[] = [];
const NO_PROJECTS: ProjectMeta[] = [];
const NO_WORKTREES: Record<string, WorktreeRef[]> = {};
const NO_BADGES: Record<string, WorktreeBadge> = {};
const ONLY_ARCHIVED: WorkspaceFilters = { owners: [], projects: [], archive: "archived" };

type CommandPaletteProps = {
  open: boolean;
  recentFiles?: Array<{ path: string; name: string }>;
  /** Available agents — palette uses these for `@` dispatch. */
  agents?: PaletteAgent[];
  /** When set, palette indexes the workspace via `fs_find_files` and
   *  surfaces matching files alongside actions/slash commands. The
   *  `:` prefix scopes results to files only. */
  repoRoot?: string;
  /** This computer's repositories, with their copies and badges, for the
   *  local place's workspace rows. */
  projects?: ProjectMeta[];
  worktreesByRoot?: Record<string, WorktreeRef[]>;
  badgeByPath?: Record<string, WorktreeBadge>;
  onClose: () => void;
  onPick: (entry: PaletteEntry) => void;
};

function scopeForQuery(q: string): { scope: PaletteLaneScope; rest: string } {
  if (q.startsWith(">")) return { scope: "aura", rest: q.slice(1).trimStart() };
  if (q.startsWith("@")) return { scope: "agent", rest: q.slice(1).trimStart() };
  if (q.startsWith("/")) return { scope: "slash", rest: q.slice(1).trimStart() };
  if (q.startsWith(":")) return { scope: "file", rest: q.slice(1).trimStart() };
  // `?` forces content-grep scope (Linear pattern: question mark = "what
  // is this thing"). Default `all` scope ALSO runs content grep async
  // once the query is long enough — see useEffect below.
  if (q.startsWith("?")) return { scope: "code", rest: q.slice(1).trimStart() };
  return { scope: "all", rest: q };
}

export function CommandPalette({
  open,
  recentFiles = NO_RECENT,
  agents = NO_AGENTS,
  repoRoot,
  projects = NO_PROJECTS,
  worktreesByRoot = NO_WORKTREES,
  badgeByPath = NO_BADGES,
  onClose,
  onPick,
}: CommandPaletteProps) {
  const scopeHere = usePlaceScope();
  const cloud = scopeHere.kind === "cloud";
  const local = scopeHere.kind === "local";
  // The cloud has no folder here: no files, code or reasons to search.
  const root = cloud ? undefined : repoRoot;
  const theme = useResolvedTheme();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<PaletteTab>("all");
  const [filters, setFilters] = useState<WorkspaceFilters>(DEFAULT_WORKSPACE_FILTERS);
  // The selected row's list value. The list moves it on arrows and hover.
  const [selected, setSelected] = useState("");
  const [feed, setFeed] = useState<PaletteWorkspaceFeed>(EMPTY_FEED);
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([]);
  // Set when a row is picked, so closing doesn't hand focus back to where it
  // was before the palette opened — the pick decides where focus goes.
  const pickedRef = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const pick = useCallback((entry: PaletteEntry) => {
    pickedRef.current = true;
    onPickRef.current(entry);
  }, []);
  const openPath = useCallback(
    (path: string) =>
      pick({
        kind: "workspace",
        id: `ws:${path}`,
        label: path.split("/").filter(Boolean).pop() ?? path,
        root: path,
        lastOpened: 0,
      }),
    [pick],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected("");
      setTab("all");
      setFilters(DEFAULT_WORKSPACE_FILTERS);
      pickedRef.current = false;
    } else {
      setFeed(EMPTY_FEED);
    }
  }, [open]);

  // The apps the open folder can be opened in, once per open.
  useEffect(() => {
    if (!open || !root) {
      setEditors([]);
      return;
    }
    let cancelled = false;
    api
      .editorsList()
      .then((rows) => {
        if (!cancelled) setEditors(rows.filter((e) => e.available).map((e) => ({ id: e.id, name: e.name })));
      })
      .catch(() => {
        if (!cancelled) setEditors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, root]);

  const { scope: lane, rest } = useMemo(() => scopeForQuery(query), [query]);
  const laneQuery = useDebouncedValue(rest, 140);
  const lanes = usePaletteLanes({ open, repoRoot: root, lane, query: laneQuery, conversations: !cloud });
  // The rows below scan thousands of paths, so they key off a debounced query.
  const debouncedRest = useDebouncedValue(rest, 60);

  const recentPathSet = useMemo(() => new Set(recentFiles.map((f) => f.path)), [recentFiles]);
  const fileEntries = useMemo<PaletteEntry[]>(() => {
    if (!root) return [];
    const recent = recentFiles.map<PaletteEntry>((f) => ({ kind: "file", id: f.path, label: f.name, hint: f.path }));
    const indexed = lanes.workspaceFiles
      .map((rel) => `${root}/${rel}`)
      .filter((abs) => !recentPathSet.has(abs))
      .map<PaletteEntry>((abs) => ({
        kind: "file",
        id: abs,
        label: abs.split("/").pop() ?? abs,
        hint: abs.slice(root.length + 1),
      }));
    return [...recent, ...indexed];
  }, [lanes.workspaceFiles, root, recentFiles, recentPathSet]);

  // The `@` view is its own picker — list agents (filtered by name) and let
  // pick = "send the rest of the prompt to that agent". It reads the RAW
  // query on purpose: `prompt` is the text that gets dispatched, so a
  // debounced snapshot would send a keystroke-stale prompt.
  const agentHits = useMemo<PaletteEntry[] | null>(() => {
    if (lane !== "agent") return null;
    const promptIdx = query.indexOf(" ");
    const namePart = promptIdx >= 0 ? query.slice(1, promptIdx).trim().toLowerCase() : rest.toLowerCase();
    const promptText = promptIdx >= 0 ? query.slice(promptIdx + 1).trim() : "";
    return agents
      .filter((a) => (namePart ? a.id.includes(namePart) || a.label.toLowerCase().includes(namePart) : true))
      .map<PaletteEntry>((a) => ({
        kind: "agent",
        id: a.id,
        label: a.label,
        hint: promptText
          ? `→ "${promptText.slice(0, 64)}${promptText.length > 64 ? "…" : ""}"`
          : "select to focus tab",
        prompt: promptText,
      }));
  }, [lane, query, rest, agents]);

  // A typed prefix narrows the list to one lane, drawn in its own sections.
  const prefixed = useMemo(() => {
    if (lane === "all") return null;
    if (lane === "agent") return groupHits(agentHits ?? []);
    const q = debouncedRest.toLowerCase().trim();
    const pool = [...APP_ACTIONS, ...SLASH_ENTRIES, ...fileEntries];
    return groupHits(laneHits({ lane, q, pool, symbolHits: lanes.symbolHits, grepHits: lanes.grepHits }));
  }, [lane, agentHits, debouncedRest, fileEntries, lanes.symbolHits, lanes.grepHits]);

  const place = useMemo<CatalogPlace>(
    () => ({
      kind: scopeHere.kind,
      hasWorkspace: !!root,
      canArchive: local && feed.canArchive,
      theme,
      editors,
    }),
    [scopeHere.kind, root, local, feed.canArchive, theme, editors],
  );
  const repositories = useMemo<PaletteRepository[] | null>(
    () => (local ? projects.map((p) => ({ id: p.id, name: p.name, repo: { kind: "local", root: p.id } })) : null),
    [local, projects],
  );
  const more = useMemo(() => auraActions(scopeHere.kind), [scopeHere.kind]);
  const sections = useMemo(() => {
    if (lane !== "all") return [];
    const q = debouncedRest.toLowerCase().trim();
    return buildPaletteSections({
      tab,
      query: debouncedRest,
      place,
      more,
      workspaces: feed.rows,
      activeId: feed.activeId,
      repositories,
      lanes: allLaneHits({
        q,
        files: fileEntries,
        commands: SLASH_ENTRIES,
        symbolHits: lanes.symbolHits,
        grepHits: lanes.grepHits,
        intentRows: lanes.intentRows,
        chatHits: lanes.chatHits,
      }),
      filters,
    });
  }, [
    lane,
    tab,
    debouncedRest,
    place,
    more,
    feed,
    repositories,
    fileEntries,
    lanes.symbolHits,
    lanes.grepHits,
    lanes.intentRows,
    lanes.chatHits,
    filters,
  ]);

  const keys = useMemo(
    () => (prefixed ? prefixed.flat.map(paletteKey) : sectionKeys(sections)),
    [prefixed, sections],
  );

  // A new query or tab starts on its top row, the way typing always has; rows
  // that land later (code search, chats) leave the row you moved to alone
  // while it is still listed. If the selected row drops out, the top row takes
  // over, so Enter always has something to run.
  const lastQueryRef = useRef("");
  useEffect(() => {
    const queryKey = `${tab}\u0000${lane}\u0000${debouncedRest}`;
    const fresh = lastQueryRef.current !== queryKey;
    lastQueryRef.current = queryKey;
    if (keys.length === 0) return;
    if (fresh || !keys.includes(selected)) setSelected(keys[0]);
  }, [keys, tab, lane, debouncedRest, selected]);

  const close = useCallback(() => {
    pickedRef.current = true;
    onClose();
  }, [onClose]);

  const runContext: CatalogRunContext = {
    repoRoot: root,
    theme,
    action: (id, label) => pick({ kind: "action", id, label }),
    setQuery: (text) => {
      setTab("all");
      setQuery(text);
    },
    showArchived: () => {
      setTab("workspaces");
      setFilters(ONLY_ARCHIVED);
      setQuery("");
    },
    close,
  };

  const pickRow = (row: PaletteRow) => {
    switch (row.type) {
      case "catalog":
        runCatalogItem(row.item, runContext);
        return;
      case "entry":
        pick(row.entry);
        return;
      case "workspace":
        feed.open(row.row);
        close();
        return;
      case "repository": {
        // A repository opens on its latest workspace still going, else itself.
        const latest = feed.rows
          .filter((r) => r.projectId === row.repo.id && !r.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (latest) feed.open(latest);
        else openPath(row.repo.id);
        close();
        return;
      }
      case "none":
        return;
    }
  };

  // Tab and Shift-Tab step through the tabs; the arrows move the rows.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (!prefixed) setTab((at) => stepPaletteTab(at, local, e.shiftKey));
  };

  const scopeLabel =
    lane === "aura"
      ? "Aura"
      : lane === "agent"
        ? "Agent"
        : lane === "file"
          ? "File"
          : lane === "code"
            ? "Code"
            : lane === "slash"
              ? "Slash"
              : null;
  const busy = lanes.searching || lanes.chatSearching;
  const filtered = tab === "workspaces" && filtersActive(filters);

  return (
    <>
      {open &&
        (scopeHere.kind === "cloud" ? (
          <CloudWorkspaceFeed onFeed={setFeed} />
        ) : scopeHere.kind === "machine" ? (
          <MachineWorkspaceFeed machineId={scopeHere.machineId} onFeed={setFeed} />
        ) : (
          <LocalWorkspaceFeed
            scope={scopeHere}
            projects={projects}
            worktreesByRoot={worktreesByRoot}
            badgeByPath={badgeByPath}
            activePath={repoRoot ?? ""}
            openPath={openPath}
            onFeed={setFeed}
          />
        ))}
      <CommandDialog
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title="Search"
        description="Search workspaces, actions, settings, files and code. Start with @ for an agent, / for a command or : for a file."
        className="ui-command-palette-dialog"
        onCloseAutoFocus={(e) => {
          if (pickedRef.current) e.preventDefault();
        }}
        commandProps={{
          shouldFilter: false,
          loop: true,
          value: selected,
          onValueChange: setSelected,
          onKeyDown,
        }}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={palettePlaceholder(tab)}
          aria-label="Search workspaces, actions, settings, files and code"
          leading={scopeLabel && <Badge variant="secondary">{scopeLabel}</Badge>}
          trailing={busy && <AsciiSpinner />}
        />
        {!prefixed && (
          <PaletteTabsRow
            tab={tab}
            showRepositories={local}
            onTab={setTab}
            actions={
              tab === "workspaces" ? (
                <PaletteWorkspaceFilters
                  filters={filters}
                  onChange={setFilters}
                  members={feed.members}
                  repositories={repositoriesOf(feed.rows)}
                />
              ) : undefined
            }
          />
        )}
        <CommandList className="ui-command-palette-list">
          {prefixed ? (
            prefixed.flat.length === 0 ? (
              busy ? (
                <div className="ui-command-empty">
                  <AsciiSpinner />
                </div>
              ) : (
                <CommandEmpty>No matches</CommandEmpty>
              )
            ) : (
              prefixed.sections.map((section) => (
                <CommandGroup key={section.key} heading={section.label}>
                  {section.items.map((e) => (
                    <PaletteResultRow key={paletteKey(e)} entry={e} query={rest} onPick={() => pick(e)} />
                  ))}
                </CommandGroup>
              ))
            )
          ) : sections.length === 0 ? (
            filtered ? (
              <div className="ui-command-palette-ws-empty">
                <span>No matching workspaces</span>
                <Button variant="outline" size="sm" onClick={() => setFilters(CLEARED_WORKSPACE_FILTERS)}>
                  Clear filters
                </Button>
              </div>
            ) : (
              <CommandEmpty>{paletteNoMatch(tab)}</CommandEmpty>
            )
          ) : (
            sections.map((section) => (
              <CommandGroup key={section.key} heading={section.heading}>
                {section.rows.map((row) => (
                  <PaletteSectionRow key={row.key} row={row} query={rest} showNumber={cloud} onPick={pickRow} />
                ))}
              </CommandGroup>
            ))
          )}
        </CommandList>
        {lanes.grepTruncated && (
          <p className="ui-command-palette-note">Showing the first matches. Type a bit more to narrow it down.</p>
        )}
      </CommandDialog>
    </>
  );
}
