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
import { PanelTop } from "lucide-react";

import { api, type BoxSession, type CloudRunner, type Machine } from "../../lib/api";
import { resolveMachine } from "../../lib/activeMachine";
import { findMachine } from "../../lib/machineRef";
import {
  canOpenTerminal,
  isAsleep,
  placeOfMachine,
  projectToFilePlaceUnder,
} from "../../lib/place";
import { remotePlaceKey, takeSessionWanted, takeShellWanted, type RemotePlace } from "../../lib/remotePlaces";
import { remotePlace } from "../../lib/placeRef";
import { openPopout } from "../../lib/popout";
import { releaseTerminalSession } from "../Terminal";
import { Button } from "../ui/button";
import { CloudStatus, type CloudSessionState } from "../ui/cloud-workspace";
import { EmptyState } from "../ui/state";
import { ConnectMachineWizard } from "../commons/crew/ConnectMachineWizard";
import { NoMachineScreen } from "./NoMachineScreen";
import { RemotePanes } from "./RemotePanes";
import { RemoteTabBody, type RemoteBodyContext } from "./RemoteTabBody";
import { publishRemoteHeader } from "./remoteHeader";
import { RemoteTabStrip } from "./RemoteTabStrip";
import {
  instanceIdFor,
  machineToOpen,
  missingMachine,
  runnerFor,
  sessionToGreet,
} from "./machineWorkspace";
import { machineCloudState } from "./machineState";
import { useBox } from "./useBox";
import { useOpenOnMachine } from "./openOnMachine";
import { useRemoteTabs } from "./useRemoteTabs";
import { useWaking } from "./useWaking";
import "../ui/remote-workspace.css";

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
    () => findMachine(machines, machineId),
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
      entry.remoteRoot ?? null,
    );
  }, [placeKey, machine?.id, entry.threadKey, placeRepoRoot, entry.remoteRoot]);

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
        })
        .catch(() => {
          // An unread board names no runner, so the machine's state rests on
          // the book and its own reads — see `machineState`.
          if (alive) setRunners(null);
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
          // "Connect it again" on a machine the book lost. The box that comes
          // back is that machine, whatever address it answers at now, so it is
          // saved under the id this workspace — and its chats and tabs — are
          // holding, rather than as a stranger they can't find.
          reconnect={missingMachineId}
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

  // Can a shell be dialled here at all? The saved address has to be one the
  // terminal can boot on. Without this the strip's ＋ has nothing to go on and
  // stays disabled on every machine, which is how it sat after this prop was
  // lost in a merge.
  const canOpen = useMemo(
    () => (machine ? canOpenTerminal(placeOfMachine(machine)) : false),
    [machine],
  );

  // What the box is holding: its projects, and every session working in them.
  // Polled, because the answer changes without this window doing anything —
  // the CLI starts sessions over ssh, and on a shared box so do other people.
  const box = useBox(machine?.id ?? null, asleep);

  // One answer to "is it up", in the cloud status words, for the header, the
  // details and the banner alike.
  const waking = useWaking(machine?.id ?? null);
  const state = machineCloudState({ asleep, waking, runner, unreachable: !!box.error });

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
  // Where the checkout is ON the machine, when a launched workspace put it in
  // a worktree beside the machine's own copy. Absent for a box entered on its
  // main checkout — which then keeps the slot and the key it always had.
  const remoteRoot = entry.remoteRoot ?? undefined;

  // The tabs, and which one is in front — held per (machine, project,
  // worktree) rather than per mount. One mount therefore serves as many
  // projects on as many boxes as you walk through, and each of them keeps
  // its own strip.
  const strip = useRemoteTabs(machine?.id ?? null, repoRoot, remoteRoot);
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
    ? remotePlaceKey({ machineId: machine.id, repoRoot, remoteRoot })
    : null;

  // The frame's header and right panel open into this workspace's tabs: a file
  // as its own tab, a scope's diff as `Uncommitted changes` / `Commit <hash>`.
  useOpenOnMachine((req) =>
    req.kind === "file" ? strip.openFile(req.path) : strip.openDiff(req.sha, req.path),
  );
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
        remoteRoot,
      }),
      title: machine?.name ? `Aura. ${machine.name}` : "Aura",
    });
  }, [machineId, threadKey, repoRoot, remoteRoot, machine?.name]);

  const attach = useCallback(
    (session: BoxSession, opts?: { readOnly?: boolean }) => {
      strip.openSession(session, !!opts?.readOnly);
      setAdding(false);
    },
    [strip.openSession],
  );

  // A shell on the machine, in the checkout this workspace stands in. Held by
  // tmux there like every other session, so it is still there tomorrow. With
  // no checkout to stand in — a box nobody has told us the folder of — the
  // join panel is the way, because it asks which project.
  const shellDir = remoteRoot ?? machine?.repo_path ?? null;
  const openShell = useCallback(async () => {
    if (!machine) return;
    if (!shellDir) {
      box.refresh();
      setAdding(true);
      return;
    }
    const s = await api.boxStart(machine.id, {
      project: shellDir,
      kind: "shell",
      agent: null,
      branch: null,
      title: null,
      prompt: null,
    });
    attach(s);
    box.refresh();
  }, [machine, shellDir, box.refresh, attach]);
  const [shellError, setShellError] = useState<string | null>(null);
  useEffect(() => setShellError(null), [standingIn]);
  const openShellFromStrip = useCallback(() => {
    setShellError(null);
    openShell().catch((e) => setShellError(e instanceof Error ? e.message : String(e)));
  }, [openShell]);
  // "Open via SSH" from a cloud workspace's details lands here: a shell in
  // the workspace's folder, opened once, the first time the place can.
  useEffect(() => {
    if (!machine || !standingIn || !canOpen || !shellDir) return;
    if (takeShellWanted(standingIn)) openShellFromStrip();
  }, [machine, standingIn, canOpen, shellDir, openShellFromStrip]);
  // A session a cloud workspace already started here — its Run command —
  // opened as a tab, once.
  useEffect(() => {
    if (!machine || !standingIn || !canOpen) return;
    const wanted = takeSessionWanted(standingIn);
    if (wanted) {
      attach(wanted);
      box.refresh();
    }
  }, [machine, standingIn, canOpen, attach, box.refresh]);
  const openJoin = useCallback(() => {
    box.refresh();
    setAdding(true);
  }, [box.refresh]);

  // The machine is the workspace's title, so its details go up to the header.
  const repository = repoRoot ? repoRoot.split("/").filter(Boolean).pop() ?? null : null;
  useEffect(() => {
    publishRemoteHeader({
      machine,
      repository,
      state,
      onClose,
      onPopOut: machine ? popOut : undefined,
      onMachineChanged,
      onOpenShell: machine && canOpen ? openShell : undefined,
      onOpenJoin: machine && canOpen ? openJoin : undefined,
    });
  });
  useEffect(() => () => publishRemoteHeader(null), []);

  // Closing a tab is closing a *view*. The session keeps running on the box —
  // that is the entire reason for putting work there, and a close button that
  // quietly killed an agent mid-edit would be the worst button in the app.
  // Ending it for real lives in the panel, where it says "Stop" and asks twice.
  const closeTab = useCallback(
    (id: string) => {
      if (machine) releaseTerminalSession(instanceIdFor(machine, id));
      strip.closeTab(id);
    },
    [machine, strip.closeTab],
  );

  // Everything a tab needs to draw itself, in one object rather than a dozen
  // props threaded down through the pane tree. The panes differ only by which
  // tab they hold — the machine, the project and the handlers are the same for
  // all of them — and a body that is one tab wide is just the one-pane case of
  // the same context.
  // Null only while the book has no machine for this entry, which returns a
  // screen of its own below — the body never draws without one.
  const bodyCtx = useMemo<RemoteBodyContext | null>(
    () => (machine === null ? null : {
      machine,
      place: tabPlace,
      repoRoot,
      threadKey,
      onOpenFile: strip.openFile,
      onCloseTab: closeTab,
      onAttach: attach,
      panes: strip.panes,
      splitWith: strip.splitWith,
      onShowBeside: strip.showBeside,
      onShowAlone: strip.showAlone,
    }),
    [
      machine,
      tabPlace,
      repoRoot,
      threadKey,
      strip.openFile,
      closeTab,
      attach,
      strip.panes,
      strip.splitWith,
      strip.showBeside,
      strip.showAlone,
    ],
  );

  // No machine in the book at all. This is not an error state — it is the
  // honest first screen for someone who has cloud work but has never told this
  // laptop how to reach the box that ran it.
  if (!machine) {
    return (
      <div className="ui-remote-workspace">
        <RemoteTabStrip machine={null} onMachineChanged={onMachineChanged} />
        <div className="ui-remote-body">
          <NoMachineScreen
            machines={machines}
            missingMachineId={missingMachineId}
            fromThread={!!entry.threadKey}
            canAnswerInList={repoRoot !== undefined}
            onPickMachine={onPickMachine}
            onConnectMachine={onConnectMachine}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ui-remote-workspace">
      {/* The cloud workspace's tab row. What the box *is* (address,
          liveness, which folder the chat reads, how to leave) is the title in
          the header above; everything else is the tabs. */}
      <RemoteTabStrip
        machine={machine}
        onMachineChanged={onMachineChanged}
        onOpenShell={openShellFromStrip}
        tabs={tabs}
        activeId={active?.id ?? activeId}
        onActivate={strip.focusTab}
        onCloseTab={closeTab}
        adding={adding}
        canOpen={canOpen}
        onToggleAdd={(open) => {
          const next = open ?? !adding;
          // Ask the box on the way open rather than showing what it was doing
          // twelve seconds ago — this is the moment someone is deciding what to
          // join, and it is the one moment staleness would actually mislead.
          if (next && !adding) box.refresh();
          setAdding(next);
        }}
        box={box}
        openSessions={tabs.flatMap((t) =>
          t.kind === "session" ? [t.session.name] : [],
        )}
        onAttach={attach}
      />
      <MachineBanner
        state={state}
        note={state === "starting" ? waking?.note ?? null : state === "reconnecting" ? box.error : null}
        shellError={shellError}
        onWake={canOpen ? openJoin : undefined}
        onDismissError={() => setShellError(null)}
      />

      <div className="ui-remote-body">
        {!active || !bodyCtx ? (
          <div className="ui-remote-empty">
            <EmptyState
              icon={PanelTop}
              title="Nothing open on this machine"
              body="Use ＋ to join something running there, or start something new."
            />
          </div>
        ) : strip.panes ? (
          // Two or more of the open tabs at once. Which ones, and how they
          // divide the body, is persisted with the strip — see
          // `lib/remotePaneTree`. The arrangement only draws while you are
          // standing in it, so looking at a tab outside it shows that tab alone
          // and leaves the split to come back to.
          <RemotePanes
            tree={strip.panes}
            tabs={tabs}
            activeId={active.id}
            onFocus={strip.focusTab}
            ctx={bodyCtx}
          />
        ) : (
          <RemoteTabBody key={active.id} tab={active} ctx={bodyCtx} />
        )}
      </div>
    </div>
  );
}

/** The cloud workspace's session banner, for every state in which the machine
 *  in front of you is not simply there — in the same status words the header
 *  and the details use, from the same `machineState`. And the one moment a
 *  shell could not be opened, which is said here rather than in a toast that
 *  leaves before it is read. Nothing at all while the machine is up. */
function MachineBanner({
  state,
  note,
  shellError,
  onWake,
  onDismissError,
}: {
  state: CloudSessionState;
  /** The engine's own sentence while it starts, or the failed read's words
   *  while it reconnects. */
  note: string | null;
  shellError: string | null;
  onWake?: () => void;
  onDismissError: () => void;
}) {
  if (shellError)
    return (
      <div className="ui-cloud-session-banner" role="alert">
        <CloudStatus state="unresponsive" />
        <span>Couldn’t open a terminal on this machine: {shellError}</span>
        <Button size="xs" variant="secondary" onClick={onDismissError}>
          Dismiss
        </Button>
      </div>
    );
  const line = bannerLine(state, note);
  if (!line) return null;
  return (
    <div className="ui-cloud-session-banner" role="status">
      <CloudStatus state={state} />
      <span>{line}</span>
      {state === "sleeping" && onWake && (
        <Button size="xs" variant="secondary" onClick={onWake}>
          Wake machine
        </Button>
      )}
    </div>
  );
}

/** What the banner says beside the status, or null for no banner. */
function bannerLine(state: CloudSessionState, note: string | null): string | null {
  switch (state) {
    case "sleeping":
      return "Aura put this machine to sleep. Its sessions and files are kept; wake it to work here again.";
    case "starting":
      return note || "This machine is waking up.";
    case "unresponsive":
      return "The board hasn’t heard from this machine recently. It may be stopped, or its runner may be down.";
    case "reconnecting":
      return note ? `Couldn’t read this machine: ${note}` : "Couldn’t read this machine.";
    default:
      return null;
  }
}
