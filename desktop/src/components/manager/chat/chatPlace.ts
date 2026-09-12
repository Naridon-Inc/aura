// Where a chat's hands are, versus where the window is standing.
//
// A chat runs in the project it was started against — `session.projects[0]`.
// That is deliberate: a conversation about one repo must not silently follow
// you into another. But nothing on screen said so, and the one sentence that
// mentioned a place ("You're working in a copy of X, branched from Y") read as
// a statement about the app's current state rather than about this chat's
// binding.
//
// So on 2026-08-23 the sidebar highlighted `zagreb`, the status bar agreed,
// and Home announced a copy of `managua` — a workspace that no longer exists
// on this machine at all. Home is the surface that launches agent work, so the
// disagreement is not cosmetic: it is about where the next prompt will edit
// files.
//
// This module decides which of those three situations a chat is in. It is the
// whole rule, kept away from the rendering so it can be tested.

/** Where a chat will actually run, relative to the workspace on screen. */
export type ChatPlace =
  /** The chat runs where the window is standing. Nothing to say. */
  | { kind: "same" }
  /** The chat runs somewhere else — legitimate, and worth stating plainly
   *  before the reader sends a prompt that edits files there. */
  | { kind: "elsewhere"; runsIn: string }
  /** The chat's folder is not on this machine any more. It cannot run at all,
   *  and naming the missing folder is the only way the reader can act. */
  | { kind: "missing"; runsIn: string };

/** Trailing slashes are a path detail, not a difference between two places. */
function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The last segment of a path — what a person calls that folder. */
export function folderName(path: string): string {
  return normalize(path).split("/").filter(Boolean).pop() ?? path;
}

/**
 * Which situation this chat is in.
 *
 * `reachable` is what the caller learned by actually reading the folder — a
 * git read that threw is a folder that is gone, renamed or not a repo any
 * more. It is passed in rather than probed here so this stays pure; `null`
 * means the caller has not found out yet, and an unfinished read must not be
 * reported as a missing folder.
 */
export function chatPlace(
  chatRoot: string | null | undefined,
  activeRoot: string | null | undefined,
  reachable: boolean | null,
): ChatPlace {
  if (!chatRoot) return { kind: "same" };
  if (reachable === false) return { kind: "missing", runsIn: chatRoot };
  if (!activeRoot) return { kind: "same" };
  return normalize(chatRoot) === normalize(activeRoot)
    ? { kind: "same" }
    : { kind: "elsewhere", runsIn: chatRoot };
}

/** The sentence for a place worth mentioning, or null when there is nothing to
 *  say. Written to be read by someone who has not thought about worktrees. */
export function chatPlaceSentence(place: ChatPlace): string | null {
  switch (place.kind) {
    case "same":
      return null;
    case "elsewhere":
      return `This chat works in ${folderName(place.runsIn)}, not the project selected in the sidebar.`;
    case "missing":
      return `This chat works in ${folderName(place.runsIn)}, which isn’t on this computer any more. Start a new chat to work here.`;
  }
}
