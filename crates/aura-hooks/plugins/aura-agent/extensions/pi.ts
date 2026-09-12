// Aura's Pi extension: report what the agent changed, so the repo shows as
// worked-in rather than idle.
//
// Like OpenCode, Pi has no shell-command hooks — an extension is a module it
// imports — so this is a shim, not a decision. What counts as a change lives
// in `on-post-tool-use.sh` next door, the one body every non-Claude CLI runs.
//
// Staged by `aura-hooks` at `~/.pi/agent/extensions/aura.ts`, where Pi
// discovers it for every project. Nothing is written into the repo.
//
// Pi splits a tool call across two events and only the first carries the
// arguments, so the arguments are held until the call finishes — an edit that
// was blocked or errored should not be recorded as one that happened.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK = join(homedir(), ".aura", "plugins", "aura-agent", "scripts", "on-post-tool-use.sh");

/** Hand one tool call to the shared hook and forget about it. Failure is not
 *  worth surfacing: the agent's own work succeeded, and only the record of it
 *  was missed. */
const report = (payload: Record<string, unknown>) => {
  try {
    const child = spawn(HOOK, {
      cwd: process.cwd(),
      env: { ...process.env, AURA_HOOK_AGENT: "Pi" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  } catch {
    // no-op
  }
};

/** What Pi hands a handler as its second argument. Only the one method is
 *  named, because it is the only one this extension has any business calling:
 *  Pi is alone among these CLIs in not putting the session id on the event, so
 *  it has to be asked for. */
type PiContext = { sessionManager?: { getSessionId?: () => string } };

export default function aura(pi: {
  on: (
    event: string,
    handler: (event: Record<string, any>, ctx: PiContext) => Promise<void> | void,
  ) => void;
}) {
  const pending = new Map<string, { toolName: string; args: unknown }>();

  pi.on("tool_execution_start", (event) => {
    if (typeof event.toolCallId === "string") {
      pending.set(event.toolCallId, { toolName: event.toolName, args: event.args });
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const started = pending.get(id);
    pending.delete(id);
    if (!started || event.isError === true) return;

    // Pi identifies a session by its session file rather than putting an id on
    // the event, so the id comes off the context. Absent is survivable — the
    // row is still worth writing, it just cannot be grouped.
    let sessionId: string | undefined;
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.();
    } catch {
      // no-op
    }

    report({
      toolName: started.toolName,
      args: started.args,
      sessionId,
      cwd: process.cwd(),
    });
  });
}
