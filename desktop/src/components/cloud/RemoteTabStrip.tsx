// The tab row of a remote workspace — the cloud workspace's own: the
// workspace tabs, and one ＋ at the right end for anything new. A machine is a
// workspace that happens to be somewhere else, so it wears a workspace's top,
// not a cloud console of its own invention.
//
// What the machine *is* — its address, whether it's up, the folder the chat
// reads, the way out — is the workspace's title in the header above, where
// every workspace keeps its details.

import { useEffect, type ReactNode } from "react";
import { MessageSquare, Plus, Radio, Terminal as TerminalIcon, X } from "lucide-react";

import type { BoxSession, Machine } from "../../lib/api";
import { placeOfMachine } from "../../lib/place";
import { CHAT_TAB_ID, type RemoteTab } from "../../lib/remoteWorkspaceSnapshot";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip } from "../ui/tooltip";
import { BoxPanel } from "./BoxPanel";
import { RemoteTabMark, remoteTabHint, remoteTabLabel } from "./remoteTabFace";
import type { BoxState } from "./useBox";
import "../ui/remote-workspace.css";

export function RemoteTabStrip({
  machine,
  onMachineChanged,
  tabs = [],
  activeId = "",
  onActivate,
  onCloseTab,
  adding = false,
  onToggleAdd,
  onOpenShell,
  canOpen = false,
  box,
  openSessions = [],
  onAttach,
}: {
  machine: Machine | null;
  /** The row the box came back as after waking, from the join panel. */
  onMachineChanged: (m: Machine) => void;
  tabs?: RemoteTab[];
  activeId?: string;
  onActivate?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  adding?: boolean;
  /** Open or close the join panel; no argument flips it. Closing passes
   *  `false` — a join has usually closed it already, and a flip would open it
   *  again over the session just joined. */
  onToggleAdd?: (open?: boolean) => void;
  /** Open a shell on the machine in a new tab. */
  onOpenShell?: () => void;
  /** Whether a shell can be dialled on this machine at all — the place's
   *  saved address has to be one the terminal can boot on. */
  canOpen?: boolean;
  box?: BoxState;
  openSessions?: string[];
  onAttach?: (s: BoxSession, opts?: { readOnly?: boolean }) => void;
}) {
  // The join panel is a plain positioned panel rather than a Radix popover
  // (it hosts its own wake flow and forms), so Escape is wired here.
  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleAdd?.(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding, onToggleAdd]);

  const cantDial = "This machine's saved address can't be dialled — reconnect it";

  return (
    <div className="ui-cloud-tab-row ui-remote-strip">
      <div className="ui-workspace-tabs">
        <div className="ui-workspace-tab-scroll" role="tablist" aria-label="Open on this machine">
          {tabs.map((t) => {
            const on = t.id === activeId;
            const label = remoteTabLabel(t);
            const shared = t.kind === "session" && t.session.attached > 1;
            return (
              <div
                key={t.id}
                className="ui-workspace-tab group"
                data-selected={on}
                title={remoteTabHint(t)}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => onActivate?.(t.id)}
                >
                  <span className="ui-remote-tab-mark">
                    <RemoteTabMark tab={t} />
                  </span>
                  <span>{label}</span>
                  {/* Someone else is attached to this same session. Worth a
                      mark on the tab itself — you are sharing a keyboard with
                      them the moment you start typing. */}
                  {shared && (
                    <span
                      className="ui-tab-unread"
                      aria-label={`${t.session.attached} people are attached to this session`}
                      title={`${t.session.attached} people are attached to this session`}
                    />
                  )}
                </button>
                {/* Closing a tab closes a view; the session keeps running on
                    the box. The conversation is the board's record, and
                    closing it here would imply otherwise, so it has no close. */}
                {t.kind !== "cloud" && (
                  <button
                    type="button"
                    className="ui-tab-close"
                    aria-label={`Close ${label}`}
                    title="Close this tab — the session keeps running on the machine"
                    onClick={() => onCloseTab?.(t.id)}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* The ＋ menu every workspace has — Chat · Cloud terminal — plus the
          one thing only a machine has: joining a session already running on
          it. A row that can't act says why on hover; a disabled row takes no
          pointer, so the reason hangs on the row's wrapper. */}
      {machine && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconSm" aria-label="New tab on this machine">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="ui-remote-new-menu">
            <DropdownMenuItem onSelect={() => onActivate?.(CHAT_TAB_ID)}>
              <MessageSquare />
              Chat
            </DropdownMenuItem>
            <NewTabRow reason={canOpen && onOpenShell ? null : cantDial} onSelect={() => onOpenShell?.()}>
              <TerminalIcon />
              Cloud terminal
            </NewTabRow>
            <DropdownMenuSeparator />
            <NewTabRow reason={canOpen ? null : cantDial} onSelect={() => onToggleAdd?.()}>
              <Radio />
              Join a running session…
            </NewTabRow>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {adding && machine && box && (
        <>
          {/* Click-away: a panel that only closes by pressing the same button
              again is a panel people leave open over their work. */}
          <div className="ui-remote-backdrop" onClick={() => onToggleAdd?.(false)} />
          <BoxPanel
            place={placeOfMachine(machine)}
            box={box}
            openSessions={openSessions}
            onAttach={(s, opts) => onAttach?.(s, opts)}
            // Waking rewrites the row — a stopped machine comes back on a
            // different address — so the woken row goes back to the book.
            onWoke={onMachineChanged}
            onClose={() => onToggleAdd?.(false)}
          />
        </>
      )}
    </div>
  );
}

/** A ＋ menu row: live when `reason` is null, otherwise greyed out with the
 *  reason on hover. */
function NewTabRow({
  reason,
  onSelect,
  children,
}: {
  reason: string | null;
  onSelect: () => void;
  children: ReactNode;
}) {
  if (!reason) return <DropdownMenuItem onSelect={onSelect}>{children}</DropdownMenuItem>;
  return (
    <Tooltip content={reason} side="left">
      <div>
        <DropdownMenuItem disabled>{children}</DropdownMenuItem>
      </div>
    </Tooltip>
  );
}
