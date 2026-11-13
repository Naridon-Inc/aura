// Plain-language formatters for a sealed record, shared by the session's
// Genuine record tab, the repo-wide ledger and the provenance chain so the
// three never word the same fact differently.

import { intentTypeSentence } from "@shared/intentTypeLabels";
import { relativeAgeFromDelta } from "../../../lib/relativeTime";

/** Canonical intent types → everyday words. Falls back to the raw value
 *  (title-cased) so an unknown tag still reads cleanly. The map itself lives
 *  in `intentTypeLabels`; this is the name the attestation surfaces import. */
export function humanizeIntentType(type: string): string {
  return intentTypeSentence(type);
}

/** Compress a long block id to head…tail. */
export function shortBlockId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

/** Render `created_at` (unix seconds, unix millis, ISO, or the positional
 *  array Rust's `time` crate serialises) as a short relative stamp, falling
 *  back to an absolute date for older entries. */
export function formatAttestWhen(value?: string | number | number[] | null): string {
  if (value == null) return "";
  let ms: number;
  if (Array.isArray(value)) {
    // `time::OffsetDateTime` serialises positionally, not as a string:
    // [year, ordinalDay, hour, minute, second, nanosecond,
    //  offsetHours, offsetMinutes, offsetSeconds]. That shape is what sits in
    // `.aura/attest/*.json`, so the seal stamp arrives here as an array.
    // Without this branch it fell through to `Date.parse`, which stringifies
    // the array to "2026,206,12,…" and yields NaN — which is why a block with
    // a perfectly good timestamp rendered its Sealed row as "? ago".
    const [year, ordinal, h = 0, min = 0, s = 0, ns = 0, offH = 0, offM = 0, offS = 0] = value;
    if (typeof year !== "number" || typeof ordinal !== "number") return "";
    // Day-of-year is 1-based, and Date.UTC rolls day overflow into the correct
    // month, so ordinal 206 of 2026 resolves to 25 July without a lookup table.
    const asUtc = Date.UTC(year, 0, ordinal, h, min, s, Math.floor(ns / 1e6));
    ms = asUtc - ((offH * 60 + offM) * 60 + offS) * 1000;
  } else if (typeof value === "number") {
    ms = value < 1e12 ? value * 1000 : value;
  } else {
    const asNum = Number(value);
    if (!Number.isNaN(asNum) && value.trim() !== "") {
      ms = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      ms = Date.parse(value);
    }
  }
  if (Number.isNaN(ms)) return typeof value === "string" ? value : "";
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff >= 2592000) {
    // Past a month an attestation isn't recent, it's filed — and the fact
    // anyone quotes from it is the date it was signed, not its age.
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(diff, { style: "compact" });
}

/** The Sealed line's words for a `formatAttestWhen` stamp: a relative age
 *  reads "3h ago", a filed date reads "on 2026-01-02", and the newest reads
 *  "just now" — never "now ago" or a date with "ago" on the end. */
export function sealedPhrase(when: string): string {
  if (when === "now") return "just now";
  if (/^\d{4}-\d{2}-\d{2}$/.test(when)) return `on ${when}`;
  return /^\d+(s|m|h|d|w|mo|y)$/.test(when) ? `${when} ago` : when;
}
