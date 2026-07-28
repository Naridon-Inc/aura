// Faithful "send a full turn into a project's ambient Aura chat" — the path
// the floating HUD's composer uses so it reaches PARITY with the in-app
// `ManagerComposer` / `ManagerChatView.send`:
//
//   1. resolve (or start) the project's ambient manager session,
//   2. run the SAME client-side slash interpreter (`handleChatSlash`) so a
//      `/command` typed in the HUD actually executes (and its output is
//      persisted into the session so it shows in the app + the HUD glance),
//   3. apply the SAME mode steering prefix (`buildSteeringText`),
//   4. dispatch through `brain_chat_turn` with the per-turn knobs the composer
//      chips carry (effort / fast / approval / model / brain override), or the
//      legacy `manager_chat` path for CLI-wrapper brains.
//
// The old HUD path called the bare `manager_chat` (no slash handling, none of
// the per-turn knobs); this module is the missing link. It deliberately does
// NOT reproduce ManagerChatView's component-local optimistic UI (stream blocks,
// busy state, slash-log bubbles) — those are owned by whatever chat view is
// mounted; the in-flight marker + backend events drive the HUD and any open
// chat alike.

import { api, type ApprovalPolicy, type ReasoningEffort } from "./api";
import { handleChatSlash } from "./chatSlashHandler";
import { focusAmbientManager } from "./focusManager";
import {
  clearManagerTurnInFlight,
  markManagerTurnInFlight,
  setManagerTurnStartedAt,
} from "./managerStore";
import { buildSteeringText, type SteeringMode } from "./managerSteering";

/** Per-turn composer config the HUD carries alongside the text. Mirrors the
 *  arguments `ManagerChatView.send` threads into `brain_chat_turn`. */
export type ManagerTurnOptions = {
  mode?: SteeringMode;
  effort?: ReasoningEffort | null;
  fast?: boolean;
  approval?: ApprovalPolicy | null;
  /** `ChatRequest.model` — null keeps the brain's default. */
  model?: string | null;
  /** The picker's "1M" rows. */
  longContext?: boolean;
  /** Engine override for this turn (a BrainChoice id), or null for the active brain. */
  brainId?: string | null;
};

const ambientKey = (repoRoot: string) => `aura.ambient.${repoRoot}`;

function readAmbientSid(repoRoot: string): string | null {
  try {
    return localStorage.getItem(ambientKey(repoRoot));
  } catch {
    return null;
  }
}

/** Trailing-slash-tolerant root compare — same rule the ambient bookkeeping
 *  uses elsewhere. */
function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

// Mode steering is a STANDING instruction (the brain keeps the conversation),
// so we send it only on the first turn of a session or when the mode changes —
// mirroring ManagerChatView's `steeringSentRef`, but module-scoped since the
// HUD path has no component to hang a ref on. Keyed by session id.
const steeringSent = new Map<string, SteeringMode>();

/**
 * Send `text` into `repoRoot`'s ambient manager session with full composer
 * parity. Returns the session id the turn landed in (so callers can focus it).
 */
export async function sendAmbientManagerTurn(
  repoRoot: string,
  text: string,
  opts: ManagerTurnOptions = {},
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // 1) Resolve the ambient session, validating it still belongs to this project
  //    (a stale / cross-workspace sid falls through to a fresh start).
  let sid = readAmbientSid(repoRoot);
  if (sid) {
    try {
      const session = await api.managerStatus(sid);
      if (!session.projects.some((p) => sameRoot(p.root, repoRoot))) sid = null;
    } catch {
      sid = null; // session gone (restart pruned it) — start fresh
    }
  }
  if (!sid) {
    // Seeds the session with the prompt as its objective; the dispatch below
    // delivers it as the first user turn (same two-step the rail uses).
    sid = await api.managerChatStart(repoRoot, trimmed);
  }
  focusAmbientManager(repoRoot, sid);

  // 2) Slash sweep — identical interpreter to the in-app composer. A handled
  //    command runs client-side and never reaches the brain; persist it so it
  //    shows in the app timeline + the HUD glance. Interactive results (e.g.
  //    `/resume`'s live picker) can't render in the HUD — record a pointer.
  let outbound = trimmed;
  if (trimmed.startsWith("/")) {
    try {
      const result = await handleChatSlash(trimmed, { repoRoot, sessionId: sid });
      if (result?.handled) {
        const output = result.output?.trim() ? result.output : null;
        const body = output ?? (result.interactive ? "Open Aura to use this command." : "Done.");
        try {
          await api.managerAppendChat(sid, "user", trimmed);
          await api.managerAppendChat(sid, "system", body);
        } catch (e) {
          console.warn("[hud] slash persist failed", e);
        }
        return sid;
      }
      if (result?.forwardText) outbound = result.forwardText;
    } catch (e) {
      console.warn("[hud] slash handler failed; sending raw", e);
    }
  }

  // 3) Mode steering prefix (once per session / on mode change).
  const mode: SteeringMode = opts.mode ?? "build";
  const established = steeringSent.get(sid) === mode;
  steeringSent.set(sid, mode);
  const finalText = (established ? "" : buildSteeringText(mode)) + outbound;

  // 4) Choose the dispatch path the same way ManagerChatView does: a native
  //    brain (or a native override) takes the brain-trait `brain_chat_turn`
  //    path that carries the per-turn knobs; a CLI-wrapper brain drives a
  //    terminal, so it falls back to legacy `manager_chat`.
  let useBrainTrait = true;
  try {
    if (opts.brainId) {
      const brains = await api.managerListBrains();
      const b = brains.find((x) => x.id === opts.brainId);
      useBrainTrait = b ? b.kind !== "cli_wrapper" : true;
    } else {
      const info = await api.brainActiveInfo();
      useBrainTrait = !info.is_cli_wrapper;
    }
  } catch {
    useBrainTrait = !opts.brainId; // unknown → prefer native unless a CLI override was named
  }

  if (useBrainTrait) {
    markManagerTurnInFlight(sid);
    // Stamp the durable start now (not when a mounted view first paints) so the
    // "Working… 12s" elapsed timer reflects the real send time even for a turn
    // injected from the HUD/sidebar into a chat that isn't open yet. Idempotent
    // — a later observer reuses this stamp rather than restarting at 0.
    setManagerTurnStartedAt(sid, Date.now());
    // Flatten the persisted chat into the brain's message array (the new user
    // turn is appended server-side from `userMessage`, so we don't add it here).
    let priorMessages: { role: "user" | "assistant"; content: string }[] = [];
    try {
      const session = await api.managerStatus(sid);
      priorMessages = (session.chat ?? []).map((t) => ({
        role: t.role === "user" ? ("user" as const) : ("assistant" as const),
        content: t.text,
      }));
    } catch {
      priorMessages = [];
    }
    try {
      await api.brainChatTurn(
        sid,
        finalText,
        {
          messages: priorMessages,
          effort: opts.effort ?? null,
          fast: opts.fast ?? false,
          model: opts.model ?? null,
          long_context: opts.longContext ?? false,
          approval: opts.approval ?? null,
        },
        opts.brainId ?? null,
      );
    } catch (e) {
      clearManagerTurnInFlight(sid);
      console.warn("[hud] brain_chat_turn failed", e);
      throw e;
    }
  } else {
    await api.managerChat(sid, finalText);
  }

  return sid;
}
