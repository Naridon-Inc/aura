// The frontend's Place seam, in one import.
//
// A file per question rather than one file holding all of them — what a place
// IS, what it can RUN, how you get a TERMINAL into it, where it BELONGS — which
// is the shape the last four modules had, each knowing a quarter of the subject
// and none of them saying so.

export type {
  Place,
  PlaceCapabilities,
  PlaceIdentity,
  PlaceKind,
  PlaceProject,
} from "./contract";
export {
  placeAddress,
  placeHere,
  placeOfMachine,
  placesOfMachines,
} from "./contract";

export {
  asleepFor,
  isAsleep,
  isReachable,
  sleepBadge,
  sleepTooltip,
  sleepingInsteadOfError,
} from "./sleep";

export {
  isWaking,
  runningLate,
  startsItselfLine,
  startsWhenUsed,
  usuallyTakes,
  waitedFor,
  wakeBadge,
  wakeHeadline,
  wakeProgress,
  wakingFor,
} from "./wake";

export { isGrantedHandle, parseGrantedHandle } from "./grant";

export type { PlaceAddress, PlaceOpen } from "./boot";
export {
  askBoot,
  askBootAt,
  canOpenTerminal,
  dialableName,
  isDialableAddress,
  openAgent,
  openAttach,
  openShell,
} from "./boot";

export type { AuthorPlan, Authorship, AuthorTone, GitAuthor } from "./author";
export {
  adoptAuthor,
  askAuthor,
  authorLine,
  authorTone,
  currentAuthor,
  needsAdopting,
  whyNotMe,
} from "./author";

export type { AgentLending } from "./agentForward";
export { agentLending, agentLendingBadge } from "./agentForward";

export type { AgentCandidate } from "./capabilities";
export {
  AGENT_CANDIDATES,
  AGENT_CANDIDATE_BINS,
  askCapabilities,
  offerableAgents,
  resolveSelectedAgent,
} from "./capabilities";

export type {
  Considered,
  CredentialTone,
  GitCredential,
  NoCredential,
  PushPlan,
} from "./pushCredential";
export {
  askPushCredential,
  credentialSentence,
  credentialTone,
  gapSentence,
  whyNotMine,
} from "./pushCredential";

export type {
  AgentKey,
  KeyLoad,
  KeyPlan,
  KeyTone,
  NoAgentKey,
} from "./agentKey";
export {
  askAgentKey,
  howToRunOnMyOwn,
  keyGapSentence,
  keySentence,
  keyTone,
  whyNotMyKey,
} from "./agentKey";

export type { Scope, ToolchainReport, VarState } from "./toolchain";
export {
  askToolchain,
  collides,
  collisions,
  separated,
  toolchainSentence,
} from "./toolchain";

export {
  UNREAD,
  isUnnarrowed,
  projectsNotice,
  whyNotOffered,
  withheldProjects,
} from "./projects";

export {
  canOpenItNow,
  canSubmit,
  entitledLine,
  madeLine,
  mayHaveOneMade,
  nameProblem,
  suggestedSize,
  worthRetrying,
} from "./make";

export type { ForgeAdvice } from "./forge";
export { askForge, canHoldCredential, forgeSentence } from "./forge";

export type { SecretBoot, SecretRef } from "./secrets";
export {
  bootSecrets,
  bootSentence,
  forgetSecret,
  isCredentialFor,
  keepSecret,
  listSecrets,
  secretSentence,
} from "./secrets";

export type {
  Drift,
  DriftItem,
  DriftLayer,
  DriftStanding,
  DriftTone,
  DriftTrust,
} from "./drift";
export {
  alsoHere,
  askDrift,
  blocking,
  compare,
  driftHeadline,
  driftTone,
  met,
  standingWord,
  trustWarning,
} from "./drift";

export type {
  AgentPhase,
  Allowed,
  Attempt,
  EgressReason,
  EgressReport,
  EgressTone,
  Endpoint,
  Phase,
} from "./egress";
export {
  askAgentPhase,
  askEgressReport,
  clean,
  egressHeadline,
  egressTone,
  endpointLabel,
  listed,
  permissions,
  phaseSentence,
  reasonWord,
  refusals,
  reportHeadline,
  tries,
} from "./egress";

export type { Installed, ToolAsk } from "./toolbox";
export { installForMe, installWorked, installedSentence } from "./toolbox";

export type {
  BaseBuild,
  EnvReport,
  EnvStep,
  EnvStepState,
  Held,
  TeamBase,
  WarmStart,
} from "./teamBase";
export {
  askTeamBase,
  baseIsUsable,
  baseWarning,
  baseWasBuilt,
  warmSentence,
  warmShortfall,
  warmStart,
} from "./teamBase";

export type { PlaceFiling } from "./placement";
export {
  filePlaces,
  placeRowLabel,
  projectToFilePlaceUnder,
} from "./placement";

export type { RosterEntry } from "./roster";
export {
  addedByLine,
  emptyLine,
  orgNotice,
  ownerLine,
  placeOfRow,
  rosterEntries,
  rowTooltip,
} from "./roster";

export type { WhereKind, WhereOption } from "./where";
export { HERE, chosenWhere, optionOfRow, whereOptions } from "./where";
