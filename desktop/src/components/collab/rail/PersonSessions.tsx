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

import { ChevronRight } from "lucide-react";

import { RailAvatar } from "./RailAvatar";
import { SessionRow } from "./SessionRow";
import { sortSessions, type RailActor, type RailPersonGroup } from "./railModel";

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

  return (
    <div className="mb-[5px]">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 min-h-[26px] text-left hover:bg-bg-2 transition-colors"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          count === 0
            ? `${group.person.name} has nothing open`
            : `${group.person.name} · ${count} session${count === 1 ? "" : "s"}`
        }
      >
        {/* The face rides the rail's 20px mark column — the same slot a
            project's mark gets in the roster below — so one ink column runs
            the whole sidebar and this row's name lands on 36px with every
            other name. It was a bare 22px disc in no slot at all, which made
            the one person on screen the largest mark in the rail and pushed
            their name two pixels right of everything under it. */}
        <span
          className="flex-none grid place-items-center"
          style={{ width: 20, height: 20 }}
        >
          <RailAvatar actor={group.person} size={16} showPresence />
        </span>
        <span className="flex-1 min-w-0 truncate text-text-1">
          {group.person.name}
        </span>
        {/* "you" rather than a coloured name or a badge — it is a fact about
            one row on a rail that is otherwise all other people, and the
            quietest way to state it is the word. Dropped when the name IS
            "You", which is what the rail falls back to before it knows your
            account: "You  you" reads as a rendering bug. */}
        {group.isYou && group.person.name !== "You" ? (
          <span className="flex-none text-2xs text-text-4">you</span>
        ) : null}
        {count > 0 ? (
          <span className="flex-none text-2xs tabular-nums text-text-4">
            {count}
          </span>
        ) : null}
        <ChevronRight
          size={12}
          aria-hidden
          className="flex-none text-text-5 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-[2px] pt-[2px]">
          {count === 0 ? (
            // A teammate with nothing open is a real answer — they're on the
            // team, they're just not in anything. Saying so beats an empty
            // gap the reader has to interpret.
            <div className="px-2 py-[3px] text-2xs text-text-4">
              {group.isYou
                ? "You have nothing open here yet."
                : "Nothing open right now."}
            </div>
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
          )}
        </div>
      ) : null}
    </div>
  );
}
