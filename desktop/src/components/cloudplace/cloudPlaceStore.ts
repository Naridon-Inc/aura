// What the cloud place reads from the server, held once for the sidebar and
// the page together — both draw the same members and the same workspaces, and
// asking twice would let them disagree for a tick.
//
// Every read keeps its own failure. The org's members can come back while the
// workspace list is refused (an app built before these commands, a plan that
// doesn't include them), and the screen says which part it couldn't read
// rather than drawing an empty organization.
//
// A refresh that fails keeps what the last one read (cloudPlaceKeep): the
// place is read every twenty seconds, and one dropped read used to empty the
// sidebar and close the open workspace until the next. What it holds lives
// for the window's life, so leaving the cloud and coming back paints at once;
// a different account or organization starts again from nothing.

import { useEffect, useSyncExternalStore } from "react";

import { api, type CloudOrgMember, type CloudRepo } from "../../lib/api";
import { boxChatSessions, withoutMirrors } from "../../lib/cloudBoxChat";
import { onAccountScopeChanged } from "../../lib/resourceCache";
import {
  cloudApi,
  cloudProblem,
  type CloudRoutineRow,
  type CloudWorkspaceRow,
} from "../../lib/cloudWorkspacesApi";
import { keptIdentity, keptRead, meAfterFailure, type Read } from "./cloudPlaceKeep";
import { cloudWorkOnly } from "./cloudRows";

export type { Read } from "./cloudPlaceKeep";

export type CloudPlaceData = {
  /** The signed-in account's cloud user id: who "you" are among the members,
   *  the owners and the authors. Null until the cloud has said. */
  userId: string | null;
  /** The sign-in's saved name, matched against members only when the id
   *  couldn't be read. It is a login or an email, depending on the sign-in. */
  login: string | null;
  orgName: string;
  members: Read<CloudOrgMember[]>;
  repos: Read<CloudRepo[]>;
  workspaces: Read<CloudWorkspaceRow[]>;
  routines: Read<CloudRoutineRow[]>;
};

const POLL_MS = 20_000;

const NOTHING_READ: CloudPlaceData = {
  userId: null,
  login: null,
  orgName: "",
  members: { state: "loading" },
  repos: { state: "loading" },
  workspaces: { state: "loading" },
  routines: { state: "loading" },
};

let data: CloudPlaceData = NOTHING_READ;
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function publish(next: Partial<CloudPlaceData>) {
  data = { ...data, ...next };
  for (const l of listeners) l();
}

async function settle<T>(p: Promise<T>): Promise<Read<T>> {
  try {
    return { state: "ready", value: await p };
  } catch (e) {
    return { state: "failed", problem: cloudProblem(e) };
  }
}

/** Read everything again. A slower earlier read never overwrites a newer one. */
export async function reloadCloudPlace(): Promise<void> {
  const mine = ++generation;
  const auth = await api.cloudAuthStatus().catch(() => null);
  if (mine !== generation) return;
  const { login, orgName } = keptIdentity(data, auth, data.userId);
  publish({ login, orgName });
  const [me, members, repos, workspaces, routines] = await Promise.all([
    api.cloudMe().then((m) => m?.user_id ?? null, meAfterFailure),
    settle(api.cloudOrgMembers()),
    settle(api.cloudRepos()),
    settle(cloudApi.workspaces()),
    settle(cloudApi.routines()),
  ]);
  if (mine !== generation) return;
  publish({
    userId: keptIdentity(data, null, me).userId,
    members: keptRead(data.members, members),
    repos: keptRead(data.repos, repos),
    workspaces: keptRead(data.workspaces, mirrorsDropped(workspaces)),
    routines: keptRead(data.routines, routines),
  });
}

// Another account or organization: nothing read as the last one is shown for
// this one, and a read still out for it is dropped. Heard after every `cloud:`
// answer in the shared cache has been forgotten.
onAccountScopeChanged(() => {
  generation += 1;
  publish(NOTHING_READ);
  if (users > 0) void reloadCloudPlace();
});

/** Home lists the cloud's own work — never a laptop's reported session —
 *  and each machine chat once, as its workspace. */
function mirrorsDropped(read: Read<CloudWorkspaceRow[]>): Read<CloudWorkspaceRow[]> {
  if (read.state !== "ready") return read;
  const cloud = cloudWorkOnly(read.value);
  let sessions: Set<string>;
  try {
    sessions = boxChatSessions(localStorage);
  } catch {
    return { state: "ready", value: cloud };
  }
  return { state: "ready", value: withoutMirrors(cloud, sessions) };
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (users === 0) return;
    void reloadCloudPlace().finally(() => {
      if (users > 0) schedule();
    });
  }, POLL_MS);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** What the place holds right now. */
export const cloudPlaceDataNow = (): CloudPlaceData => data;

/** The cloud place's server state, read while anything is showing it. */
export function useCloudPlaceData(): CloudPlaceData {
  useEffect(() => {
    users += 1;
    if (users === 1) {
      void reloadCloudPlace();
      schedule();
    }
    return () => {
      users -= 1;
      if (users === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, cloudPlaceDataNow, cloudPlaceDataNow);
}

/** What the place holds, followed as it changes, without asking the server
 *  for anything: a reader that only matters while the place is showing (the
 *  page already keeps the reads coming) and must not start them on a laptop. */
export function useCloudPlaceSnapshot(): CloudPlaceData {
  return useSyncExternalStore(subscribe, cloudPlaceDataNow, cloudPlaceDataNow);
}

/** The value of a read, or what to draw while there isn't one. */
export function valueOf<T>(read: Read<T>, fallback: T): T {
  return read.state === "ready" ? read.value : fallback;
}
