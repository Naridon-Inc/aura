// TeamActivityFeed — the team-wide accountability feed for the Trace surface.
//
// This is the surface that answers the team-wide question the rest of Trace
// only answered for one session at a time: "what has everyone's AI done to
// our project, can I trust it, and does any of it touch the work I'm in the
// middle of?" It reads the SHARED intent log (`api.auraIntentRecent`) — the
// same git-tracked record that travels to every teammate on pull — and lays
// each AI change out as a plain accountability card:
//
//   <agent> changed <file>  ·  why, in their own words  ·  ✓ sealed  ·  2h
//   ⚠ touches a file you're editing
//
// HONESTY RULE (inherited from OverviewPane / SessionsPane): every line is a
// real, observed signal. The "sealed" badge keys off `signed_block_id` (in
// the shared log); "touches a file you're editing" keys off the live
// git-dirty set (best-effort — if git status can't be read, the tag simply
// doesn't show, it is never faked). When the log is empty we render a calm
// empty state, never invented rows.
//
// Clicking a card opens the same SessionDetailPane drill the Sessions list
// uses, so the feed is the breadth lens and the detail is the depth lens —
// one model, two zooms.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ClaudeSession,
  type IntentRow,
  type TeamMember,
} from "../../lib/api";
import { agentDisplayLabel } from "../../lib/agentIdentity";
import { AgentIcon } from "../agent/AgentIcon";
import { Button } from "../ui/button";
import { initialsOf, relTimeFromTs } from "./usageProviders";
import {
  collapseAutoStubSessions,
  type SessionDisplayRow,
} from "../../lib/sessionMeta";

const DAY_MS = 86_400_000;

/** Last path segment — "src/foo/bar.rs" → "bar.rs". */
function baseName(path: string): string {
  const p = (path ?? "").replace(/[/\\]+$/, "");
  if (!p) return "";
  const parts = p.split(/[/\\]+/);
  return parts[parts.length - 1] || p;
}

/** Collapse an intent to one tidy line, truncated so a long backfill summary
 *  doesn't blow out the card. */
function oneLine(s: string, max = 140): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** A stable local-day key (YYYY-MM-DD) for bucketing. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A friendly day heading — "Today" / "Yesterday" / "Tuesday" / "12 Jun". */
function dayLabel(d: Date, nowMs: number): string {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - that.getTime()) / DAY_MS);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return WEEKDAYS[that.getDay()];
  return `${that.getDate()} ${MONTHS[that.getMonth()]}`;
}

/** Normalize a changeset/git path to a comparable key (trailing slashes off,
 *  back-slashes folded). Lets the dirty-set intersection ignore separator and
 *  trailing-slash noise. */
function pathKey(p: string): string {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

type DayGroup = { key: string; label: string; rows: SessionDisplayRow[] };

function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

/** A small green tick-in-shield — the "genuine record" seal, matching the
 *  language the Session story already uses. */
function SealIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 4 5v6c0 5 8 11 8 11s8-6 8-11V5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** A small overlap glyph for the "touches a file you're editing" warning. */
function OverlapIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="13" height="13" rx="2" />
      <path d="M8 8h13v13H8z" />
    </svg>
  );
}

/** One AI change, laid out as an accountability card. When a run's `[auto]`
 *  stubs collapse into a single entry, `display` aggregates the whole session:
 *  `paths` is every file it touched and `editCount` how many edits folded in. */
function ActivityCard({
  display,
  nowSecs,
  dirty,
  onOpen,
}: {
  display: SessionDisplayRow;
  nowSecs: number;
  /** Normalized set of files the user has uncommitted right now. */
  dirty: Set<string>;
  onOpen: (row: IntentRow) => void;
}) {
  const { row, editCount } = display;
  const label = agentDisplayLabel(row.agent_id || "unknown");
  // The human this change is attributed to — resolved backend-side from the
  // row's signing key. `agent_id` is *which AI* typed it; this is *whose work*
  // it was. Null when no registered key matches (honest, never guessed).
  const personName = row.developer || null;
  // Aggregated across a collapsed session (raw row churn for a single entry).
  const churn = {
    files: display.files,
    adds: display.adds,
    dels: display.dels,
    hasChurn: display.hasChurn,
  };
  // The de-duplicated union of every file the entry touched — across the whole
  // collapsed run, not just the representative stub.
  const paths = display.paths;
  const leadFile = paths.length > 0 ? baseName(paths[0]) : null;
  const moreFiles = paths.length > 1 ? paths.length - 1 : 0;
  const sealed = !!row.signed_block_id;
  const rel = relTimeFromTs(row.timestamp, nowSecs);

  // "Touches a file you're editing" — the change overlaps the user's live
  // git-dirty set. The one team-wide signal a vibe-coder most needs: someone
  // else's AI just rewrote a file I have open changes in. Best-effort: empty
  // dirty set (or unreadable git) → no tag, never a false alarm.
  const overlaps = useMemo(() => {
    if (dirty.size === 0 || paths.length === 0) return false;
    return paths.some((p) => dirty.has(pathKey(p)));
  }, [dirty, paths]);

  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className="group flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-bg-2"
    >
      {/* Person avatar — compact. The human teammate this change is attributed
          to (resolved from the signing key), not the AI that typed it. Falls
          back to a neutral mark when we can't yet name the teammate. */}
      <span className="mt-px shrink-0">
        <span
          className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-line-soft text-[8px] font-semibold"
          style={{
            background: "var(--color-bg-2)",
            color: personName ? "var(--color-text-3)" : "var(--color-text-4)",
          }}
          title={personName ?? "We don't yet know which teammate sealed this change"}
          aria-hidden="true"
        >
          {personName ? initialsOf(personName) : "?"}
        </span>
      </span>

      <span className="min-w-0 flex-1">
        {/* Attribution — quiet + compact: who, via which AI, what file. The
            person still leads, but small; the change message below is the lead. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-text-4">
          <span className="font-medium text-text-2">
            {personName ?? "Unknown teammate"}
          </span>
          <span className="inline-flex items-center gap-1">
            via
            <AgentIcon agentId={row.agent_id || "unknown"} label={label} size={12} />
            {label}
          </span>
          <span>{leadFile ? "· changed" : "· logged a change"}</span>
          {leadFile ? (
            <span className="truncate font-mono text-text-3">
              {leadFile}
              {moreFiles > 0 ? (
                <span className="ml-1 font-sans">+{moreFiles} more</span>
              ) : null}
            </span>
          ) : null}
        </span>

        {/* The WHY — the author's own words, promoted to the visual lead. */}
        {row.intent ? (
          <span className="mt-1 block truncate text-[12.5px] font-medium leading-snug text-text-1">
            {oneLine(row.intent)}
          </span>
        ) : null}

        {/* Meta row: time · churn · seal · overlap · type. */}
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-4">
          <span>{rel}</span>
          {churn.files > 0 ? (
            <>
              <span>·</span>
              <span>
                {churn.files} {churn.files === 1 ? "file" : "files"}
              </span>
              {churn.hasChurn ? (
                <span className="font-mono text-[10px]">
                  <span className="text-accent-green">+{churn.adds}</span>
                  <span className="text-text-4"> / </span>
                  <span className="text-text-3">−{churn.dels}</span>
                </span>
              ) : null}
            </>
          ) : null}

          {/* Collapsed-session marker — N file edits folded under one entry. */}
          {editCount > 1 ? (
            <>
              <span>·</span>
              <span title={`${editCount} file edits in this session were grouped together`}>
                {editCount} edits
              </span>
            </>
          ) : null}

          {/* Genuine-record seal — green tick when sealed, muted otherwise. */}
          {sealed ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] text-accent-green"
              style={{
                background: "color-mix(in srgb, var(--color-accent-green) 12%, transparent)",
              }}
              title="Aura sealed exactly what the AI changed and why — this record can't be altered."
            >
              <SealIcon />
              Sealed
            </span>
          ) : (
            <span
              className="rounded-full border border-line-soft px-1.5 py-px text-[10px] text-text-4"
              title="No genuine-record seal on this change yet."
            >
              Not sealed
            </span>
          )}

          {/* Overlap warning — someone's AI touched a file you have open. */}
          {overlaps ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px]"
              style={{
                color: "var(--color-accent)",
                background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
              }}
              title="This change touches a file you have uncommitted edits in — review before you save over it."
            >
              <OverlapIcon />
              Touches your work
            </span>
          ) : null}

          {row.intent_type ? (
            <span className="rounded border border-line-soft px-1.5 py-px text-[10px] text-text-4">
              {row.intent_type}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** A thin stack of roster faces in the feed header — "who's on this project".
 *  Identity only, no live detail: the live "what is everyone doing right now"
 *  card lives in exactly one place, the Trace Overview. Caps at five faces
 *  with a "+N" overflow; renders nothing for a solo project. */
function RosterStrip({ roster }: { roster: TeamMember[] }) {
  if (roster.length <= 1) return null;
  const MAX = 5;
  const shown = roster.slice(0, MAX);
  const overflow = roster.length - shown.length;
  return (
    <div
      className="flex items-center"
      title={`${roster.length} on this project`}
    >
      <div className="flex -space-x-1.5">
        {shown.map((m) => {
          const name = m.name || m.handle || m.email || "?";
          return (
            <span
              key={m.handle || m.email || name}
              className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-bg-content text-[9.5px] font-semibold text-text-2"
              style={{ background: "var(--color-bg-2)" }}
              title={name}
              aria-hidden="true"
            >
              {initialsOf(name)}
            </span>
          );
        })}
      </div>
      {overflow > 0 ? (
        <span className="ml-1.5 text-[11px] text-text-4">+{overflow}</span>
      ) : null}
    </div>
  );
}

/** What the feed can honestly tell the user about WHY it looks the way it does.
 *  Derived from real signals only — Aura sign-in, whether live sync is on, and
 *  how many distinct people's activity is actually present — never guessed.
 *   • checking    — still resolving sign-in/sync.
 *   • signed_out  — not signed in to Aura, so the ledger stays on this machine
 *                   and teammates' activity can't reach the feed (by design).
 *   • sync_off    — signed in, but live sync isn't on for this project yet.
 *   • waiting     — signed in + syncing, but only one person's activity so far.
 *   • working     — more than one teammate's activity is flowing. */
export type TeamSyncState =
  | "checking"
  | "signed_out"
  | "sync_off"
  | "waiting"
  | "working";

export function deriveTeamSyncState(opts: {
  signedIn: boolean | null;
  syncEnabled: boolean | null;
  distinctDevelopers: number;
}): TeamSyncState {
  const { signedIn, syncEnabled, distinctDevelopers } = opts;
  if (signedIn === null) return "checking";
  // The login gate (the durable fix): without an Aura sign-in the ledger never
  // leaves this computer, so a teammate's activity simply can't be here. That
  // is the intended privacy default, not a fault to alarm about.
  if (!signedIn) return "signed_out";
  if (!syncEnabled) return "sync_off";
  return distinctDevelopers > 1 ? "working" : "waiting";
}

/** The self-explaining empty state. Instead of a blank "no activity" it names
 *  WHY the feed is empty and offers the one action that fixes it — sign in, or
 *  turn on sync — in plain language. Sign-in and live-sync are both real,
 *  wired actions; nothing here is a placeholder. */
function TeamActivityEmptyState({
  state,
  onSignIn,
  onEnableSync,
  enabling,
}: {
  state: TeamSyncState;
  onSignIn: () => void;
  onEnableSync: () => void;
  enabling: boolean;
}) {
  let title = "You're all set";
  let body =
    "As you and your teammates work, every AI change lands here — who made it, why, and whether it's a sealed, genuine record.";
  let cta: { label: string; onClick: () => void; busy?: boolean } | null = null;

  if (state === "signed_out") {
    title = "See your team's activity";
    body =
      "Sign in to Aura and every teammate's AI changes show up here — who changed what, and why. Until you do, your activity stays on this computer only.";
    cta = { label: "Sign in to Aura", onClick: onSignIn };
  } else if (state === "sync_off") {
    title = "Turn on team activity";
    body =
      "You're signed in. Turn on live sync for this project and your team's AI changes will flow in here as everyone works.";
    cta = {
      label: enabling ? "Turning on…" : "Turn on live sync",
      onClick: onEnableSync,
      busy: enabling,
    };
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span className="text-[13px] text-text-2">{title}</span>
      <span className="mt-1.5 max-w-[24rem] text-[12px] leading-relaxed text-text-4">
        {body}
      </span>
      {cta ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          className="mt-3.5"
          onClick={cta.onClick}
          disabled={cta.busy}
        >
          {cta.label}
        </Button>
      ) : null}
    </div>
  );
}

/** A thin, non-blocking band shown ABOVE a populated feed when it's only
 *  showing the local developer because sync isn't on — so a feed that's
 *  technically non-empty but really just "you" reads honestly instead of
 *  looking like the whole team. Only renders for the two actionable states. */
function SyncNotice({
  state,
  onSignIn,
  onEnableSync,
  enabling,
}: {
  state: TeamSyncState;
  onSignIn: () => void;
  onEnableSync: () => void;
  enabling: boolean;
}) {
  if (state !== "signed_out" && state !== "sync_off") return null;
  const signedOut = state === "signed_out";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line-soft bg-bg-1 px-4 py-2">
      <span className="min-w-0 text-[11.5px] leading-snug text-text-3">
        {signedOut
          ? "You're seeing only your own activity — sign in so your team's changes sync here."
          : "Live sync is off, so only your activity shows. Turn it on to see your team."}
      </span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={signedOut ? onSignIn : onEnableSync}
        disabled={enabling}
      >
        {signedOut ? "Sign in" : enabling ? "Turning on…" : "Turn on"}
      </Button>
    </div>
  );
}

/** Presentational feed — all the rendering, none of the fetching. Exported so
 *  a preview harness (and any future host that already holds the rows) can
 *  render the exact production markup against supplied data. The live pane is
 *  the `TeamActivityFeed` container below. */
export function TeamActivityFeedView({
  rows,
  sessions,
  roster,
  dirty,
  nowMs,
  loading,
  error,
  syncState,
  onSignIn,
  onEnableSync,
  enabling,
  onRefresh,
  onOpenSession,
}: {
  rows: IntentRow[];
  /** Claude Code sessions — used to fold a run's `[auto]` stub spam into one
   *  entry per session. Best-effort; an empty list just means no collapsing. */
  sessions?: ClaudeSession[];
  roster: TeamMember[];
  dirty: Set<string>;
  nowMs: number;
  loading: boolean;
  error: string | null;
  /** Why the feed looks the way it does — drives the smart empty state +
   *  notice. Derived from real sign-in / sync / distinct-developer signals. */
  syncState: TeamSyncState;
  onSignIn: () => void;
  onEnableSync: () => void;
  enabling: boolean;
  onRefresh: () => void;
  onOpenSession: (row: IntentRow) => void;
}) {
  const nowSecs = Math.floor(nowMs / 1000);

  // Collapse a run's auto-stub spam into one entry per session, then group by
  // local day (newest day first, newest entry first within a day).
  const groups = useMemo<DayGroup[]>(() => {
    const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp);
    const display = collapseAutoStubSessions(sorted, sessions ?? []);
    const byDay = new Map<string, DayGroup>();
    for (const d of display) {
      const date = new Date(d.row.timestamp * 1000);
      const key = dayKey(date);
      let g = byDay.get(key);
      if (!g) {
        g = { key, label: dayLabel(date, nowMs), rows: [] };
        byDay.set(key, g);
      }
      g.rows.push(d);
    }
    return [...byDay.values()];
  }, [rows, sessions, nowMs]);

  // Count and seal-count what the feed actually shows (post-collapse), so the
  // header matches the cards rather than the inflated raw intent-log length.
  const total = useMemo(
    () => groups.reduce((n, g) => n + g.rows.length, 0),
    [groups],
  );
  const sealedCount = useMemo(
    () =>
      groups.reduce(
        (n, g) => n + g.rows.reduce((m, d) => m + (d.row.signed_block_id ? 1 : 0), 0),
        0,
      ),
    [groups],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium leading-none text-text-1">
            Team activity
          </span>
          <span className="text-[11px] leading-none text-text-4">
            {total === 0
              ? "Who on your team changed what — and why"
              : `${total} ${total === 1 ? "change" : "changes"} · ${sealedCount} sealed`}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Who's on this project — a thin presence strip. The live "Right
              now / what they're doing" detail lives once, on the Overview;
              here we just anchor the feed with the roster faces. */}
          <RosterStrip roster={roster} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            className="text-text-3 hover:text-text-1"
            title="Refresh team activity"
            aria-label="Refresh team activity"
          >
            <RefreshIcon />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-4 py-4 text-[12px] text-text-3">
            Couldn&rsquo;t load team activity.
            <span className="mt-1 block font-mono text-[11px] text-text-4">
              {error}
            </span>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="px-4 py-4 text-[12px] text-text-4">Loading…</div>
        ) : total === 0 ? (
          <TeamActivityEmptyState
            state={syncState}
            onSignIn={onSignIn}
            onEnableSync={onEnableSync}
            enabling={enabling}
          />
        ) : (
          <div className="pb-6">
            {/* Honest framing when the feed is really just "you": only its own
                activity is showing because sync isn't on. Quiet, dismissible by
                acting on it — never blocks the rows below. */}
            <SyncNotice
              state={syncState}
              onSignIn={onSignIn}
              onEnableSync={onEnableSync}
              enabling={enabling}
            />
            {groups.map((g) => (
              <div key={g.key}>
                <div className="sticky top-0 z-[1] flex items-baseline gap-2 border-b border-line-soft bg-bg-content/95 px-4 py-1.5 backdrop-blur">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                    {g.label}
                  </span>
                  <span className="text-[11px] text-text-4">
                    {g.rows.length}
                  </span>
                </div>
                <div className="divide-y divide-line-soft/60">
                  {g.rows.map((display, i) => (
                    <ActivityCard
                      key={`${display.row.timestamp}-${display.row.agent_id}-${i}`}
                      display={display}
                      nowSecs={nowSecs}
                      dirty={dirty}
                      onOpen={onOpenSession}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function TeamActivityFeed({
  repoRoot,
  onOpenSession,
}: {
  repoRoot: string;
  onOpenSession: (row: IntentRow) => void;
}) {
  const [rows, setRows] = useState<IntentRow[]>([]);
  // Real Claude Code sessions — best-effort, used to fold a run's `[auto]`
  // stub spam into one entry per session (see sessionMeta).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [roster, setRoster] = useState<TeamMember[]>([]);
  // The user's live uncommitted file set, normalized — drives the "touches
  // your work" tag. Best-effort and non-blocking; failure leaves it empty.
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  // Real sign-in / live-sync signals (app-level settings) — drive the smart
  // empty state. `null` until first resolved, so we don't flash a wrong state.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [syncEnabled, setSyncEnabled] = useState<boolean | null>(null);
  const [enabling, setEnabling] = useState(false);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    if (!repoRoot) {
      setRows([]);
      setClaudeSessions([]);
      setRoster([]);
      setDirty(new Set());
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Claude sessions are best-effort enrichment for the collapse — their
      // absence just means no folding, never a failed load.
      const [data, sessions] = await Promise.all([
        api.auraIntentRecent(repoRoot, 200),
        api.claudeListSessions(repoRoot).catch(() => [] as ClaudeSession[]),
      ]);
      if (!aliveRef.current) return;
      setRows(Array.isArray(data) ? data : []);
      setClaudeSessions(Array.isArray(sessions) ? sessions : []);
      setNowMs(Date.now());
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      if (aliveRef.current) setLoading(false);
    }

    // Roster + git-dirty are independent best-effort sidecars: a failure in
    // either degrades only its own affordance (presence strip / overlap tag)
    // and never surfaces as the pane-level error.
    void (async () => {
      try {
        const team = await api.teamLoad(repoRoot);
        if (aliveRef.current) setRoster(team?.members ?? []);
      } catch {
        if (aliveRef.current) setRoster([]);
      }
    })();

    void (async () => {
      try {
        const status = await api.gitStatus(repoRoot);
        if (!aliveRef.current) return;
        const set = new Set<string>();
        for (const p of Object.keys(status ?? {})) set.add(pathKey(p));
        setDirty(set);
      } catch {
        if (aliveRef.current) setDirty(new Set());
      }
    })();

    // Sign-in + live-sync are app-level settings — the real signals behind the
    // smart empty state. Best-effort: a read failure resolves to "signed out"
    // so the feed still offers the (always-safe) sign-in path rather than hang.
    void (async () => {
      try {
        const s = await api.settingsLoad();
        if (!aliveRef.current) return;
        setSignedIn(!!s.cloud_token_present);
        setSyncEnabled(!!s.sync_enabled);
      } catch {
        if (!aliveRef.current) return;
        setSignedIn(false);
        setSyncEnabled(false);
      }
    })();
  }, [repoRoot]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // Sign in is always safe + global; open the same sign-in flow the titlebar
  // avatar and Settings use.
  const onSignIn = useCallback(() => {
    window.dispatchEvent(new CustomEvent("aura:open-signin"));
  }, []);

  // Turn on live sync for this project, then reload so the feed reflects it.
  const onEnableSync = useCallback(async () => {
    if (!repoRoot) return;
    setEnabling(true);
    try {
      await api.auraLiveStart(repoRoot, false);
      if (aliveRef.current) setSyncEnabled(true);
      await load();
    } catch {
      // Leave state as-is; the notice/empty CTA stays actionable for a retry.
    } finally {
      if (aliveRef.current) setEnabling(false);
    }
  }, [repoRoot, load]);

  // Keyless sessions (a real Claude/Gemini transcript with no Aura signing key)
  // fall back to the git author *email* for `developer` — so a teammate's own
  // work reads "mo@company.com" while their signed commits read "Ashiq".
  // Resolve that email against the roster to the teammate's name so one person
  // reads as one person. Only an exact roster-email match wins (honest — never
  // a guess), and keyed rows already carry the signed name, so they pass
  // through untouched. This is a display convenience, not a verified identity.
  const emailToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of roster) {
      const e = (mem.email || "").trim().toLowerCase();
      if (e && mem.name) m.set(e, mem.name);
    }
    return m;
  }, [roster]);

  const resolvedRows = useMemo(() => {
    if (emailToName.size === 0) return rows;
    return rows.map((r) => {
      const dev = (r.developer || "").trim();
      if (!dev.includes("@")) return r;
      const name = emailToName.get(dev.toLowerCase());
      return name && name !== dev ? { ...r, developer: name } : r;
    });
  }, [rows, emailToName]);

  // How many distinct teammates' activity is actually present — the honest
  // "is the feed really just me?" signal. Counts resolved developer names only
  // (email→name resolved first, so one teammate never double-counts).
  const distinctDevelopers = useMemo(() => {
    const seen = new Set<string>();
    for (const r of resolvedRows) {
      const d = (r.developer || "").trim();
      if (d) seen.add(d);
    }
    return seen.size;
  }, [resolvedRows]);

  const syncState = deriveTeamSyncState({
    signedIn,
    syncEnabled,
    distinctDevelopers,
  });

  return (
    <TeamActivityFeedView
      rows={resolvedRows}
      sessions={claudeSessions}
      roster={roster}
      dirty={dirty}
      nowMs={nowMs}
      loading={loading}
      error={error}
      syncState={syncState}
      onSignIn={onSignIn}
      onEnableSync={() => void onEnableSync()}
      enabling={enabling}
      onRefresh={() => void load()}
      onOpenSession={onOpenSession}
    />
  );
}
