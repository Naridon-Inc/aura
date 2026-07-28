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
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as Icons from "./Icons";
import { ProjectMark, RepoAvatar } from "./RepoAvatar";
import { WorktreeHoverCard } from "./WorktreeHoverCard";
import { WorktreeHover } from "./WorktreeHover";
import { useEditorStore, readPersistedAgents } from "../lib/editorStore";
import { humanizeWorkspaceName, isMachineLeaf } from "../lib/workspaceLabel";
import { api } from "../lib/api";
import { openPopout } from "../lib/popout";
import {
  useWorkspaceCustomization,
  setWorkspacePinned,
  setWorkspaceArchived,
  setWorkspaceEmoji,
} from "../lib/workspaceCustomization";
import type { WorktreeBadge } from "../lib/useWorktreeBadges";
import { useWorkingRoots } from "../lib/useFleetActivity";
import { AsciiSpinner } from "./ui/ascii-spinner";
import type { Workspace, WorktreeRef } from "./WorkspaceRail";

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
      /** This copy's ⌘-hold quick-switch number (⌘1–⌘9), when it has one —
       *  a real, wired shortcut we surface on the Open row. */
      switchNo: number | null;
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

// 207 → "207", 1432 → "1.4k". Keeps the diff badge from overrunning the
// row on large worktrees, matching the mockup's compact pills.
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
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

// "feat/s1-s-manifest-signing-prep" → "manifest signing prep". Best-effort
// humanisation for the row title; the full branch still shows in the meta
// line so nothing is hidden.
function humanizeBranch(branch: string): string {
  const seg = branch.split("/").pop() ?? branch;
  // A machine worktree branch (`worktree-agent-<hash>`, `agent-<hash>`, …)
  // carries no human meaning — de-hyphenating it just yields "worktree agent
  // a6f18ff…". Call it what it is in plain words.
  if (isMachineLeaf(seg)) return "parallel copy";
  const cleaned = seg
    .replace(/^(feat|fix|chore|refactor|docs|test|perf)[-_/]?/i, "")
    .replace(/^\d+[-_]/, "") // leading issue/ticket number
    .replace(/[-_]/g, " ")
    .trim();
  return cleaned || seg || branch;
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
      <path
        d={folded ? "M5 4l3 3 3-3M5 9l3 3 3-3" : "M5 7l3-3 3 3M5 12l3-3 3 3"}
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
  useEffect(() => {
    if (!sortMenu) return;
    const close = () => setSortMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSortMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [sortMenu]);

  // Every agent attached to a worktree path — live tabs from the focused
  // workspace merged with the persisted per-repo roster (D3-II), so the
  // live-agent lane shows agents working in *backgrounded* workspaces too,
  // not just the one in view. Live tabs win on dedup (they carry the
  // real-time `attention` flag); persisted entries fill in the rest.
  const agentsForPath = (path: string): LaneAgent[] => {
    const live = editor.agentTabs.filter((t) => t.repoRoot === path);
    const seen = new Set(live.map((t) => t.sessionId));
    const fromLive: LaneAgent[] = live.map((t) => ({
      sessionId: t.sessionId,
      agentId: t.agentId,
      agentLabel: t.agentLabel,
      attention: !!t.attention,
    }));
    const fromPersist: LaneAgent[] = readPersistedAgents(path)
      .filter((p) => !seen.has(p.sessionId))
      .map((p) => ({
        sessionId: p.sessionId,
        agentId: p.agentId,
        agentLabel: p.agentLabel,
        attention: false,
      }));
    return [...fromLive, ...fromPersist];
  };

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

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      kind: "worktree",
      root,
      path,
      title,
      canRemove,
      switchNo,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const renderRow = (w: WorktreeRef, projName: string, root: string) => {
    const isActive = w.path === activePath;
    // This copy has an agent mid-turn (stream running / pty in-progress /
    // native chat turn in flight — see useWorkingRoots). Drives both the
    // spinner-for-glyph swap and a row-level "working" accent so the row
    // reads as busy at a glance, not only by the tiny glyph.
    const isWorking = workingRoots.has(w.path.replace(/\/+$/, ""));
    const title = w.branch ? humanizeBranch(w.branch) : projName;
    const badge = badgeByPath?.[w.path];
    const hasDiff = !!badge && (badge.added > 0 || badge.removed > 0);
    // No branch subline: the L1 name IS the humanized branch, so a raw
    // `feat/…` line under it just restates the same thing and forces every
    // row to two lines. One clean line per copy (Conductor); the raw ref is
    // on hover + in the Workspaces view. Diff / PR badges ride the L1 line.
    const hasBadges = hasDiff || !!badge?.pr;
    // The trash affordance is offered only for removable worktrees: never
    // the main checkout (removing it would orphan the repo) and never the
    // active row (you can't delete the checkout you're standing in).
    const canRemove = !!onRemoveWorktree && !w.is_main && !isActive;
    // This row's ⌘-hold quick-switch number, handed out in paint order. Only
    // the first nine visible rows earn one — the shortcut spans ⌘1–⌘9.
    let switchNo: number | null = null;
    if (switchPathsRef.current.length < 9) {
      switchPathsRef.current.push(w.path);
      switchNo = switchPathsRef.current.length;
    }

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
          className={`ade-wrow${isActive ? " active" : ""}${isWorking ? " working" : ""}`}
          onClick={() => onOpenWorktree?.(w.path)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenWorktree?.(w.path);
            }
          }}
          onContextMenu={(e) =>
            openWorktreeMenu(e, root, w.path, title, canRemove, switchNo)
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
            {cmdHeld && switchNo != null ? (
              <span className="wsa-num">{switchNo}</span>
            ) : isWorking ? (
              // This copy has an agent mid-turn — the identity glyph becomes
              // the loader so the row itself shows it's working.
              <AsciiSpinner className="wsa-spin text-[12px]" />
            ) : w.is_main ? (
              <MainBranchGlyph />
            ) : (
              <WorktreeGlyph />
            )}
          </span>
          {/* The copy's readable name (humanized branch, e.g. "commons
              platform"); the raw ref drops to the hover card. */}
          <span className="name">{title}</span>
          {/* Diff + PR badges ride the name line — the copy's "how much
              changed here" at a glance, so the row stays one clean line. The
              +/− read as plain text on every row, active included: this list is
              for picking a copy to go to, and the colour that says "added" /
              "removed" is spent in the Changes surface where the number is the
              change you're actually reading. (Colour lives in styles.css —
              `.ade-wrow .diff-add` / `.diff-del`.) */}
          {hasBadges && (
            <span className="badges">
              {badge && badge.added > 0 && (
                <span className="diff-add">+{compactCount(badge.added)}</span>
              )}
              {badge && badge.removed > 0 && (
                <span className="diff-del">−{compactCount(badge.removed)}</span>
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
          <button
            type="button"
            className="wrow-more"
            onClick={(e) =>
              openWorktreeMenu(e, root, w.path, title, canRemove, switchNo)
            }
            title="Parallel-copy actions — open, copy path, remove"
            aria-label="Parallel-copy actions"
          >
            <DotsIcon />
          </button>
          </span>
        </div>
      </WorktreeHover>
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
  const visible = [
    ...activeOrdered.filter((ws) => custom[ws.id]?.pinned),
    ...activeOrdered.filter((ws) => !custom[ws.id]?.pinned),
  ];
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

  return (
    // The copy rows carry their own hover bridge (`WorktreeHover`) — a
    // hand-rolled portal card, not a Medusa tooltip, because the card holds
    // interactive buttons a tooltip can't. No provider context needed.
    <div>
      {/* "Projects" section break + its controls (sort · new · fold-all) —
          Conductor's header cluster. The hairline divider separates the
          roster from the Build nav above; the label lines up with the
          project glyphs below. */}
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
              title="Add a project — open a folder"
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
      {visible.map((ws) => {
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
          const hasWork =
            (!!badge && (badge.added > 0 || badge.removed > 0)) || !!badge?.pr;
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
        // No per-project tint. A hashed hue on every folder made the list read
        // as a paint chart and gave colour a meaning it does not have — the
        // project name is the identity. The header falls back to the neutral
        // text ramp.
        return (
          <div className="ade-proj" key={ws.id}>
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
                      letter={projName.charAt(0).toUpperCase()}
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
                title={`${ws.id} — open`}
              >
                <span className="nm">{projName}</span>
              </button>
              {/* Project-level "working" tell — an agent or Aura chat is
                  mid-turn somewhere in this project. Sits on the identity line
                  so it shows even when the copies are folded away. */}
              {projWorking && (
                <span
                  className="ph-working"
                  title="Working — an agent or Aura chat is mid-turn in this project"
                  aria-label="Working"
                >
                  <AsciiSpinner className="text-[11px]" />
                </span>
              )}
              {custom[ws.id]?.pinned && (
                <span
                  title="Pinned to top"
                  aria-label="Pinned to top"
                  style={{
                    display: "inline-flex",
                    color: "var(--color-text-4)",
                    opacity: 0.7,
                  }}
                >
                  <PinIcon filled />
                </span>
              )}
              {/* Parallel-copy count chip — how many copies this project has.
                  Clicking opens the full Workspaces view scoped to it (the
                  curated few stay in the rail; the fleet lives in the view).
                  Shown only when there are copies beyond the surfaced rows. */}
              {onOpenAllCopies && inactive.length > 0 && (
                <button
                  type="button"
                  className="ph-count"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenAllCopies(ws.id);
                  }}
                  title={`${rows.length} parallel copies — open the Workspaces view`}
                  aria-label={`${rows.length} parallel copies — open the Workspaces view`}
                >
                  {rows.length}
                </button>
              )}
              {/* The header's one primary (create) affordance: start a new
                  parallel copy — a fresh worktree session — scoped to this
                  project. Reuses the global new-workspace composer (the same
                  one Crew's "New copy" opens) by naming this project, so the
                  copy lands here and its tabs stay within it. Persistent (like
                  Conductor's per-project +) but quiet; arctic-blue on hover
                  marks it as the create action. */}
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
                title="New parallel copy — start an agent on a fresh copy of this project"
                aria-label="New parallel copy"
              >
                <Icons.Plus size={14} />
              </button>
              <button
                type="button"
                className="ph-more"
                onClick={(e) => openProjectMenu(e, ws.id, projName)}
                title="Workspace actions — open, copy path, close"
                aria-label="Workspace actions"
              >
                <DotsIcon />
              </button>
            </div>

            {!isCollapsed && (
              <div className="ade-proj-rows">
                {primary.map((w) => renderRow(w, projName, ws.id))}
                {/* `aura work` sessions — the human's deliberate parallel
                    copies. Always switchable rows, never folded into the
                    "N parallel copies" count below. */}
                {workSessions.map((w) => renderRow(w, projName, ws.id))}
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
        );
      })}

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
                  <span className="ph-icon" style={{ marginLeft: 2 }}>
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
                    title={`${ws.id} — restore to your projects`}
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
                    title="Restore — bring this project back to your list"
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
                  title="Hides it from your list — your branch and files stay put"
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
                    title="Removes it from your list — your branch and files stay on disk"
                  >
                    <TrashIcon />
                    Remove repository
                  </button>
                )}
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
                        : "The main and active copies can't be removed"
                    }
                    onClick={() => {
                      if (menu.canRemove) onRemoveWorktree(menu.root, menu.path);
                      setMenu(null);
                    }}
                  >
                    <TrashIcon />
                    Remove parallel copy…
                  </button>
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

