// Lending a machine the key on your own computer — said in words somebody can
// actually decide on.
//
// The engine's half of this is a flag and a connection ([`place_forward.rs`]).
// This is the half that decides whether a person says yes to it, and it is the
// harder half. "Forward my SSH agent" means nothing to most of the people using
// Aura, and the ones it does mean something to usually picture it wrong: they
// think a copy of their key goes to the machine. It doesn't — and the thing
// that actually happens is both safer and broader than that, which is exactly
// the shape of fact you cannot leave someone to infer.
//
// So the copy lives here, next to a test, rather than inline in a panel:
//
//   * what saying yes GIVES the machine, in the machine's own terms
//   * what it does NOT give it, because the fear people arrive with is the
//     wrong one and leaving it standing costs a feature nobody turns on
//   * when it ends, because "for as long as it is connected" is the only part
//     that bounds the whole thing
//
// One sentence per fact, no jargon, and never the word "agent" on its own —
// what a person has is a key, and the agent is Aura's problem.

import type { Place } from "./contract";

/** Everything a surface needs to offer, or not offer, this decision. */
export type AgentLending = {
  /** Should the control be there at all? */
  offered: boolean;
  /** Is the place using your key now? */
  on: boolean;
  /** Where it stands, in one line. */
  state: string;
  /** What saying yes gives the machine. Every item is true while the place is
   *  connected and false the moment it is not. */
  grants: string[];
  /** What it never gives the machine. Reading only the list above leaves the
   *  scarier and wronger of the two readings standing. */
  withholds: string[];
  /** What the button says. */
  action: string;
};

/** The whole decision, for one place.
 *
 *  This laptop is not offered it — work here already runs beside your key, so
 *  there is nothing to lend and a control that did nothing would be worse than
 *  no control. That is an answer about a place, not a place-mode this feature
 *  skipped: a box you brought, one you share and one Aura runs for you all
 *  reach the same branch below, because nothing here reads `kind` except to
 *  tell "here" from "somewhere else".
 */
export function agentLending(place: Place): AgentLending {
  const name = place.name.trim() || "that computer";
  if (place.identity.kind === "here") {
    return {
      offered: false,
      on: false,
      state: "Work here already runs with your key. There is nothing to lend.",
      grants: [],
      withholds: [],
      action: "",
    };
  }
  const on = place.identity.forward_agent;
  const who = place.identity.user.trim();
  const asWho = who ? ` as ${who}` : "";
  return {
    offered: true,
    on,
    state: on
      ? `${name} can use your key while it is connected.`
      : `${name} uses its own key. Nothing of yours is reachable from it.`,
    grants: [
      `While Aura is connected to ${name}, anything running there${asWho} can ask this computer to sign with your key.`,
      `That includes reaching any other server your key opens — not only the one you had in mind.`,
      `So say yes when you trust ${name} and whoever else can run things on it.`,
    ],
    withholds: [
      `Your key is never sent to ${name} and never written down there.`,
      `${name} cannot keep anything once the connection closes — it has to ask this computer every time.`,
      `Aura closes the connection when your last session on ${name} ends, and you can close it sooner.`,
    ],
    action: on ? `Stop lending my key to ${name}` : `Let ${name} use my key`,
  };
}

/** The one line a place's row can carry without opening anything.
 *
 *  Only ever drawn when it is ON. A row that said "not lending your key" on
 *  every machine you own would be noise, and the absence of the line is already
 *  the truthful default — which is the same reason the flag itself is off. */
export function agentLendingBadge(place: Place): string | null {
  return place.identity.kind !== "here" && place.identity.forward_agent
    ? "Using your key"
    : null;
}
