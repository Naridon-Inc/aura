// The cloud place's rows, from what the server actually holds.
//
// Two kinds of cloud work reach Home: workspaces opened through the cloud's
// own API (by this app, the CLI, an agent or a routine) and work handed to a
// machine from a chat (the cloud jobs board). Both become the library's
// `WorkspaceOverview`, so Home, Dashboard and the sidebar draw them the same
// way — and neither borrows a number, a cost or an owner it wasn't given.

import type { CloudOrgMember, CloudRepo } from "../../lib/api";
import { ownerOf, type CloudWorkspaceRow } from "../../lib/cloudWorkspacesApi";
import type { CloudMember } from "../ui/cloud-workspace";
import type { WorkspaceOverview, WorkspaceStage } from "../ui/workspace-preview-card";
import { relTime } from "../workspaces/workspacesModel";

/** Prefix for a row that is a cloud API workspace (vs `cloud:` for a job thread). */
export const PUBLIC_ROW_PREFIX = "cws:";

/** Where a workspace a routine opened says it came from. */
export const ROUTINE_SOURCE = "routine";

/** The server's container for workspaces opened with no repository named. */
const IMPLICIT_REPO = "aura-workspace/";

/** Where a laptop's own session rows say they came from: the desktop's
 *  heartbeat (`aura-shell`, `aura-desktop` before the rename) and the
 *  sessions the CLI rebuilds from its notes. The server's list is the same
 *  (`DEVICE_SESSION_SOURCES` in aura-cloud). */
const DEVICE_SOURCES = new Set(["aura-shell", "aura-desktop", "aura-cli"]);

/** Whether a listed row is work the cloud itself holds, rather than an agent
 *  session a laptop reported. The server says so in `origin`; a server from
 *  before that field is read by the row's own `source`. Laptop sessions
 *  belong to the laptop's place, never to the cloud's Home. */
export function isCloudWork(w: Pick<CloudWorkspaceRow, "origin" | "source">): boolean {
  if (w.origin === "cloud") return true;
  if (w.origin === "device") return false;
  return !DEVICE_SOURCES.has((w.source ?? "").trim());
}

/** The cloud's own workspaces, each once.
 *
 *  Each id has to be unique because Home keys its rows by it: two rows under
 *  one key are a React key collision, and a collision leaves rows on screen
 *  that the next filter should have removed. Laptop rows are where repeats
 *  come from (a desktop reports one session into every project it has open,
 *  under one id) — so this keeps the most recently active row for an id,
 *  should any reach it from a server or a race. */
export function cloudWorkOnly(rows: CloudWorkspaceRow[]): CloudWorkspaceRow[] {
  const byId = new Map<string, CloudWorkspaceRow>();
  for (const w of rows) {
    if (!isCloudWork(w)) continue;
    const seen = byId.get(w.id);
    const at = (r: CloudWorkspaceRow) => stamp(r.last_activity_at) || stamp(r.created_at);
    if (!seen || at(w) > at(seen)) byId.set(w.id, w);
  }
  return rows.filter((w) => byId.get(w.id) === w);
}

const AVATAR_COLORS = ["#73594d", "#596d84", "#71617b", "#5d6862", "#6b6450", "#5b6f74"];

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Up to two letters from a name, the way the library's avatars spell them. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1 ? words[0]!.slice(0, 1) : words[0]![0]! + words[1]![0]!;
  return letters.toUpperCase();
}

/** An org member as the library's member: their photo when GitHub has one. */
export function memberOf(m: CloudOrgMember, activeIds: ReadonlySet<string> = new Set()): CloudMember {
  const name = m.display_name?.trim() || m.github_login?.trim() || m.email?.trim() || "Member";
  const role = m.role.toLowerCase();
  return {
    id: m.user_id,
    name,
    initials: initialsOf(name),
    color: AVATAR_COLORS[hash(m.user_id) % AVATAR_COLORS.length]!,
    photo: m.github_avatar?.trim() || undefined,
    active: activeIds.has(m.user_id) || undefined,
    role: role === "owner" || role === "admin" ? "Admin" : "Member",
  };
}

function stamp(iso: string | null | undefined): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

function stageOf(status: string): WorkspaceStage {
  if (status === "running") return "in-progress";
  if (status === "archived" || status === "ended") return "done";
  return "backlog";
}

/** `owner/name` → `name`; the per-caller container → no repository at all. */
export function repoLabel(fullName: string | null | undefined): string {
  const name = (fullName ?? "").trim();
  if (!name || name.startsWith(IMPLICIT_REPO)) return "No repository";
  return name.split("/").pop() || name;
}

/** `owner/name` → its page on GitHub; empty for the per-caller container and
 *  for anything that is not an `owner/name`. */
export function githubRepoPage(fullName: string | null | undefined): string {
  const name = (fullName ?? "").trim();
  if (name.startsWith(IMPLICIT_REPO)) return "";
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/.test(name)
    ? `https://github.com/${name}`
    : "";
}

/** When the freshest of these workspaces last moved (epoch ms), or null when
 *  none has a time — what decides how often the lists' ages need re-reading. */
export function newestActivityMs(rows: readonly CloudWorkspaceRow[]): number | null {
  let newest = 0;
  for (const w of rows) newest = Math.max(newest, stamp(w.last_activity_at) || stamp(w.created_at));
  return newest > 0 ? newest : null;
}

export function publicWorkspaceOverview(
  w: CloudWorkspaceRow,
  repos: ReadonlyMap<string, CloudRepo>,
  nowMs: number,
): WorkspaceOverview {
  const repo = repos.get(w.repo_id);
  const at = stamp(w.last_activity_at) || stamp(w.created_at);
  const title = (w.objective || w.intent || "").split("\n")[0]!.trim();
  return {
    id: `${PUBLIC_ROW_PREFIX}${w.id}`,
    title: title || "Untitled workspace",
    branch: w.branch || "",
    project: repoLabel(repo?.full_name),
    projectId: w.repo_id,
    stage: stageOf(w.status),
    summary: w.intent && w.intent !== title ? w.intent : undefined,
    updatedAt: at,
    createdAt: stamp(w.created_at) || undefined,
    timeLabel: at ? relTime(Math.floor(at / 1000), nowMs) : "",
    archived: w.status === "archived",
    workflow: {
      state: w.status === "running" ? "working" : "loading",
      branch: w.branch ?? undefined,
    },
  };
}

/** The id a row is known by on the server, shown where a row prints its W-n. */
export function rowNumber(rowId: string): string {
  const raw = rowId.startsWith(PUBLIC_ROW_PREFIX)
    ? rowId.slice(PUBLIC_ROW_PREFIX.length)
    : rowId.replace(/^cloud:(cloud-)?/, "");
  return raw.replace(/-/g, "").slice(0, 6).toUpperCase();
}

/** Who opened each API workspace, for the rows whose opener is an org member. */
export function ownersOf(
  rows: CloudWorkspaceRow[],
  members: CloudMember[],
): Record<string, string> {
  const known = new Set(members.map((m) => m.id));
  const out: Record<string, string> = {};
  for (const w of rows) {
    const by = ownerOf(w);
    if (by && known.has(by)) out[`${PUBLIC_ROW_PREFIX}${w.id}`] = by;
  }
  return out;
}
