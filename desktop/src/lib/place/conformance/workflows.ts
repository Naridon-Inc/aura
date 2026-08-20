// The workflows, as questions put to the frontend seam.
//
// Every check here is asked of every mode and has no idea which one it is
// holding. That is enforced rather than encouraged: the suite reads this file's
// own source and fails if a check consults `identity.kind` or the mode's id. A
// check that knew which mode it was answering would go on passing while the two
// of them drifted apart, which is the exact failure the matrix exists to catch.
//
// Where a workflow genuinely turns on one of the four things a mode is allowed
// to differ on, it asks the contract: `identity.host` for "is this somewhere you
// dial", `auraMadeThisPlace` for "did Aura create this and does Aura bill for
// it", and `auraDrivesLifecycle` for "may Aura switch this off". Those are why
// the Aura-managed row turned both amber cells green without a line changing in
// this file — and why the granted row, later, turned one of them green while
// leaving the other honestly amber.
//
// The last two are deliberately not the same question. They were, right up until
// a customer could grant Aura a narrow role in their own cloud account: a
// machine on somebody else's bill can now be one Aura stops, and a check that
// still read ownership where it means permission would have failed the row that
// proves it.

import type { BoxProject, PlaceProjects } from "../../api";
import { agentLending, agentLendingBadge } from "../agentForward";
import type { AuthorPlan, GitAuthor } from "../author";
import {
  adoptAuthor,
  askAuthor,
  authorLine,
  authorTone,
  needsAdopting,
  whyNotMe,
} from "../author";
import {
  AGENT_CANDIDATES,
  AGENT_CANDIDATE_BINS,
  askCapabilities,
  offerableAgents,
  resolveSelectedAgent,
} from "../capabilities";
import { canOpenTerminal } from "../boot";
import { ORG_CHANGED_EVENT, onOrgChanged } from "../../cloudOrgs";
import {
  WHOAMI,
  becomeMember,
  sawWho,
  writeRunnerEnv,
} from "../../../components/commons/crew/memberAccount";
import type { Place } from "../contract";
import { placeAddress } from "../contract";
import type { Drift } from "../drift";
import {
  alsoHere,
  askDrift,
  blocking,
  compare,
  driftHeadline,
  driftTone,
  met as metItems,
  trustWarning,
} from "../drift";
import type { AgentPhase, Allowed } from "../egress";
import {
  askAgentPhase,
  clean,
  egressHeadline,
  egressTone,
  listed,
  permissions,
  refusals,
  reportHeadline,
  tries,
} from "../egress";
import {
  filePlaces,
  placeRowLabel,
  projectToFilePlaceUnder,
} from "../placement";
import {
  asleepFor,
  isAsleep,
  isReachable,
  sleepBadge,
  sleepingInsteadOfError,
} from "../sleep";
import type { Waking } from "../../api";
import {
  runningLate,
  startsItselfLine,
  wakeHeadline,
  wakeProgress,
  waitedFor,
} from "../wake";
import {
  UNREAD,
  isUnnarrowed,
  projectsNotice,
  whyNotOffered,
  withheldProjects,
} from "../projects";
import type { KeyPlan } from "../agentKey";
import { askAgentKey, keySentence, keyTone, whyNotMyKey } from "../agentKey";
import type { PushPlan } from "../pushCredential";
import {
  askPushCredential,
  credentialSentence,
  credentialTone,
  whyNotMine,
} from "../pushCredential";
import type { TeamBase } from "../teamBase";
import {
  askTeamBase,
  baseIsUsable,
  baseWarning,
  warmSentence,
  warmShortfall,
  warmStart,
} from "../teamBase";
import { installForMe, installWorked, installedSentence } from "../toolbox";
import type { ToolchainReport } from "../toolchain";
import {
  askToolchain,
  collisions,
  separated,
  toolchainSentence,
} from "../toolchain";
import type { Check, WorkflowId } from "./matrix";
import {
  ALPHA,
  BETA,
  ENGINE,
  MEMBER,
  ORG,
  OTHER_ORG,
  REMOTE,
  TEAMMATE,
  auraDrivesLifecycle,
  auraMadeThisPlace,
  met,
  neighbour,
  notPromised,
  placeIn,
  placeOf,
  whoPays,
} from "./matrix";
import { answers, forgetReached, reached } from "./probe";

/**
 * W1 — open a project.
 *
 * Two things, and the second is the one that is easy to lose. The place is filed
 * under a project on THIS disk, wherever the code itself lives; and the call
 * that reaches it is handed the place, not a machine id with a null-check in
 * front of it. The second is the frontend's whole version of the seam: one call
 * shape means a feature cannot be arranged for one way of getting a place and
 * not the other.
 */
const openAProject: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  ensure(
    place.project.root === ALPHA.here,
    "the place is filed under a project that is not on this disk",
  );
  forgetReached();
  await askCapabilities(place);
  const ask = lastOf(reached.capabilities, "asking the place what it can run reached nothing");
  ensure(
    ask.target.root === place.project.root &&
      ask.target.machineId === place.machineId,
    "the call that reaches this place was handed something other than the place",
  );
  ensure(
    placeRowLabel(place).work.trim().length > 0,
    "the opened project has no row to come back to",
  );
  return met(`filed under ${place.project.root} and reached as itself`);
};

/**
 * W2 — new chat.
 *
 * The agent picker, which is the one surface that used to be box-shaped: six
 * CLIs offered on every machine, and a probe that answered for boxes only. The
 * rule it lost and must not lose again is that `null` is not `[]` — we-haven't-
 * asked is not it-has-none — because an empty picker in front of somebody whose
 * place is merely slow to answer tells them their machine is broken.
 */
const newChat: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  forgetReached();
  await askCapabilities(place);
  const ask = lastOf(reached.capabilities, "this place could not be asked what it runs");
  ensure(
    ask.bins.join(",") === AGENT_CANDIDATE_BINS.join(","),
    "this place was asked about a different set of agents than the others",
  );
  ensure(
    offerableAgents(null).length === AGENT_CANDIDATES.length,
    "a place that has not answered yet is offered an empty picker",
  );
  const answered = offerableAgents({
    agents: ["claude", "codex"],
    git: true,
    tmux: true,
    aura: false,
  });
  ensure(
    answered.map((a) => a.id).join(",") === "claude,codex",
    "the picker offered agents the place never reported",
  );
  ensure(
    offerableAgents({ agents: [], git: true, tmux: true, aura: false })
      .length === 0,
    "a place that genuinely has none was offered some anyway",
  );
  ensure(
    resolveSelectedAgent("codex", answered) === "codex",
    "a pick that is still installed was thrown away",
  );
  ensure(
    resolveSelectedAgent("gemini", answered) === "claude",
    "a pick that is not installed here was left selected",
  );
  return met("the same six are asked about and only the answered ones offered");
};

/**
 * W3 — new workspace.
 *
 * A workspace gets a row, and the row names the WORK. Every other row in that
 * rail names a piece of work; the machine row named a computer, so the one row
 * that could have said what is happening somewhere else said only that
 * somewhere else exists. And a workspace opened from a project the place has not
 * been filed under yet learns its project for free — but only when we do not
 * already know, because re-filing on every visit would make a place's position
 * depend on where you came from.
 */
const newWorkspace: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  const row = placeRowLabel(place);
  ensure(row.work.trim().length > 0, "the new workspace's row has nothing to call it");
  ensure(
    row.work !== placeAddress(place) && !row.work.includes("@"),
    "the row names an address instead of the work",
  );
  const unfiled: Place = {
    ...place,
    project: { ...place.project, root: null },
  };
  ensure(
    projectToFilePlaceUnder(unfiled, BETA.here) === BETA.here,
    "a new workspace would not be filed under the project it was opened from",
  );
  ensure(
    projectToFilePlaceUnder(place, BETA.here) === null,
    "opening a place from elsewhere would re-file it under wherever you came from",
  );
  return met(`the row reads "${row.work}", which is the work rather than the machine`);
};

/**
 * W4 — several workspaces on different projects on one place.
 *
 * One machine, two pieces of work. Both halves are easy to get wrong: the two
 * must file under their own projects and draw distinguishable rows, and they
 * must still be recognisably ONE machine rather than the rail quietly treating
 * a second project as a second box.
 */
const severalWorkspacesOnOnePlace: Check = async (mode) => {
  const alpha = placeOf(mode, ALPHA);
  const beta = placeOf(mode, BETA);
  ensure(
    alpha.identity.host === beta.identity.host &&
      alpha.identity.user === beta.identity.user,
    "two workspaces on one place answered as two different machines",
  );
  const filing = filePlaces([alpha, beta], new Set([ALPHA.here, BETA.here]));
  ensure(
    filing.unplaced.length === 0,
    "a workspace on a project the rail is showing was left off it",
  );
  ensure(
    filing.byProject.get(ALPHA.here)?.[0] === alpha &&
      filing.byProject.get(BETA.here)?.[0] === beta,
    "two workspaces on one place landed under the wrong projects",
  );
  ensure(
    placeRowLabel(alpha).work !== placeRowLabel(beta).work,
    "two workspaces on one place draw the same row",
  );
  return met(
    `${placeRowLabel(alpha).work} and ${placeRowLabel(beta).work} are two rows on one machine`,
  );
};

/**
 * W5 — several places from one laptop.
 *
 * Nothing global decides which place is "current". Each carries everything
 * needed to reach it, so two of them are two values held at once and each files
 * under its own project.
 */
const severalPlacesFromOneLaptop: Check = async (mode) => {
  const mine = placeOf(mode, ALPHA);
  const theirs = neighbour();
  ensure(
    mine.identity.host !== theirs.identity.host,
    "two places held at once share a host",
  );
  ensure(
    placeAddress(mine) !== placeAddress(theirs),
    "two places held at once share an address",
  );
  const filing = filePlaces([mine, theirs], new Set([ALPHA.here, BETA.here]));
  ensure(
    filing.byProject.get(ALPHA.here)?.includes(mine) === true &&
      filing.byProject.get(BETA.here)?.includes(theirs) === true,
    "two places held at once were filed under each other's projects",
  );
  return met(`${mine.name} and ${theirs.name} are held side by side`);
};

/**
 * W6 — pick which org I act as.
 *
 * Acting as an org is a hat, not a move. It changes which places are OFFERED; it
 * must never change what a place IS, or an open workspace would stop being
 * reachable the moment somebody looked at another team's board. And the switch
 * is a broadcast rather than renderer state, so a surface added tomorrow gets it
 * by listening — including the unsubscribe, without which a closed panel keeps
 * re-reading forever.
 */
const pickWhichOrgIActAs: Check = async (mode) => {
  const ours = placeOf(mode, ALPHA).identity;
  const theirs = placeIn(mode, ALPHA, OTHER_ORG).identity;
  ensure(
    ours.user === theirs.user &&
      ours.host === theirs.host &&
      ours.key_path === theirs.key_path &&
      ours.address === theirs.address,
    "acting as another org changed how this place is reached",
  );
  const reReads: string[] = [];
  const stopListening = onOrgChanged(() => {
    reReads.push("re-read");
  });
  window.dispatchEvent(new CustomEvent(ORG_CHANGED_EVENT));
  const afterSwitching = reReads.length;
  ensure(
    afterSwitching === 1,
    "switching org did not tell this surface to re-read",
  );
  window.dispatchEvent(new CustomEvent("aura:cloud-auth-changed"));
  const afterSigningIn = reReads.length;
  ensure(
    afterSigningIn === 2,
    "signing in or out did not tell this surface to re-read",
  );
  stopListening();
  window.dispatchEvent(new CustomEvent(ORG_CHANGED_EVENT));
  const afterLeaving = reReads.length;
  ensure(
    afterLeaving === 2,
    "a surface that went away is still being told to re-read",
  );
  return met("the same place under either hat, and every list re-reads on the switch");
};

/**
 * W7 — an org place offers only that org's projects.
 *
 * The backend does the filtering; the frontend's half is not to undo it. Three
 * ways that goes wrong and only one of them looks like a bug.
 *
 * A place whose project is not on screen must be set aside rather than dropped —
 * losing it takes the only address for that machine with it — and a project must
 * never be invented to hold one.
 *
 * The third arrived with the narrowing itself. Once the list a place offers is
 * shorter than the disk it sits on, the surface owes an explanation: the person
 * reading that dropdown is the person who cloned the missing repo, and a
 * silently shorter list is indistinguishable from a box that lost it. And the
 * "we could not ask" state has to widen the list rather than empty it, or a
 * dropped wifi connection reads as somebody's work being gone.
 */
const anOrgPlaceOffersOnlyThatOrgsProjects: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  const nothingShown = filePlaces([place], new Set<string>());
  ensure(
    nothingShown.unplaced.length === 1,
    "a place vanished because the project it belongs to was not on screen",
  );
  ensure(
    nothingShown.byProject.size === 0,
    "a project was invented to hold a place",
  );
  const shown = filePlaces([place], new Set([ALPHA.here]));
  ensure(
    shown.byProject.get(ALPHA.here)?.length === 1,
    "a place was not offered beside its own project",
  );
  ensure(
    projectToFilePlaceUnder(place, "/Users/me/somebody-elses-repo") === null,
    "opening a place from another project would re-file it under that one",
  );

  // The same disk, holding both orgs' work, as the backend hands it over.
  const narrowed = twoOrgsOnOneDisk();
  ensure(
    narrowed.projects.length === 1 && narrowed.projects[0].path === ALPHA.there,
    "a project belonging to another org reached the surface anyway",
  );
  ensure(
    whyNotOffered(narrowed, BETA.there) !== null,
    "a project was left off the list with nothing said about which, or why",
  );
  ensure(
    withheldProjects(narrowed).length === narrowed.withheld.length,
    "a reason went missing between the answer and the screen",
  );
  ensure(
    projectsNotice(narrowed) !== null && !isUnnarrowed(narrowed),
    "a clean filter was drawn as silence, or as a warning",
  );

  // Signed out, offline, or an org server having a bad afternoon.
  const couldNotAsk: PlaceProjects = {
    ...narrowed,
    narrowed: false,
    projects: [...narrowed.projects, held(BETA.there, OTHER_ORG)],
    withheld: [],
    notice: "Showing every project on this machine — Connection refused",
  };
  ensure(
    couldNotAsk.projects.length === 2 && isUnnarrowed(couldNotAsk),
    "a place nobody could ask about was drawn as an ordinary short list",
  );
  ensure(
    (projectsNotice(couldNotAsk) ?? "").includes("Connection refused"),
    "the list stopped being narrowed and did not say why",
  );

  // Nobody has asked yet. Neither a filter nor a failure — it is the first frame
  // of every panel, and a warning here would fire on all of them.
  ensure(
    !isUnnarrowed(UNREAD) && projectsNotice(UNREAD) === null,
    "an unread place was drawn as though something had gone wrong",
  );

  return met(
    "offered beside its own project, narrowed to its own org, and what it held back said out loud",
  );
};

/** One project sitting on a place, as a listing reports it. */
function held(path: string, org: string): BoxProject {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    name,
    remote: `https://github.com/${org}/${name}.git`,
    branch: "main",
    dirty: 0,
  };
}

/** A disk holding two orgs' work, as the backend narrows it for a member of the
 *  first — the shape every surface below this line is handed. */
function twoOrgsOnOneDisk(): PlaceProjects {
  const beta = held(BETA.there, OTHER_ORG);
  return {
    org: ORG,
    org_name: ORG,
    narrowed: true,
    projects: [held(ALPHA.there, ORG)],
    withheld: [
      {
        path: beta.path,
        name: beta.name,
        reason: `${OTHER_ORG}/${beta.name} belongs to ${OTHER_ORG}, not ${ORG}.`,
      },
    ],
    notice: `1 other project on this machine isn't ${ORG}'s, so it isn't listed here.`,
  };
}

/**
 * W8 — personal and self-setup keep working.
 *
 * The org apparatus arrived after people were already using this. A row written
 * before any of it existed — no org, no project root, fields somebody tabbed
 * past and left as whitespace — has to keep drawing and keep being reachable.
 * Blank is not an answer, and a place filed under a project named nothing is
 * worse than one filed under nothing at all.
 */
const personalAndSelfSetupKeepWorking: Check = async (mode) => {
  const older = placeIn(mode, { here: "   ", there: "   ", branch: "" }, null);
  ensure(older.project.root === null, "whitespace was filed as a project root");
  ensure(
    placeRowLabel(older).work.trim().length > 0,
    "a place with nothing recorded has no row to click",
  );
  const filing = filePlaces([older], new Set([ALPHA.here]));
  ensure(
    filing.unplaced.length === 1,
    "a place with no project was dropped rather than set aside",
  );
  forgetReached();
  await askCapabilities(older);
  ensure(
    reached.capabilities.length === 1,
    "a place connected before orgs existed could not be asked anything",
  );
  return met("no org, no project recorded, still drawn and still reachable");
};

/**
 * W9 — an admin turns cloud on for a member, who then reaches it with zero SSH.
 *
 * "Zero SSH" is not "no ssh happens". It is that the member never configures
 * one, never types one and never holds a key. On this side of the seam that
 * means two things: the renderer carries a REFERENCE to a key and never key
 * material, and nothing shows the member an address as though it were their work.
 *
 * A reference has two shapes — a path to a key file on this Mac, or a name for a
 * key Aura holds and lends a signature from — and this side is deliberately
 * incurious about which. Only the backend turns the difference into an ssh
 * option; a surface that inspected it here would be the first branch of the
 * one-mode drift the whole matrix exists to catch, and the check that demanded a
 * leading slash was already exactly that branch.
 */
const reachItWithZeroSsh: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  const carried = JSON.stringify(place);
  ensure(
    !carried.includes("PRIVATE KEY") && !carried.includes("BEGIN OPENSSH"),
    "key material is being carried around the renderer",
  );
  const id = place.identity;
  if (id.host === null) {
    ensure(
      id.key_path === null && id.address === null,
      "this laptop was given a key and an address it does not have",
    );
    ensure(placeAddress(place) === "", "this laptop was given an address to dial");
    return met("nothing to dial and no key to hold: the work runs where the app is");
  }
  ensure(
    typeof id.key_path === "string" && id.key_path.trim().length > 0,
    "a place you dial, with nothing recorded to authenticate with",
  );
  ensure(id.address !== null, "a place you dial, with no address to dial");
  // The gate the terminal button is drawn from. It reads the same three fields
  // whatever the key is spelled as, and a mode it said no to would be a place
  // with an address that nobody can open — a feature missing from one way of
  // getting a machine by accident of a string test.
  ensure(
    canOpenTerminal(place),
    "the terminal is refused at a place that has everything it takes to open one",
  );
  const row = placeRowLabel(place);
  ensure(
    row.work !== id.address,
    "the member is shown the address as though it were their work",
  );
  // And however the key is spelled, it is never on the row. A path is the
  // member's own business and a name for a key they were never given means
  // nothing to them; either one printed here is an arrangement they are being
  // asked to understand in order to click.
  ensure(
    !`${row.work} ${row.machine}`.includes(id.key_path!),
    "the row a member clicks names the key the place is opened with",
  );
  return met(`${MEMBER} is handed a place, not an address and a key to arrange`);
};

/**
 * W10 — push a commit as myself on a shared place.
 *
 * Two halves, and they fail differently. The token: one credential written into
 * `~/.git-credentials` for the whole machine, a bare `git push` inheriting it,
 * and the first anyone learns whose it was is a commit on GitHub under the wrong
 * account. The NAME: the author written into the commit object itself, which no
 * later credential fix reaches back into history to correct — and which on a
 * runner box was a baked-in `Aura Runner <runner@auravcs.com>`, so the audit
 * trail lost the person while every push looked healthy.
 *
 * The frontend's half of both is to ask the PLACE before the push, and to say
 * the answer — including the uncomfortable one, in a sentence that names whose
 * it will NOT be. Asking a repo root instead would answer about this laptop no
 * matter where the commit is about to be made.
 */
const pushAsMyself: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  forgetReached();
  answers.credential = ownCredential(place, MEMBER);
  const own = await askPushCredential(place, REMOTE, MEMBER);
  const ask = lastOf(reached.credential, "the credential question reached nothing");
  ensure(
    ask.target.machineId === place.machineId &&
      ask.target.root === place.project.root,
    "the credential question was asked of something other than this place",
  );
  ensure(ask.member === MEMBER, "the credential question did not say who was pushing");
  ensure(
    credentialTone(own) === "own",
    "a member's own credential was not reported as their own",
  );
  ensure(
    credentialSentence(own).includes(own.credential?.label ?? " "),
    "the sentence before the push does not name what it will spend",
  );

  answers.credential = sharedCredential(place, MEMBER);
  const shared = await askPushCredential(place, REMOTE, MEMBER);
  ensure(
    credentialTone(shared) === "shared",
    "a credential everybody on this place can use was not flagged as one",
  );
  ensure(
    credentialSentence(shared).includes(MEMBER),
    "the warning does not say whose name the commit would not land under",
  );
  ensure(
    whyNotMine(shared).length > 0,
    "nothing said why the member's own credential was not the one used",
  );

  // The name on the commit, asked of the same place through the same shape of
  // call. A place that could be asked whose token it would spend but not whose
  // name it would write is exactly half a feature.
  const me = authorOf(MEMBER);
  answers.author = machineAuthored(place, me);
  const carried = await askAuthor(place, me);
  const authorAsk = lastOf(
    reached.author,
    "nothing asked whose name a commit from this place would carry",
  );
  ensure(
    authorAsk.target.machineId === place.machineId &&
      authorAsk.target.root === place.project.root,
    "the author question was asked of something other than this place",
  );
  ensure(
    authorAsk.member?.email === me.email,
    "the author question did not carry who is asking, so it cannot say whether the author is theirs",
  );
  ensure(
    authorTone(carried) === "machine",
    "a commit that would go out under the machine's own name was not flagged as one",
  );
  ensure(
    needsAdopting(carried),
    "a commit authored by the box was reported as nothing for the member to do",
  );
  ensure(
    whyNotMe(carried).length > 0,
    "nothing said why the author on the next commit would not be the member's own",
  );

  answers.author = mineAuthored(place, me);
  const adopted = await adoptAuthor(place, me);
  const write = lastOf(reached.adopt, "adopting the account's identity reached nothing");
  ensure(
    write.target.machineId === place.machineId &&
      write.target.root === place.project.root,
    "the identity was written somewhere other than where the commit will be made",
  );
  ensure(
    write.author.name === me.name && write.author.email === me.email,
    "the identity written is not the one the account offers",
  );
  ensure(
    authorTone(adopted) === "own" && !needsAdopting(adopted),
    "after adopting their own identity the member is still told to adopt it",
  );

  // The third way "as myself" can be true: not a token and not a name, but the
  // member's own KEY, offered by their own computer and never written down on
  // the place. Over ssh it is the only one of the three that can be — a stored
  // credential cannot be spent on an ssh push at all.
  //
  // The frontend's half is the decision: it is off, it is offered on every
  // place you could make it about, and both halves of what it means are there
  // to read before anyone says yes. A mode that quietly skipped the control
  // would be a mode where pushing as yourself over ssh is impossible, with
  // nothing on screen saying so.
  const lending = agentLending(place);
  const lent = agentLending({
    ...place,
    identity: { ...place.identity, forward_agent: true },
  });
  ensure(
    !lending.on && !place.identity.forward_agent,
    "a place is lending the key on this laptop without anybody having said so",
  );
  if (lending.offered) {
    ensure(
      lending.grants.length > 0 && lending.withholds.length > 0,
      "the decision is offered without saying what it grants and what it withholds",
    );
    ensure(
      lending.action !== lent.action && lent.on,
      "there is no way back from lending a place your key",
    );
    ensure(
      agentLendingBadge(place) === null && agentLendingBadge({
        ...place,
        identity: { ...place.identity, forward_agent: true },
      }) !== null,
      "a place using your key is indistinguishable from one that is not",
    );
  } else {
    ensure(
      lending.state.trim().length > 0,
      "a place that cannot be lent a key says nothing about why",
    );
  }

  return met(
    `asked as ${MEMBER}, answered before anything is spent, and the commit lands as ${authorLine(me)}`,
  );
};

/**
 * W11 — install a package without breaking a teammate.
 *
 * Two things this side owns. First, where a global install LANDS, asked of the
 * place: `npm install -g`, `cargo install` and `gh auth login` all write to one
 * default location per machine, so on a box two people share the second install
 * silently replaces the first — it succeeds, and the person it breaks is not the
 * person who ran it. Asking has to be possible of any place, because "one member
 * works here" is an answer about this laptop, not an exemption from the question.
 *
 * Second, the wizard's own terminal. The account is made over the one ssh door;
 * what has to happen there is finding out who this session actually IS — not the
 * login typed into a form, which says who we DIALLED — becoming the member, and
 * writing their runner token where only they can read it. A token at 0644 on a
 * box several people have shells on is every member's token.
 *
 * How strong the resulting boundary is, is then the place's own promise.
 */
const installWithoutBreakingATeammate: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  forgetReached();
  answers.toolchain = separateToolchain(place, MEMBER);
  const own = await askToolchain(place, MEMBER);
  const ask = lastOf(
    reached.toolchain,
    "nothing asked this place where a global install would land",
  );
  ensure(
    ask.target.machineId === place.machineId &&
      ask.target.root === place.project.root,
    "the question about global installs was asked of something other than this place",
  );
  ensure(
    ask.login === MEMBER,
    "the question about global installs did not say whose installs it is about",
  );
  ensure(
    separated(own),
    "a toolchain kept under the member's own home was reported as one they share",
  );

  answers.toolchain = sharedToolchain(place, MEMBER);
  const shared = await askToolchain(place, MEMBER);
  ensure(
    !separated(shared),
    "a prefix every account on this place writes to was reported as the member's own",
  );
  ensure(
    collisions(shared).some((v) => v.collides.trim().length > 0),
    "a variable two members would collide on does not say what breaks",
  );
  ensure(
    toolchainSentence(shared).includes("npm"),
    "the warning does not name the tool whose install would overwrite a teammate's",
  );

  // Separation has a bill, and this is where it comes due. Two members with two
  // of everything means the second one's crate cache starts EMPTY, and on a
  // place whose spec asks for a rust toolchain that is the whole install again —
  // same bytes, same minutes, same machine. So the place is also asked where the
  // team's already-built environment is, and whether joining starts from it.
  // Asked of every mode, because "one member works here" is an answer to that
  // question, not an exemption from it.
  forgetReached();
  answers.base = teamEnvironment(place);
  const base = await askTeamBase(place);
  const askedBase = lastOf(
    reached.base,
    "nothing asked this place where the team's already-built environment is",
  );
  ensure(
    askedBase.target.machineId === place.machineId &&
      askedBase.target.root === place.project.root,
    "the question about the team's environment was asked of something other than this place",
  );
  ensure(
    baseIsUsable(base),
    baseWarning(base) ??
      "the team's environment here is not one a member could be started from",
  );
  ensure(
    base.carries.length === 0 && baseWarning(base) === null,
    "a shared environment was reported as fine while holding one person's credential",
  );
  // And the refusal itself, because the failure it prevents is the one worse
  // than a slow install: a teammate's token copied into every member's home.
  const holding: TeamBase = { ...base, carries: [".config/gh"] };
  ensure(!baseIsUsable(holding), "a base holding somebody's credential read as usable");
  ensure(
    (baseWarning(holding) ?? "").includes(".config/gh"),
    "refusing a base that is holding a credential does not say which one",
  );

  const joined = await warmStart(place, MEMBER);
  const askedWarm = lastOf(
    reached.warm,
    "nothing asked this place to start a member from the team's environment",
  );
  ensure(
    askedWarm.login === MEMBER,
    "a member was started from the team's environment without saying which member",
  );
  ensure(
    !askedWarm.force,
    "joining a place rebuilds the team's environment every time, which is the bill this exists to stop",
  );
  ensure(
    joined.start.failed.length === 0 && warmShortfall(joined.start) === null,
    "part of the copy failed and the member was not told, so they find out mid-build",
  );

  if (place.identity.host === null) {
    // One member, and it is the person typing. Their environment is the base:
    // nothing to build once, nothing to copy, and both said rather than assumed.
    ensure(
      joined.start.alone && joined.already_built,
      "this place claimed a member could be started from somebody else's environment while having only one member",
    );
    ensure(
      warmSentence(joined).includes("already standing in it"),
      "nothing said where the team's environment is on a place with one member",
    );
    return met(
      "one member works here, so an install changes one environment and it is theirs, and that same environment is the one they are already standing in",
    );
  }
  // The claim, on a place two people share: the second member through installs
  // nothing, and starts from what the first one paid for.
  ensure(
    joined.already_built,
    "a place already built to this spec would install it again for the second member",
  );
  ensure(
    joined.report === null,
    "a member joined a place that was already at spec and something was installed anyway",
  );
  ensure(
    joined.start.warm && joined.start.seeded.length > 0,
    "the second member starts from an empty home and re-downloads what the first already has",
  );
  ensure(
    joined.start.from !== MEMBER && joined.start.from !== TEAMMATE,
    "the environment everybody starts from belongs to one of them",
  );
  ensure(
    warmSentence(joined).includes("nothing was installed"),
    "nothing told the second member that they paid for none of this",
  );
  ensure(
    becomeMember(MEMBER) === `sudo -n -u '${MEMBER}' -i`,
    "the handover to the member is not a login shell in their own home",
  );
  ensure(
    becomeMember("mo's box").includes("'\\''"),
    "a login with an apostrophe in it would end the quoting and run the rest",
  );
  ensure(
    sawWho(`${WHOAMI} ubuntu\n${WHOAMI} ${MEMBER}\n`) === MEMBER,
    "the wizard would believe the shell it left rather than the one it is in",
  );
  const env = writeRunnerEnv();
  for (const [needed, complaint] of [
    ["umask 077", "the member's runner token would land readable by the others"],
    ["chmod 700 ~/.config/aura", "the member's config directory is open to the others"],
    [
      "chmod 600 ~/.config/aura/runner.env",
      "a token an earlier, laxer run left at 0644 is never healed",
    ],
  ] as const) {
    ensure(env.includes(needed), complaint);
  }
  // Separated accounts that then share one `npm install -g` have separated
  // nothing this workflow is about, so the install itself is asked for here.
  forgetReached();
  // The commands live in the backend, which is the point — this side proves the
  // ask carries whose install it is, and that the answer is judged on where the
  // binary actually landed rather than on the install having exited zero.
  const landed = await installForMe(
    place,
    `/home/${MEMBER}`,
    { manager: "npm", name: "cowsay", version: "1.5.0" },
    MEMBER,
  );
  ensure(
    reached.install.length === 1,
    "asking for a per-member install did not reach the place seam",
  );
  const asked = reached.install[0];
  ensure(
    asked.login === MEMBER && asked.home === `/home/${MEMBER}`,
    "an install was asked for without saying whose home it goes in",
  );
  ensure(installWorked(landed), "a member's own install did not land in their own home");
  ensure(
    installedSentence(landed).includes("Nobody else here is changed"),
    "nothing told the member that their install leaves the others alone",
  );
  // And the check that catches its own failure: a tool that installs and then
  // resolves to the machine's copy is not the install anybody thought they were
  // getting, and must not read as done.
  // Named apart from the shared *prefix* above: that one is a toolchain report
  // about a directory two members write to, this one is an install that landed
  // outside the member's home. Both are "shared" in English and neither is the
  // other, so they do not get to be the same word in one function.
  const machineWide = { ...landed, at: "/usr/local/bin/cowsay", mine: false };
  ensure(!installWorked(machineWide), "a machine-wide copy was presented as the member's own");
  ensure(
    installedSentence(machineWide).includes("the machine's copy"),
    "an install that landed somewhere shared says so in no words a person reads",
  );

  if (auraMadeThisPlace(place)) {
    return met(
      "a kernel boundary around this place, with a Unix boundary per member inside it, an install that lands in the member's own home without root, and a team environment built once that the next member starts from instead of rebuilding",
    );
  }
  return notPromised(
    `${MEMBER} and ${TEAMMATE} each get their own home at 0700 here, their own key file at 0600, their own runner token at 0600 and their own npm prefix, cargo home, rustup home and gh config inside it — so each installs into their own prefix without root, two versions of one tool coexist, and neither member is the other's problem. Separate does not mean starting from nothing: the project's declared environment is built once in an account that belongs to nobody and holds no credential of anybody's, and each member's caches are branched from it, so the first member pays the install and the second pays a file copy. They still share one kernel and one /usr, and a system package manager is still system-wide, which is why \`apt\` is refused with a sentence rather than run`,
  );
};

/**
 * W12 — see my spend separately from my teammate's.
 *
 * Attribution before counting, and the counting is the easy half. Every question
 * this place is asked about what will be spent carries the person asking it, so
 * two members on one place are two identities before anything is added up. A
 * place where both people are `ubuntu` produces one total no matter how
 * carefully the cloud adds it.
 *
 * Two spends, because a place costs money in two ways. A push is a name on a
 * commit; an agent run is tokens on somebody's invoice, and that is the one the
 * ledger could not recover afterwards — one org key, every member, every spend
 * looking identical. So both are asked here, both per member, and the surface has
 * to be able to SAY whose before either happens.
 */
const mySpendApartFromMyTeammates: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  forgetReached();
  answers.credential = ownCredential(place, MEMBER);
  await askPushCredential(place, REMOTE, MEMBER);
  answers.credential = ownCredential(place, TEAMMATE);
  await askPushCredential(place, REMOTE, TEAMMATE);
  ensure(
    reached.credential.length === 2,
    "two members asking the same place did not produce two asks",
  );
  const [mine, theirs] = reached.credential;
  ensure(
    mine.member === MEMBER && theirs.member === TEAMMATE,
    "two members on one place were asked about as one identity",
  );

  // The tokens half. Same place, same engine, two members — and the answers have
  // to be two credentials rather than one shared one wearing two names.
  answers.agentKey = ownKey(place, MEMBER);
  const myRun = await askAgentKey(place, ENGINE, MEMBER);
  answers.agentKey = ownKey(place, TEAMMATE);
  const theirRun = await askAgentKey(place, ENGINE, TEAMMATE);
  ensure(
    reached.agentKey.length === 2 &&
      reached.agentKey[0]?.member === MEMBER &&
      reached.agentKey[1]?.member === TEAMMATE,
    "two members starting an agent on one place were asked about as one identity",
  );
  ensure(
    reached.agentKey.every((a) => a.engine === ENGINE),
    "a place was asked for a credential without saying which engine would spend it",
  );
  ensure(
    keyTone(myRun) === "own" && keyTone(theirRun) === "own",
    "a member with a key of their own is still shown as spending somebody else's",
  );
  ensure(
    myRun.key?.spender !== theirRun.key?.spender,
    `${MEMBER} and ${TEAMMATE} would spend one credential here`,
  );

  // And the org key is still there, still working, and still saying so. Demoted
  // is not removed — a team that pays centrally wants exactly this.
  answers.agentKey = orgKey(place, MEMBER);
  const fallback = await askAgentKey(place, ENGINE, MEMBER);
  ensure(
    keyTone(fallback) === "shared",
    "the org's key is drawn as though it were this member's own",
  );
  ensure(
    keySentence(fallback).includes(fallback.key?.spender ?? " "),
    "a run would spend somebody else's credential without the screen saying whose",
  );
  ensure(
    whyNotMyKey(fallback).length > 0,
    "a member on the org's key is not told why, so there is nothing they can do about it",
  );

  const payer = whoPays(place);
  ensure(payer.trim().length > 0, "a place that will not say whose bill it is");
  return met(
    `the bill is ${payer}'s, ${MEMBER} and ${TEAMMATE} are two identities here rather than one login, and an agent each spends their own credential — the org's key is reached last and named as everybody's`,
  );
};

/**
 * W13 — sleep on idle and wake on demand.
 *
 * The floor first, and it is the same floor for every mode: a place nobody has
 * touched must still DRAW, out of what the book already holds, without reaching
 * it. A picker that emptied itself while a box was asleep, or a rail row that
 * disappeared, would tell somebody their machine is broken at the exact moment
 * it is merely idle.
 *
 * Then the half this workflow exists for. A place that is asleep must READ as
 * asleep — a stopped machine refuses connections exactly the way a dead one
 * does, so the difference cannot be found by asking and can only be known from
 * the row. Every mode is held to that, including the ones nothing here can stop:
 * a row that arrives carrying a sleep stamp has to be drawn as sleeping whoever
 * put it to sleep, and no surface may reach a place it has been told is down.
 *
 * Whether it then stops COSTING is a lifecycle question, and a lifecycle is only
 * actionable by whoever can act in the account the machine runs in. Aura can act
 * in its own, and in any account whose owner has granted it a role — which is
 * why this cell turns on permission rather than on who bought the hardware.
 */
const sleepOnIdleAndWakeOnDemand: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  const cold: Place = { ...place, capabilities: null };
  ensure(
    offerableAgents(cold.capabilities).length === AGENT_CANDIDATES.length,
    "a sleeping place is drawn as having no agents rather than as unasked",
  );
  ensure(
    placeRowLabel(cold).work.trim().length > 0,
    "a sleeping place has no row to wake it from",
  );
  const filing = filePlaces([cold], new Set([ALPHA.here]));
  ensure(
    filing.byProject.size + filing.unplaced.length === 1,
    "a sleeping place left the rail entirely",
  );

  // Awake is the default, and it has to be: the whole machine book predates the
  // sleep stamp, and a missing field read as a timestamp would draw every
  // machine anybody owns as stopped.
  ensure(
    !isAsleep(place) && isReachable(place),
    "a place with no sleep stamp is drawn as stopped, so an ordinary machine reads as switched off",
  );
  ensure(
    sleepingInsteadOfError(place) === null,
    "an awake place hands out an excuse for a failed connection, so a genuinely dead machine would read as merely sleeping",
  );

  // And the same row with a stamp on it. Built by hand rather than by stopping
  // anything, because this asks how a place is READ, and the reading has to hold
  // for a row that arrived asleep from anywhere.
  const stopped: Place = { ...place, asleepSince: 1_750_000_500 };
  const nowMs = 1_750_007_700_000;
  ensure(
    isAsleep(stopped) && !isReachable(stopped),
    "a place carrying a sleep stamp is still drawn as reachable, so something will dial a machine that cannot answer",
  );
  ensure(
    sleepBadge(stopped).trim().length > 0,
    "a sleeping place has no word on its row, so it is indistinguishable from one that is up",
  );
  const instead = sleepingInsteadOfError(stopped);
  ensure(
    instead !== null && instead.toLowerCase().includes("asleep"),
    "a sleeping place has nothing to say in place of a connection error",
  );
  for (const alarming of ["unreachable", "offline", "failed", "error", "broken"]) {
    ensure(
      !instead!.toLowerCase().includes(alarming),
      `a sleeping place is described with the word "${alarming}", which is the exact misreading this workflow exists to prevent`,
    );
  }
  ensure(
    asleepFor(stopped, nowMs).trim().length > 0,
    "a sleeping place cannot say how long it has been asleep, so there is no way to tell a nap from an abandoned box",
  );
  // Still a row, still filed, still openable — asleep is a state, not a removal.
  ensure(
    placeRowLabel(stopped).work.trim().length > 0 &&
      filePlaces([stopped], new Set([ALPHA.here])).byProject.size === 1,
    "a sleeping place left the rail, so the only way back to it went with it",
  );

  // Then the wake side, which is the half that decides whether sleeping is a
  // feature or a trap. Stopping a machine and leaving the member to work out how
  // to get it back is worse than never stopping it: they have paid for the
  // saving with a state they have to learn. The engine's answer is what the
  // surface is handed, so it is built here the way the engine would answer for
  // this mode — and every mode is held to the words, including the one that
  // cannot promise the wake.
  const wakeable = place.identity.host !== null && auraDrivesLifecycle(place);
  const waking: Waking = {
    place: place.name,
    machine_id: placeAddress(place),
    state: "asleep",
    since: 0,
    usually: 60,
    wakes_on_demand: wakeable,
    note: "",
  };
  const invitation = startsItselfLine(waking);
  ensure(
    wakeable === (invitation.trim().length > 0),
    wakeable
      ? "a place Aura can start does not say that using it starts it, so a member goes looking for a button instead of carrying on"
      : "a place Aura cannot start still promises that using it will start it, which is a promise nobody here can keep",
  );

  const started = { ...waking, state: "waking" as const, since: 1_750_007_680 };
  const early = wakeHeadline(started, nowMs);
  const late = wakeHeadline(started, nowMs + 120_000);
  ensure(
    early.includes(place.name) && waitedFor(started, nowMs).trim().length > 0,
    "a place being started says neither which machine nor how long it has been, so a minute of nothing is indistinguishable from a hang",
  );
  ensure(
    wakeProgress(started, nowMs) > 0 && wakeProgress(started, nowMs + 600_000) === 1,
    "the wait has no shape to draw, or draws a bar that keeps filling past its own end",
  );
  ensure(
    !runningLate(started, nowMs) && runningLate(started, nowMs + 120_000),
    "a wake running past the usual minute either says so too early or never says so at all",
  );
  for (const alarming of ["unreachable", "offline", "failed", "error", "broken"]) {
    ensure(
      !`${early} ${late} ${invitation}`.toLowerCase().includes(alarming),
      `a place that is starting is described with the word "${alarming}", which is the same misreading one state later`,
    );
  }

  if (place.identity.host === null) {
    return met(
      "an idle laptop costs Aura nothing, and what is running on it is there when you come back",
    );
  }
  if (auraDrivesLifecycle(place)) {
    return met(
      `${
        auraMadeThisPlace(place)
          ? "Aura made this place and can act in the account it runs in"
          : `${whoPays(place)} owns this box and granted Aura a role in the account it runs in`
      }, so an idle box is stopped and the next thing that reaches it starts it — and through both states every surface says asleep or starting rather than reporting a machine that would not answer`,
    );
  }
  return notPromised(
    `Nobody has given Aura a way to act in the account ${place.name} runs in, so nothing here can stop it or start it: it stays up, on the bill of ${whoPays(place)}. Walking away costs the work nothing — the sessions are held on the box and are there when you come back — but the idle is not free. If something else stops it, its row still reads as asleep rather than as broken. Granting Aura a scoped role in that account is what turns this cell green, and it is the owner's to grant and to take back`,
  );
};

/**
 * W14 — ask a place what it has against what the project asks for.
 *
 * "Works here, not there" as a diff. The frontend's half of it is smaller than
 * the backend's and turns on one thing: the report is asked for with a PLACE, so
 * the laptop end of the comparison is expressible in the same words as the box
 * end. A drift report you can only get about a box is worth nothing, because the
 * comparison anybody actually wants is the box against the machine it works on.
 *
 * The rest is the reading. A surface with room for three rows has to be able to
 * pick which three, and the picking is here rather than in a component: which
 * lines block, which are merely undeclared, and what the header says when the
 * project declares no environment at all.
 */
const whatItHasAgainstWhatIsAskedFor: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  forgetReached();
  answers.drift = behindSpec(place);
  const report = await askDrift(place);

  const ask = lastOf(reached.drift, "this place could not be asked what it has");
  ensure(
    ask.target.root === place.project.root &&
      ask.target.machineId === place.machineId,
    "the call that measures this place was handed something other than the place",
  );
  ensure(
    ask.bins.join(",") === AGENT_CANDIDATE_BINS.join(","),
    "the drift report asks about a different set of agents than the picker does",
  );

  ensure(
    blocking(report).map((i) => i.id).join(",") ===
      "runtime:tmux,toolchain:node,package:brew/ripgrep",
    "the lines that stop this place being what was asked for are not the ones shown first",
  );
  ensure(
    blocking(report).every((i) => i.detail.trim().length > 0),
    "a line says something is wrong here without saying what goes wrong",
  );
  ensure(
    blocking(report).some((i) => i.fix !== null),
    "nothing in the report says how to close a single one of these gaps",
  );
  ensure(
    driftTone("missing") === "bad" && driftTone("unasked") === "info",
    "a gap and an undeclared extra are drawn as the same thing",
  );

  // The honest other half. A place holding something nobody declared is not a
  // fault, and folding it into the fault list is how a report stops being read.
  ensure(
    alsoHere(report).map((i) => i.id).join(",") === "agent:codex",
    "what this place has that nothing asked for was dropped from the diff",
  );
  ensure(
    blocking(report).length + alsoHere(report).length + metItems(report).length ===
      report.items.length,
    "a line in the report belongs to none of the three readings of it",
  );

  const headline = driftHeadline(report);
  ensure(
    headline.includes("Behind spec v7") && headline.includes("3 missing"),
    "the header does not say how far behind this place is",
  );
  ensure(
    !headline.includes(report.place),
    "the header repeats the place a panel already names",
  );
  ensure(
    trustWarning({ state: "stale", sealed: "a1", actual: "b2" }) !== null,
    "a spec edited since it was sealed is measured against without a word",
  );
  ensure(
    driftHeadline({ ...report, declares_environment: false }).includes(
      "declares no environment",
    ),
    "a project with no spec is reported as being behind one",
  );

  // And the diff itself, which is the workflow's own sentence: two places, as
  // the rows they differ on. Node is here on the other one and missing on this
  // one; ripgrep is short on both and is not a difference between them.
  const rows = compare(report, atSpec(neighbour()));
  const differing = rows.map((r) => r.id);
  ensure(
    differing.includes("toolchain:node"),
    "the one tool that differs between these two places is not in the diff",
  );
  ensure(
    !differing.includes("package:brew/ripgrep"),
    "the diff lists something both places agree about",
  );
  ensure(
    rows.some((r) => r.left === null || r.right === null),
    "a thing one place has and the other has never heard of is not reported as a difference",
  );

  return met(
    `${place.name} answers with ${report.missing} missing and ${alsoHere(report).length} undeclared, and sets against another place as rows`,
  );
};

/**
 * W15 — run an agent that cannot reach the whole network.
 *
 * A run has two phases and they get different networks. Setup installs, with
 * everything, because a list that has to contain whatever `npm ci` reaches is
 * not a list. The agent phase — the half nobody is watching — is default-deny
 * with an allowlist, and that split is what bounds what a prompt injection can
 * actually carry out: reading a token is only worth doing if there is somewhere
 * to send it.
 *
 * The frontend's half turns on the same thing every other cell here does: the
 * plan is asked for with a PLACE, so the wall is arranged the same way whichever
 * way somebody got to the machine. A wall that exists on a box and not on a
 * laptop is the same feature as no wall — the agent anybody runs unattended is
 * the one on their own machine at 2am.
 *
 * The rest is the reading, which is where this one is easy to get wrong. There
 * are THREE states, not two: held, held-with-the-project's-own-list-ignored, and
 * a machine that can hold nothing. The middle one works, with less than the
 * project asked for, and shown as either "fine" or "failed" it is read wrong
 * both ways.
 */
const anAgentThatCannotReachTheWholeNetwork: Check = async (mode) => {
  const place = placeOf(mode, ALPHA);
  forgetReached();
  answers.agentPhase = confined();
  const plan = await askAgentPhase(place, "claude");

  const ask = lastOf(
    reached.agentPhase,
    "this place could not be asked what its agent phase may reach",
  );
  ensure(
    ask.target.root === place.project.root &&
      ask.target.machineId === place.machineId,
    "the call that plans the wall was handed something other than the place",
  );
  ensure(
    ask.bin === "claude",
    "the wall was planned without saying which agent it is for, so the floor is a guess",
  );

  ensure(
    plan.phase === "agent",
    "a plan that does not say which half of the run it is describing",
  );
  ensure(
    egressTone(plan) === "held" &&
      egressHeadline(plan) === "The agent phase can reach 3 machines.",
    `a confined place reads as: ${egressHeadline(plan)}`,
  );

  // What somebody chose is read before what they could not have refused. The
  // model API being on the list is not news; the host this project asked for is
  // the row worth auditing.
  ensure(
    listed(plan).map((a) => `${a.endpoint.host}`).join(",") ===
      "registry.npmjs.org,github.com,api.anthropic.com",
    "the list is not ordered by which rows somebody actually chose",
  );
  ensure(
    permissions({ run: "r", allowed: plan.allowed, refused: [] }).every((line) =>
      line.includes(" — "),
    ),
    "a row on the allowlist does not say why it is on it",
  );

  // The seal is what makes the list worth anything: an agent talked into
  // widening its own allowlist has not widened anything it can use.
  const unsealed = { ...plan, declared_honoured: false };
  ensure(
    egressTone(unsealed) === "unsealed" &&
      egressHeadline(unsealed).includes("being ignored"),
    "a list thrown away because its seal broke is drawn as a list that held",
  );

  // And the machine that can hold nothing must say so rather than imply a wall.
  const open = { ...plan, holdable: false, wall: "" };
  ensure(
    egressTone(open) === "open" && !egressHeadline(open).includes("can reach"),
    "a place holding nobody to anything still reports an allowlist",
  );

  // The other half of the workflow: what the run actually wanted afterwards.
  // A refusal names the machine rather than counting it, because a hostname is
  // a decision somebody has to make and a count is not.
  const report = {
    run: "aura-agent-alpha-k3f9",
    allowed: plan.allowed,
    refused: [
      { host: "webhook.site", port: 443, tries: 3, first: 10, last: 40 },
    ],
  };
  ensure(
    !clean(report) &&
      reportHeadline(report) ===
        "The allowlist stopped this run reaching webhook.site.",
    `a refused run reads as: ${reportHeadline(report)}`,
  );
  ensure(
    refusals(report)[0] === "wanted webhook.site:443 3 times" &&
      tries(report) === 3,
    "the refusals do not say what was wanted or how often",
  );

  return met(
    `${place.name} plans its agent phase behind ${plan.wall}: ${plan.summary}`,
  );
};

/** A place holding a project that declared one host, behind a wall it can
 *  actually put up.
 *
 *  Three rows, one of each reason, because the reading is what is under test and
 *  a list with only the floor in it would let the declared case be wrong
 *  forever.
 *
 *  The same fixture for every mode, deliberately. Which wall a machine puts up
 *  is a fact about its operating system, not about how somebody reached it, and
 *  a fixture that varied it per mode would be this file quietly asserting the
 *  thing the suite exists to forbid. */
function confined(): AgentPhase {
  const allowed: Allowed[] = [
    { endpoint: { host: "api.anthropic.com", port: 443 }, reason: "model" },
    { endpoint: { host: "github.com", port: 443 }, reason: "remote" },
    { endpoint: { host: "registry.npmjs.org", port: 443 }, reason: "declared" },
  ];
  return {
    phase: "agent",
    allowed,
    summary: allowed.map((a) => a.endpoint.host).join(", "),
    declared_honoured: true,
    holdable: true,
    wall: "seatbelt",
    note: "The agent phase can reach api.anthropic.com, github.com and registry.npmjs.org — everything else is refused, and refusals are written down.",
  };
}

/** Every workflow, with the check that answers it.
 *
 *  A `Record` over the id union rather than a lookup with a fallback: adding a
 *  workflow to the list is a type error here until it has a check. A workflow in
 *  the matrix with nothing behind it would be a green cell that asks nothing,
 *  which is worse than a missing one. */
export const CHECKS: Record<WorkflowId, Check> = {
  W1: openAProject,
  W2: newChat,
  W3: newWorkspace,
  W4: severalWorkspacesOnOnePlace,
  W5: severalPlacesFromOneLaptop,
  W6: pickWhichOrgIActAs,
  W7: anOrgPlaceOffersOnlyThatOrgsProjects,
  W8: personalAndSelfSetupKeepWorking,
  W9: reachItWithZeroSsh,
  W10: pushAsMyself,
  W11: installWithoutBreakingATeammate,
  W12: mySpendApartFromMyTeammates,
  W13: sleepOnIdleAndWakeOnDemand,
  W14: whatItHasAgainstWhatIsAskedFor,
  W15: anAgentThatCannotReachTheWholeNetwork,
};

/** The team's environment on a place, as a place that did its job would report
 *  it: built to a spec, holding what a cold join would otherwise re-download,
 *  and holding nothing of anybody's.
 *
 *  Branches on the one thing the contract lets it branch on — whether this is
 *  somewhere you dial — because a place with one member has no third account
 *  and no copy to make, and reporting one would be inventing a shared
 *  environment on somebody's laptop. */
function teamEnvironment(place: Place): TeamBase {
  const shared = place.identity.host !== null;
  return {
    place: place.name,
    login: shared ? "aura-base" : MEMBER,
    home: shared ? "/home/aura-base" : `/home/${MEMBER}`,
    created: false,
    shared,
    readable: true,
    scoped: true,
    holds: shared
      ? [
          {
            under: ".cargo",
            tool: "cargo",
            holds: "downloaded crates and compiled build artefacts",
          },
          { under: ".rustup", tool: "rustup", holds: "installed rust toolchains" },
        ]
      : [],
    carries: [],
    built_version: 4,
    built_digest: "sha256:9f2c",
  };
}

/** A place a little behind the spec it is holding.
 *
 *  Deliberately one of each standing, because the reading is what is under test
 *  and a report with only faults in it would let `alsoHere` be wrong forever. */
function behindSpec(place: Place): Drift {
  return {
    place: place.name,
    spec_from: `${place.project.root ?? place.name}/.aura/settings.toml`,
    version: 7,
    digest: "sha256:9f2c",
    trust: { state: "verified", key_id: "k1", signer: "mo" },
    declares_environment: true,
    items: [
      {
        id: "runtime:tmux",
        title: "tmux",
        layer: "runtime",
        standing: "missing",
        detail:
          "Without tmux nothing started here outlives its connection: close the lid and the work stops.",
        fix: null,
      },
      {
        id: "toolchain:node",
        title: "node 20.11.0",
        layer: "toolchain",
        standing: "missing",
        detail: "node was not found on this place.",
        fix: "mise install node@20.11.0",
      },
      {
        id: "package:brew/ripgrep",
        title: "ripgrep",
        layer: "package",
        standing: "missing",
        detail: "rg was not found on this place.",
        fix: "brew install ripgrep",
      },
      {
        id: "runtime:git",
        title: "git",
        layer: "runtime",
        standing: "present",
        detail: "git is here.",
        fix: null,
      },
      {
        id: "agent:codex",
        title: "codex",
        layer: "agent",
        standing: "unasked",
        detail: "codex is here, and nothing in the spec asks for it.",
        fix: null,
      },
    ],
    missing: 3,
    disputed: 0,
    at_spec: false,
    summary: `${place.name} is behind spec v7: 3 missing`,
  };
}

/** The other end of the comparison: the same project, one tool further along.
 *
 *  Node is here and missing on the first, ripgrep is short on both, and each has
 *  an agent the other has never heard of — which is the whole shape of a
 *  works-here-not-there answer. */
function atSpec(place: Place): Drift {
  const from = behindSpec(place);
  return {
    ...from,
    items: from.items
      .map((item) =>
        item.id === "toolchain:node"
          ? { ...item, standing: "present" as const, detail: "node 20.11.0 is here.", fix: null }
          : item,
      )
      .map((item) =>
        item.id === "agent:codex"
          ? { ...item, id: "agent:claude", title: "claude", detail: "claude is here, and nothing in the spec asks for it." }
          : item,
      ),
    missing: 2,
    summary: `${place.name} is behind spec v7: 2 missing`,
  };
}

/** A member's own credential, held in their own home. */
function ownCredential(place: Place, member: string): PushPlan {
  return {
    member,
    remote: REMOTE,
    host: "github.com",
    place: place.name,
    credential: {
      source: "member-store",
      label: `${member}'s own credential for github.com`,
      helper: "store",
      detail: `/home/${member}/.git-credentials`,
      host: "github.com",
      shared: false,
      last_resort: false,
    },
    gap: null,
    considered: [
      {
        source: "member-store",
        held: true,
        why: `${member}'s own credential for github.com`,
        last_resort: false,
      },
    ],
  };
}

/** The one the place was set up with, which everybody with a shell here can
 *  spend — and which lands under whoever provisioned it. */
function sharedCredential(place: Place, member: string): PushPlan {
  return {
    member,
    remote: REMOTE,
    host: "github.com",
    place: place.name,
    credential: {
      source: "place-default",
      label: "the credential this place was set up with",
      helper: "store",
      detail: "/home/ubuntu/.git-credentials",
      host: "github.com",
      shared: true,
      last_resort: true,
    },
    gap: null,
    considered: [
      {
        source: "member-store",
        held: false,
        why: `${member} has no account of their own on this place yet.`,
        last_resort: false,
      },
      {
        source: "place-default",
        held: true,
        why: "the credential this place was set up with",
        last_resort: true,
      },
    ],
  };
}

/** A member's own key for the agent, in their own home, closed to everybody
 *  else. What `place_agent_key` answers with once a member has one — the answer
 *  whose absence made every run on a place look identical. */
function ownKey(place: Place, member: string): KeyPlan {
  return {
    member,
    engine: ENGINE,
    provider: "Anthropic",
    var: "ANTHROPIC_API_KEY",
    place: place.name,
    key: {
      source: "member-key",
      label: `${member}'s own Anthropic key on ${place.name}`,
      detail: `/home/${member}/.config/aura/agent.env, readable only by ${member}`,
      engine: ENGINE,
      provider: "Anthropic",
      var: "ANTHROPIC_API_KEY",
      load: {
        load: "env_file",
        path: `/home/${member}/.config/aura/agent.env`,
      },
      spender: member,
      shared: false,
      last_resort: false,
    },
    gap: null,
    considered: [
      {
        source: "member-key",
        held: true,
        why: `${member}'s own Anthropic key on ${place.name}`,
        last_resort: false,
      },
    ],
  };
}

/** The org's own key — `organizations.anthropic_api_key`, which every member's
 *  runs have been spending. It works, it is reached last, and it says whose
 *  money it is. */
function orgKey(place: Place, member: string): KeyPlan {
  return {
    ...ownKey(place, member),
    key: {
      source: "org-key",
      label: `${ORG}'s shared Anthropic key — every member's runs spend it`,
      detail: `held in ${ORG}'s settings as anthropic_api_key (sk-a••••wxyz), not on this place`,
      engine: ENGINE,
      provider: "Anthropic",
      var: "ANTHROPIC_API_KEY",
      load: { load: "injected" },
      spender: ORG,
      shared: true,
      last_resort: true,
    },
    considered: [
      {
        source: "member-login",
        held: false,
        why: `${member} hasn't signed ${ENGINE} in on ${place.name} — one \`${ENGINE} setup-token\` there and this run is on their own account.`,
        last_resort: false,
      },
      {
        source: "member-key",
        held: false,
        why: `${member} holds no Anthropic key of their own here.`,
        last_resort: false,
      },
      {
        source: "org-key",
        held: true,
        why: `${ORG}'s shared Anthropic key — every member's runs spend it`,
        last_resort: true,
      },
    ],
  };
}

/** What a signed-in Aura account offers as a git identity — the same derivation
 *  `accountIdentity` does, spelled here so the check does not need an account. */
function authorOf(member: string): GitAuthor {
  return { name: member, email: `${member}@users.noreply.auravcs.com` };
}

/** The answer that is the whole reason this workflow has an authorship half: the
 *  place would author the commit as itself. Well-formed, never an error, and the
 *  person disappears from `git log`. */
function machineAuthored(place: Place, member: GitAuthor): AuthorPlan {
  return {
    place: place.name,
    root: place.project.path ?? place.project.root ?? "",
    you: place.identity.user,
    member,
    authorship: {
      who: "machine",
      author: { name: "Aura Runner", email: "runner@auravcs.com" },
      why: `Aura Runner <runner@auravcs.com> is set for this checkout, which is ${place.name}'s own identity rather than a person's.`,
    },
    origin: "file:/etc/gitconfig",
    adopted: false,
    note: `A commit from ${place.name} would be authored by the machine, not by ${member.name}.`,
  };
}

/** The answer after the account's identity has been written onto the checkout. */
function mineAuthored(place: Place, member: GitAuthor): AuthorPlan {
  return {
    ...machineAuthored(place, member),
    authorship: { who: "mine", author: member },
    origin: `file:${place.project.path ?? place.project.root ?? ""}/.git/config`,
    adopted: true,
    note: `Commits from ${place.name} are authored by ${member.name} <${member.email}>.`,
  };
}

/** A place where each member's global installs go into their own home. */
function separateToolchain(place: Place, member: string): ToolchainReport {
  const home = `/home/${member}`;
  return {
    place: place.name,
    login: member,
    home,
    you: place.identity.user,
    observed: true,
    scoped: true,
    vars: [
      toolVar("GH_CONFIG_DIR", "gh", `${home}/.config/gh`, {
        scope: "mine",
      }),
      toolVar("CARGO_HOME", "cargo", `${home}/.cargo`, { scope: "mine" }),
      toolVar("RUSTUP_HOME", "rustup", `${home}/.rustup`, { scope: "mine" }),
      toolVar("NPM_CONFIG_PREFIX", "npm", `${home}/.npm-global`, {
        scope: "mine",
      }),
    ],
  };
}

/** The same place before anything scoped it: npm's prefix is the machine's, so
 *  the second member to install a package replaces the first one's. */
function sharedToolchain(place: Place, member: string): ToolchainReport {
  const separate = separateToolchain(place, member);
  return {
    ...separate,
    scoped: false,
    vars: separate.vars.map((v) =>
      v.var === "NPM_CONFIG_PREFIX"
        ? {
            ...v,
            value: "",
            scope: { scope: "unset", shared_by_default: true },
          }
        : v,
    ),
  };
}

/** One row of a toolchain report, with what actually breaks if it is shared —
 *  in the words of the thing that breaks rather than the name of the variable. */
function toolVar(
  name: string,
  tool: string,
  value: string,
  scope: ToolchainReport["vars"][number]["scope"],
): ToolchainReport["vars"][number] {
  return {
    var: name,
    tool,
    value,
    scope,
    collides: `a global ${tool} install would replace a teammate's`,
  };
}

/** The most recent ask, or a floor failure saying nothing was asked at all. */
function lastOf<T>(asks: T[], complaint: string): T {
  ensure(asks.length > 0, complaint);
  return asks[asks.length - 1];
}

/**
 * A condition the contract has to hold, and what to say when it doesn't.
 *
 * Thrown rather than returned, so a broken floor can never be mistaken for an
 * honest asymmetry. The complaint is written as the SYMPTOM a person would meet
 * rather than as the assertion that failed: a red cell is read by whoever broke
 * it, and "a sleeping place is drawn as having no agents" sends them somewhere
 * "expected 0 to be 6" does not.
 */
function ensure(condition: boolean, complaint: string): asserts condition {
  if (!condition) throw new Error(complaint);
}
