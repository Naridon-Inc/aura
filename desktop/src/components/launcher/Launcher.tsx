// One launcher, for the one question the app asks in two places: what goes in
// this pane?
//
// It was answered twice. An empty pane rendered EmptyPanePicker — a grid of
// tiles headed "Start something new", a project chooser, and three menus for
// the starts that need a choice first (a local endpoint, an isolated login, a
// lane). The "+" on a tab strip rendered PaneAddPopover — a searchable,
// keyboard-drivable list headed "Start here", with none of those four, but
// with plan tabs, which the other didn't list.
//
// So the two doors onto one thing each did something the other couldn't, and
// which capabilities you got depended on which one you had opened. This is that
// body, once: the popover's interaction (search, ↑↓, Enter — the better one)
// with the pane's reach (every project, every way of starting an agent).
//
// The five kind chips the pane used to carry — all / agents / terminals /
// managers / files — are gone, and the search took their job: every row's kind
// is part of what it matches on, so "terminal" finds terminals whatever they
// have been renamed to. One filter, not two that disagree.

import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { SearchX } from "lucide-react";
import { placeForNewWork, writeAmbientSid } from "../../lib/ambientSession";
import { TRACE_V2 } from "../../lib/featureFlags";
import { letterMark } from "../../lib/monogram";

import {
  newBrowserTabId,
  openRemoteWorkspace,
  samePaneRef,
  useEditorStore,
  type WorkPaneRef,
} from "../../lib/editorStore";
import { remoteProjectPath } from "../../lib/workspaceCreateStore";
import { WherePicker, useWherePlaces } from "../place/WherePicker";
import {
  labelForAgentId,
  useLiveAgentSessions,
} from "../../lib/useLiveAgentSessions";
import {
  api,
  type Lane,
  type LiveAgentSession,
  type OpenAiCompatProfile,
  type ProjectEntry,
} from "../../lib/api";
import { MANAGER_AGENT, useAgents } from "../../lib/agents";
import { usePinned } from "../../lib/agentPrefs";
import { isManagedWorktreeRoot } from "../../lib/hudProjects";
import { AgentIcon } from "../agent/AgentIcon";
import { TabMark, projectName } from "../TabMark";
import { EmptyState } from "../ui/state";
import { Input } from "../ui/input";
import { Segment } from "../ui/segment";
import { titleCaseName } from "../../lib/textCase";
import { toast } from "../../lib/toast";
import { EarlierBody, useEarlierSessions } from "./earlierSessions";
import { Group, PickRow, type Row } from "./row";
import {
  IsolatedSpawnMenu,
  LaneSpawnMenu,
  LocalModelsSpawnMenu,
  ProjectSpawnTarget,
  SearchGlyph,
} from "./starters";

/** Which half of the panel is showing. Two questions, not two filters: one is
 *  about what exists right now, the other about what happened here before. */
type Mode = "now" | "earlier";

export function Launcher({
  currentRepoRoot,
  present,
  place,
  autoFocus,
  onPicked,
  variant = "panel",
  className,
}: {
  /** The workspace this launcher belongs to. Labels foreign rows, and is the
   *  default project anything it starts opens in. */
  currentRepoRoot: string;
  /** Tabs already in the pane being filled — not offered, since putting one
   *  where it already is does nothing. */
  present: WorkPaneRef[];
  /** Put a ref in the pane this launcher is filling. The two hosts differ only
   *  here: an empty pane replaces its slot, a "+" adds a tab. */
  place: (ref: WorkPaneRef) => void;
  /** A popover opens under the pointer and should take the keyboard with it. A
   *  pane must not steal focus from whatever the reader was doing. */
  autoFocus?: boolean;
  /** Popovers close on a pick; a pane is replaced by what it started. */
  onPicked?: () => void;
  /** "panel" (default) is the full body: search, list, and the three starts
   *  that ask a second question first. "compact" drops that last row.
   *
   *  It isn't a smaller panel — it's a different audience. The "+" and an
   *  empty split are chosen by someone who has already decided to start
   *  something; the whole empty work surface is what you LAND on, and a row of
   *  three menus reading "Local model… / Isolated… / New lane…" is the first
   *  thing there to no one who came to start a Claude. They keep working
   *  where they were, one click further in. */
  variant?: "panel" | "compact";
  className?: string;
}) {
  const store = useEditorStore();
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>("now");
  const live = useLiveAgentSessions();
  const { agents, loading: agentsLoading } = useAgents();
  const pins = usePinned();

  // Which project new tabs open in. Defaults to this pane's own workspace; the
  // chooser retargets any other known project, so a split can hold a Claude
  // from project B beside project A. Interactive surfaces carry their own
  // repoRoot on the tab, so a foreign start stays correctly scoped.
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [spawnRoot, setSpawnRoot] = useState(currentRepoRoot);
  useEffect(() => {
    void api
      .projectsList()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);
  // A launcher can outlive the workspace it was mounted in — the empty surface
  // stays mounted across a project switch. Without this the target stayed
  // pinned to the workspace the reader LEFT, and the next thing they started
  // opened in it.
  useEffect(() => {
    setSpawnRoot(currentRepoRoot);
  }, [currentRepoRoot]);

  // A managed worktree is a checkout the user deliberately isolated to hold one
  // piece of work. Offering to start the next thing in a different project from
  // inside it inverts that: the pane's own root is the answer, and a picker
  // that can only take you somewhere else is a control with nothing true to
  // say here. (Every other project is still one click away in the rail.)
  const inWorktree = isManagedWorktreeRoot(currentRepoRoot);
  const hasOtherProjects =
    !inWorktree && projects.some((p) => p.root !== currentRepoRoot);

  // Which COMPUTER the next thing runs on. The project chooser beside it says
  // which code; this says where the work happens to it, and until now the
  // second question had no asking here at all — a start from this panel was
  // always on this laptop, and pointing one at a box meant walking into the
  // box's own page first. Same control, same rows and same two rules as the
  // New-workspace dialog, because a person who has connected a box has
  // connected it for both doors.
  const places = useWherePlaces(spawnRoot, projectName(spawnRoot));
  const onABox = places.chosen.machineId;

  function pick(ref: WorkPaneRef) {
    place(ref);
    onPicked?.();
  }

  /** Adopt a running agent that has no tab here yet, then place it. The tab
   *  carries the SESSION's own repoRoot, not this workspace's, so a foreign
   *  agent's streams, git context and title stay scoped to the project it
   *  actually runs in. */
  function adopt(s: LiveAgentSession, label: string) {
    store.openAgent({
      sessionId: s.session_id,
      agentId: s.agent_id,
      agentLabel: label,
      agentMonogram: letterMark(label),
      repoRoot: s.repo_root,
      mode: "pty",
    });
    pick({ kind: "agent", id: s.session_id });
  }

  /** Aura is a peer in this list, and the only row in it that is not a
   *  program. The orchestrator runs inside the shell process; every other
   *  starter is a CLI that discovery found on PATH.
   *
   *  `agent_pty_open` resolves an id against the registry of installed
   *  binaries, so handing it `aura-manager` asked for an executable that was
   *  never meant to exist and the click came back as
   *  "unknown agent: aura-manager". `App` has had the right branch all along
   *  behind the sidebar row and ⌘⌥A; this door didn't — and it is the first
   *  tile in the list, on the surface you LAND on, which in a fresh worktree
   *  is the only thing on screen.
   *
   *  Same route as App's: stage a chat session in the orchestrator runtime,
   *  place it here as a manager tab. */
  /** Start it over there instead.
   *
   *  Nothing runs on this laptop: `box_start` puts a tmux session on the box, in
   *  that project's copy, and it keeps running after the wifi drops — which is
   *  the reason for having a box at all. There is no local PTY to place in this
   *  pane, so the pick opens the machine's workspace, where the session it just
   *  started is the one already attached. */
  async function startOnBox(machineId: string, agentId: string | null, label: string) {
    try {
      const project = await remoteProjectPath(
        machineId,
        spawnRoot,
        places.chosen.projectPath,
      );
      await api.boxStart(machineId, {
        project,
        kind: agentId ? "agent" : "shell",
        agent: agentId,
        title: label,
      });
      openRemoteWorkspace({ machineId, repoRoot: spawnRoot });
      onPicked?.();
    } catch (e) {
      toast.danger(`Couldn't start ${label} on ${places.chosen.label}`, String(e));
    }
  }

  async function startManagerChat(label: string) {
    try {
      // Where this launcher is standing — or where you told it to stand. The
      // picker's answer wins; `placeForNewWork` infers it for a launcher opened
      // without one. Either way the chat's hands are where its files are, and
      // the ambient pointer is written against the same place, so a machine's
      // conversation can't later be handed back as the local one.
      const place = onABox ?? placeForNewWork(spawnRoot);
      const sid = await api.managerChatStart(spawnRoot, "", place ?? undefined);
      store.openManager(sid, "New chat");
      writeAmbientSid(spawnRoot, place, sid);
      pick({ kind: "manager", id: sid });
    } catch (e) {
      toast.danger(`Couldn't start ${label}`, String(e));
    }
  }

  async function startAgent(agentId: string, label: string, profileName?: string) {
    if (agentId === MANAGER_AGENT.id) {
      await startManagerChat(label);
      return;
    }
    if (onABox) {
      await startOnBox(onABox, agentId, label);
      return;
    }
    try {
      // Same place, same reason — an agent CLI started here runs on the machine
      // this launcher is standing in, holding its work under tmux over there so
      // it survives the connection, rather than editing a different copy of the
      // project on this disk. Read once and used twice: the tab has to be filed
      // under the place the agent was actually started in, or Restart would
      // send it somewhere else.
      const place = placeForNewWork(spawnRoot);
      const handle = await api.agentPtyOpen(
        agentId,
        spawnRoot,
        80,
        24,
        undefined,
        true,
        profileName,
        undefined,
        place,
      );
      const decorated = profileName ? `${label} · ${profileName}` : label;
      store.openAgent({
        sessionId: handle.id,
        agentId,
        agentLabel: decorated,
        agentMonogram: letterMark(label),
        repoRoot: spawnRoot,
        mode: "pty",
        machineId: place,
      });
      pick({ kind: "agent", id: handle.id });
    } catch (e) {
      // This is the app's one way to launch an agent. A console.warn left
      // the popover sitting there looking unresponsive with no clue that
      // the spawn had failed — the CLI missing, the profile broken, the
      // repo gone.
      toast.danger(`Couldn't start ${label}`, String(e));
    }
  }

  // openai-compat = an HTTP chat-completions adapter (Ollama / HF / Together /
  // Groq / OpenRouter / vLLM). These don't start a process — we mint a session
  // id locally and open a chat tab against the endpoint.
  function startLocalModel(profile: OpenAiCompatProfile) {
    // Stable in (profile, repo) so re-opening focuses rather than duplicating,
    // with a short random suffix on first open so two panes can genuinely hold
    // the same profile side by side.
    const sessionId = `oai-compat:${profile.name}:${spawnRoot}:${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    store.openAgent({
      sessionId,
      agentId: "openai-compat",
      agentLabel: profile.name,
      agentMonogram: letterMark(profile.name),
      repoRoot: spawnRoot,
      mode: "chat",
      openaiCompatProfile: profile.name,
    });
    pick({ kind: "agent", id: sessionId });
  }

  // A lane is an isolated worktree with its own agent PTY (AURA-81). The
  // switcher already created or focused it; we place its live agent. The tab's
  // repoRoot is the lane's own worktree path, so its streams and git status stay
  // scoped to the lane and never collide with the main checkout. A paused lane
  // has no live PTY and nothing to place — the switcher shows its state.
  function placeLaneAgent(lane: Lane) {
    if (!lane.termId) return;
    const label = lane.label || `${titleCaseName(lane.agent)} lane`;
    store.openAgent({
      sessionId: lane.termId,
      agentId: lane.agent,
      agentLabel: label,
      agentMonogram: letterMark(label),
      repoRoot: lane.path,
      mode: "pty",
    });
    pick({ kind: "agent", id: lane.termId });
  }

  // Start something new: every agent installed on this machine, then the two
  // surfaces that need nothing but a working directory.
  //
  // The agent list is reality — `useAgents` only reports what's actually on
  // PATH, so a tile can't launch a PTY that dies on "command not found", and no
  // installed agent is hidden behind a hardcoded four. Pins order the list,
  // they don't gate it.
  const starters = useMemo<Row[]>(() => {
    const runnable = agents.filter((a) => a.available);
    const ordered = [
      ...runnable.filter((a) => pins.isPinned(a.id)),
      ...runnable.filter((a) => !pins.isPinned(a.id)),
    ];
    // What the row says under its name. The project, and — only when that is
    // not this laptop — the computer it will happen on, so the answer to "where
    // did that just start" is on the row you clicked rather than in a chip
    // above it.
    const project = projectName(spawnRoot);
    const where = onABox ? `${project} · ${places.chosen.label}` : project;
    return [
      ...ordered.map((a) => ({
        key: `new:${a.id}`,
        label: a.label,
        sub: where,
        kind: "agent",
        icon: (
          <AgentIcon agentId={a.id} label={a.monogram ?? a.label} size={13} />
        ),
        onPick: () => void startAgent(a.id, a.label),
      })),
      {
        key: "new:terminal",
        label: "Terminal",
        sub: where,
        kind: "terminal shell",
        icon: <TabMark refr={{ kind: "terminal", id: "" }} label="" size={13} />,
        onPick: () => {
          if (onABox) {
            void startOnBox(onABox, null, "Terminal");
            return;
          }
          const id = store.openTerminal(spawnRoot, { label: "Terminal" });
          pick({ kind: "terminal", id });
        },
      },
      {
        key: "new:browser",
        label: "Browser",
        sub: "",
        kind: "browser web",
        icon: <TabMark refr={{ kind: "browser", id: "" }} label="" size={13} />,
        onPick: () => pick({ kind: "browser", id: newBrowserTabId() }),
      },
    ];
    // The store and `pick` outlive a picker that unmounts the moment it's used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, pins.pinned, spawnRoot, onABox, places.chosen.label]);

  // Discovery hasn't answered, or answered with nothing on PATH. Either way the
  // list above is Terminal + Browser alone, and saying why beats leaving the
  // reader to conclude a pane can't hold an agent at all.
  const noAgents = !agentsLoading && !agents.some((a) => a.available);

  /** Everything already open or already running that isn't in this pane. */
  const openRows = useMemo<Row[]>(() => {
    const here = (r: WorkPaneRef) => present.some((x) => samePaneRef(x, r));
    const out: Row[] = [];

    for (const t of store.agentTabs) {
      const r: WorkPaneRef = { kind: "agent", id: t.sessionId };
      if (here(r)) continue;
      const foreign = t.repoRoot !== currentRepoRoot;
      out.push({
        key: `a:${t.sessionId}`,
        label: t.agentLabel,
        // The project this run lives in — never the raw session hash. Shown
        // only when it ISN'T this project: repeating the current one on every
        // row spends the slot saying nothing, and its absence is then the
        // signal that a row is from here.
        sub: foreign ? projectName(t.repoRoot) : "",
        kind: "agent",
        icon: (
          <TabMark refr={r} label={t.agentLabel} agentId={t.agentId} size={13} />
        ),
        onPick: () => pick(r),
      });
    }
    for (const t of store.terminalTabs) {
      const r: WorkPaneRef = { kind: "terminal", id: t.termId };
      if (here(r)) continue;
      const label = t.label ?? "Terminal";
      const foreign = t.cwd !== currentRepoRoot;
      out.push({
        key: `t:${t.termId}`,
        label,
        sub: foreign ? projectName(t.cwd) : "",
        kind: "terminal shell",
        icon: <TabMark refr={r} label={label} size={13} />,
        onPick: () => pick(r),
      });
    }
    for (const t of store.managerTabs) {
      const r: WorkPaneRef = { kind: "manager", id: t.sessionId };
      if (here(r)) continue;
      const label = t.label || "Aura";
      out.push({
        key: `m:${t.sessionId}`,
        label,
        // A plain descriptor, never the raw session hash — an 8-character id
        // tells the reader nothing about which chat this is.
        sub: "Aura chat",
        kind: "chat",
        icon: (
          <TabMark refr={r} label={label} agentId="aura-manager" size={13} />
        ),
        onPick: () => pick(r),
      });
    }
    for (const p of store.planTabs) {
      const r: WorkPaneRef = { kind: "plan", id: p.id };
      if (here(r)) continue;
      const label = p.title || "Plan";
      out.push({
        key: `p:${p.id}`,
        label,
        // The words the plan's own tab prints, so the row and the surface
        // behind it don't count the same list in two nouns.
        sub: `${p.todos.length} task${p.todos.length === 1 ? "" : "s"}`,
        kind: "plan",
        icon: (
          <TabMark refr={r} label={label} agentId="aura-manager" size={13} />
        ),
        onPick: () => pick(r),
      });
    }
    for (const f of store.files) {
      const r: WorkPaneRef = { kind: "file", path: f.path };
      if (here(r)) continue;
      const label = f.name || baseName(f.path);
      out.push({
        key: `f:${f.path}`,
        label,
        sub: dirName(f.path),
        kind: "file",
        icon: <TabMark refr={r} label={label} size={13} />,
        onPick: () => pick(r),
      });
    }

    // Agents running in other panes, other worktrees, other projects. Their
    // absence is what once made a picker report an empty machine to someone
    // with six agents running.
    const known = new Set(store.agentTabs.map((t) => t.sessionId));
    for (const s of live) {
      if (known.has(s.session_id)) continue;
      const r: WorkPaneRef = { kind: "agent", id: s.session_id };
      if (here(r)) continue;
      const base = labelForAgentId(s.agent_id);
      const title = s.title?.trim();
      // The window title is what the agent is actually doing — the only thing
      // that tells one Claude from the next.
      const label = title ? `${base} · ${title}` : base;
      out.push({
        key: `l:${s.session_id}`,
        label,
        sub: projectName(s.repo_root),
        kind: "agent",
        icon: <TabMark refr={r} label={label} agentId={s.agent_id} size={13} />,
        running: true,
        onPick: () => adopt(s, label),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    present,
    store.agentTabs,
    store.terminalTabs,
    store.managerTabs,
    store.planTabs,
    store.files,
    live,
    currentRepoRoot,
  ]);

  // The other half of the panel: what ran here before. Read whether or not the
  // reader is looking at it, so the strip can say how many there are and the
  // switch lands on a list rather than a spinner.
  const earlier = useEarlierSessions(currentRepoRoot, pick);
  const canSwitch = variant === "compact";
  const showing: Mode = canSwitch ? mode : "now";

  const q = filter.trim().toLowerCase();
  const match = (r: Row) =>
    !q ||
    r.label.toLowerCase().includes(q) ||
    r.sub.toLowerCase().includes(q) ||
    r.kind.includes(q);
  const shownStarters = useMemo(() => starters.filter(match), [starters, q]);
  const shownOpen = useMemo(() => openRows.filter(match), [openRows, q]);
  const shownEarlier = useMemo(
    () => earlier.rows.filter(match),
    [earlier.rows, q],
  );
  // One cursor over whatever the panel is currently showing — Enter must pick
  // the row the reader can see, never one on the side they switched away from.
  const flat = useMemo(
    () =>
      showing === "earlier" ? shownEarlier : [...shownStarters, ...shownOpen],
    [showing, shownEarlier, shownStarters, shownOpen],
  );

  // A search box that autofocuses and then ignores the keyboard is a control
  // that looks finished and isn't: you could type to narrow the list and then
  // had to reach for the mouse to choose from it.
  useEffect(() => {
    setCursor(0);
  }, [q, showing]);
  const active = flat[Math.min(cursor, Math.max(flat.length - 1, 0))];
  function onKeyDown(e: ReactKeyboardEvent) {
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      active?.onPick();
    }
  }

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      <div
        className={`flex items-center gap-2 border-b border-line-soft flex-shrink-0 ${
          variant === "compact" ? "px-2 py-1.5" : "px-2 py-2"
        }`}
      >
        <Input
          autoFocus={autoFocus}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onKeyDown}
          // The glyph says "search"; the placeholder is then free to say what
          // is searchable instead of spending its width on the word. Compact
          // gets the short one — the long sentence truncates in a pane.
          prefix={<SearchGlyph />}
          placeholder={
            variant === "compact"
              ? "Search or start…"
              : "Anything running, in any project…"
          }
          size="small"
          className="flex-1 min-w-0 text-sm"
        />
        {hasOtherProjects && (
          <ProjectSpawnTarget
            projects={projects}
            value={spawnRoot}
            currentRepoRoot={currentRepoRoot}
            onChange={setSpawnRoot}
          />
        )}
        {/* Always, and with the same rows as the New-workspace dialog. Where a
            person has no box and the project has no cloud it reads "This
            laptop" and opens onto that one row — a true answer, not a disabled
            one — and the question is in the same place, worded the same way,
            on the day they connect their first box. */}
        <WherePicker places={places} />
      </div>

      {/* Two questions, one panel. "What can I start" is answered by everything
          on this machine right now; "what was I doing here" is answered by this
          repo's own transcripts, and the reader arriving at an empty surface
          has as often come for the second. A segmented switch is the app's one
          way of saying these are two views of one thing rather than two
          places. Only where a reader LANDS — see `variant`. */}
      {canSwitch && (
        <div className="flex-shrink-0 px-2 py-1.5 border-b border-line-soft">
          <Segment<Mode>
            size="xs"
            stretch
            ariaLabel="What this pane is showing"
            value={showing}
            onChange={setMode}
            options={[
              { value: "now", label: "Start something new" },
              {
                value: "earlier",
                label:
                  earlier.total > 0
                    ? `Earlier sessions · ${earlier.total}`
                    : "Earlier sessions",
              },
            ]}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {flat.length === 0 && q ? (
          <EmptyState
            icon={SearchX}
            title="Nothing matches"
            body={
              showing === "earlier"
                ? earlier.total > 0
                  ? `${earlier.total} earlier session${earlier.total === 1 ? "" : "s"} here. None of them match “${filter.trim()}”.`
                  : "Nothing has run here yet to match."
                : openRows.length > 0
                  ? `${openRows.length} thing${openRows.length === 1 ? "" : "s"} could go in this pane. None of them match “${filter.trim()}”.`
                  : "Nothing is open to match yet."
            }
            action={{ label: "Clear search", onClick: () => setFilter("") }}
            size="sm"
          />
        ) : showing === "earlier" ? (
          <EarlierBody
            rows={shownEarlier}
            state={earlier}
            activeKey={active?.key}
            onOpenHistory={
              TRACE_V2 ? () => store.openSessions("sessions") : undefined
            }
          />
        ) : (
          <>
            <Group label="Start something new">
              {shownStarters.map((r) => (
                <PickRow key={r.key} row={r} active={active?.key === r.key} />
              ))}
              {noAgents && (
                <p className="px-3 pt-1 pb-1 text-xs leading-relaxed text-text-4">
                  No coding agents found on this machine. Install one and it
                  shows up here. Settings ▸ Coding agents lists the ones Aura
                  looks for.
                </p>
              )}
            </Group>
            {shownOpen.length > 0 ? (
              <Group label="Or move something here">
                {shownOpen.map((r) => (
                  <PickRow key={r.key} row={r} active={active?.key === r.key} />
                ))}
              </Group>
            ) : (
              // Genuinely nothing else on the machine — a different fact from
              // "your search found nothing", and it earns a different sentence.
              // It points UP, into this same list, because starting something
              // is a row above rather than an errand elsewhere in the app.
              <p className="px-3 pb-3 pt-2 text-xs leading-relaxed text-text-4">
                Nothing else is open or running. Anywhere. Start something from
                the rows above.
              </p>
            )}
          </>
        )}
      </div>

      {/* The three starts that need a choice made first — which endpoint, which
          login, which lane. They sit below the scrolling list, not in it: each
          one asks a second question instead of doing the thing, and a row that
          opens a menu behaves differently from every row above it.
          Outside the scroll area is also the only place their flyouts can open
          without being clipped by it. Not in `compact` — see `variant`.

          All three are this laptop's own machinery — an HTTP endpoint here, a
          login container here, a worktree here — so they step aside entirely
          when the work is going to a box, rather than sitting there offering
          something that place cannot do. */}
      {variant === "panel" && !onABox && (
        <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-t border-line-soft flex-shrink-0">
          <LocalModelsSpawnMenu onSpawn={startLocalModel} />
          <IsolatedSpawnMenu onSpawn={startAgent} />
          <LaneSpawnMenu repoRoot={spawnRoot} onFocusLane={placeLaneAgent} />
        </div>
      )}
    </div>
  );
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
