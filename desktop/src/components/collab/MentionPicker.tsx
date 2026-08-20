// MentionPicker — "@" in the composer, over the people *and* the agents.
//
// Typing "@" is the shortest path to the thing that makes this plane work:
// choosing who the next message is for. Picking a person addresses it to
// them (and their agent stands down); picking an agent addresses it to that
// agent, including someone else's, on their machine.
//
// Hand-over is on the same row rather than in a second menu, because handing
// a thread to a teammate is a *recipient* decision — you are already naming
// them, and making that a separate step is how it never gets used.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { ArrowRightLeft } from "lucide-react";

import type { MsgIntent, Participant } from "../../lib/sessionLive";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { MENU_LABEL, MENU_PANEL, MENU_ROW, MENU_SEP } from "../ui/menuSurface";
import { ParticipantFace } from "./ParticipantsStrip";
import {
  STATE_PHRASE,
  mentionHandle,
  participantLabel,
  sortParticipants,
} from "./collabPresence";

/** The default intent for addressing each kind. Instructing an agent is what
 *  the box already does; addressing a person is a heads-up until you say
 *  otherwise. */
export function defaultIntentFor(p: Participant): MsgIntent {
  return p.kind === "agent" ? "instruct" : "tell";
}

/** Find the "@word" the caret is sitting in, if any. Returns the offset of
 *  the "@" and the text typed after it, so the composer can replace exactly
 *  that span when a name is picked. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upto[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

export type MentionPickerProps = {
  participants: readonly Participant[];
  youId: string | null;
  /** Text typed after the "@". */
  query: string;
  onPick: (p: Participant, intent: MsgIntent) => void;
  onClose: () => void;
  /** Roster still arriving over the session socket. */
  loading?: boolean;
  /** Plain-language failure from the socket. */
  error?: string | null;
  className?: string;
};

export function MentionPicker({
  participants,
  youId,
  query,
  onPick,
  onClose,
  loading = false,
  error = null,
  className,
}: MentionPickerProps): JSX.Element {
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = sortParticipants(participants);
    if (!q) return all;
    return all.filter((p) => {
      const label = participantLabel(p, participants, youId).toLowerCase();
      return (
        label.includes(q) ||
        p.name.toLowerCase().includes(q) ||
        mentionHandle(p, participants).includes(q)
      );
    });
  }, [participants, query, youId]);

  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (matches.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const p = matches[Math.min(active, matches.length - 1)];
        if (p) onPick(p, e.shiftKey ? "handoff" : defaultIntentFor(p));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [matches, active, onPick, onClose]);

  const people = matches.filter((p) => p.kind === "human");
  const agents = matches.filter((p) => p.kind === "agent");

  return (
    <div
      role="listbox"
      aria-label="Address this message to"
      className={`${MENU_PANEL} w-[300px] max-h-[280px] overflow-y-auto ${className ?? ""}`}
    >
      {error ? (
        <div className="px-2 py-2 text-xs text-red">{error}</div>
      ) : loading ? (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-text-3">
          <AsciiSpinner size={12} />
          <span>Loading who's in this session…</span>
        </div>
      ) : matches.length === 0 ? (
        <div className="px-2 py-2 text-xs text-text-4">
          Nobody in this session matches “{query}”.
        </div>
      ) : (
        <>
          {people.length > 0 && <div className={MENU_LABEL}>People</div>}
          {people.map((p) => (
            <MentionRow
              key={p.id}
              p={p}
              participants={participants}
              youId={youId}
              activeRow={matches[active]?.id === p.id}
              onHover={() => setActive(matches.indexOf(p))}
              onPick={onPick}
            />
          ))}
          {people.length > 0 && agents.length > 0 && <div className={MENU_SEP} />}
          {agents.length > 0 && <div className={MENU_LABEL}>Agents</div>}
          {agents.map((p) => (
            <MentionRow
              key={p.id}
              p={p}
              participants={participants}
              youId={youId}
              activeRow={matches[active]?.id === p.id}
              onHover={() => setActive(matches.indexOf(p))}
              onPick={onPick}
            />
          ))}
        </>
      )}
      <div className={MENU_SEP} />
      <div className="px-2 py-1 text-2xs text-text-5">
        Enter to address · Shift+Enter to hand the thread over
      </div>
    </div>
  );
}

function MentionRow({
  p,
  participants,
  youId,
  activeRow,
  onHover,
  onPick,
}: {
  p: Participant;
  participants: readonly Participant[];
  youId: string | null;
  activeRow: boolean;
  onHover: () => void;
  onPick: (p: Participant, intent: MsgIntent) => void;
}): JSX.Element {
  return (
    <div
      role="option"
      aria-selected={activeRow}
      tabIndex={-1}
      data-highlighted={activeRow ? "" : undefined}
      onMouseEnter={onHover}
      onClick={() => onPick(p, defaultIntentFor(p))}
      className={`${MENU_ROW} group/mention cursor-pointer`}
    >
      <ParticipantFace p={p} size={20} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-text-1">
          {participantLabel(p, participants, youId)}
        </span>
        <span className="block truncate text-2xs text-text-4">
          {STATE_PHRASE[p.state]}
        </span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPick(p, "handoff");
        }}
        className="opacity-0 group-hover/mention:opacity-100 focus:opacity-100 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent/25 text-accent hover:bg-accent/10 text-2xs leading-none"
        title="Hand this thread over"
      >
        <ArrowRightLeft size={10} />
        Hand over
      </button>
    </div>
  );
}
