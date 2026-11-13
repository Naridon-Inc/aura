// Who is in a cloud workspace, read from what the server says — presence,
// access and the author on each turn — as the library's `CloudMember`s.
//
// Pure, so every rule here (who counts as typing, who is shown as inside a
// workspace, who a turn is put on) is tested without the app or a network.

import type { CloudOrgMember } from "../../lib/api";
import { withLeading } from "../../lib/composerBridge";
import { inboxKind, noticeLine } from "./cloudFeedback";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { stripSteeringDirective } from "../../lib/steeringDirective";
import type {
  AccessGrant,
  MentionRow,
  PresenceEntry,
  WorkspaceAccessDto,
} from "../../lib/cloudTeamApi";
import type { CloudMember } from "../ui/cloud-workspace";
import type { WorkspaceAccess } from "../ui/cloud-sharing";

/** The author fields a turn carries once the server records them. */
export type Authored = { author_id?: string | null; author_name?: string | null };

/** Who said a turn: a member, you, or someone the team no longer holds. */
export type TurnAuthor = { member: CloudMember; own: boolean };

const GONE_COLOR = "#6b6b6b";

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1 ? words[0]!.slice(0, 1) : words[0]![0]! + words[1]![0]!;
  return letters.toUpperCase();
}

/**
 * The person a turn is put on. A turn with no author recorded (older rows,
 * a routine, an agent's own message) is put on no one rather than guessed.
 */
export function authorOf(
  turn: Authored,
  members: readonly CloudMember[],
  me: string | null,
): TurnAuthor | null {
  const id = turn.author_id?.trim();
  if (!id) return null;
  const member = members.find((m) => m.id === id);
  if (member) return { member: id === me ? { ...member, name: "You" } : member, own: id === me };
  const name = turn.author_name?.trim() || "Someone no longer in this team";
  return {
    member: { id, name, initials: initials(name), color: GONE_COLOR, role: "Member" },
    own: id === me,
  };
}

/** A transcript is shared once anyone but you has written in it; until then
 *  it reads like your own chat, with no names over the turns. */
export function hasOtherAuthors(turns: readonly (Authored & { role: string })[], me: string | null): boolean {
  return turns.some((t) => t.role === "user" && !!t.author_id && t.author_id !== me);
}

/**
 * Your own member id. The cloud's user id names you exactly, members loaded or
 * not. Without it (an app that can't ask yet, a read that failed) the sign-in's
 * saved name is matched instead, and that name is a GitHub login for one
 * sign-in and an email for another, so it is tried against both.
 */
export function meAmong(
  members: readonly CloudOrgMember[],
  userId: string | null,
  login: string | null,
): string | null {
  const id = userId?.trim();
  if (id) return id;
  const name = login?.trim().toLowerCase();
  if (!name) return null;
  const same = (v?: string | null) => !!v && v.trim().toLowerCase() === name;
  return members.find((m) => same(m.github_login) || same(m.email))?.user_id ?? null;
}

/** Members marked active from presence: in the app now, not just signed in. */
export function activeIdsOf(presence: readonly PresenceEntry[]): Set<string> {
  return new Set(presence.filter((p) => p.state === "active").map((p) => p.user_id));
}

/** Members in the order Home lists them: active, then idle, then the rest.
 *  The order is otherwise the server's, so it doesn't reshuffle on a poll. */
export function byPresence(members: readonly CloudMember[], presence: readonly PresenceEntry[]): CloudMember[] {
  const rank = new Map(presence.map((p) => [p.user_id, p.state === "active" ? 0 : 1]));
  return members
    .map((m, i) => ({ m, i, r: rank.get(m.id) ?? 2 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
}

/**
 * The people shown in a workspace's header: whoever has it open now, then
 * the person who opened it (dimmed when they aren't here), then you.
 */
export function viewersOf(
  presence: readonly PresenceEntry[],
  workspaceId: string,
  members: readonly CloudMember[],
  me: string | null,
  owner: string | null | undefined,
): CloudMember[] {
  const here = new Map(
    presence.filter((p) => p.viewing_workspace_id === workspaceId).map((p) => [p.user_id, p]),
  );
  const out: CloudMember[] = [];
  for (const m of members) {
    if (m.id === me) continue;
    const p = here.get(m.id);
    if (p) out.push({ ...m, active: p.state === "active" || undefined });
  }
  const opener = owner && owner !== me ? members.find((m) => m.id === owner) : undefined;
  if (opener && !here.has(opener.id)) out.push({ ...opener, active: undefined });
  const self = me ? members.find((m) => m.id === me) : undefined;
  if (self) out.push({ ...self, active: true });
  return out;
}

/** The names of teammates typing in this workspace, you left out. */
export function typingNamesOf(
  presence: readonly PresenceEntry[],
  workspaceId: string,
  members: readonly CloudMember[],
  me: string | null,
): string[] {
  const names: string[] = [];
  for (const p of presence) {
    if (!p.typing || p.viewing_workspace_id !== workspaceId || p.user_id === me) continue;
    const m = members.find((x) => x.id === p.user_id);
    if (m) names.push(m.name);
  }
  return names;
}

/** The server's access as the share popover's value. */
export function shareValueOf(dto: Pick<WorkspaceAccessDto, "general" | "grants">): WorkspaceAccess {
  return {
    general: dto.general === "restricted" ? "restricted" : "organization",
    grants: dto.grants.map((g) => ({
      memberId: g.user_id,
      level: g.level === "read" ? "Read" : "Write",
    })),
  };
}

/** The share popover's value as the server's grants. */
export function grantsOf(value: WorkspaceAccess): AccessGrant[] {
  return value.grants.map((g) => ({
    user_id: g.memberId,
    level: g.level === "Read" ? "read" : "write",
  }));
}

/**
 * Whether a teammate could read an @mention of them in this workspace. While
 * it is private, only those invited, the person who opened it and the org's
 * admins can; a mention of anyone else reaches no one.
 */
export function canSeeWorkspace(
  member: CloudMember,
  access: Pick<WorkspaceAccessDto, "general" | "grants" | "owner_id"> | null,
): boolean {
  if (!access || access.general !== "restricted") return true;
  if (member.role === "Admin" || member.id === access.owner_id) return true;
  return access.grants.some((g) => g.user_id === member.id);
}

/** What a mention says in a notification: who, where, and the line itself. */
export function mentionNotice(
  m: MentionRow,
  members: readonly CloudMember[],
): { title: string; body: string } {
  const by = members.find((x) => x.id === m.by_user_id)?.name ?? "A teammate";
  const where = m.workspace_title?.split("\n")[0]?.trim() || null;
  return { title: noticeLine(inboxKind(m.kind), by, where), body: m.excerpt };
}

/** The server's own sentence from a failed call — `HTTP 422 …: {"error": …}` —
 *  when it sent one; otherwise null, and the caller says it in its own words. */
export function serverSentence(e: unknown): string | null {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    const body = JSON.parse(text.slice(at)) as { error?: unknown; message?: unknown };
    const said = typeof body.message === "string" ? body.message : body.error;
    return typeof said === "string" && said.includes(" ") ? said : null;
  } catch {
    return null;
  }
}

/**
 * The mentions worth interrupting for: ones not yet announced, outside the
 * workspace you are looking at right now (that one you are already reading).
 */
export function freshMentions(
  rows: readonly MentionRow[],
  announced: ReadonlySet<string>,
  lookingAt: string | null,
): MentionRow[] {
  return rows.filter((m) => !announced.has(m.id) && !(lookingAt && m.workspace_id === lookingAt));
}

/**
 * Who a share was refused for because they aren't on the workspace's
 * project: the server answers 422 with the member's `user_id` beside its
 * sentence. Null for any other failure, so nothing else offers to add anyone.
 */
export function notOnProjectUser(e: unknown): string | null {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    const body = JSON.parse(text.slice(at)) as { error?: unknown; user_id?: unknown };
    const said = typeof body.error === "string" ? body.error : "";
    if (!/open this workspace.s project/i.test(said)) return null;
    return typeof body.user_id === "string" && body.user_id ? body.user_id : null;
  } catch {
    return null;
  }
}

/** The people a save is adding: in `next`, not already granted in `held`. */
export function newlyGranted(held: readonly AccessGrant[], next: readonly AccessGrant[]): string[] {
  const had = new Set(held.map((g) => g.user_id));
  return next.map((g) => g.user_id).filter((id) => !had.has(id));
}

/** What the small card on a face in a workspace's header says about them. */
export type PersonCard = {
  /** "Typing…", "Here now", "Here, but away", "Last seen 3m ago", … */
  status: string;
  /** In this workspace right now. */
  here: boolean;
  /** "Owner", "Can write", "Can read" or "Can't open it"; null until the
   *  workspace's access has been read. */
  access: string | null;
  /** The login a mention names, or why a mention wouldn't reach them. Null
   *  for you: there is no one to mention. */
  mention: { login: string } | { reason: string } | null;
};

type CardAccess = Pick<WorkspaceAccessDto, "general" | "grants" | "owner_id" | "your_access">;

function accessWord(member: CloudMember, access: CardAccess | null, me: string | null): string | null {
  if (!access) return null;
  if (member.id === access.owner_id) return "Owner";
  if (member.id === me)
    return access.your_access === "write"
      ? "Can write"
      : access.your_access === "read"
        ? "Can read"
        : "Can’t open it";
  const grant = access.grants.find((g) => g.user_id === member.id);
  if (grant) return grant.level === "read" ? "Can read" : "Can write";
  if (access.general !== "restricted" || member.role === "Admin") return "Can write";
  return "Can’t open it";
}

function statusOf(p: PresenceEntry | undefined, workspaceId: string, now: number): { status: string; here: boolean } {
  if (!p) return { status: "Not in Aura lately", here: false };
  if (p.viewing_workspace_id === workspaceId) {
    if (p.typing) return { status: "Typing…", here: true };
    return { status: p.state === "active" ? "Here now" : "Here, but away", here: true };
  }
  if (p.state === "active") return { status: "In Aura, not in this workspace", here: false };
  const at = Date.parse(p.last_active_at || p.last_seen_at);
  if (!Number.isFinite(at)) return { status: "Away", here: false };
  return { status: `Last seen ${relativeAgeFromDelta(Math.max(0, Math.floor((now - at) / 1000)))}`, here: false };
}

/**
 * The card on a face in a workspace's header: are they here, what they may do
 * in this workspace, and whether an @mention of them would reach them. A
 * card, never a page: clicking a face doesn't take you anywhere.
 */
export function personCardOf(
  member: CloudMember,
  presence: readonly PresenceEntry[],
  workspaceId: string,
  access: CardAccess | null,
  me: string | null,
  login: string | undefined,
  now: number,
): PersonCard {
  const accessLine = accessWord(member, access, me);
  if (member.id === me)
    return { status: "Here now", here: true, access: accessLine, mention: null };
  const { status, here } = statusOf(
    presence.find((p) => p.user_id === member.id),
    workspaceId,
    now,
  );
  const mention = !login
    ? { reason: "Aura doesn’t know their GitHub name yet, so it can’t mention them." }
    : !canSeeWorkspace(member, access)
      ? { reason: "They can’t open this workspace, so a mention wouldn’t reach them." }
      : { login };
  return { status, here, access: accessLine, mention };
}

/** Words that start a message to the agent, not a person, even after an @. */
const NOT_PEOPLE = new Set(["claude", "codex", "aura", "agent", "here", "all", "everyone"]);

/**
 * The teammates a message is addressed to: the @logins it opens with, matched
 * to members by GitHub login (any case). A message that names no teammate
 * first, or opens with anything else, is for the agent and gives null.
 *
 * "@maya can you check the copy?" → [maya]. "Fix @maya's test" → null: the
 * mention is inside a request to the agent, so the agent still gets it.
 */
export function addressedTo(text: string, logins: Record<string, string>): string[] | null {
  const byLogin = new Map(
    Object.entries(logins)
      .filter(([, login]) => !!login)
      .map(([id, login]) => [login.toLowerCase(), id]),
  );
  const ids: string[] = [];
  const re = /^\s*@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?=[\s,:;!?.]|$)[\s,:;]*/;
  // A mode directive in front is the composer's, not the person's first words.
  let rest = stripSteeringDirective(text);
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const login = m[1]!.toLowerCase();
    const id = byLogin.get(login);
    if (!id || NOT_PEOPLE.has(login)) break;
    if (!ids.includes(id)) ids.push(id);
    rest = rest.slice(m[0].length);
  }
  return ids.length ? ids : null;
}

/** "to Maya", "to Maya and Sam", "to Maya, Sam and Lee": who a message is
 *  for, as a turn's label says it. You are "you". */
export function toNames(ids: readonly string[], members: readonly CloudMember[], me: string | null): string {
  const names = ids.map((id) =>
    id === me ? "you" : members.find((m) => m.id === id)?.name ?? "someone no longer in this team",
  );
  if (names.length <= 1) return `to ${names[0] ?? ""}`.trim();
  return `to ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The message box after Mention: the @login goes first, so the message is
 * addressed to them, ahead of whatever was already typed. Mentioning the
 * same person twice leaves it as it was.
 */
export function withMention(draft: string, insert: string): string {
  return withLeading(draft, insert);
}

/** The agent answering in a workspace, as its turns are labelled. */
export type TurnAgent = { name: "Claude" | "Codex" | "Agent"; provider: string };

/**
 * Who writes a workspace's replies: the engine of the machine chat it is
 * linked to, else the agent or model it was opened with. An agent turn is
 * always labelled with an agent, never a person's face, so the two can't be
 * mistaken for each other.
 */
export function agentOf(row: {
  place?: { engine?: string | null } | null;
  agent?: string | null;
  model?: string | null;
}): TurnAgent {
  const said = [row.place?.engine, row.agent, row.model]
    .map((v) => v?.trim().toLowerCase() ?? "")
    .find(Boolean);
  if (!said) return { name: "Agent", provider: "" };
  if (/codex|openai|gpt|\bo\d/.test(said)) return { name: "Codex", provider: "codex" };
  if (/claude|anthropic|opus|sonnet|haiku/.test(said)) return { name: "Claude", provider: "claude" };
  return { name: "Agent", provider: said };
}
