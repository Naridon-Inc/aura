// A workspace on a machine that isn't this one.
//
// Cloud work first appeared here as a *tab*: you clicked a cloud row and got a
// transcript pane in the main strip, beside your local files. That was wrong in
// the way that matters — it made the machine a document. The work is not a
// document; it is a place, with a shell, a project directory and whichever
// agents are installed there. Opening it should feel like opening a workspace,
// because that is what it is.
//
// So this is a workspace, and it is genuinely remote: every tab in it is a real
// SSH session to the box. The shells run there. The agents run there — on their
// CPU, their disk, their sign-ins. Nothing is fetched to this laptop, no branch
// is checked out here, and closing the window doesn't drag any of it home. The
// conversation with the runner sits in the same strip because it is the same
// machine, seen from the board's side instead of the shell's.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Eye,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import { api, type BoxSession, type CloudRunner, type Machine } from "../../lib/api";
import { resolveMachine } from "../../lib/activeMachine";
import { isAsleep, placeOfMachine, projectToFilePlaceUnder } from "../../lib/place";
import { remotePlaceKey, type RemotePlace } from "../../lib/remotePlaces";
import { remotePlace } from "../../lib/placeRef";
import { openPopout } from "../../lib/popout";
import type { RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import { releaseTerminalSession } from "../Terminal";
import { AgentIcon } from "../agent/AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { CloudGlyph } from "../ui/cloud-glyph";
import { Input } from "../ui/input";
import { ConnectMachineWizard } from "../commons/crew/ConnectMachineWizard";
import {
  MENU_LABEL,
  MENU_PANEL,
  MENU_ROW,
  MENU_SEP,
} from "../ui/menuSurface";
import { BoxPanel } from "./BoxPanel";
import { CloudThreadPane } from "./CloudThreadPane";
import { MachineChat } from "./MachineChat";
import { RemoteSessionTerminal } from "./RemoteSessionTerminal";
import {
  instanceIdFor,
  machineToOpen,
  missingMachine,
  runnerFor,
  sessionToGreet,
} from "./machineWorkspace";
import { sessionLabel, useBox, type BoxState } from "./useBox";
import { useRemoteTabs } from "./useRemoteTabs";

/** How often we re-ask the board whether the box is up. The board is the only
 *  honest source: a machine in another datacentre leaves no trace on this disk
 *  whether it's running or stopped. */
const LIVENESS_EVERY_MS = 30_000;

/** Which machine to open, how you got there, and whose board the conversation
 *  belongs to. One definition, in lib/remotePlaces, because the window holds a
 *  SET of these now and the set's identity rules have to be the same ones this
 *  component is opened under. */
export type RemoteWorkspaceEntry = RemotePlace;

export function RemoteWorkspace({
  entry,
  onClose,
}: {
  entry: RemoteWorkspaceEntry;
  onClose: () => void;
}) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  // The wizard is mounted here rather than signalled to some other surface:
  // "I have no machine" and "here is how you get one" have to be one screen, or
  // the empty state is a dead end with a button that changes the subject.
  const [connecting, setConnecting] = useState(false);
  const [machineId, setMachineId] = useState<string | null>(
    entry.machineId ?? null,
  );
  const [runners, setRunners] = useState<CloudRunner[] | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .machinesList()
      .then((list) => {
        if (!alive) return;
        setMachines(list);
        setMachineId((id) => machineToOpen(id, list));
      })
      .catch(() => alive && setMachines([]));
    return () => {
      alive = false;
    };
  }, []);

  const machine = useMemo(
    () => machines?.find((m) => m.id === machineId) ?? null,
    [machines, machineId],
  );

  // The box, asked as a place. Everything below that asks a question ABOUT it —
  // where it files, whether a terminal can open on it, how a session boots —
  // asks it of this rather than of the machine row, so the same question can be
  // put to a place that isn't a box without a second spelling of it.
  const place = useMemo(
    () => (machine ? placeOfMachine(machine) : null),
    [machine],
  );

  // Named rather than silently swapped, and only once the book has been read —
  // see `missingMachine`. We claim "no machines" only when there genuinely are
  // none.
  const missingMachineId = missingMachine(machines, machineId);

  // Order matters: mark it used only once we actually have it, so a failed read
  // doesn't reorder the book.
  useEffect(() => {
    if (machine) void api.machineTouch(machine.id).catch(() => {});
  }, [machine?.id]);

  // File the box under the project it is a cloud copy of, if it never learned
  // one. Entering is when this is free to know — you clicked it from a project,
  // or arrived through a conversation that names its repo — and it is what lets
  // the rail draw the machine beside that project's own copies instead of off
  // on its own. A box that already knows is left alone: re-filing it by where
  // you came from would make its position in the sidebar wander.
  useEffect(() => {
    const root = projectToFilePlaceUnder(place, entry.repoRoot);
    if (!root || !machine) return;
    void api.machineSetProject(machine.id, root).then(
      // Re-read rather than patch in place: the book is the source of truth for
      // what the rail will draw, and a local edit that silently disagreed with
      // it is how a row ends up in two places at once.
      () => api.machinesList().then(setMachines).catch(() => {}),
      () => {},
    );
  }, [machine?.id, machine?.project_root, entry.repoRoot]);

  // Tell the sidebar what this entry turned out to be. This component is the
  // only place that knows: `entry.machineId` is a request that may be absent (a
  // workspace opened from a cloud conversation names a thread, not a box) and
  // may name a machine the book no longer holds. What got resolved is the
  // answer, and the rail beside us needs it to light the row you're standing in
  // — the thread too, when that's the row you clicked to get here.
  //
  // Membership and focus are NOT ours to publish: the window can hold several
  // machines at once, and only App knows which ones and which is in front. We
  // name our own place by the same key App filed it under, and say what it
  // resolved to. Nothing is retracted on unmount — a blurred place is still
  // open, and a left one has already been dropped from the set by App.
  //
  // The project goes with it, and for the same reason: a door elsewhere in the
  // window (⌘N, the launcher, a background job) asks which machine work on a
  // project runs on, and the entry may never have named one — the box itself
  // knows, and this is where that is worked out.
  const placeKey = remotePlaceKey(entry);
  const placeRepoRoot = entry.repoRoot ?? machine?.project_root ?? null;
  useEffect(() => {
    resolveMachine(
      placeKey,
      machine?.id ?? null,
      entry.threadKey ?? null,
      placeRepoRoot,
    );
  }, [placeKey, machine?.id, entry.threadKey, placeRepoRoot]);

  // Is it up? Asked of the board, repeatedly, because the answer changes under
  // you — a box you stopped last night is not a box you can open a shell on,
  // and a terminal that just sits there is a worse way to learn that.
  useEffect(() => {
    let alive = true;
    const read = () => {
      api
        .cloudRunners()
        .then((rs) => {
          if (!alive) return;
          setRunners(rs);
          setBoardError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setRunners(null);
          setBoardError(e instanceof Error ? e.message : String(e));
        });
    };
    read();
    const t = setInterval(read, LIVENESS_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const runner = useMemo(() => runnerFor(machine, runners), [machine, runners]);

  return (
    <>
      {/* No `key` on the machine. Switching boxes from the picker used to
          remount this whole subtree, which threw away the tabs of the machine
          you were leaving before anything could record them, tore down the
          box poll, and re-dialled every terminal — for what is a change of
          which place you are looking at, not of what this component is. The
          tabs now live in a slot per (machine, project) and the body swaps
          slots in place. */}
      <RemoteWorkspaceBody
        entry={entry}
        machine={machine}
        machines={machines}
        missingMachineId={missingMachineId}
        onPickMachine={setMachineId}
        runner={runner}
        boardRead={runners !== null}
        boardError={boardError}
        onClose={onClose}
        onConnectMachine={() => setConnecting(true)}
        onMachineChanged={(m) =>
          setMachines((all) => (all ?? []).map((x) => (x.id === m.id ? m : x)))
        }
      />
      {connecting && (
        <ConnectMachineWizard
          // Connecting a second box while standing in the first: the project
          // you're in is the project it's for, and the machine you're standing
          // in knows it even when the entry doesn't.
          repoRoot={entry.repoRoot ?? machine?.project_root ?? ""}
          onClose={() => {
            setConnecting(false);
            // The wizard writes the address as soon as the box answers, so the
            // book is re-read on the way out rather than waiting for the whole
            // runner install — abandoning it at step 2 still leaves you a
            // machine you can open.
            void api
              .machinesList()
              .then((list) => {
                setMachines(list);
                setMachineId((id) => machineToOpen(id, list));
              })
              .catch(() => {});
          }}
        />
      )}
    </>
  );
}

function RemoteWorkspaceBody({
  entry,
  machine,
  machines,
  missingMachineId,
  onPickMachine,
  runner,
  boardRead,
  boardError,
  onClose,
  onConnectMachine,
  onMachineChanged,
}: {
  entry: RemoteWorkspaceEntry;
  machine: Machine | null;
  machines: Machine[] | null;
  /** The machine this workspace asked for, when the book no longer has it. */
  missingMachineId: string | null;
  onPickMachine: (id: string) => void;
  runner: CloudRunner | null;
  boardRead: boolean;
  boardError: string | null;
  onClose: () => void;
  onConnectMachine: () => void;
  onMachineChanged: (m: Machine) => void;
}) {
  // The chat is a tab because it belongs to this machine as much as the shells
  // do. A machine you can only type shell commands at is a terminal, not a
  // workspace, and "where's the agent I talk to?" was a fair question with no
  // answer on screen.
  //
  // Two things can be behind it, and they are different in kind. Arriving from
  // a dispatched job, `entry.threadKey` names a record on the board — finished
  // or draining work, which you read. Every other way in gives you the live
  // chat: the same conversation you have about local code, with its hands on
  // this box.
  const threadKey = entry.threadKey ?? null;
  const [adding, setAdding] = useState(false);

  // Has Aura stopped this one? Read off the book row, because it is the only
  // thing that knows: a sleeping box and a broken box behave identically on the
  // wire. The poll below is skipped while it holds, so the panel says "asleep"
  // rather than showing a connect timeout as the machine's own words.
  const asleep = useMemo(
    () => (machine ? isAsleep(placeOfMachine(machine)) : false),
    [machine],
  );

  // What the box is holding: its projects, and every session working in them.
  // Polled, because the answer changes without this window doing anything —
  // the CLI starts sessions over ssh, and on a shared box so do other people.
  const box = useBox(machine?.id ?? null, asleep);

  // Which project this workspace is standing in. The entry says so when you
  // arrived from a project row or a conversation that named one — and when it
  // doesn't, the machine itself does: a box records the project it is a copy
  // of. Without this fallback, opening a box any other way (a restored tab, the
  // machine picker, the Workspaces list) landed on "this workspace isn't tied
  // to a project" about a machine that plainly knows which project it is for.
  //
  // It can change under one mount, in both directions that matter: the box
  // reports its project a beat after the workspace is already open, and picking
  // a different machine picks a different project with it. That is why it is
  // half of the slot the tabs are filed under rather than something read once.
  const repoRoot = entry.repoRoot ?? machine?.project_root ?? undefined;

  // The tabs, and which one is in front — held per (machine, project) rather
  // than per mount. One mount therefore serves as many projects on as many
  // boxes as you walk through, and each of them keeps its own strip.
  const strip = useRemoteTabs(machine?.id ?? null, repoRoot);
  const { tabs, activeId, active } = strip;

  // The place a tab on this strip runs in. Same box, but the project is the
  // one the strip is filed under rather than whatever the book happens to hold
  // — that is the whole point of keying tabs by (machine, project): two
  // projects on one box are two places, and each session boots in its own.
  const tabPlace = useMemo(() => {
    if (!machine) return null;
    const p = placeOfMachine(machine);
    return repoRoot ? { ...p, project: { ...p.project, root: repoRoot } } : p;
  }, [machine, repoRoot]);

  // The box's own answer, put back onto the tabs drawn from it. A restored tab
  // states what the machine looked like when you left it, and until the first
  // read lands that is the honest thing to show — but once the box has spoken,
  // repeating it would be a lie about a computer we just talked to.
  useEffect(() => {
    if (box.sessions) strip.syncSessions(box.sessions);
  }, [box.sessions, strip.syncSessions]);

  // Walking back into a machine should put you back in front of what you were
  // doing there. Sessions outlive this window, so the most recently active one
  // is almost always the thing you left — and if the box is idle, Chat is the
  // honest landing rather than a shell we opened on someone's machine to have
  // something to show.
  //
  // Only into a place whose strip is still just the conversation. A restored
  // slot already IS what you were doing there, down to which tab was in front,
  // and attaching the box's most recent session over the top of it would move
  // someone off the agent they left running to whichever shell tmux touched
  // last. Once per place, not once per machine: two projects on one box are two
  // arrivals.
  const [greeted, setGreeted] = useState<string | null>(null);
  // Spelled by `remotePlaceKey` rather than by joining the two halves here: it
  // is the identity the window files these places under and the one the tab
  // slot is named after, and a second spelling of it is how one arrival becomes
  // two.
  const standingIn = machine
    ? remotePlaceKey({ machineId: machine.id, repoRoot })
    : null;
  useEffect(() => {
    if (!machine || !standingIn || entry.threadKey || !box.sessions) return;
    if (greeted === standingIn) return;
    setGreeted(standingIn);
    if (strip.hasSessions) return;
    const last = sessionToGreet(box.sessions);
    if (last) strip.openSession(last, false);
  }, [
    standingIn,
    machine,
    box.sessions,
    greeted,
    entry.threadKey,
    strip.hasSessions,
    strip.openSession,
  ]);

  // The join panel is about the box in front of you. Leaving that box with it
  // still open would hand the next one a list read off the last one.
  useEffect(() => setAdding(false), [standingIn]);

  // Put this place in a window of its own.
  //
  // The place popped out is the RESOLVED one, not the request we walked in
  // with: `entry.machineId` is absent when you arrive from the fleet page or
  // from a cloud conversation, and a new window opened on that entry would go
  // and pick "whichever machine was used last" — a second window claiming to be
  // this one while standing somewhere else. `machine.id` is the box we are
  // actually on. The conversation travels too, so the popped window opens on
  // the same side of the machine you were reading it from.
  //
  // This window keeps the place. Popping out is not handing over: the sessions
  // are tmux on the box and outlive every client, and the new window builds its
  // own strip from the same slot rather than being given ours. So there is no
  // `onClose()` here, and there must not be — leaving is a thing the user asks
  // for with the row below.
  const machineId = machine?.id ?? entry.machineId;
  const popOut = useCallback(() => {
    if (!machineId && !threadKey && !repoRoot) return;
    void openPopout({
      kind: "workspace",
      root: repoRoot ?? "",
      place: remotePlace({
        machineId,
        threadKey: threadKey ?? undefined,
        repoRoot,
      }),
      title: machine?.name ? `Aura. ${machine.name}` : "Aura",
    });
  }, [machineId, threadKey, repoRoot, machine?.name]);

  const attach = (session: BoxSession, opts?: { readOnly?: boolean }) => {
    strip.openSession(session, !!opts?.readOnly);
    setAdding(false);
  };

  // Closing a tab is closing a *view*. The session keeps running on the box —
  // that is the entire reason for putting work there, and a close button that
  // quietly killed an agent mid-edit would be the worst button in the app.
  // Ending it for real lives in the panel, where it says "Stop" and asks twice.
  const closeTab = (id: string) => {
    if (machine) releaseTerminalSession(instanceIdFor(machine, id));
    strip.closeTab(id);
  };

  // No machine in the book at all. This is not an error state — it is the
  // honest first screen for someone who has cloud work but has never told this
  // laptop how to reach the box that ran it.
  if (!machine) {
    return (
      <div className="flex h-full flex-col">
        <TabStrip
          machine={null}
          machines={machines}
          onPickMachine={onPickMachine}
          runner={null}
          boardRead={boardRead}
          boardError={boardError}
          onClose={onClose}
          onMachineChanged={onMachineChanged}
        />
        <div className="flex flex-1 items-center justify-center px-8">
          <div className="flex max-w-md flex-col items-center gap-3 text-center">
            <CloudGlyph size={22} />
            {/* Two ways in, two different first sentences. Arriving from a
                cloud job, the machine is a fact you're trying to reach;
                arriving from the fleet page it is a thing you're about to
                add. Telling someone who clicked "Connect a machine" that
                "this work ran on a machine" describes work they never sent. */}
            <p className="text-sm text-text-2">
              {machines === null
                ? "Looking for machines you've connected…"
                : missingMachineId
                  ? `${missingMachineId} isn’t connected to this laptop any more.`
                  : entry.threadKey
                    ? "This work ran on a machine, and this laptop doesn't know how to reach one yet."
                    : "No machines connected yet."}
            </p>
            {/* Gone, but not alone. Offering the machines you do have beats
                sending someone through the wizard to re-add a box that is
                sitting one line below — and beats picking one for them, which
                would open shells on the wrong machine and look right. */}
            {missingMachineId && !!machines?.length && (
              <div className="flex w-full flex-col gap-1">
                <span className="text-xs text-text-5">
                  Open one of these instead:
                </span>
                {machines.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onPickMachine(m.id)}
                    className="flex flex-col items-start rounded-lg border border-line-soft px-2.5 py-1.5 text-left transition-colors hover:bg-state-hover"
                  >
                    <span className="text-sm text-text-1">{m.name}</span>
                    <span className="w-full truncate font-mono text-xs text-text-4">
                      {m.user}@{m.host}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {machines !== null && (
              <>
                <p className="text-xs text-text-5">
                  Connect a machine once — its address is kept here, never its
                  key — and it opens as a workspace from then on.
                </p>
                <Button variant="accentSoft" onClick={onConnectMachine}>
                  {missingMachineId ? "Connect it again" : "Connect a machine"}
                </Button>
              </>
            )}
            {entry.threadKey && repoRoot !== undefined && (
              <p className="text-xs text-text-5">
                You can still read and answer the conversation from the cloud
                list while you do.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* One strip, in the same language the local work surface speaks: full
          `--topbar-h` cells on the chrome ground, a rule between them, the
          active one lit with the content colour. A machine is a workspace, so
          it wears the workspace's own top — not a cloud banner over a folder
          band over a strip of its own invention. What the box *is* (address,
          liveness, which folder you land in, how to leave) lives in the one
          quiet control at the end, and everything else is the tabs. */}
      <TabStrip
        machine={machine}
        machines={machines}
        onPickMachine={onPickMachine}
        runner={runner}
        boardRead={boardRead}
        boardError={boardError}
        onClose={onClose}
        onPopOut={popOut}
        onMachineChanged={onMachineChanged}
        tabs={tabs}
        activeId={active?.id ?? activeId}
        onActivate={strip.focusTab}
        onCloseTab={closeTab}
        adding={adding}
        onToggleAdd={() => {
          // Ask the box on the way open rather than showing what it was doing
          // twelve seconds ago — this is the moment someone is deciding what to
          // join, and it is the one moment staleness would actually mislead.
          if (!adding) box.refresh();
          setAdding((v) => !v);
        }}
        box={box}
        openSessions={tabs.flatMap((t) =>
          t.kind === "session" ? [t.session.name] : [],
        )}
        onAttach={attach}
      />

      <div className="min-h-0 flex-1">
        {!active ? (
          <div className="grid h-full place-items-center px-8 text-center text-sm text-text-5">
            Nothing open on this machine. Use ＋ to join something running there
            or start something new.
          </div>
        ) : active.kind === "cloud" ? (
          // Arriving *from* a dispatched job, the thread on the board is the
          // thing you clicked and the thing you want to read — a record of
          // work that already ran, which the live chat has no way to show.
          // Entering the machine any other way gives you the real chat.
          threadKey ? (
            <CloudThreadPane
              threadKey={threadKey}
              repoRoot={repoRoot ?? ""}
            />
          ) : (
            <MachineChat
              machineId={machine.id}
              machineName={machine.name}
              repoRoot={repoRoot ?? ""}
            />
          )
        ) : (
          // Every terminal tab stays mounted-by-id in the Terminal module's own
          // session cache, so switching tabs — and leaving the workspace and
          // coming back — reattaches to the same running session rather than
          // dialling a second one.
          //
          // `cwd` is this laptop's, and deliberately not the box's: it is where
          // the local pty starts before `ssh` replaces it. Where the work
          // happens is the session's own directory, which the box chose when
          // the session was started and which we have no business overriding
          // from here.
          //
          // The boot line is ASKED for rather than built here — see
          // `RemoteSessionTerminal`. One transport, written once in Rust.
          tabPlace && (
            <RemoteSessionTerminal
              key={active.id}
              place={tabPlace}
              session={active.session.name}
              readOnly={active.readOnly}
              instanceId={instanceIdFor(machine, active.id)}
              cwd={repoRoot || undefined}
              repoRoot={repoRoot || undefined}
            />
          )
        )}
      </div>
    </div>
  );
}

/** The top of a remote workspace — and it is deliberately the same top a local
 *  one has: `--topbar-h` cells on the chrome ground, a hairline between them,
 *  the open one lit with the content colour. This used to be three stacked
 *  bands (a cloud header naming the box, a "folder on the machine" strip, then
 *  tabs of its own design), which announced at a glance that you had left the
 *  app and entered some cloud console. You hadn't. You opened a workspace that
 *  happens to be somewhere else, so it reads like every other workspace and
 *  gives the height back to the terminal.
 *
 *  Everything the old bands said is still reachable — it moved into the one
 *  control at the end of the strip, where you go when you want to know *about*
 *  the machine rather than work on it. */
function TabStrip({
  machine,
  machines,
  onPickMachine,
  runner,
  boardRead,
  boardError,
  onClose,
  onPopOut,
  onMachineChanged,
  tabs = [],
  activeId = "",
  onActivate,
  onCloseTab,
  adding = false,
  onToggleAdd,
  canOpen = false,
  box,
  openSessions = [],
  onAttach,
}: {
  machine: Machine | null;
  machines: Machine[] | null;
  onPickMachine: (id: string) => void;
  runner: CloudRunner | null;
  boardRead: boolean;
  boardError: string | null;
  onClose: () => void;
  /** Detach this place into its own OS window. Absent on the no-machine
   *  screen, where there is no place to open one onto yet. */
  onPopOut?: () => void;
  onMachineChanged: (m: Machine) => void;
  tabs?: RemoteTab[];
  activeId?: string;
  onActivate?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  adding?: boolean;
  onToggleAdd?: () => void;
  canOpen?: boolean;
  box?: BoxState;
  openSessions?: string[];
  onAttach?: (s: BoxSession, opts?: { readOnly?: boolean }) => void;
}) {
  return (
    <div
      className="relative flex flex-shrink-0 items-stretch border-b border-line-soft bg-bg-chrome"
      style={{ height: "var(--topbar-h)" }}
    >
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t) => {
          const on = t.id === activeId;
          const label = t.kind === "cloud" ? t.label : sessionLabel(t.session);
          return (
            <div
              key={t.id}
              className={`group flex h-full flex-shrink-0 items-center gap-1.5 border-r border-line-soft px-2 text-sm transition-colors ${
                on
                  ? "bg-bg-content text-text-1"
                  : "text-text-3 hover:bg-state-hover hover:text-text-1"
              }`}
            >
              <button
                type="button"
                onClick={() => onActivate?.(t.id)}
                title={
                  t.kind === "cloud"
                    ? undefined
                    : `${label} — running in ${t.session.project || "the home directory"} on the machine${
                        t.readOnly
                          ? ". You are watching: this tab can't type into it."
                          : ""
                      }`
                }
                className="flex min-w-0 items-center gap-1.5"
              >
                <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                  {t.kind === "cloud" ? (
                    <CloudGlyph size={12} />
                  ) : t.readOnly ? (
                    // Which way you joined changes what the keyboard does, so
                    // it is on the tab and not only in the panel you came from.
                    <Eye size={12} />
                  ) : t.session.agent ? (
                    <AgentIcon
                      agentId={t.session.agent}
                      label={t.session.agent}
                      size={13}
                    />
                  ) : (
                    <TerminalIcon size={12} />
                  )}
                </span>
                <span className="max-w-[140px] truncate">{label}</span>
                {/* Someone else is attached to this same session. Worth a mark
                    on the tab itself, not just in the panel — you are sharing a
                    keyboard with them the moment you start typing. */}
                {t.kind === "session" && t.session.attached > 1 && (
                  <span
                    className="flex-shrink-0 text-2xs"
                    style={{ color: "var(--color-accent)" }}
                    title={`${t.session.attached} people are attached to this session`}
                  >
                    ●
                  </span>
                )}
              </button>
              {/* The conversation is the board's record and closing it here
                  would imply otherwise, so only the sessions we opened can be
                  closed. */}
              {t.kind !== "cloud" && (
                <button
                  type="button"
                  onClick={() => onCloseTab?.(t.id)}
                  title="Close this tab — the session keeps running on the machine"
                  className="opacity-0 transition-opacity hover:text-text-1 group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}

        {machine && (
          <button
            type="button"
            onClick={onToggleAdd}
            disabled={!canOpen}
            title={
              canOpen
                ? "Join something running on this machine, or start something new"
                : "This machine's saved address can't be dialled — reconnect it"
            }
            className="flex h-full flex-shrink-0 items-center px-2.5 text-text-4 transition-colors hover:bg-state-hover hover:text-text-1 disabled:opacity-40"
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      {/* Keyed on the box, because this control holds a draft OF that box: the
          folder its conversation reads, half-typed. The workspace around it no
          longer remounts when you switch machines, so without this the draft
          would follow you onto the next machine and save one box's path onto
          another. */}
      <MachineControl
        key={machine?.id ?? "no-machine"}
        machine={machine}
        machines={machines}
        onPickMachine={onPickMachine}
        runner={runner}
        boardRead={boardRead}
        boardError={boardError}
        onClose={onClose}
        onPopOut={onPopOut}
        onMachineChanged={onMachineChanged}
      />

      {adding && machine && box && (
        <>
          <MenuBackdrop onClose={() => onToggleAdd?.()} />
          <BoxPanel
            place={placeOfMachine(machine)}
            box={box}
            openSessions={openSessions}
            onAttach={(s, opts) => onAttach?.(s, opts)}
            // Waking rewrites the row — a stopped machine comes back on a
            // different address — so the woken row goes back through the same
            // channel the wizard's edits do. Nothing here patches a field in
            // place; the book stays the one answer to where this box is.
            onWoke={onMachineChanged}
            onClose={() => onToggleAdd?.()}
          />
        </>
      )}
    </div>
  );
}

/** Click-away for the hand-rolled popovers in this strip. Radix menus get this
 *  for free; these two are plain absolutely-positioned panels, and a menu that
 *  only closes by pressing the same button again is a menu people leave open
 *  over their work. Transparent and behind the panel, above everything else. */
function MenuBackdrop({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-40"
      onClick={onClose}
      onContextMenu={onClose}
    />
  );
}

/** Which box this is, folded into one control at the end of the strip.
 *
 *  Its name is the label because that is the one word you want on screen while
 *  you work; the address, whether it's up, which folder new tabs land in, the
 *  other machines you could switch to and the way out are all one click away.
 *  A workspace's identity belongs in its chrome, not in a banner above it. */
function MachineControl({
  machine,
  machines,
  onPickMachine,
  runner,
  boardRead,
  boardError,
  onClose,
  onPopOut,
  onMachineChanged,
}: {
  machine: Machine | null;
  machines: Machine[] | null;
  onPickMachine: (id: string) => void;
  runner: CloudRunner | null;
  boardRead: boolean;
  boardError: string | null;
  onClose: () => void;
  onPopOut?: () => void;
  onMachineChanged: (m: Machine) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState(machine?.repo_path ?? "");
  const others = (machines ?? []).filter((m) => m.id !== machine?.id);

  const saveDir = useCallback(async () => {
    if (!machine) return;
    const saved = await api.machineSave({
      name: machine.name,
      host: machine.host,
      user: machine.user,
      key_path: machine.key_path,
      box_kind: machine.box_kind,
      repo_path: dirDraft.trim() || null,
    });
    onMachineChanged(saved);
    setEditingDir(false);
  }, [machine, dirDraft, onMachineChanged]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          machine
            ? `${machine.user}@${machine.host} — everything in this workspace runs there, not here`
            : "No machine connected"
        }
        className="flex h-full flex-shrink-0 items-center gap-1.5 border-l border-line-soft px-2.5 text-xs text-text-4 transition-colors hover:bg-state-hover hover:text-text-1"
      >
        <CloudGlyph size={12} pulse={!!runner?.online} />
        <span className="max-w-[160px] truncate">
          {machine?.name || "No machine"}
        </span>
        <ChevronDown size={11} />
      </button>

      {open && <MenuBackdrop onClose={() => setOpen(false)} />}
      {open && (
        <div className={`${MENU_PANEL} absolute right-2 top-full mt-1 flex w-72 flex-col`}>
          {machine && (
            <div className="flex flex-col gap-0.5 px-2 py-1.5">
              <span className="truncate font-mono text-xs text-text-3">
                {machine.user}@{machine.host}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-text-5">
                <LiveWord
                  runner={runner}
                  boardRead={boardRead}
                  boardError={boardError}
                />
                {machine.box_kind === "shared" && (
                  <>
                    <span>·</span>
                    <span>shared machine</span>
                  </>
                )}
              </span>
            </div>
          )}

          {/* Which checkout the *conversation* reads. Shells and agents get
              their directory from the session they attach to — the box chose
              it when the session was started — but the chat has no session to
              inherit from, so this is where its read_file, bash and prove act.
              Blank means the home directory, which is a real answer rather
              than a missing one. */}
          {machine && (
            <>
              <div className={MENU_SEP} />
              <div className={MENU_LABEL}>Folder the conversation reads</div>
              <div className="flex flex-col gap-1 px-2 pb-1.5">
              {editingDir ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={dirDraft}
                    onChange={(e) => setDirDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveDir();
                      if (e.key === "Escape") setEditingDir(false);
                    }}
                    placeholder="~/workspaces/my-project"
                    className="h-6 flex-1 font-mono text-xs"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => void saveDir()}
                    className="rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-state-hover"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDirDraft(machine.repo_path ?? "");
                    setEditingDir(true);
                  }}
                  className="self-start truncate rounded px-1 py-0.5 font-mono text-xs text-text-3 hover:bg-state-hover"
                >
                  {machine.repo_path || "~ (home)"}
                </button>
              )}
              {/* Said once, here, rather than on every tab: work you start on
                  the box lives on the box. That is the whole point, and it is
                  also the thing that surprises people the first time. */}
                <span className="text-xs text-text-5">
                  Everything in this workspace runs on that machine, and keeps
                  running after you close the window.
                </span>
              </div>
            </>
          )}

          {others.length > 0 && (
            <>
              <div className={MENU_SEP} />
              <div className={MENU_LABEL}>Other machines</div>
              {others.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onPickMachine(m.id);
                    setOpen(false);
                  }}
                  className={`${MENU_ROW} flex-col !items-start gap-0`}
                >
                  <span>{m.name}</span>
                  <span className="w-full truncate font-mono text-xs text-text-4">
                    {m.user}@{m.host}
                  </span>
                </button>
              ))}
            </>
          )}

          <div className={MENU_SEP} />
          {/* The same move a local checkout has had all along ("Open in new
              window" on its roster row), for the other kind of place. The two
              rows are deliberately adjacent and deliberately different: one
              gives you a second window onto this machine, the other gives the
              machine up. Said in the title, because "open in its own window"
              reads like a move and people expect a move. */}
          {onPopOut && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onPopOut();
              }}
              className={MENU_ROW}
              title="A second Aura window standing on this machine. This one stays on it too"
            >
              Open in its own window
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onClose();
            }}
            className={MENU_ROW}
          >
            Leave this machine
          </button>
        </div>
      )}
    </>
  );
}

/** Whether the box is up, in the words a person would use — and never a guess.
 *
 *  Three different unknowns get three different sentences, because they send
 *  you to three different places: the board said it's down, the board has no
 *  such machine at all, and we couldn't reach the board to ask. Collapsing them
 *  into one "offline" is how you end up debugging a stopped VM that was
 *  actually a signed-out laptop. */
function LiveWord({
  runner,
  boardRead,
  boardError,
}: {
  runner: CloudRunner | null;
  boardRead: boolean;
  boardError: string | null;
}) {
  // Two or three words on the line, the whole sentence in the tooltip. These
  // used to be full clauses, which read well in isolation and then set the
  // width of the header column — pushing "everything here runs on that
  // machine" off the right-hand side and clipping themselves mid-word.
  if (boardError)
    return <span title={boardError}>couldn’t check</span>;
  if (!boardRead)
    return (
      <span className="flex items-center gap-1">
        <AsciiSpinner /> checking…
      </span>
    );
  if (!runner)
    return (
      <span
        style={{ color: "var(--color-amber)" }}
        title="This machine isn't registered as a runner on your board, so nothing can be dispatched to it — but you can still open shells and agents on it here."
      >
        not a runner
      </span>
    );
  return runner.online ? (
    <span style={{ color: "var(--color-accent)" }}>online</span>
  ) : (
    <span
      style={{ color: "var(--color-amber)" }}
      title="The board hasn't heard from this machine recently. It may be stopped or asleep, in which case a shell won't connect."
    >
      not answering
    </span>
  );
}
