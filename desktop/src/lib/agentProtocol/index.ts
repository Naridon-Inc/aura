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
//! Claude Code (`stream-json`) and Codex (its rollout JSONL) are wired
//! end-to-end; the rest are declared in the manifest and resolve to `null`
//! here until their adapter lands, so callers fall back to the raw terminal
//! view instead of crashing.

import type { StreamEvent } from "../api";
import type { NormalizedEvent } from "./events";
import { manifestFor, type AgentIngress } from "./manifest";
import { normalizeClaude } from "./adapters/claude";
import { normalizeCodex } from "./adapters/codex";
import { normalizeKimi } from "./adapters/kimi";
import { normalizeOpencode } from "./adapters/opencode";
import { normalizePi } from "./adapters/pi";

export * from "./events";
export * from "./manifest";
export { reduceEvents, type ReducedTimeline } from "./reduce";
export { normalizeClaude } from "./adapters/claude";
export { normalizeCodex } from "./adapters/codex";
export { normalizeKimi } from "./adapters/kimi";
export { normalizeOpencode } from "./adapters/opencode";
export { normalizePi } from "./adapters/pi";

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
  // "json-events": per-agent below — Codex, OpenCode and Pi share the ingress
  //                but not the schema, so none of them can claim the family.
  // "pty":         intentionally none — raw terminal only.
  // "chat":        pending — OpenAI-compatible endpoints.
};

/** Agent id → normalizer, checked BEFORE the ingress table.
 *
 *  An ingress describes the SHAPE of the transport ("a stream of JSON
 *  events"), not the vocabulary inside it. Codex, OpenCode and Pi all declare
 *  `json-events` and agree on nothing else, so binding Codex's adapter to the
 *  ingress would quietly hand OpenCode a parser that understands none of its
 *  records — and the failure would look like an empty chat, not an error.
 *  Engines whose schema is their own live here; families that genuinely share
 *  a wire (ACP) stay in the table above. */
const BY_AGENT: Record<string, Normalizer> = {
  codex: normalizeCodex,
  kimi: normalizeKimi,
  opencode: normalizeOpencode,
  pi: normalizePi,
};

function normalizerFor(agentId: string): Normalizer | undefined {
  return BY_AGENT[agentId] ?? NORMALIZERS[manifestFor(agentId).ingress];
}

/** True when this agent has a wired normalizer AND its manifest claims
 *  structured chat — i.e. the rich card view is meaningful for it right now. */
export function canNormalize(agentId: string): boolean {
  const m = manifestFor(agentId);
  return normalizerFor(agentId) != null && m.interactions.toolCalls;
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
  const fn = normalizerFor(agentId);
  return fn ? fn(raw, sessionId) : null;
}
