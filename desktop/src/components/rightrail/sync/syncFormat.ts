// Formatting helpers for the Live sync surface — kept out of the
// components so the control/section files stay presentational. No React,
// no state: pure functions over the raw api shapes.

import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { monogram } from "../../../lib/monogram";

/** Compact "now" / "5s" / "3m" / "2h" / "4d" since a Unix-seconds stamp.
 *  Returns "—" for a missing/zero stamp. */
export function agoShort(unixSecs: number | null | undefined): string {
  // One ladder for the whole app — see lib/relativeTime. This copy stopped at
  // days, so a conflict left open for a year read "412d".
  return relativeAgeFromSecs(unixSecs ?? 0, { style: "compact", empty: "—" });
}

/** Two-letter initials from an agent/session id or a display name. */
export function initials(name: string): string {
  // One monogram for the whole app — see lib/monogram. This one replaced every symbol with a
  // space before splitting, so "mo@touchstage.com" read "MC" — M from "mo",
  // C from "com".
  return monogram(name, { empty: "··" });
}

// Avatar palette — status hues only. The arctic accent (#6aa5ff) is
// deliberately absent: it's reserved for the primary Go Live affordance,
// not decorative peer chips.
const PEER_COLORS = [
  "#e0a96d",
  "#b48cff",
  "#5fb0c8",
  "#5fb98a",
  "#d08aa8",
  "#c98f6d",
];

/** Deterministic avatar color from an id — stable across renders, no
 *  state needed. */
export function peerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

/** Last path segment — "auth.rs" from "aura-cli/src/auth.rs". */
export function baseName(path: string): string {
  return path.split("/").pop() || path;
}

/** Directory prefix without the file — "aura-cli/src" from the full path,
 *  empty string when the file is at the repo root. */
export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
