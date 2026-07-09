/** Team (chat) bounded context — presentation icon kernel.
 *
 *  The small hand-rolled inline SVG glyphs the chat surface draws: search,
 *  add, send, bell, pin, members, refresh, expand-to-pane, plus the two
 *  rail glyphs (the Aura brand mark for the #aura hero channel and the
 *  padlock for private channels). Shared by the conversation list, the
 *  conversation view header, and the composer so a glyph reads identically
 *  wherever it appears. Lifted verbatim from the CommsPanel monolith —
 *  currentColor-driven so each call site colours them with text tokens. */

import { AuraMark } from "../../AuraMark";

export function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <line x1="10" y1="10" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.4" />
      <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line
        x1="8" y1="3" x2="8" y2="13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M4 7l4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 11h9l-1-1.5V7a3.5 3.5 0 00-7 0v2.5L3.5 11z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <path
        d="M6.5 12.5a1.5 1.5 0 003 0"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

export function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M9 2l5 5-3 1-2 4-4-4 4-2 1-3z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="none"
      />
      <line x1="5" y1="11" x2="2" y2="14" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function MembersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path
        d="M2.5 13c.5-2 1.8-3.2 3.5-3.2S9 11 9.5 13"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <circle cx="11.5" cy="5.5" r="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path
        d="M10 9.2c1.5 0 2.7 1 3 2.8"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M9 5h3V2M7 11H4v3" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

// "Open in main pane" — a panel with an arrow pointing into the wider
// area, signalling the chat moves out of the narrow sidebar.
export function ExpandToPaneIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9 6l2 2-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Aura brand mark — the blossom logo used in the app topbar. Rendered in
// the accent color for the pinned #aura home channel so it reads as the
// hero/home row rather than a generic "#" channel.
export function AuraMarkIcon() {
  return <AuraMark size={13} style={{ color: "var(--color-accent)" }} />;
}

// Small padlock shown in place of the `#` for private (membership-gated)
// channels.
export function RailLockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
