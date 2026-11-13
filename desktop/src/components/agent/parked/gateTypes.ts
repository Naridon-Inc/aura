// What the backend sends when it parks an agent on Aura's destructive-op
// gate, and the analysis of what the change would break that can ride along.

// The backend fail-closes a parked gate after this long (see `human_gate` in
// agent_event_listener.rs — MUST stay in sync). The card's safety-net timer
// uses it to self-dismiss shortly after, so a dropped "gate closed" event can
// never leave the modal wedged.
export const GATE_TIMEOUT_MS = 600_000;

/** The gate request the Rust backend emits on `agent-gate-request`.
 *  Defined here (and exported) so the type lives in one place and any
 *  adjacent TS can reuse it. camelCase mirrors the Rust serde payload. */
export type AgentGateRequest = {
  gateId: string;
  sessionId: string;
  toolName: string;
  severity: "info" | "warn" | "danger";
  /** Short headline, e.g. "Remove `compute_tick`". */
  title: string;
  /** Human-readable why/what — names the concrete file/symbol/command. */
  reason: string;
  file?: string | null;
  command?: string | null;
  diff?: string | null;
  /** Structured impact analysis — what user-facing feature this breaks.
   *  Forwarded by the Rust validator from `details.impact`. */
  impact?: AgentImpact | null;
  /** Unix seconds — when the agent was parked. */
  createdAt: number;
};

/** Structured "what would this break?" payload the validator attaches to a
 *  gate request. Built from the call-graph: who calls the doomed symbol, and
 *  which user-facing features sit upstream of those callers. camelCase
 *  mirrors the Rust serde payload. */
export type AgentImpact = {
  /** One plain sentence — the headline of the section. May contain `**bold**`
   *  and `` `code` `` markers (rendered by `renderInline`). */
  summary: string;
  severity: "leaf_safe" | "callers_only" | "feature_loss" | "unknown";
  leaf: boolean;
  directCallers: { symbol: string; file?: string | null; kind: string; confidence: string }[];
  transitiveCallerCount: number;
  features: {
    name: string;
    kind: string;
    entrySymbol: string;
    file: string;
    hops: number;
    /** Call chain entry→…→removed symbol ("the because"). */
    path: string[];
  }[];
  confidence: "high" | "medium" | "low";
  /** Honesty caveat — rendered small/muted. */
  hedge: string;
  /** Where the call-graph came from: "checkpoint" | "worktree" | "none". */
  graphSource: string;
  graphStalenessSecs?: number | null;
  truncated: boolean;
};
