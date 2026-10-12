// An agent PTY drawn by the native GPU engine.
//
// The agent's shell belongs to `cmd_agent_pty` — it was spawned before this
// pane existed and outlives it — so this pane attaches to that PTY rather than
// starting one: `native_term_attach` taps its output into the renderer and
// sends keystrokes back down the same write path the xterm canvas uses.
// Closing the pane detaches; the agent keeps running.
//
// Two things the xterm canvas does in the page happen in Rust here, and one
// moves to the backend's own stream:
//
//   * output parsing and painting — the whole point, since an agent's
//     full-screen repaints are what the in-page engine chokes on;
//   * scrollback, selection, copy/paste and the keymap, all inside
//     `<NativeTerminal>`;
//   * the tab title, which xterm got from parsing OSC 0/2 itself. The PTY read
//     loop already parses it (`last_title`) and publishes `agent-title:<sid>`,
//     so the title here comes from the same place the rest of the app reads it.

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { api } from "../../lib/api";
import { noteAgentTerminalTitle } from "../../lib/agentTerminalTitles";
import { NativeTerminal } from "../NativeTerminal";

type AgentTitleEvent = { session_id: string; title: string };

/** The native terminal id for an agent session. Namespaced because the native
 *  manager keys shell terminals and agent panes in one map, and derived rather
 *  than stored so `closeAgent` can release the surface without the pane having
 *  to report it first. */
export function agentNativeTermId(sessionId: string): string {
  return `agent-${sessionId}`;
}

type Props = {
  sessionId: string;
  /** The GPU surface or the attach itself failed — the parent mounts the xterm
   *  canvas instead, so the user gets a terminal rather than a blank hole. */
  onUnavailable?: () => void;
};

export function AgentNativeCanvas({ sessionId, onUnavailable }: Props) {
  // What the agent calls itself, forwarded to the tab strip. Backfilled once in
  // case the title was set before we subscribed — a session already running at
  // app launch — with the live event winning any race.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    let sawLive = false;

    (async () => {
      unlisten = await listen<AgentTitleEvent>(`agent-title:${sessionId}`, (e) => {
        if (cancelled) return;
        sawLive = true;
        noteAgentTerminalTitle(sessionId, e.payload.title);
      });
      if (cancelled) return;
      try {
        const t = await api.agentPtyTitle(sessionId);
        if (!cancelled && !sawLive && t) noteAgentTerminalTitle(sessionId, t);
      } catch {
        /* unknown session — the pill keeps the agent's name */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  return (
    <div className="absolute inset-0 bg-bg-content">
      <NativeTerminal
        instanceId={agentNativeTermId(sessionId)}
        attachSessionId={sessionId}
        onUnavailable={onUnavailable}
      />
    </div>
  );
}
