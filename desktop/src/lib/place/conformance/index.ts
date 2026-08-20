// The contract conformance suite, in one import.
//
// Deliberately NOT re-exported from `lib/place`'s own barrel: this is the proof
// that the seam holds, not part of the seam. Nothing the app ships imports it.

export type {
  Check,
  Mode,
  Outcome,
  Project,
  Workflow,
  WorkflowId,
} from "./matrix";
export {
  ALPHA,
  BETA,
  MEMBER,
  MODES,
  ORG,
  OTHER_ORG,
  REMOTE,
  TEAMMATE,
  WORKFLOWS,
  auraMadeThisPlace,
  caveatFor,
  met,
  neighbour,
  notPromised,
  placeIn,
  placeOf,
  whoPays,
} from "./matrix";

export { CHECKS } from "./workflows";

export { cell, cellCount, declaredAsymmetries, runMatrix } from "./runner";

export type { CapabilitiesAsk, CredentialAsk, Reached } from "./probe";
export { answers, fakeApi, forgetReached, reached } from "./probe";
