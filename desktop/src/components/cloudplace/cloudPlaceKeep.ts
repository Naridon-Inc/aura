// What the cloud place shows after a refresh, decided without the app.
//
// The place reads the organization every twenty seconds. A read that fails
// once — a dropped connection, a slow server, a sign-in being renewed — used
// to replace what was on screen with nothing: no members meant no "you",
// which meant no workspaces of yours, so the sidebar fell back to "Create
// your first workspace", lost the team and the organization's name, and the
// open workspace closed, all until the next read twenty seconds later. These
// rules keep the last answer instead, and say it is not current.

import type { CloudProblem } from "../../lib/cloudWorkspacesApi";

/** One read: still out, answered, or refused for a reason the screen can say.
 *  An answer kept through a later refusal carries that refusal as `stale`. */
export type Read<T> =
  | { state: "loading" }
  | { state: "ready"; value: T; stale?: CloudProblem }
  | { state: "failed"; problem: CloudProblem };

/** The read to show after a refresh: a refusal never replaces an answer. */
export function keptRead<T>(prev: Read<T>, next: Read<T>): Read<T> {
  if (next.state !== "failed" || prev.state !== "ready") return next;
  return { state: "ready", value: prev.value, stale: next.problem };
}

/** Who the place says you are, and in which organization. */
export type Identity = { userId: string | null; login: string | null; orgName: string };

/** What the sign-in said, or null when it couldn't be asked. */
export type AuthSaid = {
  user?: string | null;
  org_name?: string | null;
  org_slug?: string | null;
} | null;

/** Who you are after a refresh. A read that couldn't be made keeps what the
 *  last one said; a read that answered is taken as said, empty or not.
 *  `userId` is undefined when the account read failed. */
export function keptIdentity(prev: Identity, auth: AuthSaid, userId: string | null | undefined): Identity {
  return {
    userId: userId === undefined ? prev.userId : userId?.trim() || null,
    login: auth === null ? prev.login : auth.user?.trim() || null,
    orgName: auth === null ? prev.orgName : auth.org_name?.trim() || auth.org_slug?.trim() || "",
  };
}

/** The key an open workspace's answers are kept under for this window's
 *  life. `cloud:` keys follow the account: an organization switch or a new
 *  sign-in forgets them all (lib/resourceCache). */
/** Who you are after a read of `/me` threw: a cloud that answers 404 has no
 *  such read (an older cloud), and says there is no id — `null`; anything else
 *  is a read that didn't get through and says nothing new — `undefined`. */
export function meAfterFailure(e: unknown): null | undefined {
  const text = e instanceof Error ? e.message : String(e);
  return text.toLowerCase().includes("http 404") ? null : undefined;
}

export function viewKey(part: string, ...ids: (string | null | undefined)[]): string {
  return `cloud:view:${part}:${ids.map((id) => id ?? "").join(":")}`;
}
