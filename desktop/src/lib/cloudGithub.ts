// The GitHub accounts and organizations connected to the signed-in org. Each
// call is one Tauri command (cmd_cloud_github.rs); a refusal is the server's
// sentence. Repositories inside a connected account can run on the org's
// cloud; every member reads the list, an owner or admin changes it.

import { invoke } from "@tauri-apps/api/core";

/** One connected account as `GET /orgs/{slug}/github/installations` lists it. */
export type ConnectedGithub = {
  installation_id: number;
  account_login: string;
  /** `User` or `Organization`; null until GitHub has been asked. */
  account_type?: string | null;
  /** `all` or `selected`; null when GitHub couldn't be asked just now. */
  repository_selection?: string | null;
  /** `connected`, `uninstalled` (the app was removed on GitHub) or `unknown`. */
  status: string;
  repo_count: number;
  added_by?: string | null;
  created_at?: string | null;
};

export type ConnectedGithubList = { installations: ConnectedGithub[]; can_manage: boolean };

export type ConnectStart = {
  ticket: string;
  /** The app's install page on github.com; null when the server couldn't name the app. */
  install_url: string | null;
  /** The GitHub sign-in that tells the server which accounts you may connect. */
  authorize_url: string;
  expires_in_minutes?: number | null;
};

/** An account GitHub listed for the admin who signed in. */
export type ConnectCandidate = {
  id: number;
  account_login: string;
  account_type?: string | null;
  repository_selection?: string | null;
  can_connect: boolean;
  why_not?: string | null;
  connected_here: boolean;
  connected_elsewhere: boolean;
};

export type TicketStatus = "waiting" | "answered" | "refused" | "expired";

export type ConnectTicket = {
  status: TicketStatus;
  problem?: string | null;
  candidates: ConnectCandidate[];
};

export type Connected = {
  connected: boolean;
  already_connected: boolean;
  installation_id: number;
  account_login: string;
  repos_imported: number;
  import_error?: string | null;
};

export const listConnectedGithub = () => invoke<ConnectedGithubList>("cloud_github_installations");

export const startConnectGithub = () => invoke<ConnectStart>("cloud_github_connect_start");

export const readConnectTicket = (ticket: string) => invoke<ConnectTicket>("cloud_github_connect_ticket", { ticket });

export const connectGithub = (ticket: string, installationId: number) =>
  invoke<Connected>("cloud_github_connect", { ticket, installationId });

export const removeConnectedGithub = (installationId: number) =>
  invoke<void>("cloud_github_remove", { installationId });

/** "Personal account" or "Organization", when GitHub has said which. */
export function kindOf(accountType?: string | null): string | null {
  if (accountType === "User") return "Personal account";
  if (accountType === "Organization") return "Organization";
  if (accountType === "Enterprise") return "Enterprise";
  return null;
}

/** "All repositories" or "Selected repositories". */
export function accessOf(selection?: string | null): string | null {
  if (selection === "all") return "All repositories";
  if (selection === "selected") return "Selected repositories";
  return null;
}

function projects(n: number): string {
  return n === 1 ? "1 project" : `${n} projects`;
}

/** The line under a connected account: what it is, what it opens, how many projects it holds. */
export function connectedLine(row: ConnectedGithub): string {
  if (row.status === "uninstalled") return "The app was removed from this account on GitHub, so nothing new can be copied from it.";
  const parts = [kindOf(row.account_type), accessOf(row.repository_selection), projects(row.repo_count)];
  return parts.filter((p): p is string => !!p).join(" · ");
}

/** What a listed account offers: a Connect button, or why there isn't one. */
export function candidateState(c: ConnectCandidate): { connectable: boolean; note: string | null } {
  if (c.connected_here) return { connectable: false, note: "Already connected" };
  if (c.connected_elsewhere) return { connectable: false, note: "Connected to another Aura organization" };
  if (!c.can_connect) return { connectable: false, note: c.why_not || "You can’t connect this account." };
  return { connectable: true, note: null };
}

/** The line under a listed account, before it is connected. */
export function candidateLine(c: ConnectCandidate): string {
  return [kindOf(c.account_type), accessOf(c.repository_selection)].filter((p): p is string => !!p).join(" · ");
}

/** A ticket stops being asked about once GitHub has answered, refused or it ran out. */
export function ticketSettled(status: TicketStatus): boolean {
  return status !== "waiting";
}
