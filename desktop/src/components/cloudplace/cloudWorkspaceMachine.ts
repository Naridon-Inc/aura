// What a cloud workspace's details say about the machine it runs on, worked
// out from what the machine and the chat really reported. Pure, so every
// sentence the popover shows can be checked without a machine.

import type { MachineStats } from "../../lib/place/placeWork";
import type { CloudWorkspacePlace } from "../../lib/cloudWorkspacesApi";
import type { ChatSpend } from "../manager/chat/spend";

/** A size in kilobytes as the details print it: whole gigabytes once there
 *  are ten of them, one decimal below that. */
export function sizeGb(kb: number): number {
  const gb = kb / (1024 * 1024);
  return gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
}

/** The CPU, Memory and Disk rows, in the shape the details read them. */
export function resourcesOf(stats: MachineStats) {
  return {
    cpu: stats.cores,
    memory: sizeGb(stats.memory_kb),
    disk: sizeGb(stats.disk_kb),
    usage: { cpu: stats.cpu_used, memory: stats.memory_used, disk: stats.disk_used },
  };
}

/** Whose Claude a workspace one of the team's computers answers by itself
 *  runs on: always the member who started it, whoever sends the message. */
export function starterClaude(opts: { mine: boolean; starter: string | null }): string {
  if (opts.mine) return "your Claude";
  return opts.starter ? `${opts.starter}’s Claude` : "the Claude of whoever started it";
}

/** Whose agent sign-in a workspace's turns run on, said in a few words. */
export function payerOf(opts: {
  drives: boolean;
  boxDriven: boolean;
  driver: string | null;
  /** You started the workspace. */
  mine: boolean;
  /** Who started it, by name, when they are in the team. */
  starter: string | null;
}): string {
  if (opts.drives) return "your own sign-in";
  if (opts.boxDriven) return starterClaude(opts);
  return `${opts.driver ?? "the driving member"}’s own sign-in`;
}

/** The Agent cost row. A figure only when turns really recorded one; an
 *  agent CLI on its own sign-in prices nothing, and saying so beats a zero. */
export function costLabel(
  spend: Pick<ChatSpend, "sessionUsd" | "sessionEstimated" | "sessionPartial"> | null,
  payer: string,
): string {
  const usd = spend?.sessionUsd ?? null;
  if (usd === null) return `Not metered · runs on ${payer}`;
  const figure = usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`;
  return `${spend?.sessionPartial ? "≥ " : spend?.sessionEstimated ? "~" : ""}${figure}`;
}

/** Where Sync to a local directory puts a workspace's files unless you
 *  choose somewhere else: one folder per workspace under your home. */
export function defaultSyncFolder(home: string, repository: string, branch: string | null, id: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = [safe(repository), safe(branch ?? "") || safe(id)].filter(Boolean).join("-");
  return `${home.replace(/\/+$/, "")}/Aura/Cloud/${name || safe(id)}`;
}

export type SyncPrefs = { on: boolean; folder: string | null };

const syncKey = (id: string) => `aura.cloudWorkspace.sync.${id}`;

/** What this laptop remembers about syncing one workspace. */
export function readSyncPrefs(store: Pick<Storage, "getItem">, id: string): SyncPrefs {
  try {
    const raw = store.getItem(syncKey(id));
    const v = raw ? (JSON.parse(raw) as Partial<SyncPrefs>) : {};
    return { on: v.on === true, folder: typeof v.folder === "string" && v.folder ? v.folder : null };
  } catch {
    return { on: false, folder: null };
  }
}

export function writeSyncPrefs(store: Pick<Storage, "setItem">, id: string, prefs: SyncPrefs): void {
  try {
    store.setItem(syncKey(id), JSON.stringify(prefs));
  } catch {
    // A full or blocked store costs the preference, not the copy.
  }
}

/** Copy workspace info: what someone would paste into a message about it. */
export function workspaceInfo(w: {
  title: string;
  id: string;
  repository: string;
  branch: string | null;
  state: string;
  createdBy: string;
  createdAt: string;
  link: string | null;
  place: CloudWorkspacePlace | null;
}): string {
  const lines = [
    w.title,
    `Repository: ${w.repository}`,
    ...(w.branch ? [`Branch: ${w.branch}`] : []),
    `Status: ${w.state}`,
    `Created: ${w.createdBy} · ${w.createdAt}`,
    ...(w.place
      ? [`Machine: ${w.place.machine}`, `Folder: ${w.place.remote_root}`, `Agent: ${w.place.engine}`]
      : []),
    `Workspace: ${w.id}`,
    ...(w.link ? [`Link: ${w.link}`] : []),
  ];
  return lines.join("\n");
}
