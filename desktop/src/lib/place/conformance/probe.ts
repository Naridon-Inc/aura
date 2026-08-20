// The backend, stood in for, so the matrix can ask every place the same
// questions without a machine on the other end.
//
// Several of the fifteen workflows are about a CALL rather than a value — what
// a place can run, whose credential a push would spend, whose name the commit
// would carry, where a global install lands, what it drifted from — and each is
// the place it is precisely because it takes a `Place` instead of a machine id.
// Checking that from the outside means seeing what was handed to the backend,
// so the fake records every ask and hands back whatever the check set up.
//
// Deliberately not a general mock library. It answers the commands the matrix
// reaches a place through, records what they were given, and has one reset —
// anything richer would start being a second implementation of the backend,
// which is the thing the seam exists to avoid having.

import type { KeyPlan } from "../agentKey";
import type { AuthorPlan, GitAuthor } from "../author";
import type { PlaceCapabilities } from "../contract";
import type { Drift } from "../drift";
import type { AgentPhase } from "../egress";
import type { PushPlan } from "../pushCredential";
import type { BaseBuild, TeamBase } from "../teamBase";
import type { ToolchainReport } from "../toolchain";
import type { Installed, ToolAsk } from "../toolbox";

/** The pair every call that reaches a place is handed. `machineId: null` is
 *  this laptop and is an answer, not a missing argument. */
export type Reached = { root: string | null; machineId: string | null };

export type CapabilitiesAsk = { target: Reached; bins: string[] };
export type CredentialAsk = {
  target: Reached;
  remote: string;
  member: string | undefined;
};
/** Asking whose key an agent run would spend. `engine` is part of the ask
 *  because a credential is per engine — one member can be signed in to claude and
 *  hold no OpenAI key at all. */
export type AgentKeyAsk = {
  target: Reached;
  engine: string;
  member: string | undefined;
};
/** Asking whose name a commit would carry, and writing it. Kept as two lists
 *  rather than one with a flag: reading is safe and adopting writes, and a
 *  check has to be able to say which one a place was put through. */
export type AuthorAsk = { target: Reached; member: GitAuthor | null };
export type AdoptAsk = { target: Reached; author: GitAuthor };
export type ToolchainAsk = { target: Reached; login: string | undefined };
export type DriftAsk = { target: Reached; bins: string[]; deps: boolean };
export type AgentPhaseAsk = { target: Reached; bin: string };
/** An install for one member. `home` and `login` are here rather than folded
 *  into the ask because they are the whole point of it: an install that did not
 *  say whose home it goes in is an install that could land in anybody's. */
export type InstallAsk = {
  target: Reached;
  home: string;
  ask: ToolAsk;
  login: string | undefined;
};
/** Asking where the team's already-built environment is, and asking to be
 *  started from it. Two lists rather than one with a flag, for the same reason
 *  reading an author and adopting one are two: the first only looks, the second
 *  installs and copies, and a check has to be able to say which a place was put
 *  through. */
export type BaseAsk = { target: Reached };
export type WarmAsk = {
  target: Reached;
  login: string | undefined;
  force: boolean;
};

/** Everything the seam has reached for, in the order it did. */
export const reached: {
  capabilities: CapabilitiesAsk[];
  credential: CredentialAsk[];
  agentKey: AgentKeyAsk[];
  author: AuthorAsk[];
  adopt: AdoptAsk[];
  toolchain: ToolchainAsk[];
  drift: DriftAsk[];
  agentPhase: AgentPhaseAsk[];
  install: InstallAsk[];
  base: BaseAsk[];
  warm: WarmAsk[];
} = {
  capabilities: [],
  credential: [],
  agentKey: [],
  author: [],
  adopt: [],
  toolchain: [],
  drift: [],
  agentPhase: [],
  install: [],
  base: [],
  warm: [],
};

/** What the far side will say next. Set by a check just before it asks, so one
 *  check can walk a place through several answers — a member with a credential
 *  of their own, then the same place before they had one. */
export const answers: {
  capabilities: PlaceCapabilities;
  credential: PushPlan | null;
  agentKey: KeyPlan | null;
  author: AuthorPlan | null;
  toolchain: ToolchainReport | null;
  drift: Drift | null;
  agentPhase: AgentPhase | null;
  base: TeamBase | null;
} = {
  capabilities: { agents: [], git: true, tmux: true, aura: false },
  credential: null,
  agentKey: null,
  author: null,
  toolchain: null,
  drift: null,
  agentPhase: null,
  base: null,
};

/** Forget every ask. Checks call this first so they read their own calls rather
 *  than whatever the cell before them left behind. */
export function forgetReached(): void {
  reached.capabilities = [];
  reached.credential = [];
  reached.agentKey = [];
  reached.author = [];
  reached.adopt = [];
  reached.toolchain = [];
  reached.drift = [];
  reached.agentPhase = [];
  reached.install = [];
  reached.base = [];
  reached.warm = [];
}

/** The commands this suite reaches the backend through. */
export const fakeApi = {
  placeCapabilities(
    place: Reached,
    bins: string[],
  ): Promise<PlaceCapabilities> {
    reached.capabilities.push({ target: { ...place }, bins: [...bins] });
    return Promise.resolve(answers.capabilities);
  },
  placePushCredential(
    place: Reached,
    remote: string,
    member?: string,
  ): Promise<PushPlan> {
    reached.credential.push({ target: { ...place }, remote, member });
    const plan = answers.credential;
    if (!plan) {
      return Promise.reject(
        new Error("no push plan was set up for this ask — the check is wrong"),
      );
    }
    return Promise.resolve(plan);
  },
  placeAgentKey(
    place: Reached,
    engine: string,
    member?: string,
  ): Promise<KeyPlan> {
    reached.agentKey.push({ target: { ...place }, engine, member });
    const plan = answers.agentKey;
    if (!plan) {
      return Promise.reject(
        new Error("no key plan was set up for this ask — the check is wrong"),
      );
    }
    return Promise.resolve(plan);
  },
  placeAuthor(place: Reached, member: GitAuthor | null): Promise<AuthorPlan> {
    reached.author.push({ target: { ...place }, member });
    return authorAnswer();
  },
  placeAuthorAdopt(place: Reached, author: GitAuthor): Promise<AuthorPlan> {
    reached.adopt.push({ target: { ...place }, author });
    return authorAnswer();
  },
  placeToolchain(
    place: Reached,
    login?: string,
  ): Promise<ToolchainReport> {
    reached.toolchain.push({ target: { ...place }, login });
    const report = answers.toolchain;
    if (!report) {
      return Promise.reject(
        new Error("no toolchain report was set up for this ask — the check is wrong"),
      );
    }
    return Promise.resolve(report);
  },
  placeAgentPhase(place: Reached, bin: string): Promise<AgentPhase> {
    reached.agentPhase.push({ target: { ...place }, bin });
    const plan = answers.agentPhase;
    if (!plan) {
      return Promise.reject(
        new Error("no agent phase was set up for this ask — the check is wrong"),
      );
    }
    return Promise.resolve(plan);
  },
  /** A per-member install, answered the way a place that did its job would.
   *
   *  No `answers` slot, unlike the four above, and that is deliberate rather
   *  than an omission: this one has a single honest answer — the binary lands
   *  in the home it was given — and a check that wants to see what a BAD place
   *  says builds that object by hand, where the reader can see exactly which
   *  field is wrong. A settable global would let one check leave a landmine for
   *  the next. */
  placeInstallForMe(
    place: Reached,
    home: string,
    ask: ToolAsk,
    login?: string,
  ): Promise<Installed> {
    reached.install.push({ target: { ...place }, home, ask: { ...ask }, login });
    const dir = home.replace(/\/+$/, "");
    const at = `${dir}/.npm-global/bin/${ask.bin ?? ask.name}`;
    return Promise.resolve({
      login: login ?? "member",
      home: dir,
      tool: ask.bin ?? ask.name,
      state: "installed",
      at,
      mine: at.startsWith(`${dir}/`),
    });
  },
  placeTeamBase(place: Reached): Promise<TeamBase> {
    reached.base.push({ target: { ...place } });
    const base = answers.base;
    if (!base) {
      return Promise.reject(
        new Error("no team base was set up for this ask — the check is wrong"),
      );
    }
    return Promise.resolve(base);
  },
  /** A member being started from the team's environment, answered the way a
   *  place that did its job would.
   *
   *  Derived from `answers.base` rather than settable in its own right, because
   *  the two states a check needs to walk a place through are states of the
   *  BASE: one nobody has built yet, where the first member pays, and one whose
   *  stamp already matches, where the second does not. Letting a check set the
   *  join directly would let it assert a warm start that no base could have
   *  produced. */
  placeTeamBaseWarm(
    place: Reached,
    login: string | undefined,
    force: boolean,
  ): Promise<BaseBuild> {
    reached.warm.push({ target: { ...place }, login, force });
    const base = answers.base;
    if (!base) {
      return Promise.reject(
        new Error("no team base was set up for this ask — the check is wrong"),
      );
    }
    const member = login ?? "member";
    // A base holding one person's credential is refused before a byte moves,
    // and the refusal names the file. Everything below is the good path.
    const refused = base.carries.length
      ? `the team's environment is holding ${base.carries.join(", ")}`
      : "";
    const built = base.built_version > 0 && base.built_digest.length > 0;
    const alone = !base.shared;
    const seeded = refused || alone ? [] : base.holds;
    return Promise.resolve({
      base,
      already_built: built || alone,
      report:
        built || alone || refused
          ? null
          : {
              schema: "aura.env.report/1",
              version: base.built_version,
              digest: base.built_digest,
              trust: { state: "verified", key_id: "k1", signer: "mo" },
              steps: [
                {
                  id: "toolchain:rust",
                  title: "rust",
                  kind: "toolchain",
                  state: "brought",
                  code: 0,
                  detail: "",
                },
              ],
              at_spec: true,
              changed: true,
            },
      start: {
        member,
        home: `/home/${member}`,
        from: base.login,
        alone,
        seeded,
        kept: [],
        missing: [],
        failed: [],
        refused,
        warm: seeded.length > 0,
      },
    });
  },
  placeDrift(place: Reached, bins: string[], deps: boolean): Promise<Drift> {
    reached.drift.push({ target: { ...place }, bins: [...bins], deps });
    const drift = answers.drift;
    if (!drift) {
      return Promise.reject(
        new Error("no drift report was set up for this ask — the check is wrong"),
      );
    }
    return Promise.resolve(drift);
  },
};

/** The author plan the check set up, or a loud failure.
 *
 *  Never a default: a fake that invented "nobody is set" would let a check pass
 *  while asking about a place nothing had answered for, which is the same shape
 *  of lie as a place reporting an author it never read. */
function authorAnswer(): Promise<AuthorPlan> {
  const plan = answers.author;
  if (!plan) {
    return Promise.reject(
      new Error("no author plan was set up for this ask — the check is wrong"),
    );
  }
  return Promise.resolve(plan);
}
