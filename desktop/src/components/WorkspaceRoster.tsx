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
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as Icons from "./Icons";
import { RepoAvatar } from "./RepoAvatar";
import { WorktreeHoverCard } from "./WorktreeHoverCard";
import { WorktreeHover } from "./WorktreeHover";
import { useEditorStore, readPersistedAgents } from "../lib/editorStore";
import { isMachineLeaf } from "../lib/workspaceLabel";
import { api } from "../lib/api";
import { openPopout } from "../lib/popout";
import type { WorktreeBadge } from "../lib/useWorktreeBadges";
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
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"
        stroke="currentColor"
        strokeWidth="1.3"
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
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Small ✕ glyph for the destructive "Close workspace" item.
function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
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
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 3h3v3M13 3l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 207 → "207", 1432 → "1.4k". Keeps the diff badge from overrunning the
// row on large worktrees, matching the mockup's compact pills.
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
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

// Stable, subtle per-folder tint so each workspace reads as its own
// colour at a glance. FNV-1a hash of the id → hue; fixed S/L tuned for
// the dark theme so the colour is legible on a small glyph but never
// loud. Same id → same colour every session (no persistence needed).
function folderTint(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  // Low saturation keeps it a muted, tinted-grey — a hint of identity, not a
  // loud swatch. The same tint drives both the folder glyph and the name.
  return `hsl(${hue} 24% 62%)`;
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

// Worktree glyph — a git branch-fork whose branched-off node is FILLED,
// reading as "a live checkout split off the branch" (a git worktree). The
// row's leading identity mark for an Aura-made copy, distinct from the
// repo's own branch (the all-hollow GitBranch fork). Git-family, not the
// old clipboard/copy metaphor — the glyph says *what kind of place* the
// copy is, never who's driving it.
function WorktreeGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      className="wsa-glyph"
      aria-hidden
    >
      {/* source branch line + its two hollow nodes */}
      <circle cx="4.5" cy="3.8" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="4.5" cy="12.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      {/* the checked-out worktree, branched off and filled */}
      <path
        d="M4.5 8h4.2a1.6 1.6 0 0 0 1.6-1.6V5.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="11.3" cy="3.8" r="1.9" fill="currentColor" />
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
          className={`ade-wrow${isActive ? " active" : ""}`}
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
          {/* The row's identity is the COPY, never an agent. A hollow branch
              fork for the repo's own checkout; the filled-node worktree fork
              for an Aura-made copy — so the two kinds read apart at a glance,
              both plainly git. Who's driving it lives in the chips on the
              right. While ⌘ is held, the glyph swaps to this row's quick-
              switch number (⌘+N jumps to it). The raw ref + agent detail now
              live in the rich hover card, so no native tooltips compete. */}
          <span className="wsa">
            {cmdHeld && switchNo != null ? (
              <span className="wsa-num">{switchNo}</span>
            ) : w.is_main ? (
              <Icons.GitBranch size={15} className="wsa-glyph" />
            ) : (
              <WorktreeGlyph />
            )}
          </span>
          {/* The copy's readable name (humanized branch, e.g. "commons
              platform"); the raw ref drops to the hover card. */}
          <span className="name">{title}</span>
          {/* Diff + PR badges ride the name line — the copy's "how much
              changed here" at a glance, so the row stays one clean line. */}
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
                  title={`PR #${badge.pr.number} · ${badge.pr.state}`}
                >
                  #{badge.pr.number}
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
  const anyExpanded = ordered.some((ws) => !collapsed[ws.id]);
  const toggleAll = () => {
    setCollapsed(() => {
      if (!anyExpanded) return {}; // all folded → unfold every project
      const all: Record<string, boolean> = {};
      for (const ws of ordered) all[ws.id] = true;
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
      {ordered.map((ws) => {
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
        const projName = ws.id.split("/").pop() || ws.id;
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
        return (
          <div
            className="ade-proj"
            key={ws.id}
            style={{ "--folder-tint": folderTint(ws.id) } as CSSProperties}
          >
            <div
              className="ade-proj-h"
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
                  {ws.emoji ? (
                    <span className="glyph" style={{ fontSize: 14 }}>
                      {ws.emoji}
                    </span>
                  ) : (
                    // GitHub owner avatar when available, else the folder
                    // glyph (non-GitHub repos / 404 / still resolving).
                    <RepoAvatar
                      repoRoot={ws.id}
                      letter={projName.charAt(0).toUpperCase()}
                      size={15}
                      fallback={<Icons.Folder size={15} className="glyph" />}
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
                  onSelectProject?.(menu.wsId);
                  setMenu(null);
                }}
              >
                <Icons.Folder size={13} />
                Open workspace
              </button>
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
                New parallel copy
              </button>
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
              {onCloseProject && (
                <>
                  <div className="rm-sep" />
                  <button
                    type="button"
                    className="rm-item danger"
                    onClick={() => {
                      onCloseProject(menu.wsId);
                      setMenu(null);
                    }}
                  >
                    <CloseIcon />
                    Close workspace
                  </button>
                </>
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
    </div>
  );
}

