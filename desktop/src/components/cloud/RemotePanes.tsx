// The body of a remote workspace, divided.
//
// Draws the arrangement `remotePaneTree` describes: every leaf is a tab that is
// also on the strip, so what you see here is a view of what is open rather than
// a second place tabs live. The pane you clicked last holds the keyboard — it is
// `activeId`, the same field the strip lights — and the keystroke handlers each
// pane installs are its own, so ⌘F finds in the terminal you are typing in.
//
// Deliberately the same geometry as the local terminal panel's split: a hairline
// of the chrome colour between panes and nothing else. A terminal's output is
// not boxed in, and a pane here is already announced by the toolbar above it.

import type { ReactNode } from "react";

import {
  paneCount,
  type RemotePaneTree,
} from "../../lib/remotePaneTree";
import type { RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import { RemoteTabBody, type RemoteBodyContext } from "./RemoteTabBody";
import "../ui/remote-work.css";

export function RemotePanes({
  tree,
  tabs,
  activeId,
  onFocus,
  ctx,
}: {
  tree: RemotePaneTree;
  tabs: RemoteTab[];
  /** Which pane has the keyboard. */
  activeId: string;
  onFocus: (tabId: string) => void;
  ctx: RemoteBodyContext;
}) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  // The outline only earns its keep when there is more than one pane to tell
  // apart — and by the time this renders there always is, since a layout of one
  // is not a layout. Computed anyway rather than assumed, because a tree is an
  // input and this is the one place the assumption would show.
  const multi = paneCount(tree) > 1;
  return (
    <div className="ui-remote-panes">{render(tree)}</div>
  );

  function render(node: RemotePaneTree): ReactNode {
    if (node.kind === "leaf") {
      const tab = byId.get(node.tabId);
      if (!tab) return null;
      return (
        <div
          // Capture, so clicking into a terminal moves the keyboard before the
          // terminal itself handles the click — otherwise the first keystroke
          // after a click goes to the pane you just left.
          onMouseDownCapture={() => onFocus(tab.id)}
          onFocusCapture={() => onFocus(tab.id)}
          className="ui-remote-pane"
          data-focused={multi && tab.id === activeId ? "" : undefined}
        >
          <RemoteTabBody key={tab.id} tab={tab} ctx={ctx} />
        </div>
      );
    }
    return (
      <div className="ui-remote-split" data-direction={node.direction}>
        {node.children.map((child, i) => (
          <div key={i} className="ui-remote-split-cell">
            {render(child)}
          </div>
        ))}
      </div>
    );
  }
}
