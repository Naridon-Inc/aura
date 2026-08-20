// ComposerAddressingBar — who the next message is for, stated before you send
// it.
//
// One frame carries six different things (you→your agent, you→their agent,
// you→them, agent→agent, agent→you, everyone) and the only difference between
// them is `to`. If `to` is invisible, the surface is a guessing game: the same
// box that has always meant "tell my agent to do this" silently becomes "say
// this to the room" depending on state you can't see. So the bar is always
// there, always says where it's going, and says in plain words what will
// happen when it lands.

import type { JSX } from "react";
import { ChevronDown, Users } from "lucide-react";

import type { MsgIntent, Participant } from "../../lib/sessionLive";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ParticipantFace } from "./ParticipantsStrip";
import {
  ownerOf,
  participantLabel,
  participantName,
  sortParticipants,
} from "./collabPresence";

/** The intent list, in the order it reads as a ladder from quiet to loud. */
const INTENTS: { value: MsgIntent; label: string; blurb: string }[] = [
  { value: "chat", label: "Just chatting", blurb: "Nothing has to happen." },
  { value: "ask", label: "A question", blurb: "You want an answer." },
  { value: "tell", label: "A heads-up", blurb: "Something they should know." },
  { value: "instruct", label: "Do this", blurb: "The agent runs it." },
  { value: "handoff", label: "Hand it over", blurb: "They own this thread now." },
];

/** Not every intent makes sense for every recipient: nothing is instructed by
 *  broadcasting at the room, and you can't hand a thread to nobody. */
export function intentAllowed(intent: MsgIntent, to: Participant | null): boolean {
  if (intent === "instruct") return to?.kind === "agent";
  if (intent === "handoff") return to !== null;
  return true;
}

/** Keep the pair valid when the recipient changes under a chosen intent. */
export function coerceIntent(to: Participant | null, intent: MsgIntent): MsgIntent {
  if (intentAllowed(intent, to)) return intent;
  return to?.kind === "agent" ? "instruct" : to ? "tell" : "chat";
}

/** What will actually happen, in a sentence. This is the whole delivery-rule
 *  table said out loud, one case at a time. */
export function deliverySentence(
  to: Participant | null,
  intent: MsgIntent,
  participants: readonly Participant[],
  youId: string | null,
): string {
  if (!to) return "Everyone in the session sees this. No agent acts on it.";
  if (to.kind === "agent") {
    const owner = ownerOf(to, participants);
    const mine = !!owner && !!youId && owner.id === youId;
    const where = mine || !owner ? "here" : `on ${participantName(owner, participants)}'s machine`;
    if (intent === "handoff") return `${participantLabel(to, participants, youId)} takes this thread over, ${where}.`;
    return `${participantLabel(to, participants, youId)} picks this up ${where}.`;
  }
  const them = participantName(to, participants);
  if (intent === "handoff") return `${them} owns this thread from here. No agent acts on it.`;
  return `${them} sees this addressed to them. No agent acts on it.`;
}

export type ComposerAddressingBarProps = {
  participants: readonly Participant[];
  youId: string | null;
  /** null means everyone in the session. */
  to: Participant | null;
  intent: MsgIntent;
  onChange: (to: Participant | null, intent: MsgIntent) => void;
  /** The desktop that runs the agent. `false` is a real, common state. */
  hostOnline?: boolean;
  disabled?: boolean;
  /** Roster still arriving. */
  loading?: boolean;
  error?: string | null;
};

export function ComposerAddressingBar({
  participants,
  youId,
  to,
  intent,
  onChange,
  hostOnline = true,
  disabled = false,
  loading = false,
  error = null,
}: ComposerAddressingBarProps): JSX.Element {
  if (error) {
    return (
      <div className="flex items-center h-6 px-2 text-2xs text-red truncate">{error}</div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 h-6 px-2 text-2xs text-text-4">
        <AsciiSpinner size={11} />
        <span>Working out who's in this session…</span>
      </div>
    );
  }

  const ordered = sortParticipants(participants);
  const people = ordered.filter((p) => p.kind === "human");
  const agents = ordered.filter((p) => p.kind === "agent");
  const toLabel = to ? participantLabel(to, participants, youId) : "everyone";
  const intentEntry = INTENTS.find((i) => i.value === intent) ?? INTENTS[0];

  return (
    <div className="flex items-center gap-1.5 h-6 px-2 min-w-0 text-2xs">
      <span className="text-text-4 flex-shrink-0">to</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className="inline-flex items-center gap-1 max-w-[190px] px-1.5 h-[18px] rounded border border-line-soft bg-bg-2 text-text-1 hover:border-line disabled:opacity-50"
            title="Change who this message goes to"
          >
            {to ? (
              <ParticipantFace p={to} size={13} />
            ) : (
              <Users size={11} className="text-text-3" />
            )}
            <span className="truncate">{toLabel}</span>
            <ChevronDown size={10} className="text-text-4 flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-[280px]">
          <DropdownMenuLabel>Send to</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onChange(null, coerceIntent(null, intent))}>
            <Users size={14} className="text-text-3" />
            <span className="flex-1">Everyone in this session</span>
            {!to && <span className="text-accent">●</span>}
          </DropdownMenuItem>
          {people.length > 0 && <DropdownMenuSeparator />}
          {people.length > 0 && <DropdownMenuLabel>People</DropdownMenuLabel>}
          {people.map((p) => (
            <RecipientRow
              key={p.id}
              p={p}
              participants={participants}
              youId={youId}
              selected={to?.id === p.id}
              onSelect={() => onChange(p, coerceIntent(p, intent))}
            />
          ))}
          {agents.length > 0 && <DropdownMenuSeparator />}
          {agents.length > 0 && <DropdownMenuLabel>Agents</DropdownMenuLabel>}
          {agents.map((p) => (
            <RecipientRow
              key={p.id}
              p={p}
              participants={participants}
              youId={youId}
              selected={to?.id === p.id}
              onSelect={() => onChange(p, coerceIntent(p, intent))}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-1.5 h-[18px] rounded border border-line-soft bg-bg-2 text-text-2 hover:border-line disabled:opacity-50"
            title="Change what kind of message this is"
          >
            <span className="truncate">{intentEntry.label}</span>
            <ChevronDown size={10} className="text-text-4 flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-[240px]">
          <DropdownMenuLabel>What kind of message</DropdownMenuLabel>
          {INTENTS.map((i) => (
            <DropdownMenuItem
              key={i.value}
              disabled={!intentAllowed(i.value, to)}
              onSelect={() => onChange(to, i.value)}
            >
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-text-1">{i.label}</span>
                <span className="block truncate text-2xs text-text-4">{i.blurb}</span>
              </span>
              {i.value === intent && <span className="text-accent">●</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="text-text-4 truncate min-w-0">
        {deliverySentence(to, intent, participants, youId)}
      </span>

      {!hostOnline && (
        <span className="ml-auto flex-shrink-0 text-amber" title="Nobody's desktop is running the agent right now">
          waiting for the machine
        </span>
      )}
    </div>
  );
}

function RecipientRow({
  p,
  participants,
  youId,
  selected,
  onSelect,
}: {
  p: Participant;
  participants: readonly Participant[];
  youId: string | null;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <ParticipantFace p={p} size={18} />
      <span className="min-w-0 flex-1 truncate">
        {participantLabel(p, participants, youId)}
      </span>
      {selected && <span className="text-accent">●</span>}
    </DropdownMenuItem>
  );
}
