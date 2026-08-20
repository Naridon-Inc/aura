// ADE redesign (W1) — Build-section roster.
//
// The mockup folds the old 56px workspace rail into the Build section as
// a list: one group per open project (collapsible, closable), each
// listing its git worktrees as rows. Every row carries a status avatar —
// the agent's brand mark (who is driving that worktree) or a git-branch
// glyph when none, with a small status dot in the corner (no boxy frame).
// Status is read live from `editor.agentTabs`, not invented:
//
//   • agent tab present, waiting on user  → "attn"  (needs input)
//   • agent tab present, otherwise         → "run"   (running)
//   • no agent tab for the worktree path   → "idle"
//
// Only the active worktree + any with a live agent stay on top; every
// other worktree (idle feature checkouts and machine `worktree-agent-…`
// scratch alike) sinks into a per-project "inactive" disclosure.
//
// Per-worktree diff + PR badges (the mockup's "+207 −1  #816") come from
// `useWorktreeBadges` upstream and arrive via `badgeByPath`, keyed by the
// worktree's own path. Real data only — a row with no diff and no PR
// simply renders no badge.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as Icons from "./Icons";
import { useMinuteTick } from "../lib/useMinuteTick";
import { relativeAgeFromSecs } from "../lib/relativeTime";
import { letterMark } from "../lib/monogram";
import { ProjectMark, RepoAvatar } from "./RepoAvatar";
import { WorktreeHoverCard } from "./WorktreeHoverCard";
import { WorktreeHover } from "./WorktreeHover";
import { CloudGlyph } from "./ui/cloud-glyph";
import { labelForAgentId } from "../lib/useLiveAgentSessions";
import { openRemoteWorkspace, useEditorStore } from "../lib/editorStore";
import { useCloudJobs, type CloudJobWithRoot } from "../lib/useCloudJobs";
import {
  cloudStatusLine,
  groupCloudThreads,
  isCloudThreadLive,
  railCloudThreads,
  type CloudThread,
} from "../lib/cloudJobs";
import { agentsOnCopy } from "../lib/agentsOnCopy";
import { beginClubPick, isPickedPlace, toggleClubPick } from "../lib/clubGesture";
import { useClubPick } from "../lib/useClubGesture";
import {
  localPlace,
  remotePlace,
  remotePlaceOf,
  type PlaceRef,
  type RemotePlaceRef,
} from "../lib/placeRef";
import { PickMark } from "./places/ClubRail";
import { useLivePtySessionIds } from "../lib/useLiveAgentSessions";
import {
  humanizeCopyTitle,
  humanizeWorkspaceName,
} from "../lib/workspaceLabel";
import { api, type Machine } from "../lib/api";
import { onOrgChanged } from "../lib/cloudOrgs";
import { useActiveMachine, useEnteredMachines } from "../lib/activeMachine";
import {
  filePlaces,
  isAsleep,
  placeRowLabel,
  placesOfMachines,
  sleepBadge,
  sleepTooltip,
  type Place,
} from "../lib/place";
import { openPopout } from "../lib/popout";
import {
  useWorkspaceCustomization,
  setWorkspacePinned,
  setWorkspaceArchived,
  setWorkspaceEmoji,
  setWorkspaceName,
} from "../lib/workspaceCustomization";
import type { WorktreeBadge } from "../lib/useWorktreeBadges";
import { useWorkingRoots } from "../lib/useFleetActivity";
import { AsciiSpinner } from "./ui/ascii-spinner";
import type { Workspace, WorktreeRef } from "../lib/workspaceRef";
import { useDismiss } from "../lib/useDismiss";

// One agent attached to a worktree, normalised across the two sources the
// lane unions: live tabs (the focused workspace, carry `attention`) and
// the persisted per-repo roster (backgrounded workspaces).
type LaneAgent = {
  sessionId: string;
  agentId: string;
  agentLabel: string;
  attention: boolean;
};

// Cursor-positioned context menu, opened by right-click or the row's ⋯
// button. A project header offers open/copy/close; a worktree row offers
// open/copy/remove (remove disabled for the main + active checkouts).
type RosterMenu =
  | { kind: "project"; wsId: string; projName: string; x: number; y: number }
  | {
      kind: "worktree";
      root: string;
      path: string;
      title: string;
      canRemove: boolean;
      /** Why Remove is greyed, in the user's terms, INCLUDING what to do
       *  about it. Two different reasons blocked this and the menu used to
       *  print both at once ("The main and active copies can't be removed"),
       *  which reads as a rule about copies in general rather than a fact
       *  about the row you right-clicked. `null` when Remove is available. */
      removeBlockedWhy: string | null;
      /** This copy's ⌘-hold quick-switch number (⌘1–⌘9), when it has one —
       *  a real, wired shortcut we surface on the Open row. */
      switchNo: number | null;
      x: number;
      y: number;
    }
  /** A place that isn't on this laptop — a machine, or a cloud conversation
   *  that hasn't resolved one yet. It gets the same menu a local copy gets,
   *  because it is the same kind of thing: somewhere you can go, and somewhere
   *  you can open in a window of its own. Without this the row had no menu at
   *  all, so "open in its own window" was a move you could make on a checkout
   *  and not on a machine. */
  | {
      kind: "place";
      place: RemotePlaceRef;
      title: string;
      /** What the row is, under its name — the box's address, or what the
       *  conversation is doing. The menu's head line says it so the menu
       *  identifies the row you opened it from. */
      subtitle: string;
      /** "Go to this machine" reads wrong on a conversation you haven't
       *  resolved a box for yet, so each row brings its own word for it. */
      openLabel: string;
      x: number;
      y: number;
    };

// ── One stroke weight for every line glyph below ─────────────────────────
// These marks sit side by side in the same list and the same menus, so any
// difference in ink reads as one of them being wrong rather than as variety:
// the roster used to mix 1.2 / 1.3 / 1.4 / 1.6 / 1.9 and the heavier marks
// made the lighter ones look wiry. They are now normalised to ONE optical
// stroke — ~1.14px at the size each actually renders.
//
// That is an optical target, not a literal `strokeWidth`. Nominal weight has
// to be divided by the glyph's own (render px ÷ viewBox), so:
//
//   16-viewBox at 13px → 1.4   (1.4 × 13/16 = 1.14)   menu + header glyphs
//   24-viewBox at 13px → 2.1   (2.1 × 13/24 = 1.14)   GearIcon
//   16-viewBox at 15px → 1.2   (1.2 × 15/16 = 1.13)   the two branch marks
//
// So if you ever change a glyph's render size, its nominal weight has to move
// with it or it stops matching its neighbours.

// 16×16 three-dot "more" glyph — the menu trigger on rows + headers.
function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

// Overlapping-sheets copy glyph for the "Copy path" menu item.
// Pencil glyph for "Rename" — a workspace's name is yours to set, so the item
// sits with the other identity actions rather than under a settings pane.
function RenameIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.2 2.3a1.4 1.4 0 0 1 2 2L6 11.5l-2.6.8.8-2.6 7-7.4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M10 3.6l2.4 2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Trash glyph for the destructive "Remove worktree…" item.
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5h10M6.5 4.5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5.5 4.5l.4 8a1 1 0 0 0 1 .95h2.2a1 1 0 0 0 1-.95l.4-8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A window with an out-arrow — "Open in new window" (detach this copy into
// its own OS window).
function ExternalWindowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13 8.5v3a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 3h3v3M13 3l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A pushpin — "Pin to top" / "Unpin". `filled` reads as the pinned state.
function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 2h4l-.6 2.4 2.1 2.1-2.3.6-1.7 1.7V7l-2-2h1.5l2.1-.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill={filled ? "currentColor" : "none"}
      />
      <path d="M7 9l-2.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// A curved arrow out of a box — "Restore" (bring an archived project back).
function RestoreIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3.5A4.5 4.5 0 1 1 3.5 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M3.5 5v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A branch with a leading +, for "Create from…" (branch a new copy off a
// chosen base ref).
function CreateFromIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4.5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.6v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11 9.5v-.5a2 2 0 0 0-2-2H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 10.5v3M9.5 12h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Two panes — "Put side by side…" (start a club from this row). The same mark
// the "Side by side" rail group wears above the roster, so the menu item and
// the group it fills are visibly one feature.
function SideBySideMenuIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.7" y="3" width="5.6" height="10" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.7" y="3" width="5.6" height="10" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// A cog — "Repository settings". The one 24-viewBox glyph here, so its nominal
// weight has to be proportionally larger than the 16-viewBox glyphs' 1.4 to
// land on the same optical stroke: 2.1 × 13/24 = 1.14, the same ink as
// 1.4 × 13/16. Matching the number rather than the arithmetic would have left
// it visibly lighter than everything beside it.
function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

// A framed picture with a sun — "Change icon" (pick the project's emoji glyph).
function ChangeIconGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6.5" r="1.1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 11l3-2.5 2.5 2 2-1.5L13 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A struck-through eye — "Hide repository" (drop from the list, keep on disk).
function EyeOffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 8s2-3.5 5.5-3.5c1 0 1.9.3 2.7.7M13.5 8s-2 3.5-5.5 3.5c-1 0-1.9-.3-2.6-.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// First user-perceived character of a string. An emoji is often several code
// points (skin-tone modifiers, ZWJ family sequences, flags), so we segment by
// grapheme rather than take `str[0]`. Used to keep exactly the one glyph the OS
// emoji picker inserted, dropping any stray trailing input.
function firstGrapheme(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  // Intl.Segmenter isn't in this project's TS lib target — reach it through a
  // narrow typed shim (it's present in the app's WebKit runtime).
  const SegmenterCtor = (
    Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity?: "grapheme" | "word" | "sentence" },
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (SegmenterCtor) {
    try {
      const seg = new SegmenterCtor(undefined, { granularity: "grapheme" });
      const first = seg.segment(trimmed)[Symbol.iterator]().next();
      if (!first.done) return first.value.segment;
    } catch {
      /* fall through to the code-point split */
    }
  }
  return Array.from(trimmed)[0] ?? "";
}

// The PR's row treatment, straight off the badge state (never inferred): an
// OPEN ref keeps its live "#816" number to jump to; a MERGED ref reads the
// plain-language word "Merged"; a CLOSED ref reads "Closed". Only the OPEN
// pill keeps colour — it is the one that can still want something from you.
// "Ready to merge" / "Merge conflicts" are deliberately absent — mergeability
// isn't derivable from the data we hold, so we never fabricate it.
function prPillLabel(state: string, number: number): string {
  const s = state.toLowerCase();
  if (s === "merged") return "Merged";
  if (s === "closed") return "Closed";
  return `#${number}`;
}

type WorkspaceRosterProps = {
  workspaces: Workspace[];
  /** Current project.root — the row whose path matches lights active. */
  activePath: string;
  /** Diff + PR badges keyed by worktree path (from useWorktreeBadges). */
  badgeByPath?: Record<string, WorktreeBadge>;
  onSelectProject?: (id: string) => void;
  onOpenWorktree?: (path: string) => void;
  /** Close (remove) a project/workspace from the roster list. Omit to
   *  hide the per-project close affordance. */
  onCloseProject?: (id: string) => void;
  /** Permanently remove a single git worktree checkout from disk. Passed
   *  (project root, worktree path). Omit to hide the per-row trash button.
   *  Never offered for the main worktree or the active row. */
  onRemoveWorktree?: (root: string, path: string) => void;
  /** Open the full Workspaces view (the "cool view" for the whole fleet).
   *  When given, the project's copy-count chip opens it — scoped to that
   *  project — instead of cramming the idle rows into the rail, keeping the
   *  sidebar curated. Omit to keep the legacy in-place expansion. */
  onOpenAllCopies?: (projectId?: string) => void;
  /** Add a project to the roster (open a folder). Wired to the "Projects"
   *  section header's + control. Omit to hide it. */
  onAddProject?: () => void;
};

// How the "Projects" list is ordered, driven by the section-header sort
// control and persisted so the choice survives reloads.
type RosterSort = "recent" | "name" | "activity";

// The two leading marks are told apart by SILHOUETTE, not by which node is
// filled: the main checkout wears git's own diamond, an Aura copy wears a bare
// peel-off curve. They used to share one fork skeleton and differ only in
// which dot was solid, which is far too fine a distinction at 15px — the pair
// just read as "some circles" (exactly the complaint that prompted this).
//
// What still binds them into one family is the ink, not the outline: identical
// stroke weight and identical FILLED nodes. Filled is the whole point. A
// stroked r=1.9 ring is mostly hole, so the old marks read wiry no matter how
// heavy the stroke got — they were the heaviest glyphs in this file at 1.6 and
// still looked thin. A solid dot reads solid at any size, which is what lets
// the stroke come DOWN to match everything around it.

// Main-checkout mark — git's own logo: the rotated square with the branch fork
// inside it. The diamond is the part people actually recognise as "git", and
// it is what carries the meaning at 15px, where the fork inside is little more
// than a suggestion until you hit a Retina pixel ratio.
//
// Drawn for this size rather than scaled down from the 24-box original, which
// would silt up: the diamond is inset half a stroke so its corners land inside
// the viewBox instead of shaving flat against it, and the three nodes are
// placed ~0.7 units clear of the outline on every side so the counters stay
// open. The nodes are equidistant from the edge by construction — move one and
// you have to re-check the other two.
function MainBranchGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      className="wsa-glyph main"
      aria-hidden
    >
      <path d="M8 1.15 14.85 8 8 14.85 1.15 8Z" strokeLinejoin="round" />
      {/* Trunk, plus the branch peeling off the top node at a true 45° — the
          arrangement inside the real mark, not a re-invention of it. */}
      <path d="M7.9 5.05v5.8M7.9 5.05l2.9 2.9" strokeLinecap="round" />
      {/* Explicitly unstroked: the root `stroke` would otherwise inflate each
          dot by half a weight and close the gap to the diamond. */}
      <circle cx="7.9" cy="5.05" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="7.9" cy="10.85" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="10.8" cy="7.95" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Worktree mark — an Aura-made parallel copy: one node curving up and off to a
// second, a single sweep that reads as "a checkout peeled off the line." No
// enclosing diamond, because a copy is a piece of the line rather than the
// canonical mark. Git-family, never a clipboard/copy metaphor; the glyph says
// *what kind of place* the copy is.
//
// The sweep spans ~10.8 of the 16 box rather than the diamond's full width: a
// rotated square only covers half its own bounding box, so matching bounding
// boxes would have left this mark looking the larger of the two. 10.8 is where
// the pair balances by eye at 15px.
function WorktreeGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      className="wsa-glyph copy"
      aria-hidden
    >
      {/* Runs node-centre to node-centre — the filled dots cover its ends, so
          the curve needs no cap trimming to sit flush inside them. */}
      <path d="M4.2 12.4C4.2 6.4 6.6 4.6 11.8 4.6" strokeLinecap="round" />
      <circle cx="4.2" cy="12.4" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="11.8" cy="4.6" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Funnel glyph for the Projects-header sort control.
function SortGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M4.5 8h7M6.5 12h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Double-chevron glyph for the Projects-header collapse/expand-all control.
// Points up (fold in) when anything is open, down (unfold) when all folded.
function CollapseAllGlyph({ folded }: { folded: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      {/* Drawn 4→12 rather than 5→11. At six units wide in a sixteen-unit box
          this chevron carried less than half the ink of the sort glyph beside
          it, so the three controls read as three different sizes and the last
          one looked padded away from the edge. */}
      <path
        d={folded ? "M4 4.5l4 3.5 4-3.5M4 9l4 3.5 4-3.5" : "M4 8l4-3.5 4 3.5M4 12.5l4-3.5 4 3.5"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Order the project list for the given sort. "recent" keeps the incoming
// (recently-opened) order; "name" is A–Z on the folder name; "activity"
// floats the project whose newest copy committed most recently to the top,
// reading each worktree's real HEAD commit time (0 when unknown).
function sortWorkspaces(list: Workspace[], sort: RosterSort): Workspace[] {
  if (sort === "recent") return list;
  const name = (ws: Workspace) => (ws.id.split("/").pop() || ws.id).toLowerCase();
  const activity = (ws: Workspace) =>
    (ws.worktrees ?? []).reduce(
      (max, w) => Math.max(max, w.head_committed_at ?? 0),
      0,
    );
  const next = [...list];
  if (sort === "name") next.sort((a, b) => name(a).localeCompare(name(b)));
  else next.sort((a, b) => activity(b) - activity(a));
  return next;
}

// A worktree counts as "recently active" — and so stays in the primary
// group rather than sinking into the inactive disclosure — for an hour
// after it was last opened. Without this, switching to worktree B would
// immediately hide worktree A even though you were just there.
const RECENT_MS = 60 * 60 * 1000;

// The live-agent face pile (LiveAgentLane / AgentChip / AgentChipCard) was
// removed from the roster: showing which agent is driving each worktree
// cluttered the sidebar. Worktree rows now read as plain git checkouts
// (branch + diff badges); who's-on-it lives in the tab strip + Crew. The
// `agentsForPath` read below stays — a *live* agent still keeps its worktree
// surfaced in the ranking, it just no longer paints a mark.

export function WorkspaceRoster({
  workspaces,
  activePath,
  badgeByPath,
  onSelectProject,
  onOpenWorktree,
  onCloseProject,
  onRemoveWorktree,
  onOpenAllCopies,
  onAddProject,
}: WorkspaceRosterProps) {
  const editor = useEditorStore();
  // Per-project pin + archive flags (device-local UI state). Subscribing here
  // re-renders the roster the moment a project is pinned/archived/restored.
  const custom = useWorkspaceCustomization();
  // Which worktree roots have an agent working right now — so each row's
  // worktree icon can BECOME the loader while that copy is busy, instead of
  // the signal only living in the fleet-wide sidebar pulse.
  const workingRoots = useWorkingRoots();
  // A side-by-side pick, in progress (lib/clubGesture). While one is up every
  // place row in this list is a checkbox rather than a door: the gesture that
  // makes a club is "click two rows", and a row that behaved differently
  // depending on which list it sits in would make that "click two rows, unless
  // one of them is a machine" — which is exactly how a feature ends up landing
  // in one place-mode only.
  const { picking } = useClubPick();
  /** What a place row does when it is clicked, while a pick is up. Every row
   *  type below goes through this, so all three answer the gesture the same
   *  way and none of them can quietly opt out of it. */
  const pickRow = (ref: PlaceRef) => {
    const picked = picking && isPickedPlace(ref);
    return {
      picked,
      pickTitle: picked
        ? "Picked for side by side. Click to drop it"
        : "Pick this for side by side",
      toggle: () => toggleClubPick(ref),
    };
  };
  // One clock for every age printed below, refreshed once a minute. Read here
  // rather than inside each row so the whole list agrees about what time it is
  // — two rows reading `Date.now()` a millisecond apart can land on opposite
  // sides of a boundary and print "1m" beside "now" for the same commit.
  const now = useMinuteTick();

  // ── Machines, and the work sent to them ────────────────────────────────────
  //
  // Every project row below is drawn from the disk: a worktree, a branch, a
  // checkout. A machine has none of those — it is somewhere else — so the
  // roster, which answers "what is going on" by reading the filesystem, could
  // not see one at all. That produced two separate wrongs. Sending work to the
  // cloud left the rail exactly as it was, which is how "it didn't open
  // anything" happens; and *entering* a machine changed every shell in the
  // window while the sidebar carried on showing local checkouts with nothing
  // lit, so the one fact that mattered — you are not on this laptop — was the
  // one fact the rail refused to say.
  //
  // A cloud box is nonetheless a copy of a PROJECT, so it belongs with that
  // project's other copies — one list per project, local and remote together,
  // the cloud glyph and the machine's address the only things that mark the
  // difference. Filing machines in a group of their own put the remote copy of
  // a project further from it than an idle local branch.
  //
  // Jobs are read per project rather than account-wide: the account-wide list
  // is one request but carries no local root, and a row that can't name its
  // project can't say which one it is for.
  const { jobs: cloudJobs } = useCloudJobs(workspaces.map((ws) => ws.id));

  // Which machine (and which cloud conversation) this window is standing in,
  // published by the remote workspace itself — the only place that resolves it.
  const { machineId: activeMachineId, threadKey: activeThreadKey } =
    useActiveMachine();
  // …and every machine it is holding open, focused or not. A window can be in
  // several places at once now, so "you are here" (one row, tinted) and "this
  // is also open" (any number, tinted fainter) are two different statements and
  // the rail has to be able to make both. Without the second, a box you left
  // covering a page went dark the moment you stepped off it, and the only way
  // to find out it was still yours was to click it.
  const enteredMachines = useEnteredMachines();
  const heldMachineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of enteredMachines) {
      if (m.machineId && m.machineId !== activeMachineId) ids.add(m.machineId);
    }
    return ids;
  }, [enteredMachines, activeMachineId]);
  const heldThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of enteredMachines) {
      if (m.threadKey && m.threadKey !== activeThreadKey) keys.add(m.threadKey);
    }
    return keys;
  }, [enteredMachines, activeThreadKey]);

  // The machine book. Re-read when the active machine changes, which is also
  // what happens the moment the Connect wizard saves one: the new box becomes
  // the machine you're on, so the rail learns about it without a refresh
  // button or a poll.
  //
  // And when the org changes, because the book is filtered to the org you are
  // acting as: the rail must stop offering a client's boxes the moment you
  // stop being that client.
  const [machines, setMachines] = useState<Machine[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .machinesList()
        .then((ms) => {
          if (alive) setMachines(ms);
        })
        .catch(() => {
          // A machine book that won't read is not worth a row of red in the
          // rail — the group falls back to "connect one", which is still the
          // right next step.
          if (alive) setMachines([]);
        });
    void load();
    const off = onOrgChanged(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, [activeMachineId]);

  // Jobs → conversations → the few each project's list should carry. Capped per
  // project rather than across all of them: the rows live under their own
  // project now, so one busy repo must not crowd another's out.
  const cloudThreadsByRoot = useMemo(() => {
    const byRoot = new Map<string, CloudJobWithRoot[]>();
    for (const job of cloudJobs) {
      // No root means the account-wide read answered; it can't name a project,
      // and guessing one would file work under the wrong repo.
      if (!job.repoRoot) continue;
      const bucket = byRoot.get(job.repoRoot);
      if (bucket) bucket.push(job);
      else byRoot.set(job.repoRoot, [job]);
    }
    const out = new Map<string, CloudThread[]>();
    for (const [root, jobs] of byRoot) {
      out.set(root, railCloudThreads(groupCloudThreads(jobs), now));
    }
    return out;
  }, [cloudJobs, now]);

  // The machine book split across the projects on screen. A box that hasn't
  // named its project — every book written before machines recorded one — is
  // not guessed into someone else's list; it stands on its own at the end,
  // where it is still reachable.
  // Archived projects are deliberately absent from the list, and their rows are
  // never drawn — so they don't count as somewhere a machine can be filed. A box
  // connected for an archived project falls through to `unplaced`, where it is
  // still one click from being opened.
  const knownRoots = useMemo(
    () =>
      new Set(
        workspaces
          .filter((ws) => typeof custom[ws.id]?.archived !== "number")
          .map((ws) => ws.id),
      ),
    [workspaces, custom],
  );
  const { byProject: placesByRoot, unplaced: unplacedPlaces } = useMemo(
    () => filePlaces(placesOfMachines(machines ?? []), knownRoots),
    [machines, knownRoots],
  );

  // Cloud work whose project has no row to sit under — same reason a machine
  // can be unplaced. Dropping it would make cloud the one place the app runs
  // work and never says so.
  const orphanCloudThreads = useMemo(() => {
    const out: CloudThread[] = [];
    for (const [root, threads] of cloudThreadsByRoot) {
      if (!knownRoots.has(root)) out.push(...threads);
    }
    return out;
  }, [cloudThreadsByRoot, knownRoots]);

  // Projects-header sort choice, persisted. Reorders the whole project list
  // (recent / name / activity) without touching any project's own copies.
  const [sort, setSort] = useState<RosterSort>(() => {
    try {
      const v = localStorage.getItem("aura.roster.sort");
      return v === "name" || v === "activity" ? v : "recent";
    } catch {
      return "recent";
    }
  });
  const chooseSort = (s: RosterSort) => {
    setSort(s);
    try {
      localStorage.setItem("aura.roster.sort", s);
    } catch {
      /* ignore quota errors */
    }
    setSortMenu(null);
  };
  // Anchored sort popover (fixed viewport coords), dismissed like the row menu.
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  useDismiss(!!sortMenu, () => setSortMenu(null), [], {
    closeOnWindow: ["resize"],
  });

  // Which PTY sessions are still running, across every project — the only
  // evidence that an agent in a workspace you aren't looking at is real.
  const livePtyIds = useLivePtySessionIds(true);

  // Every agent attached to a worktree path — live tabs from the focused
  // workspace merged with the persisted per-repo roster (D3-II), so the
  // live-agent lane shows agents working in *backgrounded* workspaces too,
  // not just the one in view. A persisted entry only counts while its PTY is
  // still alive; the roster file itself is a tab-restore list and never
  // expires, so unfiltered it kept months-old agents in the lane forever.
  // Same rule as the Workspaces board — see `agentsOnCopy`.
  const agentsForPath = (path: string): LaneAgent[] =>
    agentsOnCopy(path, editor.agentTabs, livePtyIds);

  // Per-project disclosure for the "inactive" worktree group (collapsed
  // by default) and per-project collapse of the whole group. Nothing is
  // removed — the toggles reveal rows in place.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The "Archived" disclosure at the foot of the list, collapsed by default.
  const [showArchived, setShowArchived] = useState(false);

  // Last-opened timestamp per worktree path, persisted so the recency
  // window survives reloads. Stamped whenever the active path changes.
  const [visited, setVisited] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("aura.roster.visited") || "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (!activePath) return;
    setVisited((prev) => {
      const next = { ...prev, [activePath]: Date.now() };
      try {
        localStorage.setItem("aura.roster.visited", JSON.stringify(next));
      } catch {
        /* ignore quota errors */
      }
      return next;
    });
  }, [activePath]);

  // Right-click / ⋯ context menu. Positioned at the cursor (fixed,
  // viewport coords) and dismissed on any outside mousedown, Escape,
  // resize, or window blur. The menu sheet stops mousedown propagation so
  // clicking an item doesn't trip the outside-close before its onClick.
  const [menu, setMenu] = useState<RosterMenu | null>(null);
  const closeMenu = () => setMenu(null);

  // "Change icon" hands off to the operating system's own emoji picker rather
  // than a curated in-app grid. `emojiTargetRef` remembers which project the
  // pick is for across the menu-close + async picker round-trip; the chosen
  // glyph arrives via the hidden capture <input> below (`onEmojiCaptured`).
  const emojiTargetRef = useRef<string | null>(null);
  const emojiCaptureRef = useRef<HTMLInputElement | null>(null);

  // Focus the capture input, then front the system picker so the glyph the
  // user double-clicks is inserted into it. Non-macOS is a no-op on the Rust
  // side; the user's own OS shortcut still lands in the focused input.
  const pickIcon = (wsId: string) => {
    emojiTargetRef.current = wsId;
    closeMenu();
    requestAnimationFrame(() => {
      const el = emojiCaptureRef.current;
      if (el) {
        el.value = "";
        el.focus();
      }
      void api.openSystemEmojiPicker().catch(() => {
        /* picker unavailable — capture input is focused for the OS shortcut */
      });
    });
  };

  // The row being renamed, and the text as typed. Renaming happens IN the row
  // — no dialog — because the thing you're naming is the row, and a modal that
  // covers the list makes you name it from memory. Enter commits, Esc cancels,
  // blur commits (the same contract as the page title in Pages). An empty name
  // clears the override, which puts the branch-derived name back rather than
  // leaving the row blank.
  const [renaming, setRenaming] = useState<{ root: string; value: string } | null>(
    null,
  );

  const commitRename = () => {
    if (!renaming) return;
    setWorkspaceName(renaming.root, renaming.value);
    setRenaming(null);
  };

  // The picker inserted a character into the capture input — persist its first
  // grapheme as the project's icon, then reset the input for the next pick.
  const onEmojiCaptured = (e: React.FormEvent<HTMLInputElement>) => {
    const raw = e.currentTarget.value;
    const target = emojiTargetRef.current;
    e.currentTarget.value = "";
    emojiTargetRef.current = null;
    e.currentTarget.blur();
    if (!raw || !target) return;
    const glyph = firstGrapheme(raw);
    if (glyph) setWorkspaceEmoji(target, glyph);
  };

  useDismiss(!!menu, () => setMenu(null), [], {
    closeOnWindow: ["resize", "blur"],
  });

  // ⌘-hold quick-switch. While Command is held, each visible copy row shows
  // a number over its glyph (1–9, top-to-bottom) and ⌘+that-number jumps to
  // it — flip between checkouts without the mouse. `switchPathsRef` is the
  // ordered list of switchable paths, (re)built during render in the exact
  // order the rows paint, so the number you see is the number that fires.
  const [cmdHeld, setCmdHeld] = useState(false);
  const switchPathsRef = useRef<string[]>([]);
  useEffect(() => {
    const isEditing = () => {
      const el = document.activeElement as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      );
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta") {
        setCmdHeld(true);
        return;
      }
      // ⌘+1..9 → jump to the Nth visible copy. Skipped while a text field is
      // focused so it never steals a composer's own shortcuts.
      if (
        e.metaKey &&
        !e.altKey &&
        !e.ctrlKey &&
        e.key >= "1" &&
        e.key <= "9" &&
        !isEditing()
      ) {
        const path = switchPathsRef.current[Number(e.key) - 1];
        if (path) {
          e.preventDefault();
          onOpenWorktree?.(path);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta") setCmdHeld(false);
    };
    const clear = () => setCmdHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // ⌘-tabbing away / losing focus would otherwise leave the numbers stuck on.
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, [onOpenWorktree]);

  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
    } catch {
      /* clipboard may be unavailable; nothing else to do */
    }
  };

  const revealPath = async (p: string) => {
    try {
      await api.fsRevealInFinder(p);
    } catch {
      /* the file manager may refuse; nothing else to do */
    }
  };

  const openProjectMenu = (e: ReactMouseEvent, wsId: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: "project", wsId, projName: name, x: e.clientX, y: e.clientY });
  };
  const openWorktreeMenu = (
    e: ReactMouseEvent,
    root: string,
    path: string,
    title: string,
    canRemove: boolean,
    switchNo: number | null,
    removeBlockedWhy: string | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      kind: "worktree",
      root,
      path,
      title,
      canRemove,
      removeBlockedWhy,
      switchNo,
      x: e.clientX,
      y: e.clientY,
    });
  };
  const openPlaceMenu = (
    e: ReactMouseEvent,
    place: RemotePlaceRef,
    title: string,
    subtitle: string,
    openLabel: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      kind: "place",
      place,
      title,
      subtitle,
      openLabel,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const renderRow = (w: WorktreeRef, projName: string, root: string) => {
    // "You are here" is one row however many places are open, and standing in
    // front of a machine means you are not standing in the local checkout.
    // `activePath` keeps pointing at the folder you came from — it has to, it
    // is where you return to — so on its own it lit the local copy at the same
    // time as the box, and the rail claimed you were in two places at once.
    //
    // It is the FOCUSED machine that wins, not merely an open one: stepping off
    // a box to read a page leaves it held but puts the window back here, and a
    // local row that stayed dark while nothing else was lit would leave the
    // question the whole group exists to answer wide open again.
    const isActive = w.path === activePath && !activeMachineId;
    // This copy has an agent mid-turn (stream running / pty in-progress /
    // native chat turn in flight — see useWorkingRoots). Drives both the
    // spinner-for-glyph swap and a row-level "working" accent so the row
    // reads as busy at a glance, not only by the tiny glyph.
    const isWorking = workingRoots.has(w.path.replace(/\/+$/, ""));
    const title =
      custom[w.path]?.name ||
      (w.branch ? humanizeCopyTitle(w.branch, false, w.path) : projName);
    const badge = badgeByPath?.[w.path];
    const hasDiff = !!badge && (badge.added > 0 || badge.removed > 0);
    // "now" / "3h" / "2d" / "10mo" — the app's one ladder, compact style.
    //
    // Compact all the way up, where the Workspaces view switches to a calendar
    // date past a month. On a page there is room for "Oct 12, 2025" and it is
    // the better answer; in a 232px rail it is twelve characters taken out of
    // the project name beside it, to answer a question ("is this warm?") that
    // "10mo" answers just as well. Empty when the branch tip can't be resolved
    // — and an empty string renders no element at all, rather than a dash
    // standing in for a fact we don't have.
    const age = relativeAgeFromSecs(w.head_committed_at ?? 0, {
      style: "compact",
      now,
      empty: "",
    });
    // This copy's branch is mid-flight on a machine that isn't this one. It is
    // the one fact a row can't tell you by looking at the disk: locally the
    // checkout is idle, so without the mark you'd assume nothing is happening
    // and start a second agent on the same branch.
    const cloud = badge?.cloud;
    // No branch subline: the L1 name IS the humanized branch, so a raw
    // `feat/…` line under it just restates the same thing and forces every
    // row to two lines. One clean line per copy (Conductor); the raw ref is
    // on hover + in the Workspaces view. Diff / PR badges ride the L1 line.
    const hasBadges = hasDiff || !!badge?.pr || !!cloud;
    // The trash affordance is offered only for removable worktrees: never
    // the main checkout (removing it would orphan the repo) and never the
    // active row (you can't delete the checkout you're standing in).
    const canRemove = !!onRemoveWorktree && !w.is_main && !isActive;
    // Which of those two it was, said as a fact about THIS row plus the way
    // out. "You're standing in it" is a state you can leave; "it's the
    // original" is not, and conflating them left people looking for a
    // setting that would let them delete the copy they were in.
    const removeBlockedWhy = canRemove
      ? null
      : w.is_main
        ? "This is the original checkout, not a parallel copy. Removing it would take the project with it."
        : isActive
          ? `You're working in ${title} right now. Open another copy first, then you can remove this one.`
          : null;
    // This row's ⌘-hold quick-switch number, handed out in paint order. Only
    // the first nine visible rows earn one — the shortcut spans ⌘1–⌘9.
    let switchNo: number | null = null;
    if (switchPathsRef.current.length < 9) {
      switchPathsRef.current.push(w.path);
      switchNo = switchPathsRef.current.length;
    }
    // This copy, as a place — the same identity a club member is stored as,
    // and (for a local checkout) the same string its tab snapshot is filed
    // under. See lib/placeRef.
    const { picked, pickTitle, toggle } = pickRow(localPlace(w.path));
    const activate = () => (picking ? toggle() : onOpenWorktree?.(w.path));

    return (
      <WorktreeHover
        key={w.path}
        card={
          <WorktreeHoverCard
            worktree={w}
            title={title}
            projName={projName}
            isActive={isActive}
            agents={agentsForPath(w.path)}
            badge={badge}
            onOpen={() => onOpenWorktree?.(w.path)}
          />
        }
      >
        <div
          role="button"
          tabIndex={0}
          className={`ade-wrow${isActive ? " active" : ""}${isWorking ? " working" : ""}${picked ? " picked" : ""}`}
          title={picking ? pickTitle : undefined}
          onClick={activate}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activate();
            }
          }}
          onContextMenu={(e) =>
            openWorktreeMenu(e, root, w.path, title, canRemove, switchNo, removeBlockedWhy)
          }
        >
          <span className="l1">
          {/* The row's identity is the COPY, never an agent. The matched
              branch-fork pair reads apart at a glance yet plainly related: a
              filled-ROOT fork for the repo's own rooted checkout, a filled-
              BRANCH fork for an Aura-made copy split off it. Who's driving it
              lives elsewhere (tab strip · Crew). While ⌘ is held, the glyph
              swaps to this row's quick-switch number (⌘+N jumps to it). The
              raw ref + agent detail live in the rich hover card, so no native
              tooltips compete. */}
          <span className="wsa">
            {picking ? (
              // A pick is up: the identity glyph becomes this row's checkbox,
              // so the mark you click is the mark that says whether it's in.
              <PickMark on={picked} />
            ) : cmdHeld && switchNo != null ? (
              <span className="wsa-num">{switchNo}</span>
            ) : isWorking ? (
              // This copy has an agent mid-turn — the identity glyph becomes
              // the loader so the row itself shows it's working.
              <AsciiSpinner className="wsa-spin text-sm" />
            ) : w.is_main ? (
              <MainBranchGlyph />
            ) : (
              <WorktreeGlyph />
            )}
          </span>
          {/* The copy's readable name (humanized branch, e.g. "commons
              platform"); the raw ref drops to the hover card. */}
          {renaming?.root === w.path ? (
            <input
              className="name ade-wrow-rename"
              value={renaming.value}
              autoFocus
              spellCheck={false}
              aria-label="Workspace name"
              placeholder={title}
              onChange={(e) =>
                setRenaming({ root: w.path, value: e.currentTarget.value })
              }
              onBlur={commitRename}
              // The row is a button; a rename in progress owns the keyboard.
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span className="name">{title}</span>
          )}
          {/* This list is for picking a copy to go to, so the name is what the
              row owes the reader — and the name was the one thing losing. The
              churn used to ride here as "+919 −148", eleven characters of
              fixed-width digits that never shrink, so on a 232px rail the
              ellipsis fell on the words instead: "commo… +919 −148 Closed".
              You cannot pick a copy you cannot read the name of.

              What survives is the two facts you'd act on. A dot says there is
              work here that isn't committed — which is the whole of what the
              numbers told you, since 919 and 238 lead to the same next move —
              and the PR pill says where the copy stands with the team. The
              counts themselves are in the hover card, where there is room to
              say them in words. */}
          {hasBadges && (
            <span className="badges">
              {/* Leads the cluster: where the work is running changes what the
                  other marks mean. A dirty dot on a copy a runner is mid-turn
                  on is that machine's work arriving, not yours. It breathes
                  only while a box actually holds the job — `submitted` is
                  still queued, and a still glyph is the honest picture of
                  work nobody has picked up. */}
              {cloud && (
                <CloudGlyph
                  size={13}
                  pulse={cloud.status !== "submitted"}
                  className="wrow-cloud"
                  label={
                    cloud.status === "submitted"
                      ? `Queued for a machine. ${labelForAgentId(cloud.agent)} hasn't started yet`
                      : `Running on your machine in the cloud. ${labelForAgentId(cloud.agent)}`
                  }
                />
              )}
              {hasDiff && (
                <span
                  className="dirty-dot"
                  aria-label="Has uncommitted work"
                  title={`${badge?.added ?? 0} added · ${badge?.removed ?? 0} removed, not committed yet`}
                />
              )}
              {badge?.pr && (
                <span
                  className={`pr-pill ${badge.pr.state.toLowerCase()}`}
                  // Merged is history, not a to-do — it drops to the same
                  // muted treatment "Closed" already had, so the only
                  // coloured pill left in the list is a PR still open.
                  style={
                    badge.pr.state.toLowerCase() === "merged"
                      ? { color: "var(--color-text-3)" }
                      : undefined
                  }
                  title={`PR #${badge.pr.number} · ${badge.pr.state}`}
                >
                  {prPillLabel(badge.pr.state, badge.pr.number)}
                </span>
              )}
            </span>
          )}
          {/* How long since anything landed on this copy — the last thing on
              the row, where Conductor puts it ("just now" / "2d").

              A roster of parallel copies is mostly a question of which one is
              warm. Until now the only answer was ordering: the list floats the
              active copy and anything with a live agent to the top, which tells
              you the ranking and never the distance — a branch you left this
              morning and one you left in March sat one row apart looking
              identical. The age is read from the copy's own HEAD commit, so it
              says when work last LANDED, not when you last clicked the row.

              It steps aside on hover: `.wrow-more` is absolutely positioned
              over this same right edge, so the two would otherwise stack. */}
          {age && (
            <span className="wrow-age" title={`Last commit on this copy · ${age} ago`}>
              {age}
            </span>
          )}
          <button
            type="button"
            className="wrow-more"
            onClick={(e) =>
              openWorktreeMenu(e, root, w.path, title, canRemove, switchNo, removeBlockedWhy)
            }
            title="Parallel-copy actions. Open, copy path, remove"
            aria-label="Parallel-copy actions"
          >
            <DotsIcon />
          </button>
          </span>
        </div>
      </WorktreeHover>
    );
  };

  /** A place you can go to. Same row shape as a local copy, because it is the
   *  same kind of thing: somewhere with a project in it and agents you can run.
   *  What differs is which computer "there" is, which is exactly what the cloud
   *  glyph and the `user@host` line say.
   *
   *  Lit when you are inside it — the whole reason this group exists. Entering
   *  a box silently swapped every shell in the window for one on another
   *  continent and left the rail looking untouched. */
  const renderPlaceRow = (p: Place, repoRoot?: string) => {
    // Every row in this group comes off the machine book, so it has an address.
    // A place without one is this laptop, which the rail already draws as local
    // copies — so say nothing rather than invent an empty id, which is how the
    // two spellings of "which machine is this row" would come to disagree.
    const machineId = p.machineId;
    if (machineId === null) return null;

    const isActive = machineId === activeMachineId;
    // Open, but not the one you are looking at. Stepping off a place to read a
    // page no longer closes it, so this is a real and common state and the rail
    // has to say so — a fainter wash than "here", loud enough to read as yours.
    const isHeld = !isActive && heldMachineIds.has(machineId);
    // The project travels with the click. It is how a place that never recorded
    // one learns which project it is a copy of — the workspace files it on the
    // way in — so the row you opened it from is the row it comes back to.
    const open = () => openRemoteWorkspace({ machineId, repoRoot });
    // When you were last on it, in the same slot every sibling row keeps its
    // age. A place is somewhere you return to, so "when was I last here" is
    // the question the rail can actually answer about one.
    const age = relativeAgeFromSecs(p.lastUsedAt, {
      style: "compact",
      now,
      empty: "",
    });
    // Name the work, not the computer — see `placeRowLabel`.
    const { work, machine } = placeRowLabel(p);
    const at = `${p.identity.user}@${p.identity.host}`;
    // Aura stopped this one because nobody was using it. The row still draws,
    // still opens and still says what is checked out over there — everything it
    // shows comes out of the book, none of it out of a connection — but it has
    // to SAY it is asleep, because otherwise the first thing that reaches the
    // box will report a machine that refuses to answer.
    const asleep = isAsleep(p);
    const sleepNote = asleep ? sleepTooltip(p, now) : "";
    // The place, as a row reference. Identical to what `openRemoteWorkspace` is
    // handed above, so the row a club holds, the row you click and the row you
    // pop out are one thing.
    const place = remotePlace({ machineId, repoRoot });
    const { picked, pickTitle, toggle } = pickRow(place);
    const activate = () => (picking ? toggle() : open());
    const openMenu = (e: ReactMouseEvent) =>
      openPlaceMenu(e, place, work, at, "Go to this machine");

    return (
      <div
        key={machineId}
        role="button"
        tabIndex={0}
        className={`ade-wrow${isActive ? " active" : isHeld ? " held" : ""}${picked ? " picked" : ""}`}
        onClick={activate}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        title={
          picking
            ? pickTitle
            : isActive
            ? `You are on ${p.name} · ${at}${machine ? ` · ${work} is checked out there` : ""}`
            : isHeld
              ? `${p.name} is still open · ${at} · go back to it${machine ? ` · ${work} is checked out there` : ""}`
              : // The sleep note goes FIRST when there is one. It is the answer
                // to the question somebody hovering a stopped box is actually
                // asking, and "open a workspace on this machine" underneath it
                // still holds — opening one is what starts it again.
                `${sleepNote ? `${sleepNote}\n` : ""}${at} · open a workspace on this machine${machine ? ` · ${work} is checked out there` : ""}`
        }
      >
        <span className="l1">
          <span className="wsa">
            {picking ? <PickMark on={picked} /> : <CloudGlyph size={13} />}
          </span>
          <span className="name">{work}</span>
          {/* The box, small, under the work it is doing — the same shape a
              local copy uses for its project. Dropped entirely when the work
              IS the box's name, so a machine with nothing checked out doesn't
              say its own name twice. */}
          {machine && <span className="wrow-sub">{machine}</span>}
          {/* No address on the row. An IP is plumbing: it is unreadable at a
              glance, it changes under you whenever the box restarts, and in a
              232px rail it costs more than every other row pays. It stays in
              the tooltip and in the workspace you enter — the two places you
              actually want it, both of them when something is wrong. */}
          {/* The age slot carries the sleep instead when there is one. They are
              answers to the same question — how long since anything happened
              here — and the sleeping one is the answer that changes what you
              expect when you click. Same quiet weight as the age it replaces:
              a stopped box is the cheap state, not the broken one. */}
          {asleep ? (
            <span className="wrow-age" title={sleepNote}>
              {sleepBadge(p)}
            </span>
          ) : (
            age && (
              <span className="wrow-age" title={`You were last on this machine ${age} ago`}>
                {age}
              </span>
            )
          )}
          {/* The same hover-only ⋯ a local copy has, in the same slot, opening
              the same kind of menu. A machine's actions used to live only
              inside the machine — you had to enter a box to find out you could
              open it in a window — and right-click alone is not a thing anyone
              discovers on a row that never showed a control. */}
          <button
            type="button"
            className="wrow-more"
            onClick={openMenu}
            title="Machine actions. Go there, or open it in its own window"
            aria-label="Machine actions"
          >
            <DotsIcon />
          </button>
        </span>
      </div>
    );
  };

  /** Work running on a machine that isn't this one.
   *
   *  It has no checkout here, and for a while that made it a *tab*: clicking
   *  it opened the transcript beside your local files. Wrong shape. The row is
   *  a place — a box with a shell, a project directory and its own agents — so
   *  clicking it does what clicking a copy does: it takes you there. The
   *  difference is only which machine "there" is on.
   *
   *  It sits with its project's other copies, one indent in, wearing the cloud
   *  where they wear a fork. That is the whole difference the rail needs to
   *  draw: same project, different computer. `showProject` says the project's
   *  name out loud only when the row is NOT under it — an unfiled machine's
   *  work, at the end of the list, has nothing above it to inherit from. */
  const renderCloudRow = (thread: CloudThread, showProject = false) => {
    const { label, tint } = cloudStatusLine(thread.latest, now);
    const live = isCloudThreadLive(thread, now);
    const at = thread.latest.created_at
      ? Date.parse(thread.latest.created_at)
      : NaN;
    const age = Number.isNaN(at)
      ? ""
      : relativeAgeFromSecs(Math.floor(at / 1000), {
          style: "compact",
          now,
          empty: "",
        });
    const open = () =>
      openRemoteWorkspace({
        threadKey: thread.key,
        repoRoot: thread.repoRoot,
      });
    // Lit when this is the conversation you walked in through, so the row you
    // clicked is the row that stays marked while you're standing in it — and
    // marked more faintly when its workspace is one of the ones you have open
    // behind whatever you're looking at now.
    const isActive = thread.key === activeThreadKey;
    const isHeld = !isActive && heldThreadKeys.has(thread.key);
    const projName = humanizeWorkspaceName(thread.repoRoot);
    // A conversation is a place too — one that hasn't resolved a box yet. It
    // can be clubbed like any other row and popped out like any other row;
    // `placeRef` keys it by its thread.
    const place = remotePlace({
      threadKey: thread.key,
      repoRoot: thread.repoRoot,
    });
    const { picked, pickTitle, toggle } = pickRow(place);
    const activate = () => (picking ? toggle() : open());
    const openMenu = (e: ReactMouseEvent) =>
      openPlaceMenu(
        e,
        place,
        thread.title,
        `${projName} · ${label}`,
        "Open the machine this runs on",
      );

    return (
      <div
        key={thread.key}
        role="button"
        tabIndex={0}
        className={`ade-wrow${isActive ? " active" : isHeld ? " held" : ""}${picked ? " picked" : ""}`}
        onClick={activate}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        title={
          picking
            ? pickTitle
            : `${projName} · ${label} · ${labelForAgentId(thread.latest.agent)} · open the machine this is running on`
        }
      >
        <span className="l1">
          {/* Where the copy rows wear a fork, this wears the cloud — the row's
              identity is that the work is elsewhere. It breathes only once a
              machine has actually claimed it; queued work is still. */}
          <span className="wsa">
            {picking ? (
              <PickMark on={picked} />
            ) : (
              <CloudGlyph
                size={13}
                pulse={live && thread.latest.status !== "submitted"}
              />
            )}
          </span>
          <span className="name">{thread.title}</span>
          {/* Unlike a copy row there is no diff to look at and no branch to
              check out, so a cloud row always says its state in words. The
              project's name joins it only out of that project's own list,
              where nothing above the row already says it. */}
          <span className="badges">
            {showProject && (
              <span className="text-2xs text-text-4">{projName}</span>
            )}
            <span className="text-2xs" style={{ color: tint }}>
              {label}
            </span>
          </span>
          {age && (
            <span className="wrow-age" title={`Sent ${age} ago`}>
              {age}
            </span>
          )}
          <button
            type="button"
            className="wrow-more"
            onClick={openMenu}
            title="Actions. Open the machine this runs on, or open it in its own window"
            aria-label="Cloud work actions"
          >
            <DotsIcon />
          </button>
        </span>
      </div>
    );
  };

  const ordered = sortWorkspaces(workspaces, sort);
  // Split archived projects out of the visible list (they drop into their own
  // disclosure at the foot), then float pinned projects to the top of what's
  // left — the chosen sort still governs order *within* each group (stable
  // partition). Archive/pin only touch this device's view; branch + files on
  // disk are never affected.
  const archived = ordered
    .filter((ws) => typeof custom[ws.id]?.archived === "number")
    .sort((a, b) => (custom[b.id]?.archived ?? 0) - (custom[a.id]?.archived ?? 0));
  const activeOrdered = ordered.filter(
    (ws) => typeof custom[ws.id]?.archived !== "number",
  );
  const pinnedProjects = activeOrdered.filter((ws) => custom[ws.id]?.pinned);
  const restProjects = activeOrdered.filter((ws) => !custom[ws.id]?.pinned);
  const visible = [...pinnedProjects, ...restProjects];
  // Where the pinned group ends and the rest of the roster starts. Pinning
  // already floated a project to the top; what it never did was SAY so, so a
  // roster that had been deliberately arranged looked like one that happened to
  // be in that order — and the only tell was a 10px pushpin on the row itself.
  // The break header names the group, which is also what lets the pushpin go.
  const pinnedCount = pinnedProjects.length;
  const anyExpanded = visible.some((ws) => !collapsed[ws.id]);
  const toggleAll = () => {
    setCollapsed(() => {
      if (!anyExpanded) return {}; // all folded → unfold every project
      const all: Record<string, boolean> = {};
      for (const ws of visible) all[ws.id] = true;
      return all;
    });
  };

  // Rebuild the ⌘-quick-switch order from scratch each render; renderRow
  // appends to it in paint order below, so it always mirrors what's on screen.
  switchPathsRef.current = [];

  // "Projects" section break + its controls (sort · new · fold-all) —
  // Conductor's header cluster. The hairline divider separates the roster from
  // the Build nav above; the label lines up with the project glyphs below.
  //
  // Held as a value rather than written inline because it now has two places to
  // be: at the top of the list when nothing is pinned, and after the pinned
  // group when something is. Two copies of a header carrying three controls is
  // two places for them to drift apart.
  const projectsHeader = (
    <div className="ade-sec-h ade-proj-sech ade-projhead">
      Projects
      <span className="right ade-projhead-actions">
        <button
          type="button"
          className="projhead-btn"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setSortMenu({ x: r.right - 168, y: r.bottom + 6 });
          }}
          title="Sort projects"
          aria-label="Sort projects"
        >
          <SortGlyph />
        </button>
        {onAddProject && (
          <button
            type="button"
            className="projhead-btn"
            onClick={(e) => {
              e.stopPropagation();
              onAddProject();
            }}
            title="Add a project. Open a folder"
            aria-label="Add a project"
          >
            <Icons.Plus size={13} />
          </button>
        )}
        <button
          type="button"
          className="projhead-btn"
          onClick={(e) => {
            e.stopPropagation();
            toggleAll();
          }}
          title={anyExpanded ? "Collapse all projects" : "Expand all projects"}
          aria-label={
            anyExpanded ? "Collapse all projects" : "Expand all projects"
          }
        >
          <CollapseAllGlyph folded={!anyExpanded} />
        </button>
      </span>
    </div>
  );

  return (
    // The copy rows carry their own hover bridge (`WorktreeHover`) — a
    // hand-rolled portal card, not a Medusa tooltip, because the card holds
    // interactive buttons a tooltip can't. No provider context needed.
    <div>
      {/* Pinned first, under its own name; everything else under "Projects".
          With nothing pinned there is one group and it keeps the header it
          always had, in the place it always had it. */}
      {pinnedCount > 0 ? (
        <div className="ade-sec-h ade-proj-sech">Pinned</div>
      ) : (
        projectsHeader
      )}
      {visible.map((ws, i) => {
        const worktrees = ws.worktrees ?? [];
        // Fall back to a single synthetic row for the repo root when no
        // sibling worktrees exist, so a plain repo still shows one entry.
        const rows: WorktreeRef[] =
          worktrees.length > 0
            ? worktrees
            : [
                {
                  path: ws.id,
                  branch: "",
                  head: "",
                  is_main: true,
                  locked: false,
                },
              ];
        const projName = humanizeWorkspaceName(ws.id);
        // The user's chosen icon lives in the customization store (the "Change
        // icon" menu writes it there, same store as pin/archive) — prefer it
        // over the backend-supplied `ws.emoji` so a freshly-picked glyph shows
        // immediately on the tile.
        const emoji = custom[ws.id]?.emoji ?? ws.emoji;
        // Resolve each worktree's agents once per render (one localStorage
        // read per path, not per use) — feeds both the primary/other rank
        // below and the live-agent lane.
        const agentsByPath = new Map<string, LaneAgent[]>(
          rows.map((w) => [w.path, agentsForPath(w.path)] as const),
        );
        // Primary = the active worktree + anything with a live agent.
        // Everything else (idle feature checkouts and machine
        // `worktree-agent-…` scratch alike) is "inactive" and collapses
        // into one disclosure. Within inactive: has-work → idle → scratch.
        const now = Date.now();
        const enriched = rows.map((w) => {
          const bare = (w.branch || "").replace(/^refs\/heads\//, "");
          const isScratch =
            /^worktree-agent-/.test(bare) ||
            /\/worktree-agent-[^/]*$/.test(w.path);
          // `aura work` worktrees (`work/<slug>` branch in a sibling
          // `<repo>-work-<slug>` dir) are the HUMAN's own deliberate
          // parallel sessions — not crew agents. Bucket them separately
          // so they never inflate the "N other parallel copies" count and
          // never get swept into the agent-pip lane, while still rendering
          // as normal switchable rows.
          const isWorkSession =
            /^work\//.test(bare) || /-work-[^/]+$/.test(w.path);
          const hasAgent = (agentsByPath.get(w.path)?.length ?? 0) > 0;
          const badge = badgeByPath?.[w.path];
          // Work in flight on a runner counts as work. Without it, the one copy
          // a machine is actively changing sinks into the "N other parallel
          // copies" disclosure — the row you least want hidden, because
          // locally it looks idle and nothing else on screen says otherwise.
          const hasWork =
            (!!badge && (badge.added > 0 || badge.removed > 0)) ||
            !!badge?.pr ||
            !!badge?.cloud;
          const isActive = w.path === activePath;
          // Recently opened (within the last hour) keeps a worktree primary
          // so flipping between checkouts doesn't immediately bury the one
          // you just left.
          const recentlyActive =
            !!visited[w.path] && now - visited[w.path] < RECENT_MS;
          const rank = isActive
            ? 0
            : w.is_main
              ? // The home checkout is always a surfaced (primary) copy — it's
                // a workspace's one stable "active" view, so it never sinks
                // into the "N other parallel copies" disclosure. Fixes the case
                // where an idle project showed ONLY the disclosure with nothing
                // clickable to work on.
                1
              : hasAgent || recentlyActive
                ? 1
                : hasWork
                  ? 2
                  : isScratch
                    ? 4
                    : 3;
          return { w, rank, isWorkSession };
        });
        // Keep the visible (primary) list in git's natural worktree order
        // so clicking a row doesn't reshuffle it to the top — activating a
        // worktree only re-tints it in place. Only the hidden inactive
        // disclosure is sorted (has-work → idle → scratch), so machine
        // scratch dirs sink to its bottom.
        //
        // `aura work` sessions are pulled out into their own bucket: they
        // render as ordinary switchable rows (next to primary) but are
        // NOT part of the "N other parallel copies" disclosure count.
        const primary = enriched
          .filter((r) => !r.isWorkSession && r.rank <= 1)
          .map((r) => r.w);
        const workSessions = enriched
          .filter((r) => r.isWorkSession)
          .map((r) => r.w);
        const inactive = enriched
          .filter((r) => !r.isWorkSession && r.rank > 1)
          .sort((a, b) => a.rank - b.rank)
          .map((r) => r.w);
        const isCollapsed = !!collapsed[ws.id];
        const showInactive = !!expanded[ws.id];
        // The workspace's one active copy — what clicking the project header
        // opens. Prefer a copy of THIS workspace that's already focused, else
        // the home checkout (is_main), else the first surfaced copy. Always
        // lands the user on a working view in one click (the "nowhere to
        // click / one active per workspace" fix).
        const activeCopyPath =
          rows.find((w) => w.path === activePath)?.path ??
          rows.find((w) => w.is_main)?.path ??
          primary[0]?.path ??
          rows[0]?.path ??
          ws.id;
        // Is anything in this project mid-turn? A copy's row shows its own
        // spinner, but when the project is COLLAPSED the rows are hidden — and a
        // native Aura-chat turn runs against the project/worktree root, which
        // may not match any surfaced row anyway. So the header needs its own
        // working tell (the "aura chat is running but the sidebar isn't showing
        // it" fix). Checks the workspace root and every copy's path against the
        // same normalized working-roots set the rows use.
        const projWorking =
          workingRoots.has(ws.id.replace(/\/+$/, "")) ||
          rows.some((w) => workingRoots.has(w.path.replace(/\/+$/, "")));
        // The freshest thing in the project, for when its copies are folded
        // away. Folded is the state a long roster spends most of its time in,
        // and a header with nothing but a name gives a reader no way to tell a
        // project they were in an hour ago from one they abandoned in March —
        // the very distinction the copy rows below now make. Only drawn while
        // collapsed: with the rows open each one says its own age, and the
        // header repeating the newest of them is the same fact twice.
        const projAge = relativeAgeFromSecs(
          rows.reduce(
            (max, w) => Math.max(max, w.head_committed_at ?? 0),
            0,
          ),
          { style: "compact", now, empty: "" },
        );
        // No per-project tint. A hashed hue on every folder made the list read
        // as a paint chart and gave colour a meaning it does not have — the
        // project name is the identity. The header falls back to the neutral
        // text ramp.
        return (
          <Fragment key={ws.id}>
            {/* The break between the two groups. It rides inside the list
                rather than beside it because the list is ONE array — pinned
                projects are the same rows in the same order, floated — and
                splitting it into two maps to place one header would mean two
                call sites for a project row, and a ⌘-quick-switch order
                assembled across both. */}
            {pinnedCount > 0 && i === pinnedCount ? projectsHeader : null}
            <div className="ade-proj">
            <div
              className={`ade-proj-h${projWorking ? " working" : ""}`}
              onContextMenu={(e) => openProjectMenu(e, ws.id, projName)}
            >
              {/* The project's own mark IS the collapse toggle: it rests as
                  the repo glyph/avatar and cross-fades to a chevron on header
                  hover (Conductor pattern — no separate persistent chevron
                  cluttering the row). Click folds the parallel copies; the
                  .ph-name button beside it still OPENS the workspace. */}
              <button
                type="button"
                className="ph-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed((m) => ({ ...m, [ws.id]: !m[ws.id] }));
                }}
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? "Show parallel copies" : "Hide parallel copies"}
                title={isCollapsed ? "Show parallel copies" : "Hide parallel copies"}
              >
                <span className="ph-icon">
                  {emoji ? (
                    <span className="glyph" style={{ fontSize: 14 }}>
                      {emoji}
                    </span>
                  ) : (
                    // Repo owner's avatar when one resolves, else the
                    // project's own mark (non-GitHub repos / 404 / still
                    // resolving). Never a folder — every project is a
                    // repository now, and one repeated folder glyph tells
                    // you nothing about which project you're looking at.
                    <RepoAvatar
                      repoRoot={ws.id}
                      letter={letterMark(projName)}
                      size={15}
                      fallback={<ProjectMark name={projName} root={ws.id} size={15} />}
                    />
                  )}
                </span>
                <Icons.ChevronDown
                  size={13}
                  className={`ph-toggle-chev chev${isCollapsed ? "" : " open"}`}
                />
              </button>
              {/* Clicking the workspace name OPENS its one active copy — a
                  working view is always one click away (the "nowhere to
                  click" fix). The mark toggle beside it folds the copies. */}
              <button
                type="button"
                className="ph-name"
                onClick={() => onOpenWorktree?.(activeCopyPath)}
                title={`${ws.id}. Open`}
              >
                <span className="nm">{projName}</span>
              </button>
              {/* Project-level "working" tell — an agent or Aura chat is
                  mid-turn somewhere in this project. Sits on the identity line
                  so it shows even when the copies are folded away. */}
              {projWorking && (
                <span
                  className="ph-working"
                  title="Working. An agent or Aura chat is mid-turn in this project"
                  aria-label="Working"
                >
                  <AsciiSpinner className="text-xs" />
                </span>
              )}
              {/* A pushpin used to ride here on every pinned project. The
                  "Pinned" break header above the group says the same thing once
                  for all of them, so the per-row badge was the group's own
                  caption repeated down the list. Unpinning still lives in the
                  row's ⋯ menu, where the rest of the row's actions are. */}
              {/* Overflow chip — the copies this project has that the rail is
                  NOT showing. Clicking opens the full Workspaces view scoped to
                  it (the curated few stay in the rail; the fleet lives in the
                  view).

                  It counts `inactive`, not `rows`. Printing the total put "49"
                  beside four visible rows: a number matching nothing on screen,
                  in a column where the neighbouring bare numbers already mean
                  two other things (Mission Control's "6/51" is a ratio, Team's
                  "69" is unread messages). And when this chip isn't wired, the
                  rail falls back to a "Show N other parallel copies" button a
                  few pixels below that counts `inactive` — so the two
                  affordances for one job disagreed about the quantity. The
                  leading "+" makes the meaning read without the tooltip: these
                  are beyond the ones you can see. */}
              {onOpenAllCopies && inactive.length > 0 && (
                <button
                  type="button"
                  className="ph-count"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenAllCopies(ws.id);
                  }}
                  title={`${inactive.length} more parallel cop${
                    inactive.length === 1 ? "y" : "ies"
                  }. Open the Workspaces view`}
                  aria-label={`${inactive.length} more parallel cop${
                    inactive.length === 1 ? "y" : "ies"
                  }. Open the Workspaces view`}
                >
                  +{inactive.length}
                </button>
              )}
              {/* The header's one primary (create) affordance: start a new
                  parallel copy — a fresh worktree session — scoped to this
                  project. Reuses the global new-workspace composer (the same
                  one Crew's "New copy" opens) by naming this project, so the
                  copy lands here and its tabs stay within it. Hover-only,
                  arriving with the ⋯ beside it — see `.ph-new` for why it
                  stopped being persistent. */}
              <button
                type="button"
                className="ph-new"
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(
                    new CustomEvent("aura:new-workspace", {
                      detail: { repoRoot: ws.id },
                    }),
                  );
                }}
                title="New parallel copy. Start an agent on a fresh copy of this project"
                aria-label="New parallel copy"
              >
                <Icons.Plus size={14} />
              </button>
              <button
                type="button"
                className="ph-more"
                onClick={(e) => openProjectMenu(e, ws.id, projName)}
                title="Workspace actions. Open, copy path, close"
                aria-label="Workspace actions"
              >
                <DotsIcon />
              </button>
              {/* How fresh this project is, while its copies are hidden.
                  LAST in the header on purpose: the age is the one thing here
                  that has no fixed width, so anywhere else in the cluster it
                  would shove the +N chip and the hover controls off the ruler
                  every copy row's own age ends on. Rendered after the two
                  hover-only controls (both zero-width at rest) it ends exactly
                  on that ruler, and steps aside as they expand. */}
              {isCollapsed && projAge && (
                <span
                  className="ph-age"
                  title={`Newest copy · last commit ${projAge} ago`}
                >
                  {projAge}
                </span>
              )}
            </div>

            {!isCollapsed && (
              <div className="ade-proj-rows">
                {primary.map((w) => renderRow(w, projName, ws.id))}
                {/* `aura work` sessions — the human's deliberate parallel
                    copies. Always switchable rows, never folded into the
                    "N parallel copies" count below. */}
                {workSessions.map((w) => renderRow(w, projName, ws.id))}
                {/* This project's copies that aren't on this laptop: the boxes
                    connected for it, then the conversations running on them.
                    Machines first — a box is a place that persists, a
                    conversation is something happening in one. */}
                {(placesByRoot.get(ws.id) ?? []).map((p) =>
                  renderPlaceRow(p, ws.id),
                )}
                {(cloudThreadsByRoot.get(ws.id) ?? []).map((t) =>
                  renderCloudRow(t),
                )}
                {/* The count chip in the header opens the full Workspaces
                    view for the hidden copies. Only when no such view is
                    wired do we fall back to expanding the idle rows in place. */}
                {inactive.length > 0 && !onOpenAllCopies && (
                  <>
                    <button
                      type="button"
                      className="ade-wmore"
                      onClick={() =>
                        setExpanded((m) => ({ ...m, [ws.id]: !m[ws.id] }))
                      }
                    >
                      <Icons.ChevronDown
                        size={13}
                        className={`chev${showInactive ? " open" : ""}`}
                      />
                      {showInactive ? "Hide" : "Show"} {inactive.length} other
                      {" "}parallel cop{inactive.length === 1 ? "y" : "ies"}
                    </button>
                    {showInactive &&
                      inactive.map((w) => renderRow(w, projName, ws.id))}
                  </>
                )}
              </div>
            )}
            </div>
          </Fragment>
        );
      })}

      {/* Machines with no project of their own. Every box connected before the
          book recorded a project is here, as is one connected for a project
          you've since archived. They are NOT filed under a guess — a box under
          a repo it has never seen is worse than a box on its own — but they are
          shown, because this list holds the only copy of their address.
          Their cloud conversations name their project on the row instead. */}
      {machines === null ? (
        <div className="ade-proj-rows">
          <div className="ade-wrow">
            <span className="l1">
              <span className="wsa">
                <AsciiSpinner size={13} />
              </span>
              <span className="name">Reading your machines…</span>
            </span>
          </div>
        </div>
      ) : (
        unplacedPlaces.length > 0 && (
          <div className="ade-proj-rows">
            {unplacedPlaces.map((p) => renderPlaceRow(p))}
          </div>
        )
      )}
      {/* Cloud work for a project this rail isn't showing — archived, or on
          another device. It would otherwise be the only kind of work the app
          runs and never mentions, so it lands here, carrying its project name
          because it has no project header above it to inherit one from. */}
      {orphanCloudThreads.length > 0 && (
        <div className="ade-proj-rows">
          {orphanCloudThreads.map((t) => renderCloudRow(t, true))}
        </div>
      )}


      {/* Archived projects — hidden from the list above, gathered here in a
          collapsed disclosure. Archiving never touches the branch or files on
          disk; it just declutters this device's rail. Restore brings a project
          straight back into the list. */}
      {archived.length > 0 && (
        <div className="ade-archived">
          <button
            type="button"
            className="ade-wmore"
            onClick={() => setShowArchived((v) => !v)}
            title={showArchived ? "Hide archived projects" : "Show archived projects"}
          >
            <Icons.ChevronDown
              size={13}
              className={`chev${showArchived ? " open" : ""}`}
            />
            Archived · {archived.length}
          </button>
          {showArchived &&
            archived.map((ws) => {
              const projName = humanizeWorkspaceName(ws.id);
              return (
                <div
                  className="ade-proj-h ade-archived-row"
                  key={ws.id}
                  onContextMenu={(e) => openProjectMenu(e, ws.id, projName)}
                  style={{ opacity: 0.72 }}
                >
                  {/* No inline nudge — `.ade-archived-row .ph-icon` gives this
                      the same 20px mark slot a live project's `.ph-toggle`
                      has, so an archived row's mark stands in the roster's one
                      mark column instead of 2px of its own. */}
                  <span className="ph-icon">
                    <RepoAvatar
                      repoRoot={ws.id}
                      size={15}
                      fallback={<ProjectMark name={projName} root={ws.id} size={15} />}
                    />
                  </span>
                  <button
                    type="button"
                    className="ph-name"
                    onClick={() => setWorkspaceArchived(ws.id, false)}
                    title={`${ws.id}. Restore to your projects`}
                  >
                    <span className="nm">{projName}</span>
                  </button>
                  <button
                    type="button"
                    className="ph-new"
                    onClick={(e) => {
                      e.stopPropagation();
                      setWorkspaceArchived(ws.id, false);
                    }}
                    title="Restore. Bring this project back to your list"
                    aria-label="Restore project"
                  >
                    <RestoreIcon />
                  </button>
                </div>
              );
            })}
        </div>
      )}

      {sortMenu && (
        <div
          className="ade-roster-menu"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            left: Math.min(sortMenu.x, window.innerWidth - 176),
            top: sortMenu.y,
          }}
        >
          <div className="rm-head">Sort projects</div>
          {(
            [
              ["recent", "Recently opened"],
              ["name", "Name (A–Z)"],
              ["activity", "Recent activity"],
            ] as [RosterSort, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rm-item${sort === value ? " active" : ""}`}
              onClick={() => chooseSort(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {menu && (
        <div
          className="ade-roster-menu"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            left: Math.min(menu.x, window.innerWidth - 224),
            top: Math.min(menu.y, window.innerHeight - 256),
          }}
        >
          {menu.kind === "project" ? (
            <>
                <div className="rm-head" title={menu.wsId}>
                  {menu.projName}
                </div>
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent("aura:new-workspace", {
                        detail: { repoRoot: menu.wsId },
                      }),
                    );
                    setMenu(null);
                  }}
                >
                  <Icons.Plus size={13} />
                  New workspace
                </button>
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent("aura:new-workspace", {
                        detail: { repoRoot: menu.wsId, createFrom: true },
                      }),
                    );
                    setMenu(null);
                  }}
                >
                  <CreateFromIcon />
                  Create from…
                  <span className="rm-key">⌘⇧N</span>
                </button>
                {/* Beside the two "make me another copy" actions, because that
                    is what it is — a copy of THIS project on a computer that
                    isn't this one. It lives in the project's own menu rather
                    than as a row at the foot of the rail: down there it could
                    not say which project it was connecting for, and a machine
                    that doesn't know its project has nowhere to sit. */}
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    openRemoteWorkspace({ repoRoot: menu.wsId });
                    setMenu(null);
                  }}
                  title="Run agents on a box that isn't this laptop, working on this project"
                >
                  <CloudGlyph size={13} />
                  Connect a machine…
                </button>
                <div className="rm-sep" />
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    // Scope settings to this repo first, then land on its
                    // Copies & agents (repository) pane.
                    onSelectProject?.(menu.wsId);
                    window.dispatchEvent(
                      new CustomEvent("aura:open-settings", {
                        detail: { pane: "copies" },
                      }),
                    );
                    setMenu(null);
                  }}
                >
                  <GearIcon />
                  Repository settings
                  <span className="rm-key">⌘,</span>
                </button>
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    setRenaming({
                      root: menu.wsId,
                      value: custom[menu.wsId]?.name ?? "",
                    });
                    setMenu(null);
                  }}
                >
                  <RenameIcon />
                  Rename
                </button>
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => pickIcon(menu.wsId)}
                >
                  <ChangeIconGlyph />
                  Change icon
                </button>
                {custom[menu.wsId]?.emoji && (
                  <button
                    type="button"
                    className="rm-item"
                    onClick={() => {
                      setWorkspaceEmoji(menu.wsId, undefined);
                      setMenu(null);
                    }}
                  >
                    <RestoreIcon />
                    Reset icon
                  </button>
                )}
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    void copyPath(menu.wsId);
                    setMenu(null);
                  }}
                >
                  <CopyIcon />
                  Copy path
                </button>
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    setWorkspacePinned(menu.wsId, !custom[menu.wsId]?.pinned);
                    setMenu(null);
                  }}
                >
                  <PinIcon filled={!!custom[menu.wsId]?.pinned} />
                  {custom[menu.wsId]?.pinned ? "Unpin from top" : "Pin to top"}
                </button>
                <div className="rm-sep" />
                <button
                  type="button"
                  className="rm-item"
                  onClick={() => {
                    setWorkspaceArchived(menu.wsId, true);
                    setMenu(null);
                  }}
                  title="Hides it from your list. Your branch and files stay put"
                >
                  <EyeOffIcon />
                  Hide repository
                </button>
                {onCloseProject && (
                  <button
                    type="button"
                    className="rm-item danger"
                    onClick={() => {
                      onCloseProject(menu.wsId);
                      setMenu(null);
                    }}
                    title="Removes it from your list. Your branch and files stay on disk"
                  >
                    <TrashIcon />
                    Remove repository
                  </button>
                )}
              </>
          ) : menu.kind === "place" ? (
            <>
              <div className="rm-head" title={menu.subtitle}>
                {menu.title}
              </div>
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  openRemoteWorkspace(remotePlaceOf(menu.place));
                  setMenu(null);
                }}
              >
                <CloudGlyph size={13} />
                {menu.openLabel}
              </button>
              {/* The move a local copy has had all along, on the other kind of
                  place. The window that opens comes up STANDING on this
                  machine — its shell, its sessions, its agents — rather than in
                  the local copy of the same project, which is the whole point:
                  a place you can put on a second screen is a place, and one you
                  can only reach by leaving whatever this window is showing is
                  a mode.

                  This window is not asked to give the machine up. Nothing
                  moves; a second window has its own copy of everything, and the
                  sessions are tmux on the box, which was never any window's to
                  hand over in the first place. */}
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  void openPopout({
                    kind: "workspace",
                    root: menu.place.repoRoot ?? "",
                    place: menu.place,
                    title: `Aura. ${menu.title}`,
                  });
                  setMenu(null);
                }}
                title="A second Aura window standing there. This one stays where it is"
              >
                <ExternalWindowIcon />
                Open in its own window
              </button>
            </>
          ) : (
            <>
              <div className="rm-head" title={menu.path}>
                {menu.title}
              </div>
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  onOpenWorktree?.(menu.path);
                  setMenu(null);
                }}
              >
                <Icons.GitBranch size={13} />
                Open copy
                {menu.switchNo != null && menu.switchNo <= 9 && (
                  <span className="rm-key">⌘{menu.switchNo}</span>
                )}
              </button>
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  void openPopout({
                    kind: "workspace",
                    root: menu.path,
                    title: menu.title,
                  });
                  setMenu(null);
                }}
              >
                <ExternalWindowIcon />
                Open in new window
              </button>
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  setRenaming({
                    root: menu.path,
                    value: custom[menu.path]?.name ?? "",
                  });
                  setMenu(null);
                }}
              >
                <RenameIcon />
                Rename
              </button>
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("aura:new-workspace", {
                      detail: { repoRoot: menu.root },
                    }),
                  );
                  setMenu(null);
                }}
              >
                <Icons.Plus size={13} />
                New parallel copy
              </button>
              {/* The second door into the side-by-side gesture, and the one
                  that starts from a row you already have your finger on: this
                  copy goes in, the bar comes up, and the rail asks for the
                  other place. The first door is the "Side by side" section's
                  own control above the roster. */}
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  beginClubPick(localPlace(menu.path));
                  setMenu(null);
                }}
                title="Work in this and another at once — pick the second row next"
              >
                <SideBySideMenuIcon />
                Put side by side…
              </button>
              <div className="rm-sep" />
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  void copyPath(menu.path);
                  setMenu(null);
                }}
              >
                <CopyIcon />
                Copy path
              </button>
              <button
                type="button"
                className="rm-item"
                onClick={() => {
                  void revealPath(menu.path);
                  setMenu(null);
                }}
              >
                <Icons.Folder size={13} />
                Reveal in Finder
              </button>
              {onRemoveWorktree && (
                <>
                  <div className="rm-sep" />
                  <button
                    type="button"
                    className="rm-item danger"
                    disabled={!menu.canRemove}
                    title={
                      menu.canRemove
                        ? "Deletes this parallel copy from disk"
                        : (menu.removeBlockedWhy ??
                          "This copy can't be removed")
                    }
                    onClick={() => {
                      if (menu.canRemove) onRemoveWorktree(menu.root, menu.path);
                      setMenu(null);
                    }}
                  >
                    <TrashIcon />
                    Remove parallel copy…
                  </button>
                  {/* A disabled row with no reason on it reads as broken.
                   *  Hover eventually explains — but only if you think to
                   *  hover something you've already been told you can't
                   *  use, so the reason is printed under it instead. */}
                  {!menu.canRemove && menu.removeBlockedWhy && (
                    <div className="px-3 pb-2 pt-0.5 text-xs text-text-4 leading-snug max-w-[260px]">
                      {menu.removeBlockedWhy}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
      {/* Off-screen sink for the OS emoji picker: "Change icon" focuses this,
          fronts the system picker, and the glyph the user chooses is inserted
          here (see onEmojiCaptured). Kept mounted so focus lands instantly. */}
      <input
        ref={emojiCaptureRef}
        onInput={onEmojiCaptured}
        aria-hidden
        tabIndex={-1}
        inputMode="none"
        autoComplete="off"
        style={{
          position: "fixed",
          top: -9999,
          left: -9999,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

