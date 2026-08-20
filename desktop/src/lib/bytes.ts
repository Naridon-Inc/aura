// One ladder for a file size.
//
// There were three, and they disagreed at the top: the two that took bytes
// stopped at megabytes, so a three-gigabyte file read "3072.0 MB", while the
// one in the top bar knew about gigabytes but took megabytes as its input.
// Same ladder, two units, three implementations.
//
//   512 → "512 B"    1536 → "1.5 KB"    2.1e9 → "2 GB"

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** File size for display. Non-finite or negative input reads as "—" rather
 *  than "NaN B". A bare ".0" is dropped, so 2 GB is "2 GB", not "2.0 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
  return `${text} ${UNITS[i]}`;
}

/** The same ladder for a size that already arrives in megabytes. */
export function formatMegabytes(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}
