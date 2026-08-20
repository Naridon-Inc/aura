// Typing a first message into an agent CLI that is still booting.
//
// An agent PTY answers `agent_pty_send_prompt` the instant it is spawned, but
// the CLI on the other end is a TUI: it clears the screen, draws its frame and
// only then starts reading stdin. Bytes written into that gap are swallowed —
// which is exactly how a launched workspace used to lose the objective the
// user typed, landing them in Claude with an empty composer.
//
// The fix is not a fixed sleep. We wait for the session's *first output* — the
// TUI's own first paint, the earliest honest evidence it is alive — then give
// it a short settle beat to finish drawing before injecting. A silent agent
// (one that prints nothing at all, or died on spawn) is covered by a hard
// timeout, so seeding degrades to "type it anyway" rather than hanging.
//
// Lives here rather than inside `workspaceCreateStore` because two callers now
// need it: launching a workspace with an agent fleet, and landing a new copy
// in a single agent CLI (`workspaceLanding.ts`). One implementation, so a
// timing fix in one place fixes both.

import { listen } from "@tauri-apps/api/event";

import { api } from "./api";

/** How long to wait after the agent's first output before injecting — the
 *  TUI is usually mid-paint on its very first bytes. */
const SEED_SETTLE_MS = 600;
/** Give up waiting for first output and inject anyway. */
const SEED_TIMEOUT_MS = 5000;

/** Wait for the session's first PTY output, then a settle beat; resolve after
 *  SEED_TIMEOUT_MS regardless so seeding never hangs on a silent agent. */
export async function waitForFirstPaint(sessionId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    let unlisten: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      unlisten?.();
      resolve();
    };
    const timeout = setTimeout(finish, SEED_TIMEOUT_MS);
    listen(`agent-pty:${sessionId}`, () => {
      setTimeout(finish, SEED_SETTLE_MS);
    })
      .then((un) => {
        unlisten = un;
        // Listener attached after the event already fired (fast agent) is
        // covered by the hard timeout — replay isn't needed for seeding.
        if (done) un();
      })
      .catch(() => finish());
  });
}

/**
 * Wait for the agent to paint, then type `text` into it.
 *
 * Fire-and-forget by design: the caller has already put the user in front of
 * the tab, and a slow TUI boot must not hold up the surface. A session that
 * died between spawn and seed swallows the error — its own tab already shows
 * the exit, and there is nothing useful to say twice.
 */
export function seedAgentPrompt(sessionId: string, text: string): void {
  const body = text.trim();
  if (!body) return;
  void waitForFirstPaint(sessionId).then(() =>
    api.agentPtySendPrompt(sessionId, body).catch(() => {
      /* session gone — its surface shows the exit */
    }),
  );
}
