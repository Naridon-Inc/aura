// Whose credential an agent run will spend, said out loud before it spends it.
//
// LLM keys were org-wide: `organizations.{anthropic,openai,gemini}_api_key`, one
// key for every member, and on a provisioned box the same shape one level down —
// `provision.sh` writes `ANTHROPIC_API_KEY` into `/etc/aura-runner/agent.env`,
// the unit loads it, and every agent anybody starts there inherits it. The bill
// is real and lands somewhere; what was missing is whose run made it. The
// backend fixed the choosing (`manager::brain::place_agent_key`): a member's own
// sign-in first, then their own key, then the box's, then the org's. This is the
// other half — a surface can now ask BEFORE the run and say it.
//
// Mirrors that module's serialized types field for field, so the two cannot
// disagree about what will be spent. And, like `pushCredential`, it takes a
// `Place` rather than a machine id: "whose key is about to be spent" is a
// question this laptop has to answer too, and it answers it about the same four
// sources.

import { api } from "../api";
import type { Place } from "./contract";

/** How a run comes to have the credential that was chosen for it.
 *
 *  Four cases because there are four honestly different mechanisms, and only one
 *  of them is a file the run loads. A surface can render any of them; what none
 *  of them carries is key material — see `AgentKey`. */
export type KeyLoad =
  /** The engine reads its own sign-in from the member's home. Nothing is set. */
  | { load: "own_login"; path: string }
  /** A file holding `VAR=…` that the run sources before starting the engine. */
  | { load: "env_file"; path: string }
  /** Already in the environment work starts in — a systemd `EnvironmentFile`, a
   *  profile, whatever an admin set. Which makes it everybody's. */
  | { load: "already_in_env" }
  /** Not at the place at all: whoever spawns the run puts it in the environment
   *  for that run, and nothing is written down there. */
  | { load: "injected" };

/** What an agent run at a place will spend.
 *
 *  Everything needed to name it, and nothing that could leak. `var` is the
 *  environment variable's NAME — there is no field here that could hold what it
 *  is set to, which is deliberate and is why this type is safe to hand a
 *  component. The two facts the engine has no opinion about are the ones it
 *  exists to carry: whose credential it is, and whether it was the only one
 *  left. */
export type AgentKey = {
  /** Which implementation answered — `member-login`, `member-key`,
   *  `place-key`, `org-key`, or whatever is added next. */
  source: string;
  /** What to put on screen before spending it. Written for a person, by the
   *  source that knows what it is. */
  label: string;
  /** Where it came from, in the place's own words — a path, or the org's
   *  settings. Never a value. */
  detail: string;
  engine: string;
  /** Whose invoice a spend on it appears on: Anthropic, OpenAI, Google. */
  provider: string;
  /** The variable the engine reads it from. A name, never a value. */
  var: string;
  load: KeyLoad;
  /** Whose spend this run is, in words a person can check against a bill. */
  spender: string;
  /** Is this everybody's rather than this member's? The one fact a surface must
   *  never round off: a shared key works fine and bills somebody else. */
  shared: boolean;
  /** Was this only reached because nothing more specific answered? */
  last_resort: boolean;
};

/** Why this place has no credential for this ask.
 *
 *  None of the three is "something went wrong". Nobody named is a caller bug; an
 *  engine Aura can't authenticate still runs, on whatever the place holds; and a
 *  place holding nothing needs a person to go and sign in. A surface that
 *  rendered all three as an error would be wrong twice. */
export type NoAgentKey =
  | { gap: "no_member" }
  | { gap: "unknown_engine"; engine: string; known: string }
  /** `tried` names the sources that were asked, so the answer doesn't imply
   *  there is one way to have a key. */
  | { gap: "none_held"; engine: string; tried: string[] };

/** One source, asked.
 *
 *  Not debugging output. When the answer is the org's key, the only useful thing
 *  to tell somebody is WHY — "you have no account on this box yet" and "your key
 *  file has no Anthropic key in it" lead to two different next steps, and
 *  neither is guessable from the answer. */
export type Considered = {
  source: string;
  held: boolean;
  /** Its label when it held one, its reason when it did not. */
  why: string;
  last_resort: boolean;
};

/** What an agent run at a place would actually spend. */
export type KeyPlan = {
  member: string;
  engine: string;
  provider: string;
  /** The variable the engine reads its key from. */
  var: string;
  /** What to call the place in a sentence — "this laptop", or the box's name. */
  place: string;
  /** Null is an ANSWER, with `gap` saying which — not a failure. */
  key: AgentKey | null;
  gap: NoAgentKey | null;
  considered: Considered[];
};

/** Ask a place which credential an agent run would spend, before it runs.
 *
 *  One function for both place-modes, because it takes a `Place`: a box is asked
 *  over ssh, this laptop answers the same survey about its own home, and there
 *  is no second spelling to drift.
 *
 *  THROWS only when the place can't be reached. A resolved plan with `key: null`
 *  is the place's own answer and must be rendered as one. */
export function askAgentKey(
  place: Place,
  engine: string,
  member?: string,
): Promise<KeyPlan> {
  return api.placeAgentKey(
    { root: place.project.root, machineId: place.machineId },
    engine,
    member,
  );
}

/** How much of a warning this deserves.
 *
 *  `shared` is the one that matters and the only one that is amber: the run will
 *  work, and somebody else will pay for it. A gap is neutral — an engine Aura
 *  can't speak for is not a problem with the run, and a place holding nothing is
 *  a thing to go and do rather than a thing that just went wrong. */
export type KeyTone = "own" | "shared" | "none";

export function keyTone(plan: KeyPlan): KeyTone {
  if (!plan.key) return "none";
  return plan.key.shared ? "shared" : "own";
}

/** The sentence to show before an agent run.
 *
 *  One phrasing, so every surface that spends a credential says it the same way.
 *  The subject is always a person or an org, because the whole point of the line
 *  is that a spend has one. */
export function keySentence(plan: KeyPlan): string {
  const key = plan.key;
  if (key) {
    return key.shared
      ? `Runs on ${key.label}. The spend lands on ${key.spender}, not on ${plan.member}.`
      : `Runs on ${key.label}.`;
  }
  return keyGapSentence(plan);
}

/** The same thing when there is nothing to spend. Separate because a surface
 *  that only wants to warn needs the gap without the credential branch. */
export function keyGapSentence(plan: KeyPlan): string {
  const gap = plan.gap;
  if (!gap) return "";
  switch (gap.gap) {
    case "no_member":
      return "Nobody is named as the one running this, so there is no credential to look for.";
    case "unknown_engine":
      // Not "there is no key" — there is no way for Aura to say WHOSE. The run
      // happens either way, which is the part a person needs to know.
      return `Aura doesn't know how ${gap.engine} signs in, so this run spends whatever ${plan.place} already holds — it can say whose for ${gap.known}.`;
    case "none_held":
      return `Nothing on ${plan.place} holds a key ${gap.engine} can use — it will ask for one when it starts.`;
  }
}

/** Why the credential that was chosen is the one that was chosen — the sources
 *  that were asked and declined, in the order they were asked.
 *
 *  Only worth showing when the answer is somebody else's key: that is the case
 *  where the person can do something about it, and the reasons are the
 *  instructions for doing it. */
export function whyNotMyKey(plan: KeyPlan): string[] {
  return plan.considered.filter((c) => !c.held).map((c) => c.why);
}

/** What a person can DO about running on somebody else's key, on this place.
 *
 *  The reasons above say what is missing; this says the one thing that fixes it.
 *  Ordered the way the chain is: a sign-in of your own is better than a key of
 *  your own, because nothing has to be typed into a machine you share.
 *
 *  Empty when the run is already on the member's own credential — there is
 *  nothing to fix, and a surface that suggested something anyway would be
 *  telling somebody their correct setup is wrong. */
export function howToRunOnMyOwn(plan: KeyPlan): string {
  if (!plan.key?.shared && plan.key) return "";
  const engine = plan.engine || "the agent";
  return `Sign ${engine} in as yourself on ${plan.place}, or put your own key in ${plan.var} under your home there — either one and runs like this stop being billed to somebody else.`;
}
