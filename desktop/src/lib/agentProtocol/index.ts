//! Engine-agnostic chat abstraction — public entrypoint.
//!
//! One job: turn an agent's raw output into `NormalizedEvent[]` WITHOUT the
//! caller knowing which engine produced it. The manifest (`manifest.ts`) says
//! how a given agent's bytes arrive (its `ingress`); a normalizer is registered
//! per ingress; the dispatcher picks one by id and runs it. Adding an agent is
//! a manifest entry + (if its wire is new) one ingress normalizer — never a
//! change here, the reducer, or the renderer.
//!
//!     raw bytes ──(adapter, by ingress)──▶ NormalizedEvent[] ──(reduce)──▶ timeline ──▶ cards
//!
//! Today only `stream-json` (Claude Code) is wired end-to-end; the others are
//! declared in the manifest and resolve to `null` here until their adapter
//! lands, so callers fall back to the raw terminal view instead of crashing.

import type { StreamEvent } from "../api";
import type { NormalizedEvent } from "./events";
import { manifestFor, type AgentIngress } from "./manifest";
import { normalizeClaude } from "./adapters/claude";

export * from "./events";
export * from "./manifest";
export { reduceEvents, type ReducedTimeline } from "./reduce";
export { normalizeClaude } from "./adapters/claude";

/** A normalizer turns one engine-family's raw output into the shared model.
 *  `raw` is `unknown` at this seam; each adapter narrows it to the concrete
 *  wire type it owns (Claude's `StreamEvent[]`, an ACP frame array, …). */
export type Normalizer = (raw: unknown, sessionId: string) => NormalizedEvent[];

/** Ingress → normalizer. The ONLY place an ingress is bound to code. A missing
 *  entry means "declared but no adapter yet" → the dispatcher returns null and
 *  the caller keeps the raw view. */
const NORMALIZERS: Partial<Record<AgentIngress, Normalizer>> = {
  "stream-json": (raw, sessionId) =>
    normalizeClaude(raw as StreamEvent[], sessionId),
  // "acp":         pending — Gemini / Cursor / Goose adapter wave.
  // "json-events": pending — Codex / OpenCode adapter wave.
  // "pty":         intentionally none — raw terminal only.
  // "chat":        pending — OpenAI-compatible endpoints.
};

/** True when this agent has a wired normalizer AND its manifest claims
 *  structured chat — i.e. the rich card view is meaningful for it right now. */
export function canNormalize(agentId: string): boolean {
  const m = manifestFor(agentId);
  return NORMALIZERS[m.ingress] != null && m.interactions.toolCalls;
}

/** Normalize an agent's full raw event list into the shared model. Returns
 *  `null` — not `[]` — when no adapter is wired for this agent's ingress, so a
 *  caller can tell "nothing to show yet" apart from "this engine isn't
 *  structured; show the terminal". Pure: same input → same output. */
export function normalizeStream(
  agentId: string,
  raw: unknown,
  sessionId: string,
): NormalizedEvent[] | null {
  const m = manifestFor(agentId);
  const fn = NORMALIZERS[m.ingress];
  return fn ? fn(raw, sessionId) : null;
}
