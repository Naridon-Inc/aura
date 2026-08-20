// The table: the modes down the side, the workflows across the top.
//
// Same shape as `manager::brain::place_conformance` on the other side of the
// seam, and for the same reason. A mode is a row; the questions are a list; the
// suite is their product. Nothing anywhere selects which workflows a mode gets
// asked, so a new way of getting a machine cannot arrive with a short column —
// which is the one failure the whole programme is arranged against: **no feature
// may land in one place-mode only.**
//
// The frontend runs its own copy rather than trusting the Rust one because the
// two answer different questions. Rust asks what a place will DO. This asks
// whether every surface can treat a place as a place: the frontend's own way of
// shipping a feature in one mode only is a component that special-cases
// `machineId === null` and quietly does less for one of them.

import type { Machine } from "../../api";
import type { Place } from "../contract";
import { placeHere, placeOfMachine } from "../contract";
import { isGrantedHandle } from "../grant";

/** One of the workflows. Ids are the spec's own, so a red cell can be read
 *  against the brief without translation. */
export type WorkflowId =
  | "W1"
  | "W2"
  | "W3"
  | "W4"
  | "W5"
  | "W6"
  | "W7"
  | "W8"
  | "W9"
  | "W10"
  | "W11"
  | "W12"
  | "W13"
  | "W14"
  | "W15";

export type Workflow = { id: WorkflowId; title: string };

/** The whole matrix, in the words it was specified in.
 *
 *  The titles are quoted rather than paraphrased on purpose: a failure line
 *  prints one, and the person reading it should recognise the sentence they
 *  asked for rather than a summary of it. */
export const WORKFLOWS: readonly Workflow[] = [
  { id: "W1", title: "open a project" },
  { id: "W2", title: "new chat" },
  { id: "W3", title: "new workspace" },
  { id: "W4", title: "several workspaces on different projects on one place" },
  { id: "W5", title: "several places from one laptop" },
  { id: "W6", title: "pick which org I act as" },
  { id: "W7", title: "an org place offers only that org's projects" },
  { id: "W8", title: "personal and self-setup keep working" },
  {
    id: "W9",
    title: "admin enables cloud for a member, who then reaches it with zero SSH",
  },
  { id: "W10", title: "push a commit as myself on a shared place" },
  { id: "W11", title: "install a package without breaking a teammate" },
  { id: "W12", title: "see my spend separately from my teammate's" },
  { id: "W13", title: "sleep on idle and wake on demand" },
  {
    id: "W14",
    title: "ask a place what it has against what the project asks for",
  },
  { id: "W15", title: "run an agent that cannot reach the whole network" },
];

/** What a check found.
 *
 *  Two answers, not three. "It broke" is a thrown error, deliberately: a check
 *  that could RETURN a failure would let a mode's floor collapse into the same
 *  channel as an honest asymmetry, and the difference between those two is the
 *  entire value of this file. */
export type Outcome =
  | { kind: "met"; note: string }
  | { kind: "not-promised"; note: string };

export function met(note: string): Outcome {
  return { kind: "met", note };
}

/** This mode does not promise this workflow — and says what it does instead.
 *
 *  Only accepted where the table declared it up front. An undeclared one is a
 *  red cell, because "we never promised that" written after the fact is how a
 *  regression gets filed as a design decision. */
export function notPromised(note: string): Outcome {
  return { kind: "not-promised", note };
}

export type Check = (mode: Mode) => Promise<Outcome>;

/** A project, spelled the two ways a place has to hold it: where this laptop
 *  keeps it, and where the place keeps it. The pair is the point — collapsing
 *  them is how a box gets filed under a repo it has never seen. */
export type Project = { here: string; there: string; branch: string };

export const ALPHA: Project = {
  here: "/Users/me/alpha",
  there: "/srv/alpha",
  branch: "main",
};
export const BETA: Project = {
  here: "/Users/me/beta",
  there: "/srv/beta",
  branch: "feat/tidy-up",
};

export const ORG = "naridon";
export const OTHER_ORG = "mhask";
export const MEMBER = "mo";
export const TEAMMATE = "ana";
export const REMOTE = "https://github.com/naridon/aura.git";

/** The agent the workflows about spending start. A named engine rather than a
 *  bare string at each call site, because a credential is per engine — one member
 *  can be signed in to this and hold no key at all for the next one. */
export const ENGINE = "claude";

/** One way of coming to have a place.
 *
 *  Everything that makes a mode a mode is here: what its machine book row looks
 *  like, and which cells it has declared it does not promise. There is
 *  deliberately nowhere to put "and skip these workflows". */
export type Mode = {
  id: string;
  title: string;
  /** The book row this mode holds for a project, filed under `org`. `null` is
   *  this laptop, which is in no book at all — not a row with empty fields, an
   *  absence, because the absence is what makes it unfilterable by org. */
  row: (project: Project, org: string | null) => Machine | null;
  /** The cells this mode has declared up front that it does not promise, each
   *  with what it does instead. Empty for every mode that promises all
   *  of them. */
  notPromised: ReadonlyArray<readonly [WorkflowId, string]>;
};

/** This laptop is in no machine book. */
function noRow(): Machine | null {
  return null;
}

/** A box somebody brought: an address, a login, a key on this Mac, and a
 *  promise of ssh, tmux and git. Nothing else. */
function byocRow(project: Project, org: string | null): Machine {
  return {
    id: `ubuntu@10.0.0.4:${project.there}`,
    name: "aura-runner",
    host: "10.0.0.4",
    user: "ubuntu",
    key_path: "/Users/me/.ssh/aura-runner.pem",
    box_kind: "shared",
    repo_path: project.there,
    project_root: project.here,
    repo_branch: project.branch,
    org_slug: org,
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
  };
}

/** The asymmetry that belongs to the runtime rather than to the account.
 *
 *  Written once and named twice, because it is true of every box Aura did not
 *  make regardless of who may switch it off — and the day it stops being true it
 *  has to stop being true for both rows at once, or the table is lying about one
 *  of them. */
const KERNEL_ISOLATION: readonly [WorkflowId, string] = [
  "W11",
  "Kernel-level isolation. A box that promises only ssh, tmux and git separates its members by Unix account — their own home at 0700, their own authorized_keys at 0600, their own umask, their own runner token, their own prefix — so an install into their own home is their own, needs no root, and two members can hold two versions of one tool. It is not a kernel boundary: they still share one kernel and one /usr, and a system package manager is still system-wide, which is why `apt` is refused with a sentence rather than run.",
];

/** The two cells a box nobody gave Aura the keys to cannot honestly claim.
 *
 *  They read as one difference wearing two hats — Aura did not create the
 *  machine and cannot act in the account it runs in — and the `granted` row
 *  below is what shows they were two differences all along. The Aura-managed row
 *  closes both by existing; the granted one closes the second alone. */
const BYOC_ASYMMETRIES: ReadonlyArray<readonly [WorkflowId, string]> = [
  KERNEL_ISOLATION,
  [
    "W13",
    "Lifecycle. Aura holds no credential for the account this machine runs in, so nothing here can stop one or start one. An idle box stays up on its owner's bill. Walking away costs the work nothing — the sessions are held on the box and are there when you come back — but the idle is not free. This one is about permission and not about hardware: the same box, in an account whose owner grants Aura a role in it, is the `granted` row and does not declare this.",
  ],
];

/** What is left once the customer has granted Aura a role in their account.
 *
 *  One entry, and that is the row's whole claim: the lifecycle asymmetry is
 *  gone, and the isolation one is not — because a grant changes who may switch
 *  the machine off and changes nothing about what the machine is. */
const GRANTED_ASYMMETRIES: ReadonlyArray<readonly [WorkflowId, string]> = [
  KERNEL_ISOLATION,
];

/** The name Aura's own key for this machine answers to.
 *
 *  A reference, not a path — the same string `cmd_machines::made_machine` writes
 *  into the row, and the same one `place_conformance` runs its column against.
 *  There is no file behind it anywhere on this Mac: the backend turns it into a
 *  local agent instead of an `-i`, which is what "the member never holds the key"
 *  means once it is spelled out in a field. Written as a `.pem` path here, every
 *  cell below would have come out green about a place Aura never makes. */
export const MANAGED_KEY_REF = "managed:0f5b1f1a-9c4b-4c6f-8a3e-6d5c4b3a2e10";

/** The substrate's own handle for the machine Aura made — the string that makes
 *  the row stoppable, unqualified because the account it names is Aura's own. */
export const MANAGED_HANDLE = "i-0abc123def456789";

/** The same shape of handle for a box the customer owns, qualified by the
 *  account they granted Aura a role in.
 *
 *  The whole difference between the two rows below is this one string, which is
 *  the point: the machine, the login, the key on this Mac and the bill are all
 *  identical, and what changed is that somebody said Aura may switch it off. */
export const GRANTED_HANDLE = "grant:acme-eu/i-0abc123def456789";

/** A box Aura made: the same runtime, reached the same way, differing only in
 *  who made the machine — and therefore who holds the key and who gets the bill.
 *
 *  The fields that differ from `byocRow` are exactly the permitted ones.
 *  `box_kind` says Aura made it, which is what every surface reads to know the
 *  time is billable and the machine is one Aura can stop and start; `key_path`
 *  holds a reference rather than a path, because Aura holds this key and lends a
 *  signature at a time. The login and the project under a root are the same shape
 *  on purpose: a managed place is not a second kind of place, and every surface
 *  reads one machine shape rather than two. */
export function managedRow(project: Project, org: string | null): Machine {
  return {
    id: `ubuntu@10.0.0.7:${project.there}`,
    name: "aura-managed",
    host: "10.0.0.7",
    user: "ubuntu",
    key_path: MANAGED_KEY_REF,
    box_kind: "managed",
    repo_path: project.there,
    project_root: project.here,
    repo_branch: project.branch,
    org_slug: org,
    instance_id: MANAGED_HANDLE,
    added_at: 1_750_000_000,
    last_used_at: 1_750_003_600,
  };
}

/** A box you brought, in a cloud account you have granted Aura a role in.
 *
 *  Byte for byte the row above it except for one field, which is the row's whole
 *  argument: the machine, the login, the key on this Mac and the bill are the
 *  customer's, and Aura may still put it to sleep. The handle is qualified
 *  because a stop against their box is signed by the role they granted rather
 *  than by Aura's own credential. */
export function grantedRow(project: Project, org: string | null): Machine {
  return { ...byocRow(project, org), name: "acme-runner", instance_id: GRANTED_HANDLE };
}

/** Every mode that ships today.
 *
 *  Four, and the last two both arrived the way this list promised: one entry
 *  each, asked every workflow with nothing else moving — not a check, not the
 *  runner, not the workflow list. That was the acceptance criterion, written
 *  where it could be checked rather than in a comment somewhere.
 *
 *  The fourth is the one that shows the two amber cells were never the same
 *  cell. It runs on the customer's metal, on the customer's bill, and it sleeps
 *  — because a lifecycle needs permission rather than ownership, and a customer
 *  can give the one without giving up the other. */
export const MODES: readonly Mode[] = [
  { id: "here", title: "This laptop", row: noRow, notPromised: [] },
  {
    id: "box",
    title: "A box you brought (ssh + tmux + git)",
    row: byocRow,
    notPromised: BYOC_ASYMMETRIES,
  },
  {
    id: "managed",
    title: "A box Aura made (ssh + tmux + git, on Aura's account)",
    row: managedRow,
    notPromised: [],
  },
  {
    id: "granted",
    title: "A box you brought, in a cloud account Aura may act in",
    row: grantedRow,
    notPromised: GRANTED_ASYMMETRIES,
  },
];

/** This mode's place for a project, filed under an org.
 *
 *  The ONE constructor that knows the modes are built differently, so no check
 *  has to. A mode with no book row is this laptop, and it gets the local
 *  spelling — which is the whole reason `placeHere` exists rather than the
 *  frontend having a box-shaped seam with a null-check in front of it. */
export function placeIn(
  mode: Mode,
  project: Project,
  org: string | null,
): Place {
  const row = mode.row(project, org);
  return row ? placeOfMachine(row) : placeHere(project.here);
}

/** This mode's place for a project, acting as the org it was connected under. */
export function placeOf(mode: Mode, project: Project): Place {
  return placeIn(mode, project, ORG);
}

/** What this mode declared it does not promise for this workflow, if anything. */
export function caveatFor(mode: Mode, workflow: WorkflowId): string | null {
  const found = mode.notPromised.find(([w]) => w === workflow);
  return found ? found[1] : null;
}

/** Did Aura make this place, and does Aura therefore bill for it?
 *
 *  The mirror of `Place::billing`'s second half on the Rust side, and the only
 *  reading of `kind` this suite allows. `kind` is one of the four things a mode
 *  is permitted to differ on — who creates the machine, where the address
 *  lives, who holds the key, who gets the bill — and a check may consult it for
 *  exactly that. It may never consult it to decide what a place can DO, which
 *  is why it is spelled once, here, and pinned by a test that reads
 *  `workflows.ts` and fails if it mentions a kind at all. */
export function auraMadeThisPlace(place: Place): boolean {
  return place.identity.kind === "managed";
}

/** May Aura stop and start this place?
 *
 *  Not the same question as `auraMadeThisPlace`, and it stopped being the same
 *  question the day a customer could grant Aura a narrow role in their own cloud
 *  account. A machine Aura made is always one Aura may switch off; a machine
 *  somebody else owns may be one too, and the row says so by carrying a handle
 *  qualified with the account they granted.
 *
 *  Read off the row rather than off the kind, for the same reason `whoPays` is
 *  read off the kind rather than off a component's memory: this is what every
 *  surface offering a Sleep button consults, and a second spelling of it
 *  somewhere is a surface that offers to stop a machine nothing can start. */
export function auraDrivesLifecycle(place: Place): boolean {
  return auraMadeThisPlace(place) || isGrantedHandle(place.lifecycleHandle);
}

/** Whose bill this place lands on, in the same words the Rust seam uses. */
export function whoPays(place: Place): string {
  switch (place.identity.kind) {
    case "here":
      return "you (this laptop)";
    case "mine":
      return "you (your own machine)";
    case "shared":
      return "the machine's owner";
    case "managed":
      return "your Aura account";
  }
}

/** A second place, always somewhere else, for the workflows about holding more
 *  than one at a time. Deliberately not built from the mode under test: "two
 *  places at once" has to hold when one of them is this laptop. */
export function neighbour(): Place {
  return placeOfMachine({
    id: `ana@10.0.0.9:${BETA.there}`,
    name: "ana-runner",
    host: "10.0.0.9",
    user: "ana",
    key_path: "/Users/me/.ssh/ana.pem",
    box_kind: "mine",
    repo_path: BETA.there,
    project_root: BETA.here,
    repo_branch: BETA.branch,
    org_slug: OTHER_ORG,
    added_at: 1_750_000_100,
    last_used_at: 1_750_003_700,
  });
}
