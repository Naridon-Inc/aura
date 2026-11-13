// What one tab of a remote workspace shows.
//
// Lifted out of `RemoteWorkspace` because the body stopped being a single
// thing: two tabs can be on screen at once now, and the switch that chooses
// between a conversation, a work surface and a session terminal has to be
// callable per pane rather than once per workspace. One place decides what a
// tab looks like, whether it is alone or sharing the body with three others.
//
// Everything it needs about the place arrives as one `ctx` rather than a dozen
// props threaded through the pane tree: the panes differ only by which tab they
// hold, and the machine, the project and the handlers are the same for all of
// them.

import type { BoxSession, Machine } from "../../lib/api";
import type { Place } from "../../lib/place";
import {
  paneHolds,
  type RemotePaneDirection,
  type RemotePaneTree,
} from "../../lib/remotePaneTree";
import type { RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import { CloudThreadPane } from "./CloudThreadPane";
import { MachineChat } from "./MachineChat";
import { RemoteSessionTerminal } from "./RemoteSessionTerminal";
import { RemoteFileEditor } from "./RemoteFileEditor";
import { WorkingDiffPane } from "../git/WorkingDiffPane";
import { ChangesSummaryPane } from "../git/ChangesSummaryPane";
import { MachineCommitDetail } from "../git/detail/MachineCommitDetail";
import { instanceIdFor } from "./machineWorkspace";

export type RemoteBodyContext = {
  machine: Machine;
  /** The place a tab on this strip runs in — the box, standing in the project
   *  the strip is filed under. Null until the machine resolves. */
  place: Place | null;
  /** This laptop's root for the project, which is what the place is keyed by.
   *  Not the box's: see `RemoteSessionTerminal` on why the local pty's cwd is
   *  deliberately ours. */
  repoRoot: string | undefined;
  /** A record on the board, when this workspace was entered from a dispatched
   *  job. The conversation tab reads it instead of the live chat. */
  threadKey: string | null;
  /** Open a file of the project as its own tab. Local-spelled absolute path. */
  onOpenFile: (path: string) => void;
  /** Close a tab. The session keeps running on the box. */
  onCloseTab: (id: string) => void;
  /** Join a session — used to re-join the other way round when someone swaps
   *  between watching and typing. */
  onAttach: (session: BoxSession, opts?: { readOnly?: boolean }) => void;
  /** How the body is divided, or null when one tab fills it. */
  panes: RemotePaneTree | null;
  /** The other open tabs that could join the pane holding `beside`. */
  splitWith: (beside: string) => RemoteTab[];
  onShowBeside: (
    beside: string,
    tabId: string,
    direction: RemotePaneDirection,
  ) => void;
  onShowAlone: () => void;
};

export function RemoteTabBody({
  tab,
  ctx,
}: {
  tab: RemoteTab;
  ctx: RemoteBodyContext;
}) {
  const { machine, place, repoRoot, threadKey } = ctx;

  if (tab.kind === "cloud") {
    // Arriving *from* a dispatched job, the thread on the board is the thing
    // you clicked and the thing you want to read — a record of work that
    // already ran, which the live chat has no way to show. Entering the machine
    // any other way gives you the real chat.
    return threadKey ? (
      <CloudThreadPane threadKey={threadKey} repoRoot={repoRoot ?? ""} />
    ) : (
      <MachineChat
        machineId={machine.id}
        machineName={machine.name}
        repoRoot={repoRoot ?? ""}
      />
    );
  }

  if (tab.kind === "file") {
    return repoRoot ? (
      <RemoteFileEditor repoRoot={repoRoot} path={tab.path} machineName={machine.name} />
    ) : null;
  }
  if (tab.kind === "diff") {
    if (!repoRoot) return null;
    if (tab.sha)
      return (
        <div className="ui-remote-scroll">
          <MachineCommitDetail
            key={tab.sha}
            repoRoot={repoRoot}
            sha={tab.sha}
            initialPath={tab.path}
          />
        </div>
      );
    const rel = tab.path;
    return rel ? (
      <WorkingDiffPane
        key={rel}
        repoRoot={repoRoot}
        path={rel}
        onOpenInEditor={() => ctx.onOpenFile(`${repoRoot.replace(/\/$/, "")}/${rel}`)}
      />
    ) : (
      <ChangesSummaryPane repoRoot={repoRoot} />
    );
  }
  // Every terminal tab stays mounted-by-id in the Terminal module's own session
  // cache, so switching tabs — and leaving the workspace and coming back —
  // reattaches to the same running session rather than dialling a second one.
  //
  // The boot line is ASKED for rather than built here — see
  // `RemoteSessionTerminal`. One transport, written once in Rust.
  if (!place) return null;
  return (
    <RemoteSessionTerminal
      place={place}
      session={tab.session}
      readOnly={tab.readOnly}
      instanceId={instanceIdFor(machine, tab.id)}
      // Asked about this pane, not about whichever one holds the keyboard:
      // every pane carries its own toolbar, and a menu that offered the
      // neighbours of a different pane would put the new one in the wrong place.
      split={{
        candidates: ctx.splitWith(tab.id),
        inSplit: !!ctx.panes && paneHolds(ctx.panes, tab.id),
        onShowBeside: (other, direction) =>
          ctx.onShowBeside(tab.id, other, direction),
        onShowAlone: ctx.onShowAlone,
      }}
      cwd={repoRoot || undefined}
      repoRoot={repoRoot || undefined}
      onCloseView={() => ctx.onCloseTab(tab.id)}
      // Watching and typing are two tabs of one session, because the attach
      // mode is part of the line the box is dialled with. So swapping is: join
      // the other way, then drop the view you were in — the session on the box
      // never notices.
      onToggleReadOnly={() => {
        ctx.onAttach(tab.session, { readOnly: !tab.readOnly });
        ctx.onCloseTab(tab.id);
      }}
    />
  );
}
