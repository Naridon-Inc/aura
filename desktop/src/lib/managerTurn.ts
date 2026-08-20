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

import { placeForNewWork, readAmbientSid, samePlace } from "./ambientSession";
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
  /** Dispatch into THIS session instead of resolving the project's ambient
   *  one. For callers that just created the session and need the turn to land
   *  in that exact one — a freshly launched workspace starts its chat first so
   *  the model chip is set before the view mounts, then sends the objective.
   *  Resolving by ambient id there would risk starting a second, empty chat if
   *  the round-trip validation hiccuped. */
  sessionId?: string;
  /** The place this turn's tools run in — a connected machine's id, or null for
   *  this laptop. Omitted, it is wherever the window is standing when the turn
   *  is sent, which is what a message typed in the HUD or fired from a rail
   *  means. Callers that made the session themselves pass what they made it
   *  with, so the pointer they write names the same place the session has. */
  machineId?: string | null;
  /** Run the turn WITHOUT bringing it to the user's attention: don't repoint
   *  the project's ambient pointer at this session and don't fire the focus
   *  event. For background jobs (see lib/auraJob) whose whole point is that
   *  they don't interrupt the conversation the user is already in. Only
   *  meaningful alongside `sessionId` — a background turn runs in its own lane,
   *  never the ambient one. */
  background?: boolean;
};

/** Trailing-slash-tolerant root compare — same rule the ambient bookkeeping
 *  uses elsewhere. */
function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

/**
 * Resolve the project's ambient Aura session, creating one when there isn't a
 * usable one. Returns a session id that is guaranteed to load.
 *
 * The validation is the point. A persisted `aura.ambient.<root>` pointer is
 * just a string in localStorage — nothing prunes it when the session behind it
 * goes away (a restart that cleared `~/.aura/manager-sessions/`, a workspace
 * opened at a different path). Handing that stale id straight to
 * `openManager` mounts a chat tab for a session the backend can't load, which
 * reads to the user as the Aura door doing nothing at all. So we ask the
 * backend whether the session still exists AND still belongs to this project,
 * and fall through to a fresh one when either answer is no.
 *
 * `seed` becomes the new session's objective when we do start fresh; pass the
 * user's first message if there is one, or "" to open an empty chat.
 *
 * `machineId` is the place the chat's hands are in — omit it and the answer is
 * wherever the window is standing right now, which is what a turn typed into
 * the HUD or fired from a rail means. It is part of the identity of the chat,
 * not a setting on it: a conversation about the copy of this project on a box
 * is a different conversation from one about the copy on this disk, so the two
 * have their own pointers and a session found under one is rejected if it turns
 * out to be running in the other.
 */
export async function resolveAmbientSession(
  repoRoot: string,
  seed = "",
  machineId: string | null = placeForNewWork(repoRoot),
): Promise<string> {
  let sid = readAmbientSid(repoRoot, machineId);
  if (sid) {
    try {
      const session = await api.managerStatus(sid);
      if (!session.projects.some((p) => sameRoot(p.root, repoRoot))) sid = null;
      // A pointer that outlived a change of place: same project, different
      // machine. Starting fresh is the only honest answer — the alternative is
      // a chat whose tools quietly edit a different copy of the code than the
      // one you are looking at.
      else if (!samePlace(session.machine_id, machineId)) sid = null;
    } catch {
      sid = null; // session gone (restart pruned it) — start fresh
    }
  }
  if (!sid) sid = await api.managerChatStart(repoRoot, seed, machineId);
  return sid;
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

  // 1) Resolve the session. An explicit `sessionId` is taken as given — the
  //    caller made it and is telling us where the turn goes. Otherwise fall
  //    back to the project's ambient session (validated; a stale or
  //    cross-workspace sid falls through to a fresh start). Seeding the fresh
  //    session with the prompt makes it the objective; the dispatch below
  //    delivers it as the first user turn (same two-step the rail uses).
  //    A background turn skips the focus entirely: repointing the ambient
  //    pointer at a job session would hand the user's next "open Aura here" to
  //    a PR-drafting job, and firing the focus event would yank the rail off
  //    whatever they were reading.
  //    The place is read once, here, and used for both the resolution and the
  //    pointer — reading it twice could straddle a change of focus and file the
  //    chat under a place it isn't running in.
  const place = opts.machineId ?? placeForNewWork(repoRoot);
  const sid =
    opts.sessionId ?? (await resolveAmbientSession(repoRoot, trimmed, place));
  if (!opts.background) focusAmbientManager(repoRoot, sid, place);

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
