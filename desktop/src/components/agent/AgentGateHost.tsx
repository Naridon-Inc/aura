// The single global host for every "your agent has stopped and is waiting
// on you" card. Two things park an agent, and both dock here:
//
//   * Aura's destructive-op gate — our validator is unsure about something
//     risky, described below;
//   * a permission prompt — claude itself asking before it uses a tool,
//     arriving over the MCP bridge (`parked/PermissionCard`). In chat mode
//     the CLI has no terminal to draw its own prompt in, so if nothing
//     renders this the agent waits forever with no visible reason.
//
// One host and one queue because it is one moment for the person using the
// app: work stopped, and only they can restart it. Two hosts would race for
// the same dock and stack cards on top of each other.
//
// The rest of this file is the gate itself. When the coding agent (Claude
// Code / Gemini) is about to do something risky and Aura's validator is
// *unsure*, the backend parks the agent and fires `agent-gate-request`.
// This host catches every such request (bare, global event — one place,
// not per-pane) and shows the human a calm, plain-language card: exactly
// what's about to happen and why, with Allow / Deny. The agent stays
// blocked until we resolve.
//
// The human must decide before the agent proceeds — but that decision does
// NOT need to hijack the whole screen. A full-screen dim scrim in the middle
// of the window read as alarming and got in the way ("why is this popping up,
// it's annoying"). Instead we dock a compact card just above the composer
// input — right where the user is working — as a non-blocking overlay: the
// rest of the app stays live and clickable behind it, and the card floats over
// the input the parked agent is waiting on. Still rendered via a body portal
// (so it's global, one host for every pane) with the Enter=Allow / Esc=Deny
// keymap, just without the scrim and focus-trap of a true modal.
//
// Multiple gates can queue (the agent fires one per blocked tool call);
// we show them oldest-first since the agent is blocked on the oldest,
// de-duped by gateId.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { usePermissionPrompts } from "../../lib/permissionStore";
import { ParkedHeader, ParkedShell } from "./parked/dock";
import { PermissionCard } from "./parked/PermissionCard";
import { relativeAgeFromDelta } from "../../lib/relativeTime";

// The backend fail-closes a parked gate after this long (see `human_gate` in
// agent_event_listener.rs — MUST stay in sync). The card's safety-net timer
// uses it to self-dismiss shortly after, so a dropped "gate closed" event can
// never leave the modal wedged.
const GATE_TIMEOUT_MS = 600_000;

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

// severity → token mapping. We lean on the existing ember tokens rather
// than hardcoding hex: `danger` = --color-red, `warn` = --color-amber
// (the cool slate-cyan "in-flight" marker), `info` = neutral text ramp.
const SEVERITY: Record<
  AgentGateRequest["severity"],
  { label: string; dot: string; chipText: string; chipBg: string; chipBorder: string }
> = {
  info: {
    label: "Info",
    dot: "bg-text-3",
    chipText: "text-text-2",
    chipBg: "bg-bg-2",
    chipBorder: "border-line",
  },
  warn: {
    label: "Needs review",
    dot: "bg-amber",
    chipText: "text-amber",
    chipBg: "bg-amber/10",
    chipBorder: "border-amber/40",
  },
  danger: {
    label: "Risky",
    dot: "bg-red",
    chipText: "text-red",
    chipBg: "bg-red/10",
    chipBorder: "border-red/40",
  },
};

// impact severity → tone. Reuses the SAME token vocabulary as SEVERITY
// above (red / amber / neutral / green) so the impact panel reads as part
// of the same card. `feature_loss` is the loudest (red); `callers_only`
// is a softer warn (amber); `leaf_safe` is reassuring (green); `unknown`
// stays neutral so we never over-claim danger we couldn't prove.
const IMPACT_TONE: Record<
  AgentImpact["severity"],
  { word: string; text: string; bg: string; border: string }
> = {
  feature_loss: { word: "Could break a feature", text: "text-red", bg: "bg-red/10", border: "border-red/40" },
  callers_only: { word: "Affects other code", text: "text-amber", bg: "bg-amber/10", border: "border-amber/40" },
  leaf_safe: { word: "Likely safe", text: "text-green", bg: "bg-green/10", border: "border-line" },
  unknown: { word: "Not sure", text: "text-text-2", bg: "bg-bg-2", border: "border-line" },
};

// confidence → tiny-pill tone. green = high, amber = medium, neutral = low.
const CONFIDENCE_TONE: Record<
  AgentImpact["confidence"],
  { text: string; bg: string; border: string }
> = {
  high: { text: "text-green", bg: "bg-green/10", border: "border-line" },
  medium: { text: "text-amber", bg: "bg-amber/10", border: "border-amber/40" },
  low: { text: "text-text-3", bg: "bg-bg-2", border: "border-line" },
};

// Tiny inline formatter: turns `**x**` into <strong> and `` `x` `` into
// <code>. No markdown lib, no dangerouslySetInnerHTML — we split on the
// two marker syntaxes and emit React nodes, so the text stays inert.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Match a `**bold**` run OR a `` `code` `` run; everything else is plain.
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={key++} className="font-semibold text-text-1">
          {m[1]}
        </strong>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <code key={key++} className="font-mono text-[0.92em] text-text-1">
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Map a feature/caller `kind` from the backend onto a calm, human label.
// Falls back to the raw kind (humanized) so an unknown kind still reads ok.
function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    desktop_command: "desktop command",
    tauri_command: "desktop command",
    http_route: "HTTP route",
    route: "HTTP route",
    cli_command: "CLI command",
    cli: "CLI command",
    ui: "UI",
    ui_component: "UI",
    component: "UI",
    api: "API",
    mcp_tool: "API",
  };
  const k = kind.toLowerCase();
  return map[k] ?? k.replace(/_/g, " ");
}

// Humanize an age in seconds → "42s" / "9m" / "3h" / "5d". Coarse on
// purpose — staleness is a vibe, not a stopwatch.
function humanizeAge(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs, { style: "compact" });
}

export function AgentGateHost() {
  // Oldest-first queue (FIFO). The agent is blocked on the oldest gate,
  // so that's the one we surface; resolving it pops the front.
  const [queue, setQueue] = useState<AgentGateRequest[]>([]);

  // The other reason an agent parks: claude asking permission before it
  // uses a tool, routed in over the MCP bridge. Different question, same
  // moment — work has stopped and only a human restarts it — so both go
  // through this one host rather than two cards racing for the same dock.
  const prompts = usePermissionPrompts(null);

  // Subscribe once to the bare global events. Every gate, every session.
  useEffect(() => {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    const track = (fn: UnlistenFn) => {
      if (active) unlisteners.push(fn);
      else fn(); // unmounted before subscribe resolved
    };
    listen<AgentGateRequest>("agent-gate-request", (event) => {
      const req = event.payload;
      if (!req || !req.gateId) return;
      setQueue((q) => {
        // De-dupe by gateId — the hook can retry, and we never want two
        // cards for the same parked call.
        if (q.some((g) => g.gateId === req.gateId)) return q;
        return [...q, req];
      });
    }).then(track);
    // The backend fires this the instant a parked gate is settled on ITS side
    // — approved, denied, timed out, or the parked connection dropped. Drop the
    // matching card so a server-side timeout can never strand a live-but-dead
    // card whose Allow button no longer maps to anything (the old "must restart
    // the app" deadlock).
    listen<{ gateId?: string }>("agent-gate-closed", (event) => {
      const gid = event.payload?.gateId;
      if (gid) setQueue((q) => q.filter((g) => g.gateId !== gid));
    }).then(track);
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const gateFront = queue[0] ?? null;
  const promptFront = prompts[0] ?? null;
  const waiting = queue.length + prompts.length;

  const pop = useCallback((gateId: string) => {
    setQueue((q) => q.filter((g) => g.gateId !== gateId));
  }, []);

  // Whichever has been waiting longest is shown first. Both stamp unix
  // seconds when the agent parked, so they sort against each other — and
  // answering out of order would leave the older, more-stuck agent behind
  // a card that has no way to reach it.
  if (promptFront && (!gateFront || promptFront.ts <= gateFront.createdAt)) {
    return createPortal(
      // No onResolved: `decidePrompt` removes the prompt from the store
      // itself, and the store is what this host reads. One owner.
      <PermissionCard
        key={promptFront.prompt_id}
        prompt={promptFront}
        pending={waiting - 1}
      />,
      document.body,
    );
  }

  if (!gateFront) return null;

  return createPortal(
    <GateCard
      // key by gateId so each gate gets a fresh card (resets note input,
      // in-flight + error state, and re-focuses Allow).
      key={gateFront.gateId}
      request={gateFront}
      pending={waiting - 1}
      onResolved={() => pop(gateFront.gateId)}
    />,
    document.body,
  );
}

function GateCard({
  request,
  pending,
  onResolved,
}: {
  request: AgentGateRequest;
  pending: number;
  onResolved: () => void;
}) {
  const sev = SEVERITY[request.severity] ?? SEVERITY.info;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denyMode, setDenyMode] = useState(false);
  const [note, setNote] = useState("");
  const [showDiff, setShowDiff] = useState(false);

  const allowRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  // Resolve the gate. allow=true → agent proceeds; allow=false → denied,
  // with an optional human note. Keep the card up (and re-enable) on
  // failure so a transient IPC error never silently drops a parked agent.
  const resolve = useCallback(
    async (allow: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await api.agentGateResolve(
          request.gateId,
          allow,
          allow ? undefined : note.trim() || undefined,
        );
        onResolved();
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error)?.message ?? "";
        // A gate the backend has already let go of (its 600s wait timed out, or
        // the parked connection dropped) is stale, not a live error — dismiss
        // the card instead of stranding it with an inert, re-erroring Allow
        // button that only an app restart could clear. The agent already got a
        // fail-closed "denied — re-run if intended", which shows in the
        // transcript, so there's nothing more to decide here.
        if (/no pending gate|waiter already gone/i.test(msg)) {
          onResolved();
          return;
        }
        setError(msg || "Failed to resolve. Try again.");
        setBusy(false);
      }
    },
    [busy, request.gateId, note, onResolved],
  );

  // Safety net: even if the "gate closed" event never arrives (app was asleep,
  // event dropped), never leave the card up forever. The backend fail-closes at
  // 600s; a little after that, auto-dismiss so the modal can't wedge. Anchored
  // to createdAt so a card restored mid-life still expires on the real clock.
  useEffect(() => {
    const ageMs = Math.max(0, Date.now() - request.createdAt * 1000);
    const remaining = GATE_TIMEOUT_MS + 15_000 - ageMs;
    const id = setTimeout(onResolved, Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [request.createdAt, onResolved]);

  // Deny needs one click to reveal the optional note, a second to confirm.
  // This keeps the "why?" affordance without forcing a typed reason.
  const onDenyClick = useCallback(() => {
    if (!denyMode) {
      setDenyMode(true);
      return;
    }
    void resolve(false);
  }, [denyMode, resolve]);

  // Deliberately do NOT steal focus on mount: the card is a non-blocking dock
  // now, and yanking the caret out of the composer mid-type is exactly the
  // "annoying" behaviour we're removing. Enter=Allow / Esc=Deny still work once
  // the card itself has focus (click it, or Tab in). The buttons stay one click
  // away regardless.

  // When deny mode opens, move focus to the note input.
  useEffect(() => {
    if (denyMode) noteRef.current?.focus();
  }, [denyMode]);

  // Keyboard: Enter = Allow, Esc = Deny. Tab is trapped within the card
  // so the user can't focus the (inert) app behind the scrim.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Enter") {
        // Let Enter inside the note input fall through to confirm-deny
        // rather than firing Allow.
        if (denyMode && document.activeElement === noteRef.current) {
          e.preventDefault();
          void resolve(false);
          return;
        }
        e.preventDefault();
        void resolve(true);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDenyClick();
        return;
      }
      // No Tab-trap: this is a docked, non-blocking card, so Tab should be free
      // to move focus back into the live app behind it.
    },
    [busy, denyMode, resolve, onDenyClick],
  );

  return (
    <ParkedShell label={request.title} onKeyDown={onKeyDown}>
      <ParkedHeader
        since={request.createdAt}
        chip={
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${sev.chipBg} ${sev.chipBorder} ${sev.chipText}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${sev.dot}`} />
            {sev.label}
          </span>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 space-y-3">
        {/* Headline — the short "what". */}
        <h2 className="text-text-1 text-md font-medium leading-snug">
          {request.title}
        </h2>

        {/* Body — the plain-language "what & why". `break-words` so a long
            unbroken token (a big inline symbol list) wraps instead of
            forcing horizontal overflow. */}
        <p className="text-text-2 text-base leading-relaxed whitespace-pre-wrap break-words">
          {request.reason}
        </p>

        {/* Impact — what user-facing feature this would break. Only when
            the validator attached a structured analysis. Informational:
            no focusable controls, so it never disturbs the focus trap. */}
        {request.impact && <ImpactPanel impact={request.impact} />}

        {/* Metadata row: which tool, and the target file when present. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-text-4">
            Tool{" "}
            <span className="text-text-2 font-mono">{request.toolName}</span>
          </span>
          {request.file && (
            <span className="min-w-0 flex items-center gap-1 text-text-4">
              File
              <span
                className="text-text-2 font-mono truncate max-w-[280px]"
                title={request.file}
                dir="rtl"
              >
                {request.file}
              </span>
            </span>
          )}
        </div>

        {/* Command block — verbatim, mono, so the human sees exactly
            what would run. */}
        {request.command && (
          <div>
            <div className="section-label mb-1">
              Command
            </div>
            {/* break-words, not break-all — a command you're being asked to
              approve must not be sliced through the middle of a flag. */}
          <code className="block bg-bg-2 border border-line-soft rounded px-2.5 py-1.5 text-sm font-mono text-text-1 whitespace-pre-wrap break-words">
              {request.command}
            </code>
          </div>
        )}

        {/* Diff — collapsed by default; +/- line tinting, no diff lib. */}
        {request.diff && (
          <div>
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className="text-text-3 hover:text-text-1 text-xs inline-flex items-center gap-1 transition-colors"
            >
              <span
                className="inline-block transition-transform"
                style={{ transform: showDiff ? "rotate(90deg)" : "none" }}
              >
                ▸
              </span>
              {showDiff ? "Hide changes" : "Show changes"}
            </button>
            {showDiff && <DiffBlock diff={request.diff} />}
          </div>
        )}

        {/* Optional deny note — revealed on the first Deny click. */}
        {denyMode && (
          <div>
            <label className="section-label block mb-1">
              Why? (optional)
            </label>
            <input
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for denying. Sent back to the agent"
              disabled={busy}
              className="w-full bg-bg-content border border-line rounded px-2.5 py-1.5 text-base text-text-1 placeholder:text-text-4 focus:outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
        )}

        {error && (
          <p className="text-red text-sm leading-snug" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Footer actions. Allow is primary; Deny is secondary (outline,
          red-tinted in confirm mode so the two-step reads clearly). */}
      <footer className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-t border-line-soft">
        {pending > 0 && (
          <span className="text-text-4 text-xs tabular-nums mr-auto">
            {pending} more waiting
          </span>
        )}
        <div className={`flex items-center gap-2 ${pending > 0 ? "" : "ml-auto"}`}>
          <Button
            variant="outline"
            size="sm"
            onClick={onDenyClick}
            disabled={busy}
            // Red on hover in both modes, not just the confirm step — the
            // first click is still the one that starts refusing, and this
            // is the control where a reflex click on the wrong button
            // costs the most.
            className={
              denyMode
                ? "text-red border-red/40 hover:bg-red/10"
                : "text-text-2 hover:bg-red/10 hover:text-red hover:border-red/40"
            }
          >
            {denyMode ? "Confirm deny" : "Deny"}
          </Button>
          <Button
            ref={allowRef}
            variant="default"
            size="sm"
            onClick={() => void resolve(true)}
            disabled={busy}
            className="bg-accent-green text-bg-deep hover:opacity-90"
          >
            {busy ? "Resolving…" : "Allow"}
          </Button>
        </div>
      </footer>
    </ParkedShell>
  );
}

// Collapsible diff renderer. Split on newlines and tint by the leading
// +/- character — green add, red remove — without pulling in a diff lib.
function DiffBlock({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.replace(/\n$/, "").split("\n"), [diff]);
  return (
    <pre className="mt-1.5 max-h-[240px] overflow-auto bg-bg-2 border border-line-soft rounded text-xs font-mono leading-[1.5]">
      {lines.map((line, i) => {
        const add = line.startsWith("+") && !line.startsWith("+++");
        const del = line.startsWith("-") && !line.startsWith("---");
        const cls = add
          ? "bg-green/10 text-green"
          : del
            ? "bg-red/10 text-red"
            : "text-text-3";
        return (
          <div key={i} className={`px-2.5 ${cls} whitespace-pre-wrap break-all`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

// Impact panel — a compact, severity-tinted summary of what user-facing
// feature the doomed change would break. Built entirely from the structured
// `AgentImpact` payload; purely informational (no focusable controls).
function ImpactPanel({ impact }: { impact: AgentImpact }) {
  const tone = IMPACT_TONE[impact.severity] ?? IMPACT_TONE.unknown;
  const conf = CONFIDENCE_TONE[impact.confidence] ?? CONFIDENCE_TONE.low;

  const features = impact.features ?? [];
  const callers = impact.directCallers ?? [];

  const shownFeatures = features.slice(0, 6);
  const moreFeatures = features.length - shownFeatures.length;

  const shownCallers = callers.slice(0, 4);
  const moreCallers = callers.length - shownCallers.length;
  const hasNameOnly = callers.some((c) => c.confidence === "name_only");

  // Footer caveats: the always-on hedge, plus graph-provenance notes when
  // the analysis was run against something other than a fresh checkpoint,
  // was truncated, or is meaningfully stale (> 1 day).
  const notes: string[] = [];
  if (impact.graphSource === "none") {
    notes.push("limited view. Nothing recent to compare against");
  } else if (impact.graphSource !== "checkpoint") {
    notes.push("based on your unsaved changes");
  } else if (impact.graphStalenessSecs != null && impact.graphStalenessSecs > 86400) {
    notes.push(`based on a save from ${humanizeAge(impact.graphStalenessSecs)} ago`);
  }
  if (impact.truncated) notes.push("partial check");

  return (
    <div className={`rounded-md border px-3 py-2.5 space-y-2 ${tone.bg} ${tone.border}`}>
      {/* Header: "IMPACT" label + severity word + confidence pill. */}
      <div className="flex items-center gap-2">
        <span className="section-label">
          Impact
        </span>
        <span className={`text-xs font-medium ${tone.text}`}>{tone.word}</span>
        <span
          className={`ml-auto rounded-full border px-1.5 py-0.5 text-2xs font-medium ${conf.bg} ${conf.border} ${conf.text}`}
        >
          {impact.confidence}
        </span>
      </div>

      {/* Summary — the headline sentence, prominent, with inline **bold**
          and `code` rendered safely (no markdown lib, no raw HTML). */}
      <p className="text-text-1 text-base leading-snug">
        {renderInline(impact.summary)}
      </p>

      {/* Feature chips — the user-facing surfaces upstream of the change. */}
      {shownFeatures.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {shownFeatures.map((f, i) => (
            <span
              key={`${f.entrySymbol}:${f.file}:${i}`}
              className="inline-flex items-center gap-1 rounded border border-line bg-bg-2 px-1.5 py-0.5 text-xs"
              title={`${f.path && f.path.length > 1 ? f.path.join(" → ") : f.entrySymbol} · ${f.file}`}
            >
              <span className="text-text-1 font-medium truncate max-w-[160px]">{f.name}</span>
              <span className="text-text-4">{kindLabel(f.kind)}</span>
              {f.path && f.path.length > 1 && (
                <span className="font-mono text-2xs text-text-3 truncate max-w-[200px]">
                  {f.path.join(" → ")}
                </span>
              )}
            </span>
          ))}
          {moreFeatures > 0 && (
            <span className="text-text-4 text-xs">+{moreFeatures} more</span>
          )}
        </div>
      )}

      {/* "Used by" line — the other parts of the code that rely on this. */}
      {callers.length > 0 && (
        <div className="text-text-3 text-xs leading-snug">
          Used by:{" "}
          {shownCallers.map((c, i) => (
            <span key={`${c.symbol}:${i}`}>
              {i > 0 && ", "}
              <code className="font-mono text-text-2" title={c.file ?? undefined}>
                {c.symbol}
              </code>
            </span>
          ))}
          {moreCallers > 0 && <span className="text-text-4"> (+{moreCallers} more)</span>}
          {hasNameOnly && (
            <span className="text-text-4"> · some of these are uncertain matches</span>
          )}
        </div>
      )}

      {/* Footer micro-line — the honesty caveat + provenance notes. */}
      <p className="text-text-4 text-xs leading-snug">
        {impact.hedge}
        {notes.map((n) => (
          <span key={n}> · {n}</span>
        ))}
      </p>
    </div>
  );
}

// The "Xs ago" ticker now lives in `parked/dock` with the rest of the
// shared chrome — both cards need it and it was only ever written here
// because this was the only card.
