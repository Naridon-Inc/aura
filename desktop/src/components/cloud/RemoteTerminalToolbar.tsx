// The toolbar over a session terminal on another machine.
//
// A remote pane used to be a bare terminal with a tab strip above it, while a
// local one carried a full toolbar: shell chip, find, clear, the `...` actions.
// Same keystrokes, same engine, two different levels of furniture — so the
// remote one read as a console someone bolted on, and the things you reach for
// mid-session (find a line in a build log, clear a screen, copy a stack trace)
// were simply not there.
//
// This is that toolbar — the library terminal toolbar, led by the cloud
// terminal's own header line — with the parts that only mean something here:
//
//   • WHOSE session it is. The box named it, an agent may be running in it, and
//     it may have a branch of its own — that is the identity a local pane gets
//     for free from the fact that you started it.
//   • Whether you have the keyboard. Joining read-only is how you look over an
//     agent's shoulder without typing into it, and the difference has to be on
//     screen: a terminal that silently drops your keystrokes is indistinguishable
//     from a machine that has stopped answering.
//   • Who else is in here. tmux reports the clients attached, and on a shared
//     box that is sometimes a person.
//
// It does not repeat the tab strip: joining another session and closing a tab
// live there. Clear and select-all are view actions on the local grid, so they
// stay available read-only; Paste writes to the session and does not.

import {
  Eraser,
  Eye,
  Keyboard,
  MoreHorizontal,
  Search,
  Terminal,
  Users,
} from "lucide-react";

import type { BoxSession } from "../../lib/api";
import type { RemotePaneDirection } from "../../lib/remotePaneTree";
import type { RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import { SplitIcon } from "../terminal/icons";
import { TerminalOverflowMenu } from "../terminal/TerminalOverflowMenu";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RemoteSplitMenu } from "./RemoteSplitMenu";
import "../ui/details-terminal.css";
import "../ui/remote-workspace.css";

/** What this pane can be shown beside, and how to ask for it. Absent in a
 *  surface that has no second pane to offer — a popped-out window of one
 *  session, say — so the control is missing rather than inert. */
export type RemoteSplitOffer = {
  candidates: RemoteTab[];
  inSplit: boolean;
  onShowBeside: (tabId: string, direction: RemotePaneDirection) => void;
  onShowAlone: () => void;
};

type Props = {
  /** The session, as the machine reported it — never a name invented here. */
  session: BoxSession;
  /** Joined to watch, without the keyboard. */
  readOnly: boolean;
  split?: RemoteSplitOffer;
  onFind: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  /** Re-join the same session the other way round: take the keyboard, or give
   *  it back. Absent when this workspace cannot offer the swap. */
  onToggleReadOnly?: () => void;
  /** Close this view. The session keeps running on the box. */
  onCloseView: () => void;
};

export function RemoteTerminalToolbar({
  session,
  readOnly,
  split,
  onFind,
  onClear,
  onCopy,
  onPaste,
  onSelectAll,
  onToggleReadOnly,
  onCloseView,
}: Props) {
  // What is running, in the box's own words. The agent when there is one,
  // because "claude" is the answer to "what is this session" far more often
  // than the tmux name is; the branch when it was given its own.
  const detail = [session.agent, session.branch].filter(Boolean).join(" · ");
  const others = Math.max(0, session.attached - 1);

  return (
    <div className="ui-details-terminal-toolbar ui-remote-terminal-bar">
      <span className="ui-remote-terminal-title">
        <Terminal size={14} />
        <span>{session.name}</span>
        {detail && <span className="ui-remote-terminal-detail">{detail}</span>}
      </span>
      {readOnly && (
        <Badge
          variant="secondary"
          title="You joined to watch. Keystrokes are not sent to this session."
        >
          <Eye size={12} />
          Watching
        </Badge>
      )}
      {others > 0 && (
        <Badge
          variant="secondary"
          title={`${others} other client${others > 1 ? "s" : ""} attached to this session`}
        >
          <Users size={12} />
          {others}
        </Badge>
      )}

      <div className="ui-details-terminal-actions">
        {onToggleReadOnly && (
          <Button
            variant="ghost"
            size="iconXs"
            aria-label={readOnly ? "Take the keyboard" : "Watch without typing"}
            title={readOnly ? "Take the keyboard" : "Watch without typing"}
            onClick={onToggleReadOnly}
          >
            {readOnly ? <Keyboard /> : <Eye />}
          </Button>
        )}
        {split && (
          <RemoteSplitMenu
            trigger={
              <Button
                variant="ghost"
                size="iconXs"
                aria-label="Show another session beside this one"
                title="Show another session beside this one"
              >
                <SplitIcon />
              </Button>
            }
            candidates={split.candidates}
            inSplit={split.inSplit}
            onShowBeside={split.onShowBeside}
            onShowAlone={split.onShowAlone}
          />
        )}
        <Button variant="ghost" size="iconXs" aria-label="Find" title="Find (⌘F)" onClick={onFind}>
          <Search />
        </Button>
        <Button
          variant="ghost"
          size="iconXs"
          aria-label="Clear terminal"
          title="Clear Terminal (⌘K)"
          onClick={onClear}
        >
          <Eraser />
        </Button>
        <TerminalOverflowMenu
          trigger={
            <Button variant="ghost" size="iconXs" aria-label="More actions" title="More Actions">
              <MoreHorizontal />
            </Button>
          }
          hasSelection
          canPaste={!readOnly}
          onClear={onClear}
          onCopy={onCopy}
          onPaste={onPaste}
          onSelectAll={onSelectAll}
          onKill={onCloseView}
          killLabel="Close View"
          killDestructive={false}
        />
      </div>
    </div>
  );
}
