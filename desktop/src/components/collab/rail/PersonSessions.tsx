// One person, and the sessions that are theirs.
//
// The header is the person — their avatar carrying their presence, their name,
// and how many sessions sit under it. The sessions follow as a block, not as an
// indented sub-tree: the header already says whose they are, so a staircase
// would only spend horizontal room the titles need.
//
// The avatar does NOT cross-fade to a chevron on hover the way the project
// roster's mark does. That trick works there because a repo glyph is
// decoration; here the mark is carrying presence, and hiding "is this person
// here" behind not-hovering is hiding the one thing this rail exists to show.
// The header row is the toggle, and the count is the affordance.

import { useState } from "react";

import { ChevronDown, ChevronRight } from "lucide-react";

import { RailAvatar } from "./RailAvatar";
import { SessionRow } from "./SessionRow";
import {
  presenceTitle,
  sortSessions,
  type RailActor,
  type RailPersonGroup,
} from "./railModel";
import "../../ui/people-rail.css";

export type PersonSessionsProps = {
  group: RailPersonGroup;
  /** Every actor on the rail, so activity lines can name anyone. */
  byId: Map<string, RailActor>;
  /** Epoch SECONDS, ticking, shared by every row. */
  nowSecs: number;
  /** The session currently on screen, if it's one of these. */
  activeSessionId?: string | null;
  onOpenSession: (sessionId: string) => void;
  /** Enter a session you aren't in. Never offered on your own group. */
  onJoinSession?: (sessionId: string) => void | Promise<void>;
  /** Whether this group starts expanded. Open is right almost always — the
   *  sessions ARE the content. The exception the rail hands it is your own
   *  group when you are the only person on the rail: there, the list under
   *  your name is your own agents, which the surface you are looking at
   *  already shows, and the header alone is enough to say the rail is here
   *  and will fill when somebody arrives. */
  defaultOpen?: boolean;
};

export function PersonSessions({
  group,
  byId,
  nowSecs,
  activeSessionId = null,
  onOpenSession,
  onJoinSession,
  defaultOpen = true,
}: PersonSessionsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const sessions = sortSessions(group.sessions);
  const count = sessions.length;

  const sessionsWord =
    count === 0 ? "nothing open" : `${count} session${count === 1 ? "" : "s"}`;

  return (
    <section className="ui-navigation-section" data-kind="repository">
      <header>
        <button
          type="button"
          className="ui-navigation-title"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          // The face gives way to the fold chevron under the pointer, as a
          // repository's folder does, so what its presence dot said is
          // said here too.
          title={`${presenceTitle(group.person.name, group.person.state)} · ${sessionsWord}`}
        >
          {/* The face rides the folder's slot, so this name lands on the same
              column as every repository name in the list below. */}
          <span className="ui-repository-icon">
            <i className="ui-rail-person-face">
              <RailAvatar actor={group.person} size={16} showPresence />
            </i>
            <span>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
          </span>
          <span>{group.person.name}</span>
          {/* "you" rather than a coloured name or a badge — it is a fact about
              one row on a rail that is otherwise all other people, and the
              quietest way to state it is the word. Dropped when the name IS
              "You", which is what the rail falls back to before it knows your
              account: "You  you" reads as a rendering bug. */}
          {group.isYou && group.person.name !== "You" ? <small>you</small> : null}
          {!open && count > 0 ? <small>{count}</small> : null}
        </button>
      </header>

      {open ? (
        count === 0 ? (
          <p className="ui-navigation-empty">
            {group.isYou ? "You have nothing open here yet." : "Nothing open right now."}
          </p>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              byId={byId}
              nowSecs={nowSecs}
              ownerName={group.person.name}
              active={s.id === activeSessionId}
              onOpen={onOpenSession}
              onJoin={group.isYou ? undefined : onJoinSession}
            />
          ))
        )
      ) : null}
    </section>
  );
}
