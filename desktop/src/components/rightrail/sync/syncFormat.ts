// Formatting helpers for the Live sync surface — kept out of the
// components so the control/section files stay presentational. No React,
// no state: pure functions over the raw api shapes.

/** Compact "now" / "5s" / "3m" / "2h" / "4d" since a Unix-seconds stamp.
 *  Returns "—" for a missing/zero stamp. */
export function agoShort(unixSecs: number | null | undefined): string {
  if (!unixSecs) return "—";
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Two-letter initials from an agent/session id or a display name. */
export function initials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  if (!cleaned) return "··";
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
