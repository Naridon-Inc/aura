// When is a disk "low"? One rule, kept out of the component that draws it.
//
// Two thresholds, either one trips it: an absolute floor, because a 4 TB
// volume at 1% still has 40 GB and is fine while a 256 GB laptop at 1% is
// about to stop an agent mid-build; and a percent floor, because a small
// volume with 6 GB free is in trouble sooner than the absolute number says.

import { formatBytes } from "./bytes";

export const LOW_DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
export const LOW_DISK_FLOOR_PERCENT = 5;

export type DiskFigures = {
  /** Bytes still free on the volume. `0` when the producer could not ask. */
  disk_free_bytes: number;
  /** The volume's size. `0` when the producer could not ask. */
  disk_total_bytes: number;
};

export type DiskWarning = {
  /** One line for the person: "Low disk space: 3.2 GB left". */
  message: string;
  freeBytes: number;
  /** Whole percent of the volume still free. */
  freePercent: number;
};

/** The warning to show, or `null` when the disk is fine or unknown.
 *
 *  Unknown (a zero total — the producer could not read the volume) is `null`,
 *  not a warning: a line that says the disk is low when nothing was measured
 *  would have someone deleting files for no reason. */
export function diskWarning(snap: DiskFigures | null | undefined): DiskWarning | null {
  if (!snap) return null;
  const free = snap.disk_free_bytes;
  const total = snap.disk_total_bytes;
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0 || free < 0) {
    return null;
  }
  const freePercent = Math.round((free / total) * 100);
  const low = free < LOW_DISK_FLOOR_BYTES || (free / total) * 100 < LOW_DISK_FLOOR_PERCENT;
  if (!low) return null;
  return {
    message: `Low disk space: ${formatBytes(free)} left`,
    freeBytes: free,
    freePercent,
  };
}
