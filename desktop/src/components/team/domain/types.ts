/** Team (chat) bounded context — domain types.
 *
 *  Pure data shapes for the Team surface: conversations, messages, read
 *  cursors, and the structured activity payload that backs the project
 *  feed. No React, no rendering, no side effects — just the model the
 *  application (hooks/state) and presentation (components) layers share.
 *
 *  Lifted verbatim from the CommsPanel monolith so the surface can be
 *  decomposed without rewriting proven shapes. */

import type { ChannelTabDef, IntentChangesetFile } from "../../../lib/api";

export type ConvKind = "project" | "channel" | "dm" | "system" | "custom";

/** Tabs rendered in the channel header below the title row. `messages`
 *  is the default — clicking other tabs swaps the body content in place
 *  (Canvas replaces the stream with the channel's markdown doc).
 *  `custom:<id>` addresses a team-shared URL tab pinned via the header's
 *  add-tab affordance (the id is the ChannelTabDef id from team.json). */
export type ChannelTab =
  | "messages"
  | "canvas"
  | "files"
  | "bookmarks"
  | `custom:${string}`;

export type Conversation = {
  id: string;            // routing id: "project" | "ch:<name>" | "sentinel" | "dm:<handle>"
  name: string;
  kind: ConvKind;
  channel?: string;      // chat channel slug if kind === "channel" | "dm" | "custom"
  lastBody?: string;
  lastTs?: number;
  unread?: number;
  /** Subset of `unread` that @mentions the local user. Drives the
   *  distinct mention badge + the "Mentions" rail filter. */
  mentionUnread?: number;
  pinned?: boolean;
  hint?: string;
  builtIn?: boolean;     // separates "general/agents/sentinel" from user-created
  private?: boolean;     // private (membership-gated) custom channel — rail shows a lock
  /** Team-shared custom URL tabs from the channel's meta (team.json). */
  tabs?: ChannelTabDef[];
};

export type Msg = {
  id: string;
  ts: number;
  sender: string;
  body: string;
  fromMe: boolean;
  kind: "msg" | "system" | "activity";
  mentions?: string[];
  thread_parent?: string;
  is_agent?: boolean;
  /** Local-only flag toggled via the pin menu; persisted per-conv in localStorage. */
  pinned?: boolean;
  /** Local-only delivery-status badge ("pending"/"failed"); sourced from the outbox poll. */
  delivery_status?: "pending" | "delivered" | "failed";
  /** Peer's last-read timestamp at or beyond this message's ts. When set,
   *  the delivery badge upgrades from "✓✓ delivered" to a read receipt.
   *  Currently only populated in DMs from the peer's presence beacon. */
  read_at?: number;
  /** Cloud-assigned monotonic sequence number. Used to drive read-cursor
   *  comparisons ("seen by Alice up to seq=N"). Absent on locally-only
   *  rows that haven't been ack'd by the cloud yet. */
  seq?: number;
  /** Structured payload for kind === "activity" rows (intent/snapshot/commit/sentinel). */
  activity?: ActivityPayload;
};

/** Per-channel read cursor recorded by a peer device. Held in a per-conv
 *  map and surfaced to Bubble so the last `fromMe` message at or below
 *  `last_read_seq` shows a "Seen by …" footer. */
export type ReadCursorEntry = {
  channel: string;
  device_id: string;
  display: string;
  last_read_seq: number;
  last_read_at: string;
};

export type ActivityPayload = {
  type: "intent" | "commit";
  /** Short headline shown when collapsed. */
  title: string;
  /** Optional secondary line: a path, branch, or summary. */
  target?: string;
  /** Long-form body shown when expanded (intent description, commit message). */
  detail?: string;
  /** Files touched (from intent's bound changeset, with +/- counts). */
  files?: IntentChangesetFile[];
  /** Commit sha if the activity is bound to one — enables "Show diff". */
  commitSha?: string;
  /** Extra badges (branch name, commit sha, status). */
  badges?: { label: string; tone?: "neutral" | "good" | "warn" }[];
};
