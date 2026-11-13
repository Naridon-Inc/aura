// Who is working on what — the rail, grouped by the person the sessions
// belong to.
//
// The old shape was a flat list of sessions, which answers "what exists" and
// never "who is doing it". Grouping under the person makes the rail readable
// as a team: your own work first, because it is the only work you can act on
// without joining anything, then everyone else by whoever moved most recently.
//
// It is drawn with the workspace list's own parts, because it sits directly
// above that list in the same column: the sidebar group header for "People",
// a repository-style section per person, and a workspace-height sidebar item
// per session. Rows take their gutter from the host exactly as the list's rows
// do, and the host owns the scroll. This component does not scroll itself: a
// rail with two independent scrollers is a rail where the thing you are
// looking for is always in the other one.
//
// Three real states, not one: we don't know yet, we couldn't find out, and
// there is genuinely nothing. They read differently because they mean
// different things, and a rail that renders "nothing here" while it is still
// looking has told the reader something false.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { ErrorNote, LoadingState } from "../../ui/state";
import { PersonSessions } from "./PersonSessions";
import {
  indexActors,
  isPresent,
  sortGroups,
  type RailPersonGroup,
} from "./railModel";
import "../../ui/people-rail.css";

export type PeopleRailProps = {
  /** The rail's contents. `null` means "we don't know yet" — distinct from an
   *  empty array, which means "we asked and there is nobody". */
  groups: RailPersonGroup[] | null;
  /** A refresh is in flight. With `groups` already set this is a quiet
   *  re-read and the list stays up; with `groups` null it is the first load. */
  loading?: boolean;
  /** Why we couldn't read who is here. Shown in full, with a way to retry. */
  error?: string | null;
  onRetry?: () => void;
  /** The session on screen, so its row can say so. */
  activeSessionId?: string | null;
  onOpenSession: (sessionId: string) => void;
  /** Enter a session you aren't in. Without it, rows on other people's
   *  sessions open read-only and offer no way in — which is the honest
   *  rendering for a build that can't join yet. */
  onJoinSession?: (sessionId: string) => void | Promise<void>;
  /** Pin the clock. The screenshot harness sets it so relative times and
   *  activity decay don't drift between shots; the app leaves it off and the
   *  rail ticks on its own. */
  nowSecs?: number;
  /** The caption above the list. `null` drops it — for hosts that already
   *  caption the panel. */
  heading?: string | null;
};

/** How often the rail re-reads the clock.
 *
 *  Ten seconds: fast enough that "now" becomes "1m" while you're looking, slow
 *  enough that a rail of twenty rows isn't re-rendering every second for a
 *  column of text that changes twice an hour. It is also what bounds how long
 *  a spent activity line can linger past its window. */
const TICK_MS = 10_000;

export function PeopleRail({
  groups,
  loading = false,
  error = null,
  onRetry,
  activeSessionId = null,
  onOpenSession,
  onJoinSession,
  nowSecs,
  heading = "People",
}: PeopleRailProps) {
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 1000));
  const pinned = nowSecs != null;
  useEffect(() => {
    if (pinned) return;
    const id = setInterval(
      () => setTick(Math.floor(Date.now() / 1000)),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [pinned]);
  const now = nowSecs ?? tick;

  const ordered = useMemo(() => sortGroups(groups ?? []), [groups]);
  const byId = useMemo(() => indexActors(ordered), [ordered]);

  const others = ordered.filter((g) => !g.isYou);
  const anyoneElseHere = others.some(
    (g) =>
      isPresent(g.person.state) ||
      g.sessions.some((s) => s.participants.some((p) => isPresent(p.state))),
  );
  const sessionCount = ordered.reduce((n, g) => n + g.sessions.length, 0);
  const peopleHere = ordered.filter((g) => isPresent(g.person.state)).length;
  /** Nobody but you on the rail — the ordinary state before anyone shares
   *  anything, and the one where the rail should take up the least room. */
  const alone = others.length === 0;

  const [folded, setFolded] = useState(false);

  const content = error ? (
    <ErrorNote>
      <AlertTitle>Couldn’t see who’s working right now.</AlertTitle>
      <AlertDescription>
        {error}
        {onRetry ? (
          <div>
            <Button variant="outline" size="xs" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </ErrorNote>
  ) : groups === null ? (
    <LoadingState label="Looking for who’s here…" />
  ) : ordered.length === 0 ? (
    <div className="ui-navigation-empty">
      <p>Nobody is working here yet.</p>
      <p>
        When you or a teammate starts a session in this repository, it shows up
        here with whoever is in it.
      </p>
    </div>
  ) : (
    <div className="ui-navigation-groups">
      {ordered.map((g) => (
        <PersonSessions
          key={g.person.id}
          group={g}
          byId={byId}
          nowSecs={now}
          activeSessionId={activeSessionId}
          onOpenSession={onOpenSession}
          onJoinSession={onJoinSession}
          // Alone on the rail, your own group starts folded: what's under
          // it is your own agents, which whatever you are looking at
          // already shows, and a rail that opens as a second copy of your
          // session list is charging a column for a duplicate. The header
          // stays, so the rail is still findable, and the moment anybody
          // else appears every group opens normally.
          defaultOpen={!(alone && g.isYou)}
        />
      ))}

      {/* Working alone is a state, and it is worth naming — otherwise the
          rail looks the same whether the team is offline or the feature is
          broken. Only said once the rail has something in it; on an empty
          project the block above already covers it. */}
      {sessionCount > 0 && !anyoneElseHere ? (
        <p className="ui-navigation-empty">
          {others.length === 0
            ? "Nobody else has joined this repository yet."
            : "Nobody else is here right now."}
        </p>
      ) : null}
    </div>
  );

  return (
    <nav className="ui-sidebar-group ui-people-rail" data-kind="section" aria-label="People">
      {heading ? (
        <div className="ui-sidebar-group-header">
          <button
            type="button"
            aria-expanded={!folded}
            onClick={() => setFolded((v) => !v)}
            title={folded ? `Show ${heading.toLowerCase()}` : `Hide ${heading.toLowerCase()}`}
          >
            <span>{heading}</span>
            {/* A quiet re-read shows the loader here rather than replacing the
                list — the list is still true while we check it. */}
            {loading && groups !== null ? <AsciiSpinner size={10} /> : null}
            {peopleHere > 0 ? <small>{peopleHere} here</small> : null}
            <ChevronDown size={12} className="ui-section-chevron" data-collapsed={folded} />
          </button>
        </div>
      ) : null}
      {heading && folded ? null : content}
    </nav>
  );
}
