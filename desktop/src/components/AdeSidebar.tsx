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
// The app's one left sidebar (there used to be a flag and a second one); the
// legacy three-column shell stays the untouched default.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { TraceKey } from "./trace/traceDestinations";
import { SidebarFooter } from "./ade/SidebarFooter";
import { WhatsNewCard } from "./WhatsNewCard";
import type { ReleaseCta, ReleaseNote } from "../lib/releaseNotes";

export type AdeSection = "build" | "trace";

const SECTION_KEY = "aura.ade.section";

const SECTIONS: { id: AdeSection; label: string; glyph: ReactNode }[] = [
  { id: "build", label: "Build", glyph: <LayersGlyph /> },
  { id: "trace", label: "Trace", glyph: <ShieldGlyph /> },
];

// The nav renders `buildRows` in place of the "build" entry when the host
// supplies them (see the `buildRows` prop) — those rows ARE the Build section,
// named for the three places it holds. Hosts that don't pass them fall back to
// the plain "Build" row, so the section list stays whole either way.
const TAIL_SECTIONS = SECTIONS.filter((s) => s.id !== "build");

type AdeSidebarProps = {
  /** The rail's one body: your projects, and the checkouts under them.
   *
   *  This used to be four bodies swapped by section — Build's roster, Team's
   *  conversations, Pages' documents, Trace's menu of views — so the widest
   *  column on screen changed its subject every time you changed destination,
   *  and the projects, the one index that is true wherever you are standing,
   *  were visible in exactly one of them. Each of the other three has its own
   *  navigation on its own page now, which is where a page's navigation
   *  belongs. What is left is a rail that always answers the same question. */
  buildBody: ReactNode;
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
  /** The open project, for the foot of the rail — it resolves who `@me` is
   *  from this repo's roster, the same answer Team and Tasks show. Empty with
   *  no project open, which the footer reads as "can't name you". */
  repoRoot?: string;
  /** Set after a MINOR update — renders the small dismissible "what's new"
   *  card at the top of the sidebar. (Major updates show a modal instead, so
   *  this is undefined for them.) */
  whatsNew?: ReleaseNote;
  /** Dismiss the what's-new card (marks the version seen). */
  onDismissWhatsNew?: () => void;
  /** Take the note's offered action (e.g. open the phone-app waitlist). */
  onWhatsNewCta?: (kind: ReleaseCta) => void;
  /** The Build section's own destinations — Aura, Workspaces, Tasks (see
   *  BuildNav). They render as the HEAD of this one nav list rather than
   *  as a second band below it, and any click in them selects Build, because
   *  standing in one of them is standing in Build. Supplied, they replace the
   *  "Build" row entirely: a row captioning a group whose first entry says the
   *  same thing is a row spent on nothing. */
  buildRows?: ReactNode;
  /** Take the reader to a section's home surface.
   *
   *  Until this existed, these rows were a readout wearing a button's clothes.
   *  `activeSection` flows one way — the host derives it from whichever pane is
   *  focused, so the rail FOLLOWS the work surface — and a click here only set
   *  this component's own `section` state. The result was that clicking Team
   *  lit the Team row, swapped the rail to Team's channel list, and left
   *  Workspaces (or a file, or a board) sitting in the other 1268px. You asked
   *  to go to Team and the app changed its filing cabinet instead of its page.
   *
   *  So the host opens the section's home here, the surface changes, and
   *  `activeSection` comes back around and confirms the same section the click
   *  chose. Navigation stays one-way — surface is still the source of truth —
   *  and the rows become the doors they always looked like.
   *
   *  Not called for `build`: its rows (`buildRows`) are their own doors and
   *  carry their own handlers. */
  onNavigate?: (section: AdeSection) => void;
};

// How tall the destination list is allowed to be, in px. Persisted per
// device: where you put the split is a property of your screen, not of the
// project you happen to have open.
const NAV_H_KEY = "aura.ade.navHeight";

// One row plus the nav's own padding — the floor keeps at least one
// destination reachable, so a drag to the top can't hide the navigation.
const NAV_MIN_H = 44;

function readSection(): AdeSection {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    // "team" and "plan" are deliberately not read back. Both destinations are
    // gone, and a reader whose last visit was one of them would otherwise boot
    // into a section the app can no longer render.
    if (raw === "build" || raw === "trace") return raw;
  } catch {
    /* ignore */
  }
  return "build";
}

function readNavHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(NAV_H_KEY));
    return Number.isFinite(n) && n >= NAV_MIN_H ? n : null;
  } catch {
    return null;
  }
}

export function AdeSidebar({
  buildBody,
  activeSection,
  workspaceKey,
  traceCount = 0,
  repoRoot = "",
  whatsNew,
  onDismissWhatsNew,
  onWhatsNewCta,
  buildRows,
  onNavigate,
}: AdeSidebarProps) {
  const [section, setSection] = useState<AdeSection>(() => readSection());

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

  // ── the split between the destinations and your projects ───────────
  //
  // There used to be TWO hairlines here, a few pixels apart: the nav drew a
  // border under itself and the roster drew one over its "Projects" header,
  // neither knowing about the other. One line now, and since a line between
  // two lists that both want the room is a thing you should be able to move,
  // it is the handle as well — drag it, or grab it with the keyboard and use
  // the arrow keys; double-click gives the nav its natural height back.
  const navRef = useRef<HTMLElement | null>(null);
  const [navHeight, setNavHeight] = useState<number | null>(() =>
    readNavHeight(),
  );
  const [dragging, setDragging] = useState(false);

  // Never taller than the rows actually need: past that you'd be dragging out
  // blank space, and the projects below would lose room for nothing.
  const navMaxH = () => navRef.current?.scrollHeight ?? Infinity;
  const clampNav = (px: number) =>
    Math.round(Math.max(NAV_MIN_H, Math.min(navMaxH(), px)));

  const commitNav = (px: number | null) => {
    setNavHeight(px);
    try {
      if (px == null) localStorage.removeItem(NAV_H_KEY);
      else localStorage.setItem(NAV_H_KEY, String(px));
    } catch {
      /* private mode — the drag still holds for this session */
    }
  };

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const nav = navRef.current;
    if (!nav || e.button !== 0) return;
    e.preventDefault();
    const top = nav.getBoundingClientRect().top;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    let last = navHeight ?? nav.getBoundingClientRect().height;
    const move = (ev: PointerEvent) => {
      last = clampNav(ev.clientY - top);
      setNavHeight(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setDragging(false);
      commitNav(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  // Reserve the announcement's own height at the foot of the scroller.
  //
  // Measured rather than guessed: the card's height depends on how long the
  // release's headline wraps, and a hard-coded inset is either a gap under an
  // absent card or a project row stuck behind a present one. Observed, so a
  // rail resize that re-wraps the text re-reserves in the same frame.
  const stackRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const stack = stackRef.current;
    const notice = noticeRef.current;
    if (!stack) return;
    if (!notice) {
      stack.style.removeProperty("--ade-notice-h");
      return;
    }
    const apply = () =>
      stack.style.setProperty("--ade-notice-h", `${notice.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(notice);
    return () => ro.disconnect();
  }, [whatsNew]);

  const onDividerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const from =
        navHeight ?? navRef.current?.getBoundingClientRect().height ?? NAV_MIN_H;
      commitNav(clampNav(from + (e.key === "ArrowDown" ? step : -step)));
    } else if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      commitNav(null);
    }
  };

  return (
    <div className="ade-side">
      {/* Account + Settings + Help used to sit here as a top identity row;
          they were consolidated into the sidebar header strip (account +
          settings) — Help was dropped — so the sidebar body starts straight
          at the section content. The what's-new notice used to sit here too;
          it lives in the announcement slot at the foot of the rail now, so
          shipping a release no longer pushes the project list down the page
          (see `.ade-side-stack` below). */}

      {/* The app's destinations, at the top, where navigation goes. They used
          to live in the sidebar's FOOTER as stacked icon tiles ~850px below
          the panel they control — a switch that far from its effect reads as a
          status bar, not a spine: the rail said "Trace" at the top and the only
          way to leave Trace was at the very bottom of the window.

          ONE list, one treatment. Until now this was two: four section rows
          here, then a hairline, then Aura / Workspaces / Mission Control as a
          second band in smaller type with an accent-tint active state against
          this band's surface fill. Both bands held destinations, so the split
          was asking the reader to infer a rule that didn't exist, and it cost
          a whole row to the word "Build" — the caption of a group whose first
          entry already said it, in a word that means nothing to someone who
          doesn't write code. The lit row is the lit row, wherever you are. */}
      <nav
        ref={navRef}
        className="ade-nav"
        aria-label="Sections"
        style={navHeight != null ? { height: navHeight } : undefined}
      >
        {buildRows ? (
          // `display: contents` — the rows are siblings of the ones below, not
          // a group. The wrapper exists only to catch their clicks (standing in
          // any of them is standing in Build) and to hold back their active
          // paint while the reader is off in Team / Pages / Trace, where those
          // rows are not where they are.
          <div
            className={`ade-navgrp${section === "build" ? " on" : ""}`}
            onClickCapture={() => setSection("build")}
          >
            {buildRows}
          </div>
        ) : null}
        {(buildRows ? TAIL_SECTIONS : SECTIONS).map((s) => {
          const count = s.id === "trace" ? traceCount : 0;
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              data-tour={`section-${s.id}`}
              className={`ade-nav-row${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                setSection(s.id);
                // …and go there. See `onNavigate`.
                onNavigate?.(s.id);
              }}
            >
              {s.glyph}
              <span className="nm">{s.label}</span>
              {/* Not while you're standing in it. The badge exists to tell you
                  from elsewhere that something is waiting; the section itself
                  says so again, in the same amber, on the row you'd actually
                  click to read it ("Impacts on me" in Trace). One number on
                  screen, and it's the one nearest the thing it's about. */}
              {count > 0 && !active ? <CountBadge count={count} /> : null}
            </button>
          );
        })}
      </nav>

      {/* The one line between them, and the handle for it. */}
      <div
        className={`ade-nav-split${dragging ? " dragging" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the destinations list"
        tabIndex={0}
        onPointerDown={onDividerDown}
        onDoubleClick={() => commitNav(null)}
        onKeyDown={onDividerKey}
      />

      {/* Your projects, under the nav, in every section — never swapped out
          for a second index that belongs to somewhere you're only visiting.

          The stack holds two layers: the list, which scrolls, and the
          announcement, which doesn't. The announcement is pinned over the
          foot of the list rather than stacked above or below it, so it never
          takes a row away from the index — the list keeps the full column and
          simply passes underneath, dissolving into the card through the fade
          the slot draws above itself. The scroller reserves exactly the
          card's measured height at its bottom, so the last project can still
          be scrolled clear of it instead of sitting permanently behind it. */}
      <div ref={stackRef} className="ade-side-stack">
        <div className="ade-side-body">
          <div className="ade-sec show">{buildBody}</div>
        </div>
        {whatsNew ? (
          <div ref={noticeRef} className="ade-side-notice">
            <WhatsNewCard
              note={whatsNew}
              onDismiss={() => onDismissWhatsNew?.()}
              onCta={onWhatsNewCta}
            />
          </div>
        ) : null}
      </div>

      {/* The foot of the rail. The nav that used to sit here was moved to the
          top (a destination switcher belongs beside what it switches), which
          left the bottom edge saying nothing at all. What belongs at a bottom
          edge is standing and shelter: which plan you're on, and the two doors
          — help and settings — that have no section of their own. */}
      <SidebarFooter repoRoot={repoRoot} />
    </div>
  );
}

/* ── section notification counts ──────────────────────────────────── */

// A count of things waiting on you, as a trailing pill on the destination
// row. It used to be a badge overhanging the corner of a stacked icon tile,
// which is the shape you reach for when the control has no room for a
// number beside its label — a row has that room, so the count sits inline
// where every other count in this rail sits.
// Amber, not red — new work waiting is an ask, and red has to keep meaning
// "this broke". Not the accent either: in this rail the accent marks WHERE
// YOU ARE, so filling every count with it drowns the one signal it exists to
// carry and leaves the whole panel reading as a single tinted wash.
const SEG_BADGE_INK: CSSProperties = {
  background: "var(--color-amber)",
  color: "var(--color-bg-0)",
};

function CountBadge({ count }: { count: number }) {
  return (
    <span className="unread" style={SEG_BADGE_INK} aria-label={`${count} new`}>
      {/* Capped at 99, not 9. Team had 70 unread messages and this badge said
          "9+" while the Unreads row one click away said "70" — the same number
          rendered two ways, and the one you see first is the one that throws
          away the magnitude. Seventy waiting is a different day from ten. */}
      {count > 99 ? "99+" : count}
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

// ── Trace section — the moat: accountability + insight tools ────────
// Every row dispatches to an existing surface/dialog/CLI; no row is a
// placeholder.
export type TraceActions = {
  onOverview: () => void;
  onSessions: () => void;
  onTeamActivity: () => void;
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
  onAttest: () => void;
  /** Opens Code Map / Project health. Both are parked behind their own flags,
   *  so the strip has no cell for either and nothing calls these until a flag
   *  comes back on — they stay in the bag so flipping one is a one-line
   *  change rather than a re-wiring. */
  onCodeMap: () => void;
  onDoctor: () => void;
  /** Unresolved cross-branch impact count. Drives the conditional
   *  "Impacts on me" row — when 0 the row is hidden entirely (nothing is
   *  reaching your work, so it's not a dead menu entry); when >0 the row
   *  appears with a count chip. The surface itself still carries an
   *  educating empty state for when it's opened by other means. */
  impactsCount?: number;
  // Which launcher row maps to the center pane on screen. Lets the rail
  // highlight "you are here" instead of reading as a flat tool menu —
  // the same cue the section tab strip gives, one level down. Shared with the
  // surface strip (TraceKey) so the two entrances light for the same reasons.
  activeKey?: TraceKey | null;
  /** Goals and Safety check are the two rows that ASK rather than navigate:
   *  they hand a question to Aura and the answer arrives in the chat, so they
   *  can never be `activeKey` (no pane opens). Set this while the question is
   *  out and the row spins instead of taking a second click. */
  busyKey?: "goals" | "review" | null;
};

// The glyphs each Trace destination wears now live beside the destination
// list itself (components/trace/traceDestinations.tsx), because the surface
// strip draws the same marks and a mark defined in a sidebar is a mark the
// other entrance has to copy. Imported above for the legacy layout, which
// still names its rows by hand.

// TraceRow + TraceBody used to live here: Trace's ten destinations, drawn
// as a 232px column of rows under the nav. The switcher is on the surface
// now (components/trace/TraceTabs.tsx), above whichever Trace pane is open,
// and nothing rendered these any more. A rail nobody can reach is not a
// fallback, it is a second copy of a menu waiting to disagree with the
// first — so it is gone rather than parked behind a flag. The destinations
// themselves live in components/trace/traceDestinations.tsx.
