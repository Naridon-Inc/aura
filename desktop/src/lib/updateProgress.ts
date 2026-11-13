// What the update toast says while a release downloads, kept free of React and
// Tauri so it can be tested on its own. `components/UpdateToast.tsx` feeds it
// the updater's own byte counts (`lib/updater.ts::downloadUpdate`), chunk by
// chunk; this file turns them into "34% · 19 of 56 MB" and decides which of the
// toast's faces is up.
//
//   downloading → "Downloading update…"  [▓▓▓░░░░] 34% · 19 of 56 MB
//                 (no size from the server → the bar slides, "19 MB so far")
//   ready       → "Ready — restart to update"  [See changes] [Restart]
//   failed      → "Couldn't download the update"  [Retry]

/** Bytes the updater has received, and the size the server announced — null
 *  when it sent none, which is when the bar has no end to fill toward. */
export type DownloadProgress = { downloaded: number; total: number | null };

/** Before the first chunk: nothing yet, size not known. */
export const DOWNLOAD_START: DownloadProgress = { downloaded: 0, total: null };

/** One megabyte, the way macOS counts a file's size. */
const MB = 1_000_000;

/** The announced size, or null when there is nothing to divide by. */
function knownTotal(p: DownloadProgress): number | null {
  return p.total != null && Number.isFinite(p.total) && p.total > 0 ? p.total : null;
}

/** Whole percent done, 0–100, or null while the size is unknown. Rounded down,
 *  so it only says 100 once every byte is in. */
export function downloadPercent(p: DownloadProgress): number | null {
  const total = knownTotal(p);
  if (total == null) return null;
  const pct = Math.floor((Math.max(0, p.downloaded) / total) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** A byte count in megabytes, rounded down: one decimal under 10 MB, so a
 *  small release still visibly moves, and whole megabytes above. */
export function megabytes(bytes: number): string {
  const mb = Math.max(0, Number.isFinite(bytes) ? bytes : 0) / MB;
  if (mb >= 10) return String(Math.floor(mb));
  const tenths = Math.floor(mb * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

/** The line under the bar: "34% · 19 of 56 MB", or "19 MB so far" when the
 *  server sent no size, or "Starting…" before the first byte. */
export function downloadLabel(p: DownloadProgress): string {
  const total = knownTotal(p);
  const pct = downloadPercent(p);
  if (total == null || pct == null) {
    return p.downloaded > 0 ? `${megabytes(p.downloaded)} MB so far` : "Starting…";
  }
  const got = Math.min(Math.max(0, p.downloaded), total);
  return `${pct}% · ${megabytes(got)} of ${megabytes(total)} MB`;
}

/** The progress to show once the updater reports `downloaded` of `total`. The
 *  updater calls back on every network chunk — thousands per release — so
 *  while nothing on screen would change this hands `prev` back unchanged, and
 *  React skips the redraw. */
export function nextProgress(
  prev: DownloadProgress,
  downloaded: number,
  total: number | null,
): DownloadProgress {
  const next: DownloadProgress = { downloaded, total };
  return downloadLabel(next) === downloadLabel(prev) ? prev : next;
}

/** A download the toast is narrating: still coming in, or stopped by an
 *  error the person can retry. */
export type DownloadState =
  | { phase: "downloading"; version: string; progress: DownloadProgress }
  | { phase: "failed"; version: string; reason: string };

/** Which face the update toast shows, if any.
 *  * A release that is downloaded and waiting wins: Restart is the one thing
 *    left to do.
 *  * A failed download shows even if its progress was hidden — the person
 *    otherwise waits for a "ready" that is not coming.
 *  * A download in flight shows its progress unless the person hid it; it
 *    keeps going either way and comes back as "ready". */
export type UpdateToastView = "ready" | "downloading" | "failed" | null;

export function updateToastView(args: {
  ready: boolean;
  download: DownloadState["phase"] | null;
  progressHidden: boolean;
}): UpdateToastView {
  if (args.ready) return "ready";
  if (args.download === "failed") return "failed";
  if (args.download === "downloading") return args.progressHidden ? null : "downloading";
  return null;
}
