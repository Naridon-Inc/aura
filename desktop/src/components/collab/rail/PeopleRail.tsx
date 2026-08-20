// Who is working on what — the rail, grouped by the person the sessions
// belong to.
//
// The old shape was a flat list of sessions, which answers "what exists" and
// never "who is doing it". Grouping under the person makes the rail readable
// as a team: your own work first, because it is the only work you can act on
// without joining anything, then everyone else by whoever moved most recently.
//
// Geometry is the rail's, not this feature's, and the gutter belongs to the
// HOST, exactly as it does for the project roster mounted below this. The root
// used to carry a `px-1.5` of its own on the reasoning that every rail section
// carries one — but the section it is mounted in (`.ade-build`) already adds
// that 6px, so this rail alone ran on a 12px gutter and its heading and every
// avatar under it sat 6px right of the roster's and the destinations'. Rows pad
// 8px against whatever the host gives them, which puts every glyph on the rail's
// 14px column. Mount it as the roster is mounted — inside `.ade-sec-fill`, which
// cancels the body's own padding, under a host that supplies the gutter — and
// give that host the scroll (`.ade-build` does `flex-1; min-height: 0;
// overflow-y: auto`). This component does not scroll itself: a rail with two
// independent scrollers is a rail where the thing you are looking for is
// always in the other one.
//
// Three real states, not one: we don't know yet, we couldn't find out, and
// there is genuinely nothing. They read differently because they mean
// different things, and a rail that renders "nothing here" while it is still
// looking has told the reader something false.

import { useEffect, useMemo, useState } from "react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { PersonSessions } from "./PersonSessions";
import {
  indexActors,
  isPresent,
  sortGroups,
  type RailPersonGroup,
} from "./railModel";

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

  return (
    <nav className="flex flex-col min-h-0 text-[13px]" aria-label="People">
      {heading ? (
        <div className="ade-sec-h">
          {heading}
          <span className="right dim">
            {/* A quiet re-read shows the loader here rather than replacing the
                list — the list is still true while we check it. */}
            {loading && groups !== null ? <AsciiSpinner size={10} /> : null}
            {peopleHere > 0 ? (
              <span className="tabular-nums">{peopleHere} here</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="px-2 py-2">
          <div className="text-2xs text-red leading-[15px]">
            Couldn’t see who’s working right now.
          </div>
          <div className="mt-0.5 text-2xs text-text-4 leading-[15px] break-words">
            {error}
          </div>
          {onRetry ? (
            <button
              type="button"
              className="mt-1.5 rounded px-1.5 h-[18px] text-2xs font-medium text-accent"
              style={{
                background:
                  "color-mix(in srgb, var(--color-accent) 13%, transparent)",
              }}
              onClick={onRetry}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : groups === null ? (
        <div className="flex items-center gap-2 px-2 py-2 text-2xs text-text-4">
          <AsciiSpinner size={11} />
          <span>Looking for who’s here…</span>
        </div>
      ) : ordered.length === 0 ? (
        <div className="px-2 py-2">
          <div className="text-2xs text-text-3 leading-[15px]">
            Nobody is working here yet.
          </div>
          <div className="mt-0.5 text-2xs text-text-4 leading-[15px]">
            When you or a teammate starts a session in this project, it shows up
            here with whoever is in it.
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
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
            <div className="px-2 pt-0.5 pb-1 text-2xs text-text-4">
              {others.length === 0
                ? "Nobody else has joined this project yet."
                : "Nobody else is here right now."}
            </div>
          ) : null}
        </div>
      )}
    </nav>
  );
}
