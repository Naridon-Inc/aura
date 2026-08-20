// The mark a tab wears, for every destination that has one elsewhere in the
// app.
//
// The rule this file exists to keep: a tab wears the same mark as the sidebar
// row that opened it. Two things broke that. The default strip drew ONE bare
// shield for all six trace tools, so Memory, Time machine, Project health,
// Genuine record, Impacts on me and Safety check were six pages behind six
// identical icons — an icon carrying no information at all. And the split-view
// strip drew nothing for any of them, so the same tab had a mark in one layout
// and none in the other.
//
// Every glyph here is the concept its AdeSidebar row draws, redrawn on the tab
// strip's 16-grid at ~1.2px rather than the sidebar's 24-grid at 2px. It is
// deliberately NOT `Icons.tsx`: that set is an older port from aura-term whose
// Memory is a list-card, whose Impacts is a warning triangle and whose Timeline
// is a clock — none of which are what the rail draws today. Unifying the two
// sets is its own job; until then the rail wins, because the rail is what the
// user clicked.

import type { ReactNode } from "react";
import type { TraceToolKind, WorkPaneRef } from "../lib/editorStore";
import { sessionsViewFromId } from "../lib/editorStore";
import * as Icons from "./Icons";

/** Children for a `<svg viewBox="0 0 16 16" fill="none">` wrapper. */
export const TRACE_TOOL_GLYPH: Record<TraceToolKind, ReactNode> = {
  // Safety check — a shield with a check: a second set of eyes on the changes.
  review: (
    <>
      <path
        d="M8 1.5l5 2v3.2c0 3-2.1 5.6-5 6.8-2.9-1.2-5-3.8-5-6.8V3.5l5-2z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="m5.9 7.5 1.5 1.5 2.7-2.9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // Time machine — an arrow curling back around the clock face.
  rewind: (
    <>
      <path
        d="M2 8a6 6 0 1 0 2-4.5L2 5.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M2 2v3.3h3.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // Genuine record — a seal: a certified stamp with ribbon tails. NOT another
  // shield; "this record is authentic" and "someone checked your changes for
  // problems" are two different promises and need two different marks.
  attest: (
    <>
      <circle cx="8" cy="6.3" r="4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="m6.2 6.3 1.3 1.3 2.3-2.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.7 9.7 4.7 14.7 8 13.1l3.3 1.6-1-5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </>
  ),
  // Memory — a store: stacked bands, the shape every database wears.
  memory: (
    <>
      <ellipse cx="8" cy="4" rx="5.3" ry="2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2.7 4v8c0 1.1 2.4 2 5.3 2s5.3-.9 5.3-2V4M2.7 8c0 1.1 2.4 2 5.3 2s5.3-.9 5.3-2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </>
  ),
  // Impacts on me — a horizontal fork: one node splitting rightward into two
  // diverged branch nodes, i.e. "a change on another branch reaches yours".
  impacts: (
    <>
      <circle cx="3.3" cy="8" r="1.3" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12.7" cy="4" r="1.3" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12.7" cy="12" r="1.3" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.7 8H8M8 8c1.7 0 1.7-4 3.3-4M8 8c1.7 0 1.7 4 3.3 4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </>
  ),
  // Project health — a stethoscope: a check-up on the project itself.
  doctor: (
    <>
      <path d="M3.3 2v4a3.3 3.3 0 0 0 6.7 0V2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.3 2H2M10 2h1.3M6.7 9.3v2a2.7 2.7 0 0 0 5.3 0v-.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="8.7" r="1.3" stroke="currentColor" strokeWidth="1.2" />
    </>
  ),
};

// The four Sessions views, each its own openable tab — so each needs its own
// mark, for the same reason the trace tools do.
const SESSIONS_GLYPH = {
  // Overview — a gauge with its needle: the at-a-glance dial.
  overview: (
    <>
      <path d="M3.3 12a6 6 0 1 1 9.3 0" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 9.7 10.7 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="9.7" r="0.9" fill="currentColor" />
    </>
  ),
  // My sessions — stacked run rows, each with its own lead dot.
  sessions: (
    <>
      <rect x="2" y="2.7" width="12" height="3.3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="8.7" width="12" height="3.3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.7" cy="4.3" r="0.6" fill="currentColor" />
      <circle cx="4.7" cy="10.3" r="0.6" fill="currentColor" />
    </>
  ),
  // Team activity — two figures: what everyone's AI is doing to our project.
  team: (
    <>
      <circle cx="6" cy="5.3" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.3 12.7a3.7 3.7 0 0 1 7.3 0" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.7 3a2 2 0 0 1 0 3.9M12.3 12.7a3.7 3.7 0 0 0-2-3.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </>
  ),
  // Cost & usage — a banknote: what this is costing in tokens and dollars.
  usage: (
    <>
      <rect x="1.7" y="4" width="12.7" height="8" rx="1.3" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 6.3v3.4M12 6.3v3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
} as const;

// Goals — concentric rings around a centre: the thing you aimed at.
const GLYPH_GOAL = (
  <>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="8" r="3.3" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" />
  </>
);

// Change story — intent and code, each arrow pointing at the other.
const GLYPH_CHANGE_STORY = (
  <>
    <path
      d="M3.3 6a2.7 2.7 0 0 0 2.7 2.7h4M12.7 10a2.7 2.7 0 0 1-2.7-2.7H6"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path
      d="m10.7 4 2 2-2 2M5.3 12l-2-2 2-2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
);

// Proof trail — sealed points along one line, with the cut between them.
const GLYPH_PROOF_TRAIL = (
  <>
    <path d="M3 8h10" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="3" cy="8" r="1.6" fill="currentColor" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    <circle cx="13" cy="8" r="1.6" fill="currentColor" />
    <path d="M5.5 4v8" stroke="currentColor" strokeWidth="0.9" strokeDasharray="1.5 1.5" />
  </>
);

// Code Map — three linked nodes: what touches what.
const GLYPH_CODE_MAP = (
  <>
    <circle cx="4" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="12" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="6" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5.3 5 10.3 6M5.3 5.3 5.5 10.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </>
);

// Browser — a globe: this pane holds the open web, not the project.
const GLYPH_BROWSER = (
  <>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
    <path d="M2 8h12" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14C6.2 12.3 5.3 10.3 5.3 8S6.2 3.7 8 2Z" stroke="currentColor" strokeWidth="1.2" />
  </>
);

// Screen share — a display with a stand.
const GLYPH_SCREENSHARE = (
  <>
    <rect x="2" y="3" width="12" height="8" rx="1.3" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 13.5h4M8 11v2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </>
);

/** Wraps a glyph's paths so every caller gets a finished element back — the
 *  fragments above are all authored against the same 16-grid. */
function Svg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className="flex-shrink-0"
    >
      {children}
    </svg>
  );
}

/** The mark for one trace tool. */
export function traceToolGlyph(kind: TraceToolKind, size = 12): ReactNode {
  return <Svg size={size}>{TRACE_TOOL_GLYPH[kind]}</Svg>;
}

/** The mark for a tab, or null when the destination genuinely has none.
 *
 *  Agent-backed tabs (agent / manager / plan) are excluded on purpose — they
 *  wear the running agent's own icon, which only the caller can resolve; so
 *  are file, terminal, pages and tasks, which already resolve their own. */
export function tabGlyph(ref: WorkPaneRef, size = 11): ReactNode {
  switch (ref.kind) {
    case "trace":
      return <Svg size={size}>{TRACE_TOOL_GLYPH[ref.tool]}</Svg>;
    case "sessions":
      return <Svg size={size}>{SESSIONS_GLYPH[sessionsViewFromId(ref.id)]}</Svg>;
    case "prove":
      return <Svg size={size}>{GLYPH_GOAL}</Svg>;
    case "inspector":
      return <Svg size={size}>{GLYPH_CHANGE_STORY}</Svg>;
    case "replay":
      return <Svg size={size}>{GLYPH_PROOF_TRAIL}</Svg>;
    case "graph":
      return <Svg size={size}>{GLYPH_CODE_MAP}</Svg>;
    case "browser":
      return <Svg size={size}>{GLYPH_BROWSER}</Svg>;
    case "screenshare":
      return <Svg size={size}>{GLYPH_SCREENSHARE}</Svg>;
    // These already own a mark in the shared set; reuse it rather than
    // drawing a second one that means the same thing.
    case "task":
      return <Icons.Tasks size={size} className="flex-shrink-0" />;
    case "channels":
      return <Icons.Users size={size} className="flex-shrink-0" />;
    case "automations":
      return <Icons.Workflow size={size} className="flex-shrink-0" />;
    default:
      return null;
  }
}
