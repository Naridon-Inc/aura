// What an agent may reach while it is running, and what it was refused.
//
// The frontend half of `manager::brain::place_egress` and the `aura-egress`
// crate, field for field, so the two cannot disagree about what is confined.
//
// The shape worth understanding before reading any of it: a run has two phases.
// The SETUP phase installs — package managers, lockfiles, a hundred hosts
// nobody can enumerate in advance — and has the whole network, because a list
// that has to contain everything `npm ci` might reach is not a list. The AGENT
// phase, which is the half nobody is watching, is default-deny with an
// allowlist. That split is the entire feature: it is what bounds what a prompt
// injection can actually carry out, because reaching a machine to send stolen
// tokens to is the step that has to succeed for reading them to matter.
//
// Everything below the types is presentation logic kept OUT of the component,
// for the ordinary reason: a `.tsx` in this codebase is not under test, and the
// decision about which of these sentences a person is shown is worth more than
// the markup around it.

import { api } from "../api";
import type { Place } from "./contract";

/** Which half of the run. Mirrors `aura_egress::Phase`. */
export type Phase = "setup" | "agent";

/** Why one machine is on the list.
 *
 *  Three cases rather than a flat list of hosts, and the distinction is the
 *  point: "you asked for this" and "the agent cannot start without this" are
 *  different decisions, and only one of them is the project's. Mirrors
 *  `aura_egress::Reason`. */
export type EgressReason = "declared" | "model" | "remote";

/** A machine, as the allowlist names one. Exact host and exact port — there is
 *  no wildcard and no suffix match, because `evil-anthropic.com` ends in
 *  nothing that `api.anthropic.com` does not. */
export type Endpoint = { host: string; port: number };

/** One line of the allowlist. Mirrors `aura_egress::Allowed`. */
export type Allowed = { endpoint: Endpoint; reason: EgressReason };

/** One machine the agent phase wanted and did not get, with how often.
 *  Mirrors `aura_egress::Attempt`. */
export type Attempt = {
  host: string;
  port: number;
  tries: number;
  /** Unix seconds, first and last time it was asked for. */
  first: number;
  last: number;
};

/** What the agent phase of a run at this place may reach, worked out before
 *  anything starts. Mirrors `place_egress::AgentPhase`. */
export type AgentPhase = {
  /** Always `"agent"`. Carried so a surface showing this cannot get which half
   *  of the run it is describing wrong. */
  phase: Phase;
  allowed: Allowed[];
  /** The same list as one line. */
  summary: string;
  /** Did the project's own `[env.network]` entries survive the seal check?
   *  False means the spec was edited after it was signed, and only the floor —
   *  the model API and the git remote — is being honoured. That is what makes
   *  the seal load-bearing: an agent talked into widening its own allowlist has
   *  widened nothing it can use. */
  declared_honoured: boolean;
  /** Can this machine hold the agent phase to the list at all? False is an
   *  answer, not an error, and `note` says what to do about it. */
  holdable: boolean;
  /** `"seatbelt"` on macOS, `"netfilter"` on Linux, empty for neither. */
  wall: string;
  /** The sentence to show. Always true; never empty. */
  note: string;
};

/** What one run's agent phase wanted and was refused. Mirrors
 *  `aura_egress::Report`. */
export type EgressReport = {
  run: string;
  allowed: Allowed[];
  /** One row per machine, most-wanted first. */
  refused: Attempt[];
};

/** What the agent phase would be allowed to reach at a place, changing nothing.
 *
 *  One function for both place-modes, because it takes a `Place` rather than a
 *  machine id — the same reason `askDrift` does. A wall that exists on the box
 *  and not on the laptop would be a feature that landed in one place-mode only,
 *  which is the thing this programme is not allowed to do.
 *
 *  `bin` is the agent binary, because the floor depends on it: `claude` cannot
 *  work without api.anthropic.com and `codex` cannot work without
 *  api.openai.com, and giving either of them the other's would be a hole nobody
 *  asked for.
 *
 *  THROWS when the place can't be reached, and the caller must hold `null`
 *  rather than an empty plan: "we couldn't ask" is not "it reaches nothing". */
export function askAgentPhase(place: Place, bin: string): Promise<AgentPhase> {
  return api.placeAgentPhase(
    { root: place.project.root, machineId: place.machineId },
    bin,
  );
}

/** What one run wanted and was refused, read off the journal the guard left.
 *
 *  `run` is the run name, which is derived from the session's name rather than
 *  generated — so anybody holding a session name can ask what that run was
 *  refused, months later, without a second book to look it up in. */
export function askEgressReport(
  place: Place,
  run: string,
  bin: string,
): Promise<EgressReport> {
  return api.placeEgressReport(
    { root: place.project.root, machineId: place.machineId },
    run,
    bin,
  );
}

/** A machine, written the way the list writes one — host and port, always.
 *
 *  The port is never elided, even when it is 443. It is half of what the rule
 *  actually permits: an allowlist row for a host on 22 and the same host on 443
 *  are two different permissions, and a surface that hides the difference is
 *  showing a list somebody could sign off on without having read it. Same
 *  spelling as `Endpoint`'s `Display` on the Rust side, so this panel and
 *  `aura egress report` cannot name the same machine two ways. */
export function endpointLabel(e: Endpoint): string {
  return `${e.host}:${e.port}`;
}

/** Why this row is on the list, as a half-sentence. Same words as
 *  `Reason::plainly` on the Rust side, deliberately, so the CLI and the app
 *  cannot describe the same row two ways. */
export function reasonWord(r: EgressReason): string {
  switch (r) {
    case "declared":
      return "this project asked for it";
    case "model":
      return "the agent cannot answer without its own model";
    case "remote":
      return "this is where the code came from";
  }
}

/** What one phase can reach, in the words a person reads — the same words
 *  `Phase::plainly` uses on the Rust side. */
export function phaseSentence(p: Phase): string {
  return p === "setup"
    ? "the setup phase, which has the network because installing is what a network is for"
    : "the agent phase, which can reach only what this project declared, plus its own model and the remote this checkout came from";
}

/** How the plan should be shown: `held` is the wall doing its job, `open` is a
 *  machine that cannot hold one, `unsealed` is a list that was edited after it
 *  was signed.
 *
 *  Three tones rather than good/bad, because the middle one is the case that
 *  actually happens and it is neither: the run works, and it works with less
 *  than the project asked for. Shown as a failure it gets dismissed; shown as
 *  fine it gets missed. */
export type EgressTone = "held" | "unsealed" | "open";

export function egressTone(plan: AgentPhase): EgressTone {
  if (!plan.holdable) return "open";
  if (!plan.declared_honoured) return "unsealed";
  return "held";
}

/** The one line above the list. */
export function egressHeadline(plan: AgentPhase): string {
  if (!plan.holdable) {
    return "This machine can't hold an agent to an allowlist.";
  }
  const n = plan.allowed.length;
  const seal = plan.declared_honoured ? "" : " — this project's own list is being ignored";
  return n === 1
    ? `The agent phase can reach 1 machine${seal}.`
    : `The agent phase can reach ${n} machines${seal}.`;
}

/** The list, worth-reading order: what the project asked for first, then the
 *  floor it could not have been refused anyway.
 *
 *  Declared first because that is the half somebody chose and the half worth
 *  auditing — the model API being on the list is not news. Within a group, by
 *  host, so two runs of the same project produce the same list in the same
 *  order and a diff between them is a real change. */
export function listed(plan: AgentPhase): Allowed[] {
  const rank: Record<EgressReason, number> = { declared: 0, remote: 1, model: 2 };
  return [...plan.allowed].sort(
    (a, b) =>
      rank[a.reason] - rank[b.reason] ||
      a.endpoint.host.localeCompare(b.endpoint.host) ||
      a.endpoint.port - b.endpoint.port,
  );
}

/** Did this run stay inside its list? */
export function clean(report: EgressReport): boolean {
  return report.refused.length === 0;
}

/** Every refusal in this run, added up. */
export function tries(report: EgressReport): number {
  return report.refused.reduce((n, a) => n + a.tries, 0);
}

/** The headline for a finished run. Same sentences as `Report::headline` on the
 *  Rust side, so the CLI's `aura egress report` and this panel say one thing.
 *
 *  A clean run says so and stops. A run with refusals NAMES the machine rather
 *  than counting them, because "3 refusals" is a number and
 *  `webhook.site` is a decision somebody has to make. */
export function reportHeadline(report: EgressReport): string {
  const refused = report.refused.length;
  const allowed = report.allowed.length;
  if (refused === 0) {
    return allowed === 0
      ? "The agent phase reached nothing, and was allowed nothing."
      : `The agent phase stayed inside its allowlist (${allowed} machine${
          allowed === 1 ? "" : "s"
        }).`;
  }
  return refused === 1
    ? `The allowlist stopped this run reaching ${report.refused[0].host}.`
    : `The allowlist stopped this run reaching ${refused} machines.`;
}

/** Every permission as its own sentence, with why it was granted — shown next
 *  to the refusals on purpose. The useful question in front of a blocked host
 *  is "compared to what", and this is the fastest way to see that the run had
 *  its model and its remote and wanted a third thing anyway. */
export function permissions(report: EgressReport): string[] {
  return report.allowed.map(
    (a) => `${endpointLabel(a.endpoint)} — ${reasonWord(a.reason)}`,
  );
}

/** One line per refused machine, most-wanted first — the same words
 *  `Attempt::plainly` uses. */
export function refusals(report: EgressReport): string[] {
  return report.refused.map((a) =>
    a.tries === 1
      ? `wanted ${a.host}:${a.port} once`
      : `wanted ${a.host}:${a.port} ${a.tries} times`,
  );
}
