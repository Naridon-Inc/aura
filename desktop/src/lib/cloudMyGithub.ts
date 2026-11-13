// Your own GitHub, connected from Settings → Git → Your GitHub. Each call is
// one Tauri command (cmd_cloud_me_github.rs); a refusal is the server's
// sentence.
//
// Pushes, commits and pull requests made in a cloud workspace go out as the
// member who made them, with the GitHub account connected here. A member only
// starts cloud workspaces on repositories their own GitHub can open, inside
// the GitHub accounts the organization connected. The token stays on the
// server; nothing here sees it.

import { invoke } from "@tauri-apps/api/core";

/** Who `GET /me/github` says is connected. */
export type MyGithub = { connected: boolean; login: string | null; linked_at: string | null };

export type MyGithubStart = {
  ticket: string;
  /** The GitHub sign-in that answers the ticket. */
  authorize_url: string;
  expires_in_minutes?: number | null;
};

export type MyGithubTicketStatus = "waiting" | "connected" | "refused" | "expired";

export type MyGithubTicket = { status: MyGithubTicketStatus; problem?: string | null; login?: string | null };

/** A repository the member's own GitHub can open, and whether it may push. */
export type MyGithubRepo = { full_name: string; push: boolean };

/** `repos` null: connected, but GitHub hasn't been asked (an older server). */
export type MyGithubRepos = { connected: boolean; login: string | null; repos: MyGithubRepo[] | null };

export const readMyGithub = () => invoke<MyGithub>("cloud_my_github");

export const startMyGithubConnect = () => invoke<MyGithubStart>("cloud_my_github_connect_start");

export const readMyGithubTicket = (ticket: string) => invoke<MyGithubTicket>("cloud_my_github_connect_ticket", { ticket });

export const disconnectMyGithub = () =>
  invoke<{ connected: boolean; revoked_on_github: boolean }>("cloud_my_github_disconnect");

export const readMyGithubRepos = () => invoke<MyGithubRepos>("cloud_my_github_repos");

/** Open Settings on the page with Your GitHub on it. */
export function openYourGithub(): void {
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "git" } }));
}

/** The row's one line: who is connected, or what connecting is for. */
export function myGithubLine(me: MyGithub | null): string {
  if (me?.connected && me.login) return `Connected as @${me.login}`;
  if (me?.connected) return "Connected";
  return "Not connected. Pushes and pull requests from cloud workspaces need it.";
}

/** A ticket is settled once GitHub has answered it one way or another. */
export function myTicketSettled(status: MyGithubTicketStatus): boolean {
  return status !== "waiting";
}

/** What a settled ticket that didn't connect says. */
export function myTicketProblem(ticket: MyGithubTicket): string | null {
  if (ticket.status === "expired") return "This took too long. Press Connect again.";
  if (ticket.status === "refused") return ticket.problem?.trim() || "GitHub didn’t connect your account. Press Connect again.";
  return null;
}

/** A name the server treats as a GitHub repository (`owner/name`), not one
 *  that lives only in Aura (`local/…`). */
export function isGithubName(name: string): boolean {
  const parts = name.trim().split("/");
  if (parts.length !== 2 || parts[0].toLowerCase() === "local") return false;
  return parts.every((p) => p.length > 0 && p !== "." && p !== "..");
}

/**
 * The organization's repositories this member can start a cloud workspace on.
 * `mine` null (not read yet, or an older server) keeps every name: the server
 * still decides. Not connected keeps only names that aren't on GitHub.
 */
export function reachableRepos(names: string[], mine: MyGithubRepos | null): { names: string[]; hidden: number } {
  if (!mine || (mine.connected && !mine.repos)) return { names, hidden: 0 };
  const open = new Set((mine.repos ?? []).map((r) => r.full_name.toLowerCase()));
  const kept = names.filter((n) => !isGithubName(n) || (mine.connected && open.has(n.toLowerCase())));
  return { names: kept, hidden: names.length - kept.length };
}

/**
 * The repositories a new workspace can start on. The org's Aura computer has
 * no copy of anything: it clones from GitHub, so a repository that isn't on
 * GitHub would give it a workspace it can never open. A computer that already
 * holds the project, such as a member's own, still takes one.
 */
export function startableRepos(names: string[], clonesFromGithub: boolean): { names: string[]; offGithub: number } {
  if (!clonesFromGithub) return { names, offGithub: 0 };
  const kept = names.filter(isGithubName);
  return { names: kept, offGithub: names.length - kept.length };
}

/**
 * Why the create dialog can't start a workspace, when the member's GitHub is
 * the reason: nothing connected, or nothing it can open. Null otherwise.
 */
export function githubBlock(mine: MyGithubRepos | null, reach: { names: string[]; hidden: number }): string | null {
  if (!mine || reach.names.length || !reach.hidden) return null;
  if (!mine.connected)
    return "Cloud workspaces push and open pull requests as you, with your own GitHub. Connect it to start one.";
  const who = mine.login ? `Your GitHub account @${mine.login}` : "Your GitHub account";
  return `${who} can’t open any of this organization’s repositories. Ask whoever manages them on GitHub to add you.`;
}

/** The refusals the member fixes on GitHub or in Your GitHub, by reason. */
export const MY_GITHUB_REASONS = ["github_not_connected", "github_cannot_open", "no_github_push_access"] as const;
export type MyGithubReason = (typeof MY_GITHUB_REASONS)[number];

const PLAIN: Record<MyGithubReason, string> = {
  github_not_connected:
    "Cloud workspaces push and open pull requests as you, and your GitHub isn’t connected to Aura. Connect it in Settings → Git → Your GitHub, then try again.",
  github_cannot_open:
    "Your GitHub account can’t open this repository. Ask whoever manages it on GitHub to add you, then try again.",
  no_github_push_access:
    "Your GitHub account can read this repository but not push to it. Ask whoever manages it on GitHub for write access.",
};

export function isMyGithubReason(reason: string | null | undefined): reason is MyGithubReason {
  return !!reason && (MY_GITHUB_REASONS as readonly string[]).includes(reason);
}

/** The sentence for one of those refusals: the server's own, else ours. */
export function myGithubRefusal(reason: MyGithubReason, said?: string | null): string {
  return said?.trim() || PLAIN[reason];
}

/**
 * One of those refusals out of a failed call's text (`HTTP 409 …: {"error":
 * "…","reason":"github_not_connected"}`), or null when it's something else.
 */
export function myGithubProblem(raw: string): { reason: MyGithubReason; message: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { reason, error } = body as { reason?: unknown; error?: unknown };
  if (typeof reason !== "string" || !isMyGithubReason(reason)) return null;
  return { reason, message: myGithubRefusal(reason, typeof error === "string" ? error : null) };
}
