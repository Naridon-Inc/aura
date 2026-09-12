// The small parts every tracker card is built from: the two notices a card
// prints (the browser-didn't-open link, and its own error), the three-state
// status chip, the "this machine has no app for that" explainer, and the
// glyphs. Split out of the old 1717-line IntegrationsTab so a card file is
// about one tracker and nothing else.

import { ExternalLink, TriangleAlert } from "lucide-react";

import { onExternalAnchorClick } from "../../../lib/openExternal";
import { monogram } from "../../../lib/monogram";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { type ConnectionStatus } from "../../../lib/integrationsApi";

/** The "if the system browser didn't pop up, here's the link" fallback.
 *  It used to live at the foot of the pane, under every card — so during
 *  the one moment it matters, a flow you've just started on the first
 *  card, it was below the fold. It belongs beside the spinner. */
export function AuthFallback({ url }: { url: string }) {
  return (
    <div className="text-sm text-text-4 flex items-center gap-2">
      <span>Browser didn't open?</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onExternalAnchorClick}
        className="text-text-2 hover:text-text-1 inline-flex items-center gap-1 hover:underline"
      >
        Open authorize URL <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

/** The red block a card prints when one of its own buttons failed.
 *  Lives inside the card body so it lands next to the control that
 *  raised it rather than at the foot of the pane. */
export function CardError({ msg }: { msg: string }) {
  return (
    <div
      role="alert"
      className="p-2.5 rounded-md border border-red/30 bg-red/5 text-sm text-red whitespace-pre-wrap"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>{msg}</span>
      </div>
    </div>
  );
}

export function upsertStatus(
  prev: ConnectionStatus[],
  next: ConnectionStatus,
): ConnectionStatus[] {
  const idx = prev.findIndex((s) => s.kind === next.kind);
  if (idx === -1) return [...prev, next];
  const out = prev.slice();
  out[idx] = next;
  return out;
}

// TrackerStatusChip lived here: Connected / Not connected / Not set up here,
// drawn on every tracker card. It has no reader left. The list only ever holds
// connections, so a "Connected" chip on every row said the same thing the row
// being there already said; the store only ever holds things you have not
// connected, so "Not connected" was the heading of the page repeated once per
// item. The third state — this machine has no app for it — survived the move
// and is the one that carried information: it is now SetupNeeded, below.

/** What to show instead of a Connect button when this machine has no
 *  credentials for the provider.
 *
 *  Aura signs in through an OAuth app *you* own — there's no Aura-hosted
 *  client — so on a machine whose `integrations.toml` has no block for
 *  the provider, pressing Connect can only ever fail. It used to do
 *  exactly that: open nothing, then print `integration not configured:
 *  missing [jira] block …` in a banner far below. Same information,
 *  delivered as a failure the user had to trigger. Now the card says it
 *  up front and doesn't offer the button. */
export function SetupNeeded({
  what,
  where,
  block,
}: {
  what: string;
  where: string;
  block: string;
}) {
  return (
    <p className="text-text-4 text-sm">
      No {what} app is set up on this machine — that file has no{" "}
      <code className="rounded bg-bg-2/60 px-1 py-px text-text-3">
        [{block}]
      </code>{" "}
      section Aura can read, so there's nothing to sign in to. Create a{" "}
      {what} app in {where}, put its id and secret there, and this card will
      offer to connect.
    </p>
  );
}

export function timeAgo(unixSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(unixSecs);
}

// Tiny inline glyph for Beads — three dots on a thread, evoking beads on a
// string. Kept inline to avoid shipping an asset.
export function BeadsGlyph() {
  return (
    <div className="w-7 h-7 rounded-md bg-amber/10 grid place-items-center text-amber">
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden>
        <path
          d="M3 12h18"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
        />
        <circle cx="6" cy="12" r="2.4" />
        <circle cx="12" cy="12" r="2.4" />
        <circle cx="18" cy="12" r="2.4" />
      </svg>
    </div>
  );
}

// Tiny Jira-blue triangle glyph — kept inline so we don't need to
// ship Atlassian SVG assets (and to dodge trademark friction for OSS).
export function JiraGlyph() {
  return (
    <div className="w-7 h-7 rounded-md bg-[#2684FF]/10 grid place-items-center text-[#2684FF]">
      <svg
        viewBox="0 0 24 24"
        className="w-4 h-4"
        fill="currentColor"
        aria-hidden
      >
        <path d="M11.53 2L5.06 8.47a2 2 0 0 0 0 2.83l6.47 6.47a.5.5 0 0 0 .71 0L18.71 11.3a2 2 0 0 0 0-2.83L12.24 2a.5.5 0 0 0-.71 0Zm.36 9.18a3.18 3.18 0 0 1 3.18 3.18V18a3.18 3.18 0 1 1-6.36 0v-3.64a3.18 3.18 0 0 1 3.18-3.18Z" />
      </svg>
    </div>
  );
}

// Tiny Linear glyph — the signature three-bar mark in Linear's purple.
// Kept inline (no shipped asset) to match the Jira/Beads glyphs.
export function LinearGlyph() {
  return (
    <div className="w-7 h-7 rounded-md bg-[#5e6ad2]/12 grid place-items-center text-[#5e6ad2]">
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden>
        <rect x="3" y="5" width="18" height="2.6" rx="1.3" />
        <rect x="6" y="10.7" width="15" height="2.6" rx="1.3" />
        <rect x="9" y="16.4" width="12" height="2.6" rx="1.3" />
      </svg>
    </div>
  );
}

export function initials(name: string): string {
  // One monogram for the whole app — see lib/monogram. This one returned an empty string
  // for a blank name, so the avatar drew a ring with nothing inside it.
  return monogram(name);
}

export function formatExpiry(expiresAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = expiresAt - now;
  if (delta < 60) return "under a minute";
  if (delta < 3600) return `${Math.round(delta / 60)} min`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h`;
  return `${Math.round(delta / 86400)} d`;
}
