// SessionTypingLine — "someone is about to say something" for a room that
// contains both people and machines.
//
// A person typing and an agent working are not the same event and must not
// look the same. A person will produce a message in a few seconds and you
// might wait for it; an agent is *doing the work* and might be minutes. So
// people get the shared session's typing line — its three dots and "is
// typing…" — and agents get the house loader (the braille AsciiSpinner), the
// same glyph that means "running" everywhere else in the app.
//
// The line always keeps its height whether or not anything is happening, so
// the composer never jumps as people start and stop typing.

import type { JSX } from "react";

import type { Participant } from "../../lib/sessionLive";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { isYou, participantLabel } from "./collabPresence";
import "../ui/cloud-patterns.css";
import "../ui/session-room.css";

export type SessionTypingLineProps = {
  /** Humans whose `typing` is currently on. */
  typing: readonly Participant[];
  /** Agents that are producing output right now. */
  working: readonly Participant[];
  participants: readonly Participant[];
  youId: string | null;
};

const LINE = "ui-cloud-typing ui-session-typing";

export function SessionTypingLine({
  typing,
  working,
  participants,
  youId,
}: SessionTypingLineProps): JSX.Element {
  const people = typing.filter((p) => p.kind === "human" && !isYou(p, youId));
  const agents = working.filter((p) => p.kind === "agent");

  if (people.length === 0 && agents.length === 0) {
    return <div className={LINE} role="status" data-slot="session-activity" />;
  }

  return (
    <div className={LINE} role="status" data-slot="session-activity">
      {agents.length > 0 && (
        <AgentWorkingChip agents={agents} participants={participants} youId={youId} />
      )}
      {agents.length > 0 && people.length > 0 && (
        <span className="ui-session-typing-sep" aria-hidden>
          ·
        </span>
      )}
      {people.length > 0 && (
        <TypingChip people={people} participants={participants} youId={youId} />
      )}
    </div>
  );
}

/** People. The shared session's own three dots. */
export function TypingChip({
  people,
  participants,
  youId,
}: {
  people: readonly Participant[];
  participants: readonly Participant[];
  youId: string | null;
}): JSX.Element {
  const names = people.map((p) => firstWord(participantLabel(p, participants, youId)));
  return (
    <span className="ui-session-typing-chip">
      <span className="ui-session-typing-dots" aria-hidden>
        •••
      </span>
      <span>{listSentence(names, "typing")}…</span>
    </span>
  );
}

/** Agents. The house loader, and the word "working" — not "typing", because
 *  an agent isn't composing a sentence, it's changing the code. */
export function AgentWorkingChip({
  agents,
  participants,
  youId,
}: {
  agents: readonly Participant[];
  participants: readonly Participant[];
  youId: string | null;
}): JSX.Element {
  const names = agents.map((p) => participantLabel(p, participants, youId));
  return (
    <span className="ui-session-typing-chip">
      <AsciiSpinner size={11} />
      <span>{listSentence(names, "working")}…</span>
    </span>
  );
}

function firstWord(label: string): string {
  return label.split(" ")[0] ?? label;
}

/** "Shahabas is typing" / "Shahabas and Ashiq are typing" /
 *  "Shahabas, Ashiq and 2 more are typing". */
function listSentence(names: readonly string[], verb: string): string {
  const unique = Array.from(new Set(names));
  if (unique.length === 0) return "";
  if (unique.length === 1) return `${unique[0]} is ${verb}`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are ${verb}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} more are ${verb}`;
}
