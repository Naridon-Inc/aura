// The wire between Aura's Rust control plane and the tabs, expressed as
// types plus the two decisions that are easy to get subtly wrong.
//
// Nothing here touches React, Tauri or the editor store, so the shape an
// agent CLI sees can be asserted in a unit test instead of by launching a
// real agent and squinting at a terminal.

/** One request, pushed at us on the `ide-bridge:request` Tauri event. */
export type IdeRequest = {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};

/** `openDiff` — show a proposed change and wait for a person to decide. */
export type OpenDiffParams = {
  path: string;
  tabName: string;
  /** The file as it is on disk right now. Read in Rust, at the instant the
   *  agent asked, so the left-hand side is never a stale buffer. */
  oldContents: string;
  /** What the agent wants the file to become. */
  newContents: string;
};

/** `openFile` — put a file on screen, optionally at a line. */
export type OpenFileParams = {
  path: string;
  startLine?: number | null;
  endLine?: number | null;
  makeFrontmost?: boolean;
};

/** What we send back. Exactly one of these per request id. */
export type IdeReply =
  | { outcome: "saved"; content: string }
  | { outcome: "rejected" }
  | { outcome: "closed" }
  | { ok: true }
  | { error: string }
  | Record<string, unknown>;

/** How a diff tab ended. `saved` carries the text that was actually written,
 *  which is not always what the agent proposed — a person is free to edit
 *  the change before accepting it, and the agent must be told what landed
 *  rather than what it asked for. */
export type DiffOutcome =
  | { outcome: "saved"; content: string }
  | { outcome: "rejected" };

/** A diff waiting on a person. */
export type PendingDiff = {
  requestId: string;
  path: string;
  tabName: string;
  /** The on-disk text we opened against — the diff's left-hand side. */
  original: string;
  /** What the agent proposed — what we put in the buffer. */
  proposed: string;
};

/** Decide what a diff tab's current state means, or `null` for "still
 *  waiting".
 *
 *  `file` is the tab as the editor store holds it, or `undefined` when the
 *  tab is gone.
 *
 *  Two rules, and both exist because the alternative lies to the agent:
 *
 *  * a tab that disappeared was **rejected**. The person looked and closed
 *    it. Reporting "saved" here would tell the agent its change landed when
 *    the file on disk never changed.
 *  * a tab whose buffer matches its baseline has been **saved** — that is
 *    what saving does to the two. We report `current`, not the text that was
 *    proposed, because the person may have edited the proposal first.
 *
 *  Anything else — unsaved edits sitting in the tab — is a live decision. */
export function diffOutcomeFor(
  file: { current: string; baseline: string } | undefined,
): DiffOutcome | null {
  if (!file) return { outcome: "rejected" };
  if (file.current !== file.baseline) return null;
  return { outcome: "saved", content: file.current };
}

/** Whether opening a diff on this file would destroy work.
 *
 *  Showing a proposal means putting it in the file's buffer, and this editor
 *  has one buffer per file. If the person has unsaved edits there, writing
 *  over them loses work they can't get back — so we refuse and say why
 *  instead. Rare, and a refusal the agent handles: it falls back to asking
 *  in the terminal. */
export function wouldClobberUnsavedEdits(
  file: { current: string; baseline: string } | undefined,
): boolean {
  return !!file && file.current !== file.baseline;
}

/** Plain-language refusal, addressed to whoever reads the agent's output —
 *  which is a person, not a compiler. */
export function unsavedEditsMessage(path: string): string {
  const name = path.split("/").pop() || path;
  return `You have unsaved changes to ${name} open in Aura. Save or undo them, then ask again — otherwise showing this change here would throw your edits away.`;
}
