// ADE redesign (W1) — consolidated left sidebar shell.
//
// Replaces the old workspace-rail + icon-rail + sidebar trio with one
// panel: a body that shows the active section and a 4-up footer
// switcher. The brand + settings + profile that used to sit in a head
// row here moved up to the TopBar in the chrome consolidation, so the
// sidebar starts flush under the topbar. This component is a pure
// shell — each section's contents are passed in as a slot so the real
// work (FilesSidebar, CommsPanel, Tasks/Pages, History + trace tools)
// is reused verbatim from the existing app, nothing rebuilt.
//
// Rendered only when the `aura.ade.v2` flag is on (see useAdeV2); the
// legacy three-column shell stays the untouched default.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CODE_MAP_ENABLED,
  MEMORY_SURFACE_ENABLED,
  TEAM_ACTIVITY_ENABLED,
  TIMELINE_V2,
  TRACE_V2,
} from "../lib/featureFlags";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import {
  readTeamUnread,
  subscribeTeamUnread,
  type TeamUnreadSummary,
} from "../lib/teamUnread";
import { WhatsNewCard } from "./WhatsNewCard";
import type { ReleaseNote } from "../lib/releaseNotes";

export type AdeSection = "build" | "team" | "plan" | "trace";

const SECTION_KEY = "aura.ade.section";

const SECTIONS: { id: AdeSection; label: string; glyph: ReactNode }[] = [
  { id: "build", label: "Build", glyph: <LayersGlyph /> },
  { id: "team", label: "Team", glyph: <MessageGlyph /> },
  { id: "plan", label: "Plan", glyph: <KanbanGlyph /> },
  { id: "trace", label: "Trace", glyph: <ShieldGlyph /> },
];

type AdeSidebarProps = {
  buildBody: ReactNode;
  teamBody: ReactNode;
  planBody: ReactNode;
  traceBody: ReactNode;
  /** ADE auto-follow — the section to surface for whatever the user is
   *  looking at in the center pane (Build for an agent/terminal/file,
   *  Plan for the Tasks board / a Page, etc.). Re-selecting only fires
   *  when this value changes, so a manual footer pick sticks until the
   *  next pane switch. */
  activeSection?: AdeSection;
  /** The active workspace root. When it changes (the user switched
   *  workspaces) the sidebar resets to Build — opening a workspace lands
   *  on the Build home, never inherits the incoming workspace's restored
   *  Plan/Trace focus. In-session pane-follow (`activeSection`) resumes
   *  for subsequent user-driven switches within the workspace. */
  workspaceKey?: string;
  /** Unresolved Trace alerts (cross-branch impacts + git conflicts) —
   *  drives the Trace segment's notification badge. 0 hides it. Team's
   *  badge is sourced internally from the live chat unread bridge. */
  traceCount?: number;
  /** Set after a MINOR update — renders the small dismissible "what's new"
   *  card at the top of the sidebar. (Major updates show a modal instead, so
   *  this is undefined for them.) */
  whatsNew?: ReleaseNote;
  /** Dismiss the what's-new card (marks the version seen). */
  onDismissWhatsNew?: () => void;
};

function readSection(): AdeSection {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    if (
      raw === "build" ||
      raw === "team" ||
      raw === "plan" ||
      raw === "trace"
    )
      return raw;
  } catch {
    /* ignore */
  }
  return "build";
}

export function AdeSidebar({
  buildBody,
  teamBody,
  planBody,
  traceBody,
  activeSection,
  workspaceKey,
  traceCount = 0,
  whatsNew,
  onDismissWhatsNew,
}: AdeSidebarProps) {
  const [section, setSection] = useState<AdeSection>(() => readSection());

  // Live team unread (count + who sent it) from CommsPanel's bridge —
  // seeded from localStorage so the badge is right on first paint.
  const [teamUnread, setTeamUnread] = useState<TeamUnreadSummary>(() =>
    readTeamUnread(),
  );
  useEffect(() => subscribeTeamUnread(setTeamUnread), []);

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_KEY, section);
    } catch {
      /* private mode — best-effort */
    }
  }, [section]);

  // Auto-follow the active center pane. Keyed on `activeSection` ONLY —
  // never on `section` — so a manual footer click (which mutates
  // `section`) doesn't immediately get reverted; it survives until the
  // user next switches the center pane to a different section.
  useEffect(() => {
    if (activeSection) setSection(activeSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  // Workspace switch → land on Build. Declared AFTER the auto-follow
  // effect so that on a switch (where both `activeSection` and
  // `workspaceKey` change in the same commit) this runs last and wins,
  // overriding the incoming workspace's restored Plan/Trace focus. The
  // first-mount run is skipped so app boot keeps the persisted section.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (!bootedRef.current) {
      bootedRef.current = true;
      return;
    }
    setSection("build");
  }, [workspaceKey]);

  const bodies: Record<AdeSection, ReactNode> = {
    build: buildBody,
    team: teamBody,
    plan: planBody,
    trace: traceBody,
  };

  return (
    <div className="ade-side">
      {whatsNew ? (
        <WhatsNewCard
          note={whatsNew}
          onDismiss={() => onDismissWhatsNew?.()}
        />
      ) : null}
      <div className="ade-side-body">
        {SECTIONS.map((s) => (
          <div
            key={s.id}
            className={`ade-sec${section === s.id ? " show" : ""}`}
          >
            {bodies[s.id]}
          </div>
        ))}
      </div>

      <div className="ade-side-foot">
        <div className="ade-seg">
          {SECTIONS.map((s) => {
            const count = s.id === "team"
              ? teamUnread.total
              : s.id === "trace"
                ? traceCount
                : 0;
            return (
              <button
                key={s.id}
                type="button"
                className={section === s.id ? "active" : ""}
                onClick={() => setSection(s.id)}
                title={s.label}
              >
                {s.glyph}
                {s.label}
                {count > 0 ? <CountBadge count={count} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── segment notification badges ──────────────────────────────────── */

// Count badge for the section buttons: a plain dot for a single item, a
// numbered pill (capped 9+) once there's more than one.
function CountBadge({ count }: { count: number }) {
  if (count <= 1) {
    return <span className="ade-seg-badge ade-seg-badge--dot" aria-hidden />;
  }
  return (
    <span className="ade-seg-badge" aria-label={`${count} new`}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

/* ── inline glyphs (stroke = currentColor; sized via CSS) ──────────── */

function LayersGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2 2 7l10 5 10-5-10-5Z" strokeLinejoin="round" />
      <path d="m2 17 10 5 10-5" strokeLinejoin="round" />
      <path d="m2 12 10 5 10-5" strokeLinejoin="round" />
    </svg>
  );
}

function MessageGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KanbanGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 7v7M12 7v10M16 7v4" strokeLinecap="round" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"
        strokeLinejoin="round"
      />
      <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Small generic row glyph — one consistent stroke style across the
// Plan/Trace launcher rows. `moat` paints it with the accent so the
// Trace "Accountability" tools read as the differentiated moat.
function RowGlyph({ children, moat }: { children: ReactNode; moat?: boolean }) {
  return (
    <svg
      className="ade-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={moat ? { color: "var(--color-accent)" } : undefined}
    >
      {children}
    </svg>
  );
}

// ── Plan section — Tasks + Pages launchers ──────────────────────────
// Real openers: clicking opens the same Tasks board / Pages surface the
// legacy rail tiles did. Richer in-section lists (task filters, page
// summaries) are a follow-up; these never no-op.
export function PlanBody({
  onOpenTasks,
  onOpenPages,
}: {
  onOpenTasks: () => void;
  onOpenPages: () => void;
}) {
  return (
    <div>
      <div className="ade-sec-h">Tasks</div>
      <button type="button" className="ade-row" onClick={onOpenTasks}>
        <RowGlyph>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M8 7v10M12 7v6M16 7v8" />
        </RowGlyph>
        <span className="nm">Board</span>
      </button>
      <div className="ade-sec-h">Pages</div>
      <button type="button" className="ade-row" onClick={onOpenPages}>
        <RowGlyph>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
          <path d="M14 3v6h6M8 13h8M8 17h6" />
        </RowGlyph>
        <span className="nm">Open Pages</span>
      </button>
    </div>
  );
}

// ── Plan section (rich) — Tasks board + Pages, combined under one ───
// sub-tab toggle. The actual TasksSidebar / PagesSidebarMount surfaces
// are passed in by the host (App) and mounted here, so the old takeover
// panels are re-homed into Plan rather than removed; clicking an item
// still opens the board / page in the center pane.
const PLAN_SUBTAB_KEY = "aura.ade.plan";
type PlanSubtab = "tasks" | "pages";

export function PlanSection({
  tasksView,
  pagesView,
  activeSubtab,
  onOpenTasks,
  onOpenPages,
  onOpenStandup,
  onOpenAutomations,
}: {
  tasksView: ReactNode;
  pagesView: ReactNode;
  /** ADE auto-follow — when the active center pane is a Tasks tab this
   *  is "tasks", a Page "pages"; the toggle re-selects to match so the
   *  rail mirrors the pane. Undefined (Standup / a plan doc) leaves the
   *  user's current toggle untouched. Only re-syncs on value change, so
   *  a manual sub-tab pick sticks until the next pane switch. */
  activeSubtab?: PlanSubtab;
  /** Open/focus the Tasks board center pane when the Tasks sub-tab is
   *  picked — otherwise the sub-tab only swaps the left rail and the
   *  board never surfaces. */
  onOpenTasks?: () => void;
  /** Open/focus the Pages center pane when the Pages sub-tab is picked. */
  onOpenPages?: () => void;
  /** Open the Standup rollup as a center {standup} pane. */
  onOpenStandup?: () => void;
  /** Open the Automations surface as a center {automations} pane. Re-homed
   *  here from the Build rail — scheduled / orchestrated runs are planning. */
  onOpenAutomations?: () => void;
}) {
  const [tab, setTab] = useState<PlanSubtab>(() => {
    try {
      return localStorage.getItem(PLAN_SUBTAB_KEY) === "pages"
        ? "pages"
        : "tasks";
    } catch {
      return "tasks";
    }
  });

  // Mirror the active center pane's kind onto the Tasks/Pages toggle.
  // Keyed on `activeSubtab` only (same reasoning as AdeSidebar's section
  // sync): a manual toggle persists until the next pane switch. This
  // does NOT call onOpenTasks/onOpenPages — the pane is already the one
  // driving this value, so re-opening would be a redundant focus churn.
  useEffect(() => {
    if (!activeSubtab) return;
    setTab(activeSubtab);
    try {
      localStorage.setItem(PLAN_SUBTAB_KEY, activeSubtab);
    } catch {
      /* private mode — best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubtab]);
  const pick = (t: PlanSubtab) => {
    setTab(t);
    try {
      localStorage.setItem(PLAN_SUBTAB_KEY, t);
    } catch {
      /* private mode — best-effort */
    }
    // Surface the matching center pane so picking the sub-tab actually
    // shows the board / pages, not just the left rail.
    if (t === "tasks") onOpenTasks?.();
    else onOpenPages?.();
  };
  return (
    <div className="ade-subsec">
      <div className="ade-subtabs">
        <button
          type="button"
          className={tab === "tasks" ? "active" : ""}
          onClick={() => pick("tasks")}
        >
          Tasks
        </button>
        <button
          type="button"
          className={tab === "pages" ? "active" : ""}
          onClick={() => pick("pages")}
        >
          Pages
        </button>
        {onOpenAutomations && (
          <button
            type="button"
            className="ade-subtab-aux"
            title="Automations — schedule and orchestrate agent runs"
            onClick={onOpenAutomations}
          >
            Automations
          </button>
        )}
        {onOpenStandup && (
          <button
            type="button"
            className="ade-subtab-aux"
            title="A quick summary of what everyone got done"
            onClick={onOpenStandup}
          >
            Standup
          </button>
        )}
      </div>
      <div className="ade-sec-fill">
        {tab === "tasks" ? tasksView : pagesView}
      </div>
    </div>
  );
}

// ── Trace section — the moat: accountability + insight tools ────────
// Every row dispatches to an existing surface/dialog/CLI; no row is a
// placeholder.
export type TraceActions = {
  onOverview: () => void;
  onSessions: () => void;
  onTeamActivity: () => void;
  onCostUsage: () => void;
  onIntentAst: () => void;
  onReview: () => void;
  /** Opens the "Ready to ship" surface (Semantic CI) — secrets, half-finished
   *  code, and a clean build, in plain language. Named apart from "Safety
   *  check" so the two never read as synonyms. Lives here in Trace (its one
   *  home), not on the Build rail. */
  onChecks: () => void;
  onImpacts: () => void;
  onProve: () => void;
  onRewind: () => void;
  /** Opens the full-screen Project Timeline — relive how the project evolved
   *  (intent + sessions + code) on a scrubbable bottom timeline. Gated by
   *  TIMELINE_V2; the row is hidden when the flag is off. */
  onTimeline: () => void;
  onAttest: () => void;
  onCodeMap: () => void;
  onMemory: () => void;
  onDoctor: () => void;
  /** Unresolved cross-branch impact count. Drives the conditional
   *  "Impacts on me" row — when 0 the row is hidden entirely (nothing is
   *  reaching your work, so it's not a dead menu entry); when >0 the row
   *  appears with a count chip. The surface itself still carries an
   *  educating empty state for when it's opened by other means. */
  impactsCount?: number;
  // Which launcher row maps to the center pane on screen. Lets the rail
  // highlight "you are here" instead of reading as a flat tool menu —
  // the same cue the section tab strip gives, one level down.
  activeKey?:
    | "overview"
    | "sessions"
    | "team"
    | "usage"
    | "goals"
    | "intent"
    | "review"
    | "checks"
    | "impacts"
    | "rewind"
    | "timeline"
    | "attest"
    | "doctor"
    | "memory"
    | null;
};

// Reused row glyphs (kept as elements so both the v2 and legacy layouts
// draw identical icons).
const GLYPH_INTENT_AST = (
  <>
    <path d="M5 9a4 4 0 0 0 4 4h6M19 15a4 4 0 0 1-4-4H9" />
    <path d="m16 6 3 3-3 3M8 18l-3-3 3-3" />
  </>
);
const GLYPH_REVIEW = (
  <path d="M12 3v18M3 7h18M6 7l-3 6a3 3 0 0 0 6 0ZM18 7l-3 6a3 3 0 0 0 6 0Z" />
);
const GLYPH_GOAL = (
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </>
);
const GLYPH_REWIND = (
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </>
);
const GLYPH_ATTEST = (
  <>
    <path d="M12 2 4 5v6c0 5 8 11 8 11s8-6 8-11V5Z" />
    <path d="m9 12 2 2 4-4" />
  </>
);
const GLYPH_MEMORY = (
  <>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </>
);
const GLYPH_DOCTOR = (
  <>
    <path d="M5 3v6a5 5 0 0 0 10 0V3" />
    <path d="M5 3H3M15 3h2M10 14v3a4 4 0 0 0 8 0v-1" />
    <circle cx="18" cy="13" r="2" />
  </>
);
const GLYPH_CODEMAP = (
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <circle cx="9" cy="18" r="2.5" />
    <path d="M8 7.5 15.5 9M8 16l1.5-7" />
  </>
);
const GLYPH_OVERVIEW = (
  <>
    <path d="M5 18a8 8 0 1 1 14 0" />
    <path d="M12 14.5 16 9" strokeLinecap="round" />
    <circle cx="12" cy="14.5" r="1.1" />
  </>
);
const GLYPH_SESSIONS = (
  <>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="13" width="18" height="5" rx="1.5" />
    <path d="M7 6.5h.01M7 15.5h.01" />
  </>
);
// Team activity — two figures + a pulse line, hinting "what everyone's AI is
// doing to our project, as it happens".
const GLYPH_TEAM_ACTIVITY = (
  <>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 4.5a3 3 0 0 1 0 5.8M18.5 19a5.5 5.5 0 0 0-3-4.9" />
  </>
);
// Cost & usage — a banknote: a rounded bill with a coin in the middle,
// hinting "what this is costing us in tokens and dollars".
const GLYPH_USAGE = (
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 9.5v5M18 9.5v5" />
  </>
);
// Cross-branch impacts — a git-fork: a left trunk with two nodes and a
// branch node on the right curving back, hinting "a change on another
// branch reaches yours".
const GLYPH_IMPACTS = (
  <>
    <path d="M6 4v16" />
    <circle cx="6" cy="5" r="1.9" />
    <circle cx="6" cy="19" r="1.9" />
    <circle cx="18" cy="8" r="1.9" />
    <path d="M18 10a6 6 0 0 1-6 6H6" />
  </>
);
// Safety check — a shield with a check, hinting "a second set of eyes
// finds bugs, security holes, and things that don't match the ask".
const GLYPH_SAFETY = (
  <>
    <path d="M12 3 5 5.5v5.2c0 4.4 3 7.3 7 8.8 4-1.5 7-4.4 7-8.8V5.5Z" />
    <path d="m9 11.5 2 2 4-4.2" />
  </>
);

// Project timeline — a churn sparkline over a baseline with a playhead dot,
// echoing the scrubber: "scrub the project's history and watch it evolve".
const GLYPH_TIMELINE = (
  <>
    <path d="M3 17h18" />
    <path d="M7 17v-3M11 17v-6M15 17v-2.5M19 17v-7" />
    <circle cx="11" cy="11" r="1.9" />
  </>
);

function TraceRow({
  onClick,
  glyph,
  label,
  moat,
  active,
  hint,
  count,
}: {
  onClick: () => void;
  glyph: ReactNode;
  label: string;
  moat?: boolean;
  active?: boolean;
  /** Plain-language "what is this" — several Trace tools have jargon
   *  labels (Attestations, Intent ↔ AST). Shown as a styled tooltip. */
  hint?: string;
  /** Optional trailing count chip (e.g. the number of impacts reaching
   *  your work). Omitted/0 renders nothing. */
  count?: number;
}) {
  const btn = (
    <button
      type="button"
      className={`ade-row${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={hint ? `${label} — ${hint}` : undefined}
      onClick={onClick}
    >
      <RowGlyph moat={moat}>{glyph}</RowGlyph>
      <span className="nm">{label}</span>
      {count && count > 0 ? (
        <span
          className="ml-auto flex-shrink-0 min-w-[18px] text-center rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
          style={{
            background: "color-mix(in oklab, var(--color-amber) 18%, transparent)",
            color: "var(--color-amber)",
          }}
          aria-label={`${count} ${count === 1 ? "impact" : "impacts"}`}
        >
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
  if (!hint) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[220px]">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

export function TraceBody(actions: TraceActions) {
  // Trace v2 — the calm entire.io-style spine: a short primary nav
  // (Overview · Sessions · Goals), then the semantic / cryptographic
  // moat under "Verify", then the heavier "Tools". Pull Requests moved
  // out to the right rail's PRs tab (one home), so they're absent here.
  if (TRACE_V2) {
    const k = actions.activeKey ?? null;
    const impactsCount = actions.impactsCount ?? 0;
    // Rail organized around the QUESTION each tool answers, not the kind of
    // tool it is: what happened + what it taught Aura (Activity, incl.
    // Memory), is my work sound (Trust & safety), travel the past / undo
    // (History), then quiet utilities (More). "Did it match?" and "Genuine
    // records" left the rail — they're per-change facts that now live ON each
    // session/change in the detail view (the Alignment + Attestation tabs),
    // not as top-level menu sections. Every concept has exactly ONE home.
    return (
      // 6px horizontal gutter so every row's active pill insets from the
      // rail edge (instead of bleeding to it) and section headers + row
      // glyphs land at a consistent 14px — the shared rail inset that
      // Tasks/Pages now match.
      <div className="px-1.5">
        {/* Rail title — shield glyph + name. Gives Trace the header the
            other sections get from their own chrome (Plan's sub-tabs,
            Build's nav) and restores the top breathing room the flush
            full-bleed mount otherwise loses. */}
        <div className="ade-rail-title">
          <ShieldGlyph />
          <span>Trace</span>
        </div>

        {/* Landing summary — ungrouped. Links down to every canonical home;
            renders no full dashboard of its own. */}
        <TraceRow onClick={actions.onOverview} glyph={GLYPH_OVERVIEW} label="Overview" active={k === "overview"} hint="Live activity, headline numbers, and a one-line cost summary — at a glance, links to the rest." />

        {/* What happened — and what it taught Aura. Your runs and the team's
            are the raw activity; Memory is its durable distillation: the
            decisions, conventions, and gotchas Aura now carries into every
            session. Memory lives HERE, beside the sessions that produced it,
            instead of buried next to the undo button — the raw → distilled
            story reads top to bottom. */}
        <div className="ade-sec-h">Activity</div>
        <TraceRow onClick={actions.onSessions} glyph={GLYPH_SESSIONS} label="My sessions" moat active={k === "sessions"} hint="Your own AI coding sessions — open any run to see what changed and why." />
        {TEAM_ACTIVITY_ENABLED && (
          <TraceRow onClick={actions.onTeamActivity} glyph={GLYPH_TEAM_ACTIVITY} label="Team activity" moat active={k === "team"} hint="Every AI change across your team — who made it, why, and if it touches the work you're in." />
        )}
        {MEMORY_SURFACE_ENABLED && (
          <TraceRow onClick={actions.onMemory} glyph={GLYPH_MEMORY} label="Memory" moat active={k === "memory"} hint="What Aura remembers about this project — the decisions, conventions, and gotchas it carries into every session. Search it, see where each fact came from, and forget anything that's wrong." />
        )}

        {/* Two trust rungs: built right (Goals) → reviewed (Safety check).
            Each answers a distinct question so neither reads as a synonym of
            the other. "Ready to ship" used to be a third rung here — it's now
            an ambient pill at the commit moment (CommitInput's ShipReadyPill),
            a live status rather than a place you navigate to. Impacts shows
            only when something on another branch actually reaches your work. */}
        <div className="ade-sec-h">Trust &amp; safety</div>
        <TraceRow onClick={actions.onProve} glyph={GLYPH_GOAL} label="Goals" moat active={k === "goals"} hint="Pick something you asked for and confirm it's truly built — Aura traces it through the real code, end to end." />
        <TraceRow onClick={actions.onReview} glyph={GLYPH_SAFETY} label="Safety check" moat active={k === "review"} hint="A second set of eyes on your changes — bugs, security holes, and things that don't match what you asked." />
        {impactsCount > 0 && (
          <TraceRow
            onClick={actions.onImpacts}
            glyph={GLYPH_IMPACTS}
            label="Impacts on me"
            moat
            active={k === "impacts"}
            count={impactsCount}
            hint="Code you depend on changed on another branch — fix or acknowledge before it bites."
          />
        )}

        {/* The past, in one home: browse how the project came to be (Project
            timeline). The old separate "Time machine" browse row is gone — its
            unique job, bringing a single past version back, now lives where you
            actually SEE the change: a "Bring this back" on each changed piece
            inside a session's Changes tab (My sessions). One verb, one place,
            no second list that does the same thing. The full Time-machine view
            is still reachable on demand — right-click a symbol → "Bring back",
            or from a session's Change story. */}
        {TIMELINE_V2 && (
          <>
            <div className="ade-sec-h">History</div>
            <TraceRow onClick={actions.onTimeline} glyph={GLYPH_TIMELINE} label="Project timeline" moat active={k === "timeline"} hint="Relive how the project came to be — scrub a bottom timeline through every moment, with the reason and the code behind it." />
          </>
        )}

        {/* Quiet utilities — money, diagnostics, and the structural map. */}
        <div className="ade-sec-h">More</div>
        <TraceRow onClick={actions.onCostUsage} glyph={GLYPH_USAGE} label="Cost &amp; usage" active={k === "usage"} hint="Token spend and per-developer cost — this month and all time, the one home for usage." />
        <TraceRow onClick={actions.onDoctor} glyph={GLYPH_DOCTOR} label="Project health" active={k === "doctor"} hint="A quick health check of your project — finds anything stuck or half-set-up before it trips you, and tells you how to fix it." />
        {CODE_MAP_ENABLED && (
          <TraceRow onClick={actions.onCodeMap} glyph={GLYPH_CODEMAP} label="Code Map" hint="A map of your project's files and how they connect — what touches what." />
        )}
      </div>
    );
  }

  // Legacy layout (flag off) — Accountability + Insight, unchanged.
  return (
    <div>
      <div className="ade-sec-h">Accountability</div>
      <TraceRow onClick={actions.onIntentAst} glyph={GLYPH_INTENT_AST} label="Change story" moat />
      <TraceRow onClick={actions.onReview} glyph={GLYPH_REVIEW} label="Semantic Review" moat />
      <TraceRow onClick={actions.onProve} glyph={GLYPH_GOAL} label="Prove a goal" moat />
      <TraceRow onClick={actions.onRewind} glyph={GLYPH_REWIND} label="Rewind" moat />
      <TraceRow onClick={actions.onAttest} glyph={GLYPH_ATTEST} label="Attestations" moat />
      <div className="ade-sec-h">Insight</div>
      {CODE_MAP_ENABLED && (
        <TraceRow onClick={actions.onCodeMap} glyph={GLYPH_CODEMAP} label="Code Map" />
      )}
      {MEMORY_SURFACE_ENABLED && (
        <TraceRow onClick={actions.onMemory} glyph={GLYPH_MEMORY} label="Memory" />
      )}
      <TraceRow onClick={actions.onDoctor} glyph={GLYPH_DOCTOR} label="Doctor" />
    </div>
  );
}

