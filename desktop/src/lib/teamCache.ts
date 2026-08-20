// teamCache — the team manifest, read once for everyone who wants it.
//
// `team_load` is not a file read. It walks git history for the roster, then
// announces your presence to the cloud and fetches everyone else's, then writes
// the merged manifest back to disk. Two network round-trips and a disk write,
// per call.
//
// Fifteen surfaces call it: the tasks board (once per project root, so a
// fan-out), the activity feed, chat, standup, the task detail pane, the share
// dialog, the relay menu, Overview and Cost & usage — several of them on a
// timer, most of them on every mount. Opening two tabs that both show who is on
// the team paid for the whole thing twice.
//
// The window is 10 seconds, matching `AUTHOR_WALK_TTL_SECS` in cmd_team.rs,
// which caches the history walk underneath for exactly the same reason: "the
// roster moves about as often as somebody commits — a handful of seconds of
// staleness is invisible".
//
// PRESENCE IS SAFE. `team_load` doubles as this app's presence heartbeat, so
// caching it looks like it might make you appear offline to teammates. It
// cannot: a caller that would have fired at time T still fires at T unless
// another caller already fired within the last 10 seconds — in which case a
// heartbeat went out then instead. The longest gap between heartbeats is set by
// the slowest polling surface, and that is unchanged. All this removes is the
// duplicate beats several surfaces were sending within the same second.

import { api, type TeamIdentity, type TeamManifest } from "./api";
import { dropShared, peekShared, readShared, sharedReader } from "./sharedRead";

/** Matches `AUTHOR_WALK_TTL_SECS` in cmd_team.rs — the same staleness the
 *  backend already considers invisible for the same data. */
const FRESH_MS = 10_000;

const team = sharedReader(
  (repoRoot: string) => api.teamLoad(repoRoot),
  FRESH_MS,
);

/** The team manifest for a repo, shared with every other surface that wants
 *  it. Rejects if it could not be read — an empty roster is not a truthful
 *  stand-in for "we couldn't ask", and every caller already decides for
 *  itself what a failure means. */
export function fetchTeam(repoRoot: string): Promise<TeamManifest> {
  return readShared(team, repoRoot);
}

/** Read past the window, and publish what comes back to everyone else.
 *
 *  This is what a surface that just changed the team uses — added a member,
 *  set an admin, created a channel. Its own re-read has to see the change (a
 *  button that worked is otherwise indistinguishable from one that didn't),
 *  and because the forced read lands in the shared cache, every other surface
 *  converges on the new manifest instead of holding the old one. */
export function refreshTeam(repoRoot: string): Promise<TeamManifest> {
  return readShared(team, repoRoot, true);
}

/** What was last read, however old — for a surface that would otherwise paint
 *  a spinner over a roster it already has. */
export function peekTeam(repoRoot: string): TeamManifest | undefined {
  return peekShared(team, repoRoot);
}

/** Forget a repo's manifest (or every repo's), so the next read is real. */
export function invalidateTeam(repoRoot?: string): void {
  dropShared(team, repoRoot);
}

// ── who you are, in this repo ────────────────────────────────────────────────
//
// `team_identity` runs the same `sync_with_git` the manifest does, and then
// spawns git for your local user, resolves your account login and matches you
// against the roster. Eleven surfaces asked for it — and six of them asked in
// the same `Promise.all` as the manifest, so one load of the team tab ran that
// sync twice, concurrently. The backend's own 10s walk cache does not help
// there: neither call has landed yet, so both miss it. That is the thundering
// herd `inflight` exists to collapse, which is why this belongs here and not
// only in Rust.
//
// It shares the manifest's window because it is telling you about the same
// roster at the same instant; two different windows would let one surface show
// you as an admin while the next says you are not.

const identity = sharedReader(
  (repoRoot: string) => api.teamIdentity(repoRoot),
  FRESH_MS,
);

/** Who you are in this repo, shared with every other surface asking.
 *
 *  Rejects if it could not be resolved. A null identity is what the callers
 *  render as "not in this team", and that is a different statement from "we
 *  could not tell" — one of them hides controls you are entitled to. */
export function fetchIdentity(repoRoot: string): Promise<TeamIdentity> {
  return readShared(identity, repoRoot);
}

/** Read past the window and publish, for a caller that has just changed who
 *  you are: claiming your seat, an admin transfer, a linked account. The
 *  controls regate off this, so it has to see the new answer — and because the
 *  forced read is published, the other surfaces regate too instead of holding
 *  the permissions you had a moment ago. */
export function refreshIdentity(repoRoot: string): Promise<TeamIdentity> {
  return readShared(identity, repoRoot, true);
}

/** What was last read, however old. */
export function peekIdentity(repoRoot: string): TeamIdentity | undefined {
  return peekShared(identity, repoRoot);
}

/** Forget a repo's identity (or every repo's), so the next read is real. */
export function invalidateIdentity(repoRoot?: string): void {
  dropShared(identity, repoRoot);
}
