/** Team (chat) bounded context — domain layer barrel.
 *
 *  One import surface for the pure model the application (hooks/state) and
 *  presentation (components) layers build on: types, channel identity + DM
 *  routing, message-model converters, label/time formatters, and local
 *  persistence. No React, no rendering, no side effects beyond the guarded
 *  localStorage adapters. */

export type {
  ConvKind,
  ChannelTab,
  Conversation,
  Msg,
  ReadCursorEntry,
  ActivityPayload,
} from "./types";

export {
  BUILTIN_CHANNELS,
  AURA_GLOBAL_ROOM_ID,
  AURA_GLOBAL_CHANNEL,
  AURA_CONV_ID,
  dmChannel,
  dmOtherSide,
  byRecency,
} from "./channels";

export { pseudonymFor, randomHandle } from "./handle";

export {
  countThreads,
  chatToMsg,
  auraRosterFromStream,
  convIdForMessage,
  commitToMsg,
  intentToMsg,
  intentRowsToSessionMsgs,
  sentinelToMsg,
  cleanIntentBody,
  hasMoreThanFirstLine,
  firstLine,
} from "./messageModel";

export type { SelfKeys } from "./identity";
export {
  buildSelfKeys,
  isSelfSender,
  norm,
  senderHandle,
  readSelfLinks,
  writeSelfLinks,
  addSelfLink,
  removeSelfLink,
  isLinkedSelf,
  SELF_LINKS_EVENT,
} from "./identity";

export {
  prettyName,
  railLabel,
  composerHint,
  hhmm,
  previewBody,
  isHumanBody,
  railTime,
  formatPinTime,
} from "./labels";

export type { ConvPresence } from "./presence";
export { presenceForConversation } from "./presence";

export type { Draft } from "./persistence";
export {
  loadLastRead,
  persistLastRead,
  loadPinned,
  persistPinned,
  loadDraft,
  persistDraft,
  clearDraft,
  loadAllDrafts,
} from "./persistence";
