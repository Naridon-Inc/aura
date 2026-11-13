// Team activity — "what did everyone's agents change, and does any of it
// land on my work?". The shared intent log, the same record that travels to
// every teammate on pull, told on the story column: who, what they asked for
// in their own words, and one line of facts under it. A change that touches a
// file you have uncommitted edits in says so; that is read from git status
// and simply doesn't show when it can't be read.
//
// When the feed is really only you, because sign-in or live sync is off, one
// sentence says so above the days, with the action that fixes it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users } from "lucide-react";
import { api, type ClaudeSession, type IntentRow, type TeamMember } from "../../lib/api";
import { fetchSessions } from "../../lib/sessionsCache";
import { fetchIntentRows } from "../../lib/intentCache";
import { deriveTeamSyncState, teamEmptyCopy, type TeamSyncState } from "../../lib/teamFeedState";
import { fetchTeam } from "../../lib/teamCache";
import { Button } from "../ui/button";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TraceStory, TraceStoryHead, TraceStoryIntro } from "../ui/trace-story";
import { StoryDays, useMomentKeys } from "../trace/story/StoryDays";
import { formatCount } from "../trace/story/storyFormat";
import { pathKey, teamDays } from "../trace/story/teamDays";
import { useRefreshOnReturn } from "../trace/story/useRefreshOnReturn";

/** The self-explaining empty state. Instead of a blank "no activity" it names
 *  WHY the feed is empty and offers the one action that fixes it — sign in, or
 *  turn on sync — in plain language. Every word comes from `teamEmptyCopy`,
 *  which answers for all six states; this used to name three of them and let
 *  the other three fall through to a reassurance, including the state where
 *  the sign-in check hadn't come back yet. Sign-in and live-sync are both
 *  real, wired actions; nothing here is a placeholder. */
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
  const copy = teamEmptyCopy(state);

  // Still reading. The app's one block loader, never a headline — a state
  // that hasn't been read is not an answer.
  if (copy.tone === "waiting") return <LoadingState label={copy.body} />;

  const cta =
    copy.cta === "signin"
      ? { label: "Sign in to Aura", onClick: onSignIn, busy: false }
      : copy.cta === "sync"
        ? {
            label: enabling ? "Turning on…" : "Turn on live sync",
            onClick: onEnableSync,
            busy: enabling,
          }
        : null;

  return (
    <EmptyState
      icon={Users}
      title={copy.title}
      body={copy.body}
      action={cta ? { label: cta.label, onClick: cta.onClick, disabled: cta.busy } : undefined}
      size="sm"
    />
  );
}

/** One sentence above the days when the feed is only you. */
function SyncLine({
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
    <TraceStoryIntro>
      {signedOut
        ? "You're seeing only your own activity. Sign in so your team's changes sync here. "
        : "Live sync is off, so only your activity shows. Turn it on to see your team. "}
      <Button variant="link" size="xs" onClick={signedOut ? onSignIn : onEnableSync} disabled={enabling}>
        {signedOut ? "Sign in" : enabling ? "Turning on…" : "Turn on live sync"}
      </Button>
    </TraceStoryIntro>
  );
}

function TeamStory({
  rows,
  sessions,
  dirty,
  loading,
  error,
  syncState,
  activeKey,
  onSignIn,
  onEnableSync,
  enabling,
  onRefresh,
  onOpenSession,
}: {
  rows: IntentRow[];
  sessions: ClaudeSession[];
  /** Files the reader has uncommitted right now, as `pathKey`s. */
  dirty: Set<string>;
  loading: boolean;
  error: string | null;
  syncState: TeamSyncState;
  activeKey?: string | null;
  onSignIn: () => void;
  onEnableSync: () => void;
  enabling: boolean;
  onRefresh: () => void;
  onOpenSession: (row: IntentRow) => void;
}) {
  const groups = useMemo(() => teamDays(rows, sessions), [rows, sessions]);
  const { total, unsealed } = useMemo(() => {
    let total = 0;
    let unsealed = 0;
    for (const g of groups) {
      for (const r of g.rows) {
        total += 1;
        if (r.kind === "intent" && !r.display.row.signed_block_id) unsealed += 1;
      }
    }
    return { total, unsealed };
  }, [groups]);
  const touches = useCallback(
    (paths: string[]) => dirty.size > 0 && paths.some((p) => dirty.has(pathKey(p))),
    [dirty],
  );
  const onKeyDown = useMomentKeys();
  const nowSecs = Math.floor(Date.now() / 1000);

  return (
    <TraceStory label="Team activity">
      <TraceStoryHead icon={<Users aria-hidden />}>
        {total === 0 ? (
          "Who on your team changed what, and why"
        ) : (
          <>
            <strong>{formatCount(total)}</strong> {total === 1 ? "change" : "changes"} ·{" "}
            {unsealed === 0 ? (
              "all sealed"
            ) : (
              <>
                <strong>{formatCount(unsealed)}</strong> not sealed
              </>
            )}
          </>
        )}
      </TraceStoryHead>
      <TraceStoryIntro>
        What everyone&apos;s agents changed here, newest first. A change that lands on a file
        you&apos;re editing says so.
      </TraceStoryIntro>
      {error ? (
        <ErrorState title="Couldn’t load team activity" message={error} onRetry={onRefresh} size="sm" />
      ) : loading && rows.length === 0 ? (
        <LoadingState label="Gathering what your team changed…" />
      ) : total === 0 ? (
        <TeamActivityEmptyState
          state={syncState}
          onSignIn={onSignIn}
          onEnableSync={onEnableSync}
          enabling={enabling}
        />
      ) : (
        <>
          <SyncLine state={syncState} onSignIn={onSignIn} onEnableSync={onEnableSync} enabling={enabling} />
          <div className="ui-trace-story-days" onKeyDown={onKeyDown}>
            <StoryDays
              groups={groups}
              sessions={sessions}
              nowSecs={nowSecs}
              currentBranch={null}
              activeKey={activeKey}
              whoOf={(row) => row.developer || undefined}
              touches={touches}
              onOpen={onOpenSession}
            />
          </div>
        </>
      )}
    </TraceStory>
  );
}

export function TeamActivityFeed({
  repoRoot,
  activeKey,
  onOpenSession,
}: {
  repoRoot: string;
  /** The session last opened, kept marked when the reader comes Back. */
  activeKey?: string | null;
  onOpenSession: (row: IntentRow) => void;
}) {
  const [rows, setRows] = useState<IntentRow[]>([]);
  // Real Claude Code sessions — best-effort, used to fold a run's `[auto]`
  // stub spam into one entry per session (see sessionMeta).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        fetchIntentRows(repoRoot, 200),
        fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
      ]);
      if (!aliveRef.current) return;
      setRows(Array.isArray(data) ? data : []);
      setClaudeSessions(Array.isArray(sessions) ? sessions : []);
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
        const team = await fetchTeam(repoRoot);
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

  useRefreshOnReturn(load);

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
    // With no project open the settings probe never runs, so `signedIn` stays
    // null forever — which used to render as a permanent reassurance.
    hasProject: !!repoRoot,
    signedIn,
    syncEnabled,
    distinctDevelopers,
  });

  return (
    <TeamStory
      rows={resolvedRows}
      sessions={claudeSessions}
      dirty={dirty}
      loading={loading}
      error={error}
      syncState={syncState}
      activeKey={activeKey}
      onSignIn={onSignIn}
      onEnableSync={() => void onEnableSync()}
      enabling={enabling}
      onRefresh={() => void load()}
      onOpenSession={onOpenSession}
    />
  );
}
