// Where Aura asks for support, and the ledger that decides when it's allowed to.
//
// Aura is open source and the project lives or dies on people finding it, so
// the app asks twice: once at first run, and once — ever — after Aura has
// actually earned it. Everything else is a permanent, quiet link in Settings.
//
// Three rules keep the ask from becoming nagware:
//
//   1. The earned ask fires at most once per install, and never again once the
//      person has answered it or waved it away.
//   2. "Earned" means real use — three separate days, or twenty-five finished
//      agent turns — not elapsed time and not a launch count.
//   3. Nothing here ever blocks. Every surface is skippable in one click.
//
// The ledger is durable (`setDurable`): it is a promise the app made to the
// user about how often it will ask, so it must not be evicted as a cache.

import { setDurable } from "./localStore";
import { toast } from "./toast";

export const GITHUB_REPO_URL = "https://github.com/Naridon-Inc/aura";

/** Aura's Discord invite. Empty until we have a permanent one — the chat link
 *  then falls back to GitHub Discussions, which does exist. Filling this in is
 *  the only change needed: every surface below reads it. */
export const DISCORD_INVITE_URL = "";

export const DISCUSSIONS_URL = `${GITHUB_REPO_URL}/discussions`;

export type CommunityLink = {
  kind: "star" | "chat";
  label: string;
  hint: string;
  url: string;
};

/** Somewhere to talk to other people using Aura: Discord when we have one,
 *  GitHub Discussions until then. Never a dead link. */
export function chatLink(): CommunityLink {
  return DISCORD_INVITE_URL
    ? {
        kind: "chat",
        label: "Join the Discord",
        hint: "Ask questions and trade workflows with other people using Aura",
        url: DISCORD_INVITE_URL,
      }
    : {
        kind: "chat",
        label: "Join the discussion",
        hint: "Ask questions and trade workflows with other people using Aura",
        url: DISCUSSIONS_URL,
      };
}

export function starLink(): CommunityLink {
  return {
    kind: "star",
    label: "Star Aura on GitHub",
    hint: "github.com/Naridon-Inc/aura — stars are how people find it",
    url: GITHUB_REPO_URL,
  };
}

export function communityLinks(): CommunityLink[] {
  return [starLink(), chatLink()];
}

// ── The ledger ─────────────────────────────────────────────────────────

const LEDGER_KEY = "aura.community.v1";

/** Distinct days of use that earn the ask. */
export const DAYS_TO_EARN = 3;
/** Finished agent turns that earn the ask, for people who use Aura hard in
 *  one sitting rather than across a week. */
export const TURNS_TO_EARN = 25;
/** We only ever need to know how many distinct days there were, so the list
 *  is capped — an install running for a year must not grow an unbounded key. */
const MAX_DAYS_KEPT = DAYS_TO_EARN;

export type CommunityLedger = {
  /** ISO `YYYY-MM-DD` days this install was used, newest last, capped. */
  days: string[];
  /** Agent turns that ran to completion. */
  turns: number;
  /** The earned ask has been shown. Never shows again. */
  asked: boolean;
  /** The first-run screen has been shown. Never shows again. */
  greeted: boolean;
  /** The person opened the star page / the chat from one of our surfaces. */
  starred: boolean;
  joined: boolean;
};

export function emptyLedger(): CommunityLedger {
  return {
    days: [],
    turns: 0,
    asked: false,
    greeted: false,
    starred: false,
    joined: false,
  };
}

/** `YYYY-MM-DD` in the user's own timezone — "three days of use" should mean
 *  three of their days, not three UTC days. */
export function isoDay(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Pure transitions (the part worth testing) ──────────────────────────

/** Record that Aura was used today. Same day twice is a no-op, so this is
 *  safe to call on every launch. */
export function recordDay(
  ledger: CommunityLedger,
  day: string,
): CommunityLedger {
  if (ledger.days.includes(day)) return ledger;
  const days = [...ledger.days, day].slice(-MAX_DAYS_KEPT);
  return { ...ledger, days };
}

export function recordTurn(ledger: CommunityLedger): CommunityLedger {
  return { ...ledger, turns: ledger.turns + 1 };
}

/** Has Aura done enough for the ask to be fair — and not asked already? */
export function hasEarnedTheAsk(ledger: CommunityLedger): boolean {
  if (ledger.asked) return false;
  if (ledger.starred && ledger.joined) return false;
  return ledger.days.length >= DAYS_TO_EARN || ledger.turns >= TURNS_TO_EARN;
}

/** The first-run screen shows once, on a genuinely new install. */
export function shouldGreet(ledger: CommunityLedger = readLedger()): boolean {
  return !ledger.greeted;
}

// ── Storage ────────────────────────────────────────────────────────────

export function readLedger(): CommunityLedger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as Partial<CommunityLedger>;
    return {
      ...emptyLedger(),
      ...parsed,
      days: Array.isArray(parsed.days) ? parsed.days.filter(isDay) : [],
      turns: typeof parsed.turns === "number" ? parsed.turns : 0,
    };
  } catch {
    // Unparseable or storage disabled — start clean rather than throw. The
    // cost of being wrong here is one extra ask, once.
    return emptyLedger();
  }
}

function isDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function writeLedger(ledger: CommunityLedger): void {
  setDurable(LEDGER_KEY, JSON.stringify(ledger));
}

function update(fn: (l: CommunityLedger) => CommunityLedger): CommunityLedger {
  const next = fn(readLedger());
  writeLedger(next);
  return next;
}

/** Call once per app start. */
export function noteAppOpened(): CommunityLedger {
  return update((l) => recordDay(l, isoDay()));
}

export function markGreeted(): void {
  update((l) => ({ ...l, greeted: true }));
}

export function markStarred(): void {
  update((l) => ({ ...l, starred: true }));
}

export function markJoined(): void {
  update((l) => ({ ...l, joined: true }));
}

export function markAsked(): void {
  update((l) => ({ ...l, asked: true }));
}

// ── The earned ask ─────────────────────────────────────────────────────

/** Open one of our links in the user's browser, and remember they did. */
export async function openCommunityLink(link: CommunityLink): Promise<void> {
  if (link.kind === "star") markStarred();
  else markJoined();
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(link.url);
  } catch (e) {
    console.warn("openUrl failed:", e);
  }
}

/** A permanent link surface (Settings → Help) was used. If it was one of the
 *  community links, that answers the ask as surely as the first-run screen
 *  would have. Anything else is ignored. */
export function noteHelpLinkOpened(url: string): void {
  if (url === starLink().url) markStarred();
  else if (url === chatLink().url) markJoined();
}

/** Count a finished agent turn, and raise the earned ask if this was the one
 *  that earned it. Safe to call on every turn-end; it fires at most once per
 *  install. */
export function noteTurnFinished(): void {
  const ledger = update(recordTurn);
  if (!hasEarnedTheAsk(ledger)) return;
  markAsked();
  askForSupport();
}

/** The one earned nudge. Accent-toned and sticky because it asks for a
 *  decision, and it never comes back either way. */
export function askForSupport(): void {
  const star = starLink();
  const chat = chatLink();
  toast.show({
    id: "community-ask",
    tone: "accent",
    title: "Aura has been doing real work for you",
    message:
      "It's free and open source. A star is how other people find it — and the community is where the workflows get shared.",
    durationMs: null,
    actions: [
      {
        label: "Star on GitHub",
        variant: "primary",
        onClick: () => void openCommunityLink(star),
      },
      { label: chat.label, onClick: () => void openCommunityLink(chat) },
    ],
  });
}
