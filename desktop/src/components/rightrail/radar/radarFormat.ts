// Formatting helpers for the Team Radar (awareness plane) surface. Pure
// functions over the raw api shapes — no React, no state — so the section
// components stay presentational. The CLI already did the scoring and
// noise-damping; this is purely cosmetic mapping.

import type { RadarCollision } from "../../../lib/api";

/** Compact "now" / "5s" / "3m" / "2h" / "4d" from a millisecond age. */
export function agoFromMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Compact age from a Unix-millisecond timestamp (the event `ts`). */
export function agoFromTs(tsMs: number | null | undefined): string {
  if (!tsMs) return "—";
  return agoFromMs(Date.now() - tsMs);
}

/** A small glyph per awareness kind — mirrors the CLI feed glyphs so the two
 *  surfaces read the same. */
export function kindGlyph(kind: string): string {
  switch (kind) {
    case "editing":
      return "✎";
    case "intent":
      return "✱";
    case "impact":
      return "⚡";
    case "zone":
      return "▢";
    case "paused":
      return "⏸";
    case "abandoned":
      return "⊘";
    case "committed":
      return "✓";
    case "started":
      return "▸";
    default:
      return "·";
  }
}

/** Human label for an awareness kind. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "editing":
      return "editing";
    case "intent":
      return "intends";
    case "impact":
      return "impact";
    case "zone":
      return "claimed zone";
    case "paused":
      return "paused";
    case "abandoned":
      return "abandoned";
    case "committed":
      return "committed";
    case "started":
      return "started";
    default:
      return kind;
  }
}

export type SeverityMeta = {
  label: string;
  /** Dot color — status hues only (the arctic accent stays reserved for
   *  primary affordances like Go Live, never a warning chip). */
  color: string;
  /** A one-word disposition shown after the peer. */
  disposition: string;
};

/** Severity → label + status color + disposition word. direct = head-on
 *  (red), likely = real risk (amber), possible = a quiet ripple (muted). */
export function severityMeta(severity: RadarCollision["severity"]): SeverityMeta {
  switch (severity) {
    case "direct":
      return { label: "direct", color: "#e5484d", disposition: "coordinate" };
    case "likely":
      return { label: "likely", color: "#e0a96d", disposition: "heads-up" };
    case "possible":
    default:
      return { label: "possible", color: "#7d8590", disposition: "fyi" };
  }
}

/** Strip an agent transport suffix for a compact label: "claude@cursor" →
 *  "claude". The full handle stays available in the tooltip. */
export function actorShort(actor: string): string {
  return actor.split("@")[0] || actor;
}
