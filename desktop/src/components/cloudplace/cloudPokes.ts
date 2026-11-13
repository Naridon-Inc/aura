// Pokes: a teammate taps you on the shoulder from the Team list.
//
// While pokes are on, the server is asked every few seconds for pokes sent in
// the last half minute. Each is shown once — a toast with "Poke back", the
// overlay when Aura is in front, a system notification when it isn't — and a
// poke older than that window is let go, so coming back to the app doesn't
// replay a pile of them. Sending one says what the server did with it.

import { useSyncExternalStore } from "react";

import { onOrgChanged } from "../../lib/cloudOrgs";
import { openCloud } from "../../lib/cloudPlace";
import { cloudPokeApi, serverSentence, type PokeDto } from "../../lib/cloudPokeApi";
import { cachePokes, pokesOn } from "../../lib/cloudTeamPrefs";
import { cloudProblem } from "../../lib/cloudWorkspacesApi";
import { isWindowFocused, notify, onNotificationTap } from "../../lib/notifications";
import { toast } from "../../lib/toast";

const TICK_MS = 4_000;
/** A poke this old is news no longer. The server keeps the same window. */
export const FRESH_FOR_MS = 30_000;
const QUIET_MS = 5 * 60_000;
const TOAST_MS = 15_000;
export const OVERLAY_MS = 5_000;
export const POKE_KIND = "cloud-poke";

export type ShownPoke = { id: string; name: string };

let current: ShownPoke | null = null;
const listeners = new Set<() => void>();
let seen = new Set<string>();
let busy = false;
let quietUntil = 0;
let generation = 0;

function show(next: ShownPoke | null) {
  current = next;
  for (const l of listeners) l();
}

/** The pokes in a poll worth telling about: not told before, and recent. */
export function freshPokes(rows: PokeDto[], told: Set<string>, nowMs: number): PokeDto[] {
  return rows.filter((p) => {
    if (told.has(p.id)) return false;
    const at = Date.parse(p.created_at);
    return Number.isFinite(at) && nowMs - at <= FRESH_FOR_MS;
  });
}

/** What the sender is told: delivered, held back by the other side's
 *  setting, or refused with the server's reason. */
export function pokeOutcome(
  name: string,
  result: { delivered: boolean } | { error: unknown },
): { tone: "success" | "info" | "warning"; title: string } {
  if ("delivered" in result)
    return result.delivered
      ? { tone: "success", title: `Poked ${name}` }
      : { tone: "info", title: `${name} didn't get the poke` };
  return { tone: "warning", title: serverSentence(result.error) ?? `Couldn't poke ${name}. Try again.` };
}

/** Poke a teammate and say how it went. Resolves either way. */
export async function pokeMember(userId: string, name: string): Promise<void> {
  try {
    const sent = await cloudPokeApi.poke(userId);
    const o = pokeOutcome(name, sent);
    toast.show({ id: `cloud-poke-sent:${userId}`, tone: o.tone, title: o.title });
  } catch (error) {
    const o = pokeOutcome(name, { error });
    toast.show({ id: `cloud-poke-sent:${userId}`, tone: o.tone, title: o.title });
  }
}

async function tell(p: PokeDto) {
  const title = `${p.from_name} poked you`;
  toast.show({
    id: `cloud-poke:${p.id}`,
    tone: "accent",
    title,
    durationMs: TOAST_MS,
    actions: [{ label: "Poke back", variant: "primary", onClick: () => void pokeMember(p.from_user_id, p.from_name) }],
  });
  const focused = await isWindowFocused().catch(() => true);
  if (focused) {
    show({ id: p.id, name: p.from_name });
    return;
  }
  void notify({
    title,
    body: "Tap to see their workspaces. Poke back from their row under Team.",
    dedupeKey: `cloud-poke:${p.id}`,
    threadId: "cloud-pokes",
    extra: { kind: POKE_KIND, user_id: p.from_user_id },
  });
}

async function poll() {
  const now = Date.now();
  if (busy || now < quietUntil || !pokesOn()) return;
  busy = true;
  const mine = generation;
  try {
    const rows = await cloudPokeApi.pokes();
    if (mine !== generation) return;
    const fresh = freshPokes(rows, seen, Date.now());
    for (const p of rows) seen.add(p.id);
    // Oldest first, so a quick double poke reads in the order it was sent.
    for (const p of [...fresh].reverse()) await tell(p);
  } catch (e) {
    if (mine === generation && cloudProblem(e).kind !== "other") quietUntil = Date.now() + QUIET_MS;
  } finally {
    busy = false;
  }
}

/** Read the server's setting into this computer's copy. */
async function readSetting() {
  const mine = generation;
  try {
    const s = await cloudPokeApi.pokeSettings();
    if (mine === generation) cachePokes(s.enabled);
  } catch {
    // Signed out or an older server: keep what this computer last knew.
  }
}

/** Turn pokes on or off. The switch moves at once and moves back, with the
 *  reason, if the server didn't take it. */
export async function setPokes(on: boolean): Promise<void> {
  const was = pokesOn();
  cachePokes(on);
  try {
    const s = await cloudPokeApi.setPokeSettings(on);
    cachePokes(s.enabled);
  } catch (e) {
    cachePokes(was);
    throw new Error(cloudProblem(e).message);
  }
}

function forget() {
  generation += 1;
  seen = new Set();
  quietUntil = 0;
  show(null);
  void readSetting();
}

function openTapped(extra: Record<string, unknown>) {
  const id = extra["user_id"];
  if (typeof id === "string" && id) openCloud("home", [id]);
}

/** Start listening for pokes. Returns the stop. Mounted once, by `CloudTeamHost`. */
export function startCloudPokes(): () => void {
  void readSetting();
  const offOrg = onOrgChanged(forget);
  const offTap = onNotificationTap(POKE_KIND, openTapped);
  void poll();
  const timer = setInterval(() => void poll(), TICK_MS);
  return () => {
    clearInterval(timer);
    offOrg();
    offTap();
  };
}

/** The overlay is done with this poke. */
export function pokeShown(id: string) {
  if (current?.id === id) show(null);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const currentNow = () => current;

export function useShownPoke(): ShownPoke | null {
  return useSyncExternalStore(subscribe, currentNow, currentNow);
}
