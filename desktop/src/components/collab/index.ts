// The in-session collaboration surface — what a coding session looks like
// when two people and their agents are both in it.
//
// Wiring: every component here is presentational and takes its data as props,
// so the session store can be attached in one place instead of five. What
// each one needs from `lib/sessionLiveStore` is named in its props.

// The one exception to "presentational, data as props": the pane is the place
// the store IS attached, so the rest of the folder doesn't have to be.
export { LiveSessionPane } from "./LiveSessionPane";
export type { LiveSessionPaneProps } from "./LiveSessionPane";

export { ParticipantsStrip, ParticipantFace } from "./ParticipantsStrip";
export type { ParticipantsStripProps } from "./ParticipantsStrip";

export { SessionMessageRow } from "./SessionMessageRow";
export type { SessionMessageRowProps } from "./SessionMessageRow";

export { SessionStream } from "./SessionStream";
export type { SessionStreamProps } from "./SessionStream";

export { AgentStandDownNotice } from "./AgentStandDownNotice";
export type { AgentStandDownNoticeProps } from "./AgentStandDownNotice";

export { SessionTypingLine, TypingChip, AgentWorkingChip } from "./SessionTypingLine";
export type { SessionTypingLineProps } from "./SessionTypingLine";

export { MentionPicker, mentionQueryAt, defaultIntentFor } from "./MentionPicker";
export type { MentionPickerProps } from "./MentionPicker";

export {
  ComposerAddressingBar,
  coerceIntent,
  deliverySentence,
  intentAllowed,
} from "./ComposerAddressingBar";
export type { ComposerAddressingBarProps } from "./ComposerAddressingBar";

export { SessionComposer } from "./SessionComposer";
export type { SessionComposerProps, SessionDraft } from "./SessionComposer";

export {
  STATE_PHRASE,
  activitySentence,
  agentBrandName,
  agentIconId,
  isYou,
  mentionHandle,
  ownerOf,
  participantLabel,
  participantName,
  presenceDotStyle,
  sinceWords,
  sortParticipants,
} from "./collabPresence";

export {
  findParticipant,
  fromMsgFrame,
  itemAt,
  itemKey,
  mergeSessionStream,
} from "./collabTypes";
export type { SessionMessage, SessionStreamItem } from "./collabTypes";
