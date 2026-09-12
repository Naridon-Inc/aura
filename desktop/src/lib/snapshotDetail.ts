import type { SnapshotDetail } from "./api";

/**
 * Turn one save point into something worth reading.
 *
 * The panel that shows these used to run `aura snapshot show <id>` — a
 * command that has never existed — so opening a save point produced a
 * command-line usage error. Now it reads the file, which means deciding
 * what to say about it.
 *
 * What is on disk is a `trigger` and an `agent_id`. Neither is English.
 * "pre_tool_use" is not a thing anyone says, and the person clicking a
 * save point wants one thing: can I trust this, and what is in it.
 */

/**
 * The file a save point was taken of, and when, read out of its own name.
 *
 * Save points are stored one file per save, named for the path with every
 * slash turned into a double underscore and a millisecond stamp on the end:
 * `aura-shell__src__lib__api.ts__1788970329784.json`. That name was going
 * straight onto the screen, twice, as both lines of the row — so the list
 * read as a wall of underscores and the panel title was the same wall
 * again. The name holds everything needed to say it properly, and saying
 * it properly costs nothing: no second trip to disk, no waiting.
 *
 * Best-effort by construction. A path segment that genuinely contained a
 * double underscore comes back split, which is why the panel replaces this
 * with the real path as soon as the save point is open.
 */
export function savePointName(fileName: string): {
  path: string;
  takenAtMs: number | null;
} {
  const withoutExt = fileName.replace(/\.json$/, "");
  const stamped = withoutExt.match(/^(.*)__(\d{10,})$/);
  const body = stamped ? stamped[1] : withoutExt;
  const takenAtMs = stamped ? Number(stamped[2]) : null;
  const path = body.split("__").join("/");
  return {
    path: path || fileName,
    takenAtMs: takenAtMs && Number.isFinite(takenAtMs) ? takenAtMs : null,
  };
}

/** The row label for one save point: the file, then the time it was kept. */
export function savePointLabel(fileName: string): [string, string] {
  const { path, takenAtMs } = savePointName(fileName);
  const when = takenAtMs === null ? null : takenAt(takenAtMs);
  return [path, when ? `saved ${when}` : "saved copy"];
}

/** `trigger` as a sentence. Unknown values are shown rather than hidden —
 *  a trigger we have not seen before is still information. */
export function whenItWasTaken(trigger: string): string {
  switch (trigger) {
    case "pre_tool_use":
    case "pre_edit":
    case "mcp_pre_edit":
      return "Taken automatically, right before something edited this file.";
    case "pre_rewind":
      return "Taken right before a piece of this file was brought back, so the recovery itself can be undone.";
    case "pre_deletion_guard":
      return "Taken because something was about to remove code from this file.";
    case "pre_dispatch_guard":
      return "Taken before work was handed to an agent.";
    case "pre_commit":
      return "Taken just before a commit.";
    case "manual":
      return "Taken because someone asked for it.";
    case "auto_pulled_from_cloud":
      return "Taken before a teammate's change was applied here.";
    default:
      return `Taken by: ${trigger}.`;
  }
}

/** Local date and time, or nothing when the stamp is missing or nonsense. */
export function takenAt(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

/** How many lines the saved copy holds, said the way a person counts. */
export function sizeOf(content: string): string {
  if (content === "") return "The file was empty at this point.";
  const lines = content.split("\n").length;
  return `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} saved.`;
}

/**
 * The panel body: a few lines of context, then the file as it was.
 *
 * Context first and short. Someone opening a save point is deciding
 * whether this is the copy they want, and they decide that from when it
 * was taken and why — not from the first line of the file.
 */
export function describeSnapshot(snap: SnapshotDetail): string {
  const header: string[] = [];
  const at = takenAt(snap.timestamp);
  if (at) header.push(at);
  header.push(whenItWasTaken(snap.trigger));
  if (snap.why) header.push(`Reason given: ${snap.why}`);
  if (snap.agent_id && snap.agent_id !== "unknown") {
    header.push(`Saved by ${snap.agent_id}.`);
  }
  header.push(sizeOf(snap.content));

  return [...header, "", snap.content].join("\n");
}
