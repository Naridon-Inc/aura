// The one Aura conversation — the command centre behind the sidebar's Aura
// row, distinct from any project's ambient chat.
//
// Every other chat in the app is keyed by repo: `aura.ambient.<root>` is "the
// chat about THIS project", which is a real and useful thing (it's what the
// HUD composer and the project agent surface talk to). The Aura row is not
// that. Aura spans everything — projects, worktrees, running agents, PRs — so
// binding its door to whichever workspace happened to be open meant clicking
// Aura reopened an unrelated conversation: open the bundled sample and you got
// the sample's old thread back, with no way to tell why.
//
// So the orchestrator gets its own pointer, unqualified by project. One id,
// one conversation, the same one every time you click Aura.
//
// It still has to be *created* against some repo — a manager session carries a
// `ProjectRef` that anchors the brain's cwd for `bash` and the board tools.
// That anchor is a starting point, not a boundary: the control-plane tools
// (`aura_projects_list`, `aura_agents_live`, `aura_prs_list`, …) sweep the
// whole registry regardless of which project the session was minted against.

import { api } from "./api";
import { knownProjectRoots } from "./projectRoots";

const ORCHESTRATOR_KEY = "aura.orchestrator.session";

/**
 * Every project Aura should be born knowing about.
 *
 * The anchor leads — it is the cwd the brain's `bash` and board tools run in —
 * and the rest ride behind it. A session used to carry exactly one project,
 * which for the ordinary chat is right and for THIS one never was: the control
 * plane is about your projects, plural, and a conversation that lists one of
 * them is a conversation that has to be told about the others every time.
 *
 * Never throws and never blocks the door: a registry that won't read gives the
 * anchor alone, which is exactly what this used to send.
 */
async function projectsForAura(anchor: string): Promise<string[]> {
  try {
    const known = await knownProjectRoots(anchor);
    return [anchor, ...known.map((k) => k.root)];
  } catch {
    return [anchor];
  }
}

/**
 * Where Aura's hands are: here, deliberately, and it is the one door in the app
 * that says so rather than asking where the window is standing.
 *
 * Every other entry point runs its work in the place you are looking at, because
 * what it acts on is the code in front of you. Aura acts on the *registry* — the
 * projects this laptop has open, the agents it is running, the pull requests it
 * is tracking — and every one of those tools reads state that lives on this
 * disk. Pointing its hands at a box would not move the control plane there; it
 * would break it.
 */
const AURA_RUNS_HERE = null;

/** The stored orchestrator session id, or null. Unvalidated — callers that
 *  are about to open it should go through `resolveOrchestratorSession`. */
export function readOrchestratorSid(): string | null {
  try {
    return localStorage.getItem(ORCHESTRATOR_KEY);
  } catch {
    return null;
  }
}

/** Remember `sid` as THE Aura conversation. Called on create, and when the
 *  user deliberately starts a new one from the Aura surface. */
export function setOrchestratorSid(sid: string): void {
  try {
    localStorage.setItem(ORCHESTRATOR_KEY, sid);
  } catch {
    /* localStorage quota — non-fatal, we just re-create next time */
  }
}

/**
 * Resolve the Aura session, creating one when there isn't a usable one.
 * Returns a session id that is guaranteed to load.
 *
 * The validation matters for the same reason it does for ambient chats: the
 * pointer is a string in localStorage and nothing prunes it when the session
 * behind it goes away (a restart that cleared `~/.aura/manager-sessions/`).
 * Handing a stale id to `openManager` mounts a tab the backend can't load,
 * which reads as the door doing nothing.
 *
 * Unlike the ambient resolver, there is deliberately NO project check here. A
 * session that belongs to a different repo than the one currently open is the
 * normal case, not a stale pointer — that is the whole point of the thing.
 *
 * `anchor` is only consulted when minting a fresh session, which is why it is
 * allowed to be null: an Aura conversation that already exists opens with no
 * project loaded at all, because it never belonged to one. Returns null in the
 * one case that genuinely cannot proceed — no conversation yet AND no repo to
 * start one against, since a manager session has to have a cwd to run in. The
 * caller's job there is to get a folder open and ask again.
 */
export async function resolveOrchestratorSession(
  anchor: string | null,
): Promise<string | null> {
  const existing = readOrchestratorSid();
  if (existing) {
    try {
      await api.managerStatus(existing);
      return existing;
    } catch {
      /* session gone — fall through and start a fresh one */
    }
  }
  if (!anchor) return null;
  const sid = await api.managerChatStart(
    anchor,
    "",
    AURA_RUNS_HERE,
    await projectsForAura(anchor),
  );
  setOrchestratorSid(sid);
  return sid;
}

/**
 * Start a fresh Aura conversation and make it the one the Aura row opens.
 * The previous session isn't deleted — it stays in the session list — it just
 * stops being the one behind the door.
 */
export async function startNewOrchestratorSession(anchor: string): Promise<string> {
  const sid = await api.managerChatStart(
    anchor,
    "",
    AURA_RUNS_HERE,
    await projectsForAura(anchor),
  );
  setOrchestratorSid(sid);
  return sid;
}
