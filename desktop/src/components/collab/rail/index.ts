// The rail, as one door.
//
// Hosts mount `PeopleRail` and nothing else; the pieces are exported because
// the in-session surfaces need the same presence dot and the same participant
// pips, and two drawings of "who is in here" one panel apart is how a product
// stops looking like one product.

export { PeopleRail, type PeopleRailProps } from "./PeopleRail";
export { PersonSessions, type PersonSessionsProps } from "./PersonSessions";
export { SessionRow, type SessionRowProps } from "./SessionRow";
export { ActivityLine, type ActivityLineProps } from "./ActivityLine";
export { ParticipantPips, type ParticipantPipsProps } from "./ParticipantPips";
export { PresenceDot, PresenceMark, type PresenceDotProps } from "./PresenceDot";
export { RailAvatar, RailAvatarDimmable, type RailAvatarProps } from "./RailAvatar";
export {
  JoinSessionButton,
  type JoinSessionButtonProps,
} from "./JoinSessionButton";

export {
  buildGroups,
  groupLastAt,
  indexActors,
  isPresent,
  isSessionLive,
  orderPips,
  presenceInk,
  presenceLabel,
  presenceTitle,
  sortGroups,
  sortSessions,
  type RailAccess,
  type RailActivity,
  type RailActor,
  type RailPersonGroup,
  type RailPresenceState,
  type RailSession,
} from "./railModel";

export {
  ACTIVITY_TTL_SECS,
  activityRank,
  activityTtl,
  actorLabel,
  describeActivity,
  isActivityFresh,
  pickActivity,
  possessive,
  type RailActivityCopy,
} from "./railActivity";

export {
  mergePresence,
  railActivityFrom,
  railActivityFromLive,
  railActorFromRoster,
  railActorsFromParticipants,
  railSessionFromLive,
  railSessionResting,
  type RailSessionMeta,
} from "./railFromLive";

export {
  RAIL_FIXTURE_ACTIVE_SESSION_ID,
  railFixtureEmpty,
  railFixtureGroups,
  railFixtureNow,
  railFixtureQuiet,
} from "./railFixtures";
