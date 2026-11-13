// The small parts every tracker row is built from: the two notices a row
// prints (the browser-didn't-open link, and its own error), the "this machine
// has no app for that" explainer, and the marks.

import { ExternalLink } from "lucide-react";

import { SettingsError } from "../../ui/settings-blocks";
import { SettingsServiceMark } from "../../ui/settings-services-row";
import { onExternalAnchorClick } from "../../../lib/openExternal";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { type ConnectionStatus } from "../../../lib/integrationsApi";

/** The "if the system browser didn't pop up, here's the link" fallback.
 *  It used to live at the foot of the pane, under every card — so during
 *  the one moment it matters, a flow you've just started, it was below the
 *  fold. It belongs beside the spinner, under the row that started it. */
export function AuthFallback({ url }: { url: string }) {
  return (
    <p>
      Browser didn't open?{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onExternalAnchorClick}
      >
        Open the sign-in page <ExternalLink />
      </a>
    </p>
  );
}

/** What a row prints when one of its own buttons failed. It sits under the
 *  row that raised it rather than at the foot of the page. */
export function CardError({ msg }: { msg: string }) {
  return <SettingsError>{msg}</SettingsError>;
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

/** What to show instead of a Connect button when this machine has no
 *  credentials for the provider.
 *
 *  Aura signs in through an OAuth app *you* own — there's no Aura-hosted
 *  client — so on a machine whose `integrations.toml` has no block for
 *  the provider, pressing Connect can only ever fail. It used to do
 *  exactly that: open nothing, then print `integration not configured:
 *  missing [jira] block …` in a banner far below. Same information,
 *  delivered as a failure the user had to trigger. Now the row says it
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
    <p>
      No {what} app is set up on this machine: <code>~/.aura/integrations.toml</code> has no{" "}
      <code>[{block}]</code> section, so there's nothing to sign in to. Create a {what} app in{" "}
      {where}, put its id and secret there, and this row will offer to connect.
    </p>
  );
}

export function timeAgo(unixSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(unixSecs);
}

// Beads — three dots on a thread, beads on a string. Drawn here because no
// bundled asset exists for it.
export function BeadsGlyph() {
  return (
    <SettingsServiceMark style={{ color: "var(--ui-terminal-yellow)" }}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 12h18" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <circle cx="6" cy="12" r="2.4" />
        <circle cx="12" cy="12" r="2.4" />
        <circle cx="18" cy="12" r="2.4" />
      </svg>
    </SettingsServiceMark>
  );
}

// Jira's blue triangle, drawn inline so we don't ship Atlassian's SVG
// assets (and dodge trademark friction for the open-source build).
export function JiraGlyph() {
  return (
    <SettingsServiceMark style={{ color: "#2684FF" }}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M11.53 2L5.06 8.47a2 2 0 0 0 0 2.83l6.47 6.47a.5.5 0 0 0 .71 0L18.71 11.3a2 2 0 0 0 0-2.83L12.24 2a.5.5 0 0 0-.71 0Zm.36 9.18a3.18 3.18 0 0 1 3.18 3.18V18a3.18 3.18 0 1 1-6.36 0v-3.64a3.18 3.18 0 0 1 3.18-3.18Z" />
      </svg>
    </SettingsServiceMark>
  );
}

// Linear's three-bar mark in its purple, inline like the Jira and Beads marks.
export function LinearGlyph() {
  return (
    <SettingsServiceMark style={{ color: "#5e6ad2" }}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <rect x="3" y="5" width="18" height="2.6" rx="1.3" />
        <rect x="6" y="10.7" width="15" height="2.6" rx="1.3" />
        <rect x="9" y="16.4" width="12" height="2.6" rx="1.3" />
      </svg>
    </SettingsServiceMark>
  );
}

export function formatExpiry(expiresAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = expiresAt - now;
  if (delta < 60) return "under a minute";
  if (delta < 3600) return `${Math.round(delta / 60)} min`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h`;
  return `${Math.round(delta / 86400)} d`;
}
