// The single global host for every "your agent has stopped and is waiting
// on you" card. Two things park an agent, and both dock here:
//
//   * Aura's destructive-op gate — our validator is unsure about something
//     risky the agent is about to do (`parked/GateCard`);
//   * a permission prompt — claude itself asking before it uses a tool,
//     arriving over the MCP bridge (`parked/PermissionCard`). In chat mode
//     the CLI has no terminal to draw its own prompt in, so if nothing
//     renders this the agent waits forever with no visible reason.
//
// One host and one queue because it is one moment for the person using the
// app: work stopped, and only they can restart it. Two hosts would race for
// the same dock and stack cards on top of each other.
//
// Both cards sit in the same dock (`parked/dock`), just above the composer
// the agent is waiting on, without hijacking the rest of the window.
//
// Multiple gates can queue (the agent fires one per blocked tool call);
// we show them oldest-first since the agent is blocked on the oldest,
// de-duped by gateId.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePermissionPrompts } from "../../lib/permissionStore";
import { getChannelMeta } from "../../lib/agentStreamStore";
import { ACP_PROMPT_TOOLS, AcpPrompt } from "./AcpPrompts";
import { GateCard } from "./parked/GateCard";
import { ParkedShell } from "./parked/dock";
import type { AgentGateRequest } from "./parked/gateTypes";
import { PermissionCard } from "./parked/PermissionCard";

export type { AgentGateRequest, AgentImpact } from "./parked/gateTypes";

export function AgentGateHost() {
  // Oldest-first queue (FIFO). The agent is blocked on the oldest gate,
  // so that's the one we surface; resolving it pops the front.
  const [queue, setQueue] = useState<AgentGateRequest[]>([]);

  // The other reason an agent parks: claude asking permission before it
  // uses a tool, routed in over the MCP bridge. Different question, same
  // moment — work has stopped and only a human restarts it — so both go
  // through this one host rather than two cards racing for the same dock.
  const prompts = usePermissionPrompts(null);

  // Subscribe once to the bare global events. Every gate, every session.
  useEffect(() => {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    const track = (fn: UnlistenFn) => {
      if (active) unlisteners.push(fn);
      else fn(); // unmounted before subscribe resolved
    };
    listen<AgentGateRequest>("agent-gate-request", (event) => {
      const req = event.payload;
      if (!req || !req.gateId) return;
      setQueue((q) => {
        // De-dupe by gateId — the hook can retry, and we never want two
        // cards for the same parked call.
        if (q.some((g) => g.gateId === req.gateId)) return q;
        return [...q, req];
      });
    }).then(track);
    // The backend fires this the instant a parked gate is settled on ITS side
    // — approved, denied, timed out, or the parked connection dropped. Drop the
    // matching card so a server-side timeout can never strand a live-but-dead
    // card whose Allow button no longer maps to anything (the old "must restart
    // the app" deadlock).
    listen<{ gateId?: string }>("agent-gate-closed", (event) => {
      const gid = event.payload?.gateId;
      if (gid) setQueue((q) => q.filter((g) => g.gateId !== gid));
    }).then(track);
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const gateFront = queue[0] ?? null;
  const promptFront = prompts[0] ?? null;
  const waiting = queue.length + prompts.length;

  const pop = useCallback((gateId: string) => {
    setQueue((q) => q.filter((g) => g.gateId !== gateId));
  }, []);

  // Whichever has been waiting longest is shown first. Both stamp unix
  // seconds when the agent parked, so they sort against each other — and
  // answering out of order would leave the older, more-stuck agent behind
  // a card that has no way to reach it.
  if (promptFront && (!gateFront || promptFront.ts <= gateFront.createdAt)) {
    // A form to fill or a link to open, from an agent Aura hosts. Allow and
    // Deny alone cannot answer those, so the dock carries the same card the
    // chat shows for them.
    if (ACP_PROMPT_TOOLS.has(promptFront.tool_name)) {
      return createPortal(
        <ParkedShell key={promptFront.prompt_id} label="Your agent is asking you">
          <AcpPrompt
            prompt={promptFront}
            docked
            repoRoot={getChannelMeta(promptFront.channel).repoRoot ?? ""}
          />
        </ParkedShell>,
        document.body,
      );
    }
    return createPortal(
      // No onResolved: `decidePrompt` removes the prompt from the store
      // itself, and the store is what this host reads. One owner.
      <PermissionCard
        key={promptFront.prompt_id}
        prompt={promptFront}
        pending={waiting - 1}
      />,
      document.body,
    );
  }

  if (!gateFront) return null;

  return createPortal(
    <GateCard
      // key by gateId so each gate gets a fresh card (resets the note,
      // in-flight and error state).
      key={gateFront.gateId}
      request={gateFront}
      pending={waiting - 1}
      onResolved={() => pop(gateFront.gateId)}
    />,
    document.body,
  );
}
