// One shared team-roster poll per repo — the Lounge's presence rows.
//
// Commons exists twice: as a rail panel and as a full-width centre tab, and
// the rail one has an "expand" button that opens the other, so both are
// routinely mounted at once. Each used to run its own 15s `team_load`, which
// meant two reads of the same manifest for one identical roster.
//
// This owns a single timer + cached roster per repo root, pauses while the
// window is hidden, and only wakes subscribers when the roster actually
// changed — a steady team answers identically four times a minute, and
// republishing that re-rendered every presence row for nothing.

import { useEffect, useState } from "react";
import { type TeamMember } from "./api";
import { fetchTeam, peekTeam } from "./teamCache";

const POLL_MS = 15_000;

const NO_MEMBERS: TeamMember[] = [];

type Store = {
  members: TeamMember[];
  subs: Set<(m: TeamMember[]) => void>;
  timer: number | null;
  inFlight: boolean;
};

const stores = new Map<string, Store>();

function storeFor(repoRoot: string): Store {
  let s = stores.get(repoRoot);
  if (!s) {
    s = { members: NO_MEMBERS, subs: new Set(), timer: null, inFlight: false };
    stores.set(repoRoot, s);
  }
  return s;
}

// Identity = what a presence row draws. `last_seen` ticks on every read by
// design, so it is deliberately not part of it.
function sameRoster(a: TeamMember[], b: TeamMember[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].email !== b[i].email ||
      a[i].name !== b[i].name ||
      a[i].handle !== b[i].handle ||
      a[i].claimed !== b[i].claimed ||
      a[i].admin !== b[i].admin ||
      a[i].activity_text !== b[i].activity_text ||
      a[i].status_emoji !== b[i].status_emoji ||
      a[i].voice_channel !== b[i].voice_channel
    ) {
      return false;
    }
  }
  return true;
}

async function read(repoRoot: string): Promise<void> {
  const s = stores.get(repoRoot);
  if (!s || s.inFlight) return;
  s.inFlight = true;
  try {
    // Through `teamCache`, not `api.teamLoad`: a dozen other surfaces read the
    // manifest from there, and the poll below is slower than that cache's
    // freshness window, so this still does a real read while everyone shares
    // one answer between ticks.
    const manifest = await fetchTeam(repoRoot);
    const next = manifest.members ?? NO_MEMBERS;
    if (sameRoster(s.members, next)) return;
    s.members = next;
    for (const fn of s.subs) fn(next);
  } catch {
    // Room-less repo, or a manifest read that blipped — keep the last good
    // roster. An empty lounge is a real state; it is not an error state.
  } finally {
    s.inFlight = false;
  }
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function retime(repoRoot: string): void {
  const s = stores.get(repoRoot);
  if (!s) return;
  const wanted = s.subs.size > 0 && documentVisible();
  if (wanted && s.timer === null) {
    s.timer = window.setInterval(() => void read(repoRoot), POLL_MS);
  } else if (!wanted && s.timer !== null) {
    window.clearInterval(s.timer);
    s.timer = null;
  }
}

let wired = false;

function wireGlobals(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  document.addEventListener("visibilitychange", () => {
    for (const [root, s] of stores) {
      retime(root);
      if (documentVisible() && s.subs.size > 0) void read(root);
    }
  });
}

/** The team roster for this repo, on one shared 15s poll. */
export function useTeamRoster(repoRoot: string): TeamMember[] {
  const [members, setMembers] = useState<TeamMember[]>(
    () =>
      stores.get(repoRoot)?.members ??
      peekTeam(repoRoot)?.members ??
      NO_MEMBERS,
  );

  useEffect(() => {
    if (!repoRoot) {
      setMembers(NO_MEMBERS);
      return;
    }
    wireGlobals();
    const s = storeFor(repoRoot);
    // Paint the cached roster first so a second Commons surface never opens
    // to an empty lounge while it waits out the shared timer.
    // Cached roster first — from this store, or from the shared manifest
    // cache when another surface read it before we mounted — so a second
    // Commons surface never opens to an empty lounge waiting out the timer.
    if (s.members === NO_MEMBERS) {
      const cached = peekTeam(repoRoot)?.members;
      if (cached) s.members = cached;
    }
    setMembers(s.members);
    s.subs.add(setMembers);
    retime(repoRoot);
    void read(repoRoot);
    return () => {
      s.subs.delete(setMembers);
      retime(repoRoot);
    };
  }, [repoRoot]);

  return members;
}
