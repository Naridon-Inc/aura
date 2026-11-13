// The team side of the cloud, kept once for the whole app: who is online and
// where, which workspaces you follow, and the @mentions that reach you.
//
// One clock drives four reads, each on its own cadence. Presence is read
// often only while the cloud is on screen (every few seconds inside a
// workspace, so typing shows up), and not at all while it isn't. The beacon
// that tells teammates you're here goes out every half minute and at once
// when the workspace you have open changes. A read the server refuses for
// good reason — signed out, an older server, a plan without it — goes quiet
// for a few minutes rather than asking again every tick.

import { useSyncExternalStore } from "react";

import { api } from "../../lib/api";
import { isChimeMuted, playChime } from "../../lib/chime";
import { onOrgChanged } from "../../lib/cloudOrgs";
import { cloudPlaceNow, openCloudWorkspace } from "../../lib/cloudPlace";
import { cloudTeamApi, type MentionRow, type PresenceEntry } from "../../lib/cloudTeamApi";
import { mentionAlertsOn, showOnlineOn } from "../../lib/cloudTeamPrefs";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { isWindowFocused, notify, onNotificationTap } from "../../lib/notifications";
import { toast } from "../../lib/toast";
import type { CloudMember } from "../ui/cloud-workspace";
import { freshMentions, mentionNotice } from "./cloudPeople";
import { focusFeedback } from "./feedbackFocus";
import { memberOf, PUBLIC_ROW_PREFIX } from "./cloudRows";

const TICK_MS = 2_000;
const BEACON_MS = 30_000;
const PRESENCE_IN_WORKSPACE_MS = 4_000;
const PRESENCE_IN_CLOUD_MS = 15_000;
const FOLLOWING_MS = 60_000;
const MENTIONS_MS = 15_000;
/** At most one "typing" beacon this often; the server holds one for six. */
const TYPING_EVERY_MS = 3_000;
const QUIET_MS = 5 * 60_000;
const MEMBERS_FOR_MS = 10 * 60_000;
/** More new mentions than this at once become one notice, not a stack. */
const ONE_BY_ONE = 3;

type Loop = "beacon" | "presence" | "following" | "mentions";

type TeamState = { presence: PresenceEntry[]; following: string[] };

let state: TeamState = { presence: [], following: [] };
const listeners = new Set<() => void>();

const due: Record<Loop, number> = { beacon: 0, presence: 0, following: 0, mentions: 0 };
const quietUntil: Record<Loop, number> = { beacon: 0, presence: 0, following: 0, mentions: 0 };
const busy = new Set<Loop>();

let viewing: string | null = null;
let lastInput = Date.now();
let lastTyping = 0;
let announced = new Set<string>();
let firstMentions = true;
let unread: MentionRow[] = [];
let members: { at: number; list: CloudMember[] } | null = null;
let generation = 0;

function publish(next: Partial<TeamState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** A refusal that won't change on the next tick: stop asking for a while. */
function goesQuiet(e: unknown): boolean {
  const kind = cloudProblem(e).kind;
  return kind !== "other";
}

async function run(loop: Loop, every: number, work: () => Promise<void>) {
  const now = Date.now();
  if (busy.has(loop) || now < due[loop] || now < quietUntil[loop]) return;
  busy.add(loop);
  due[loop] = now + every;
  const mine = generation;
  try {
    await work();
  } catch (e) {
    if (mine === generation && goesQuiet(e)) quietUntil[loop] = Date.now() + QUIET_MS;
  } finally {
    busy.delete(loop);
  }
}

function sendBeacon(typing: boolean): Promise<void> {
  if (!showOnlineOn()) return Promise.resolve();
  return cloudTeamApi.beacon(viewing, typing, Date.now() - lastInput).then(() => undefined);
}

async function teamMembers(): Promise<CloudMember[]> {
  if (members && Date.now() - members.at < MEMBERS_FOR_MS) return members.list;
  const list = (await api.cloudOrgMembers()).map((m) => memberOf(m));
  members = { at: Date.now(), list };
  return list;
}

/** The `extra.kind` a mention's OS notification is posted with; tapping one
 *  opens its workspace. */
const MENTION_KIND = "cloud-mention";

type Opens = Pick<MentionRow, "workspace_id" | "comment_id" | "anchor_message_id">;

/** Open the workspace; for a comment, with its thread open and in view. */
function openMention(m: Opens) {
  if (!m.workspace_id) return;
  if (m.comment_id) focusFeedback(m.workspace_id, m.anchor_message_id ?? null, m.comment_id);
  openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${m.workspace_id}`);
}

const text = (v: unknown) => (typeof v === "string" && v ? v : null);

function openTappedMention(extra: Record<string, unknown>) {
  const id = text(extra["workspace_id"]);
  if (id)
    openMention({
      workspace_id: id,
      comment_id: text(extra["comment_id"]),
      anchor_message_id: text(extra["anchor_message_id"]),
    });
}

/** What a tap on the OS notification needs to find the row's place again. */
const tapExtra = (m: Opens) => ({
  kind: MENTION_KIND,
  workspace_id: m.workspace_id,
  comment_id: m.comment_id ?? null,
  anchor_message_id: m.anchor_message_id ?? null,
});

async function announce(rows: MentionRow[]) {
  const fresh = freshMentions(rows, announced, viewing);
  for (const m of rows) announced.add(m.id);
  const first = firstMentions;
  firstMentions = false;
  if (!fresh.length || !mentionAlertsOn()) return;
  const people = await teamMembers().catch(() => [] as CloudMember[]);
  const focused = await isWindowFocused().catch(() => true);
  if (focused && !isChimeMuted()) playChime("mention");

  // On launch, or a burst while away: one notice that says how many.
  if (first || fresh.length > ONE_BY_ONE) {
    const latest = fresh[0]!;
    const { title, body } = mentionNotice(latest, people);
    const more = fresh.length - 1;
    const allMentions = fresh.every((m) => !m.kind || m.kind === "mention");
    const what = allMentions ? `mention${more === 1 ? "" : "s"}` : more === 1 ? "notification" : "notifications";
    const line = more ? `${body}\n…and ${more} more ${what}.` : body;
    toast.show({
      id: "cloud-mentions",
      tone: "accent",
      title,
      message: line,
      durationMs: 15_000,
      actions: [{ label: "Open", variant: "primary", onClick: () => openMention(latest) }],
    });
    void notify({
      title,
      body: line,
      dedupeKey: "cloud-mentions",
      threadId: "cloud-mentions",
      extra: tapExtra(latest),
    });
    return;
  }
  for (const m of fresh) {
    const { title, body } = mentionNotice(m, people);
    toast.show({
      id: `cloud-mention:${m.id}`,
      tone: "accent",
      title,
      message: body,
      durationMs: 15_000,
      actions: [{ label: "Open", variant: "primary", onClick: () => openMention(m) }],
    });
    void notify({
      title,
      body,
      dedupeKey: `cloud-mention:${m.id}`,
      threadId: "cloud-mentions",
      extra: tapExtra(m),
    });
  }
}

/** Opening a workspace reads the mentions in it: mark them read and take
 *  their notices down. */
function readMentionsIn(id: string) {
  const here = unread.filter((m) => m.workspace_id === id);
  if (!here.length) return;
  unread = unread.filter((m) => m.workspace_id !== id);
  for (const m of here) toast.dismiss(`cloud-mention:${m.id}`);
  cloudTeamApi.markMentionsRead(here.map((m) => m.id)).catch(() => {
    // Still unread on the server; the next poll lists them again, already announced.
  });
}

function tick() {
  const place = cloudPlaceNow();
  void run("beacon", BEACON_MS, () => sendBeacon(false));
  if (place.open) {
    void run("presence", viewing ? PRESENCE_IN_WORKSPACE_MS : PRESENCE_IN_CLOUD_MS, async () => {
      const mine = generation;
      const presence = await cloudTeamApi.presence();
      if (mine === generation) publish({ presence });
    });
    void run("following", FOLLOWING_MS, async () => {
      const mine = generation;
      const following = await cloudTeamApi.following();
      if (mine === generation) publish({ following });
    });
  }
  if (mentionAlertsOn()) {
    void run("mentions", MENTIONS_MS, async () => {
      const mine = generation;
      const rows = await cloudTeamApi.mentions(true, 50);
      if (mine !== generation) return;
      unread = rows;
      await announce(rows);
      if (viewing) readMentionsIn(viewing);
    });
  }
}

/** Another org, or signed in as someone else: nothing read so far holds. */
function forget() {
  generation += 1;
  for (const k of Object.keys(due) as Loop[]) {
    due[k] = 0;
    quietUntil[k] = 0;
  }
  announced = new Set();
  firstMentions = true;
  unread = [];
  members = null;
  publish({ presence: [], following: [] });
}

/** Start the clock. Returns the stop. Mounted once, by `CloudTeamHost`. */
export function startCloudTeam(): () => void {
  const touched = () => {
    lastInput = Date.now();
  };
  const events = ["keydown", "pointerdown", "pointermove", "wheel", "focus"] as const;
  for (const ev of events) window.addEventListener(ev, touched, { passive: true });
  const offOrg = onOrgChanged(forget);
  const offTap = onNotificationTap(MENTION_KIND, openTappedMention);
  tick();
  const timer = setInterval(tick, TICK_MS);
  return () => {
    clearInterval(timer);
    offOrg();
    offTap();
    for (const ev of events) window.removeEventListener(ev, touched);
  };
}

/** The cloud workspace on screen (its server id), or null. Teammates see it
 *  at once, and its mentions count as read. */
export function setViewingWorkspace(id: string | null) {
  if (id === viewing) return;
  viewing = id;
  lastInput = Date.now();
  due.beacon = 0;
  due.presence = 0;
  if (id) readMentionsIn(id);
}

/** The draft changed: tell teammates you're typing, at most every few seconds. */
export function noteTyping() {
  const now = Date.now();
  lastInput = now;
  if (!viewing || now - lastTyping < TYPING_EVERY_MS) return;
  lastTyping = now;
  void sendBeacon(true).catch(() => {});
}

/** The draft was sent or cleared: stop showing you as typing. */
export function stopTyping() {
  if (!viewing || Date.now() - lastTyping > 6_000) return;
  lastTyping = 0;
  void sendBeacon(false).catch(() => {});
}

/** After a follow or unfollow the server accepted. */
export function setFollowing(id: string, on: boolean) {
  const rest = state.following.filter((x) => x !== id);
  publish({ following: on ? [id, ...rest] : rest });
}

/** Read presence again now, e.g. when a screen that shows it opens. */
export function refreshPresence() {
  due.presence = 0;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const presenceNow = () => state.presence;
const followingNow = () => state.following;

export function useCloudPresence(): PresenceEntry[] {
  return useSyncExternalStore(subscribe, presenceNow, presenceNow);
}

/** Server ids of the workspaces you follow. */
export function useCloudFollowing(): string[] {
  return useSyncExternalStore(subscribe, followingNow, followingNow);
}
