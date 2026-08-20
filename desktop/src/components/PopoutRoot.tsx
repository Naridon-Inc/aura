// Root component for a spun-off popout window (see lib/popout.ts). Mounted by
// main.tsx in place of <App/> when the window URL carries `?popout=…`. Renders
// a slim drag-bar (matching the main window's overlay chrome) plus the single
// requested surface — currently a floating portrait Tasks board.

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pin, PinOff, X } from "lucide-react";
import { TasksBoard } from "./TasksBoard";
import { TaskDetailPane } from "./tasks/TaskDetailPane";
import { PRDetailPane } from "./workpanes/PRDetailPane";
import { AgentTerminalView } from "./agent/AgentTerminalView";
import { AgentIcon } from "./agent/AgentIcon";
import { BrowserPopout } from "./BrowserPopout";
import { ManagerSurface } from "./manager/ManagerSurface";
import { Terminal } from "./Terminal";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import type { PopoutParams } from "../lib/popout";

const TITLES: Record<PopoutParams["kind"], string> = {
  tasks: "Tasks",
  task: "Task",
  pr: "Pull request",
  agent: "Agent",
  browser: "Browser",
  manager: "Chat",
  terminal: "Terminal",
  // `workspace` never reaches PopoutRoot (main.tsx mounts the full App for it);
  // the key exists only to satisfy the exhaustive PopoutKind record.
  workspace: "Workspace",
};

/** The agent terminal in a detached window.
 *
 *  The PTY lives in the Rust backend keyed by session id, so this view
 *  attaches to the same app-global `agent-pty:<sid>` stream the in-app tab
 *  used and the live session continues here uninterrupted. `dormant={false}`
 *  → attach, don't show the cold "Start agent" overlay.
 *
 *  It withholds `onAutoRespawn` on purpose — a detached window must not
 *  silently relaunch an agent that died. But that prop was also the Restart
 *  button's implementation, so withholding it left a popped-out window with a
 *  permanently greyed-out Restart and no way back. `onRestart` is the
 *  explicit half: the session id lives in state so a restart can re-point
 *  this window at the new PTY, since the URL param only names the first one.
 */
function PopoutAgent({
  sessionId,
  agentId,
  repoRoot,
  label,
}: {
  sessionId: string;
  agentId?: string;
  repoRoot: string;
  label?: string;
}) {
  const [sid, setSid] = useState(sessionId);
  const [restartErr, setRestartErr] = useState<string | null>(null);

  // Without the agent id there is nothing to spawn — an older popout URL, or
  // a kind that never carried one. Leaving `onRestart` undefined keeps the
  // button honestly disabled rather than failing on click.
  const restart = agentId
    ? async () => {
        setRestartErr(null);
        try {
          const handle = await api.agentPtyOpen(agentId, repoRoot, 80, 24, undefined, true);
          setSid(handle.id);
        } catch (e) {
          setRestartErr(e instanceof Error ? e.message : String(e));
        }
      }
    : undefined;

  return (
    <div className="flex-1 min-h-0 relative">
      <AgentTerminalView
        key={sid}
        sessionId={sid}
        agentId={agentId}
        agentLabel={label}
        repoRoot={repoRoot}
        dormant={false}
        onRestart={restart}
      />
      {restartErr && (
        <div className="absolute inset-x-0 bottom-0 z-20 border-t border-red/30 bg-bg-1/95 px-4 py-2 text-xs text-red">
          Couldn't restart the agent. {restartErr}
        </div>
      )}
    </div>
  );
}

function shortRoot(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

export function PopoutRoot({ params }: { params: PopoutParams }) {
  const [pinned, setPinned] = useState(false);

  // Tag <html> so popout-scoped CSS (full-bleed, no app chrome) can apply.
  useEffect(() => {
    document.documentElement.dataset.popout = params.kind;
    return () => {
      delete document.documentElement.dataset.popout;
    };
  }, [params.kind]);

  const togglePinned = () => {
    const next = !pinned;
    setPinned(next);
    getCurrentWindow()
      .setAlwaysOnTop(next)
      .catch(() => setPinned(!next));
  };

  const close = () => {
    getCurrentWindow().close().catch(() => {});
  };

  return (
    <div className="popout-root">
      <div className="popout-bar" data-tauri-drag-region>
        <span className="popout-bar-title" data-tauri-drag-region>
          {params.kind === "agent" && params.agentId && (
            <AgentIcon agentId={params.agentId} size={14} />
          )}
          {params.kind === "agent" ? params.label ?? "Agent" : TITLES[params.kind]}
          <span className="popout-bar-sub">{shortRoot(params.root)}</span>
        </span>
        <div className="popout-bar-actions">
          <button
            type="button"
            className={`popout-bar-btn${pinned ? " active" : ""}`}
            onClick={togglePinned}
            title={pinned ? "Unpin (allow other windows on top)" : "Keep on top of other windows"}
            aria-pressed={pinned}
          >
            {pinned ? <PinOff size={14} strokeWidth={2} /> : <Pin size={14} strokeWidth={2} />}
          </button>
          <button
            type="button"
            className="popout-bar-btn"
            onClick={close}
            title="Close window"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="popout-body">
        {params.kind === "tasks" && (
          <TasksBoard repoRoot={params.root} embedded onClose={close} />
        )}
        {params.kind === "task" && params.taskId && (
          <TaskDetailPane
            taskId={params.taskId}
            repoRoot={params.root}
            embedded
            onClose={close}
          />
        )}
        {params.kind === "agent" && params.sessionId && (
          <PopoutAgent
            sessionId={params.sessionId}
            agentId={params.agentId}
            repoRoot={params.root}
            label={params.label}
          />
        )}
        {params.kind === "pr" && params.prNumber != null && (
          <PRDetailPane
            selOverride={{ repoRoot: params.root, number: params.prNumber }}
            embedded
            onClose={close}
          />
        )}
        {params.kind === "browser" && params.browserId && (
          <BrowserPopout tabId={params.browserId} initialUrl={params.url} />
        )}
        {params.kind === "manager" && params.sessionId && (
          // The session lives in the Rust ManagerRuntime keyed by id;
          // ManagerSurface's useManagerSession hydrates from `manager:<sid>`
          // snapshots (app-global emit), so the forked chat renders here
          // exactly as it would in the in-app view.
          <ManagerSurface sessionId={params.sessionId} />
        )}
        {params.kind === "terminal" && (
          <TerminalPopout
            root={params.root}
            cwd={params.cwd ?? params.root}
            reconnectId={params.reconnectId ?? null}
          />
        )}
      </div>
    </div>
  );
}

// A standalone terminal in its own OS window ("New Terminal Window"). In daemon
// mode `reconnectId` re-subscribes to the live session that was popped out; in
// the default in-process mode it spawns a fresh shell in `cwd`. The PTY lives in
// the shared Rust backend, so closing this window must `pty_close` the child or
// it orphans — the main window's session Map never knew about it. We capture the
// backend pty id from `onOpened` and close it on the window-close request.
function TerminalPopout({
  root,
  cwd,
  reconnectId,
}: {
  root: string;
  cwd: string;
  reconnectId: string | null;
}) {
  const ptyIdRef = useRef<string | null>(null);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onCloseRequested(() => {
      const id = ptyIdRef.current;
      if (id) invoke("pty_close", { id }).catch(() => {});
    });
    return () => {
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, []);

  return (
    <div className="flex-1 min-h-0 relative">
      <Terminal
        instanceId={reconnectId ?? "popout-terminal"}
        cwd={cwd}
        repoRoot={root}
        reconnectId={reconnectId}
        scrollbackKey={null}
        onOpened={(ptyId) => {
          ptyIdRef.current = ptyId;
        }}
      />
    </div>
  );
}
