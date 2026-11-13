// The card for Aura's destructive-op gate. When the coding agent is about to
// do something risky and Aura's validator is *unsure*, the backend parks the
// agent and asks the person: exactly what's about to happen and why, what it
// would break, and Allow / Deny. The agent stays blocked until they answer.
//
// Deny takes two clicks: the first opens an optional note that goes back to
// the agent, the second sends it. Denying here strands a half-finished
// operation, so the "why?" is worth the extra step — but it is never forced.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../../lib/api";
import { Alert, AlertDescription } from "../../ui/alert";
import { PermissionRequest } from "../../ui/chat-decisions";
import { Field } from "../../ui/field";
import { Input } from "../../ui/input";
import { ParkedLine, ParkedQueue, ParkedShell } from "./dock";
import { GATE_TIMEOUT_MS, type AgentGateRequest } from "./gateTypes";
import { FoldedDiff, ImpactPanel } from "./ImpactPanel";

// How loud the gate's own verdict reads beside the headline.
const SEVERITY: Record<AgentGateRequest["severity"], { label: string; tone?: "danger" | "warn" }> = {
  info: { label: "Info" },
  warn: { label: "Needs review", tone: "warn" },
  danger: { label: "Risky", tone: "danger" },
};

export function GateCard({
  request,
  pending,
  onResolved,
}: {
  request: AgentGateRequest;
  /** How many more agents are queued behind this one. */
  pending: number;
  onResolved: () => void;
}) {
  const sev = SEVERITY[request.severity] ?? SEVERITY.info;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denyMode, setDenyMode] = useState(false);
  const [note, setNote] = useState("");

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
  // 600s; a little after that, auto-dismiss so the card can't wedge. Anchored
  // to createdAt so a card restored mid-life still expires on the real clock.
  useEffect(() => {
    const ageMs = Math.max(0, Date.now() - request.createdAt * 1000);
    const remaining = GATE_TIMEOUT_MS + 15_000 - ageMs;
    const id = setTimeout(onResolved, Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [request.createdAt, onResolved]);

  // Deny needs one click to reveal the optional note, a second to confirm.
  const onDeny = useCallback(() => {
    if (!denyMode) {
      setDenyMode(true);
      return;
    }
    void resolve(false);
  }, [denyMode, resolve]);

  // Deliberately do NOT steal focus on mount: the card is a non-blocking dock,
  // and yanking the caret out of the composer mid-type is exactly what made
  // the old full-screen version annoying. Once the deny note opens, though,
  // the person has asked to type — so it takes focus then.
  useEffect(() => {
    if (denyMode) noteRef.current?.focus();
  }, [denyMode]);

  // The request answers to its number keys once it has focus; Esc is Deny,
  // the safe answer, from anywhere on the card.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (busy || e.key !== "Escape") return;
      e.preventDefault();
      onDeny();
    },
    [busy, onDeny],
  );

  return (
    <ParkedShell label={request.title} tone={sev.tone} onKeyDown={onKeyDown}>
      <PermissionRequest
        title={request.title}
        agent={<ParkedLine lead={sev.label} since={request.createdAt} />}
        description={request.reason}
        command={request.command ?? undefined}
        pending={busy}
        choices={[
          { id: "allow", label: busy ? "Resolving…" : "Allow", primary: true },
          {
            id: "deny",
            label: denyMode ? "Confirm deny" : "Deny",
            description: denyMode ? "Your note goes back to the agent" : undefined,
          },
        ]}
        onChoose={(choice) => (choice === "allow" ? void resolve(true) : onDeny())}
      >
        {/* What user-facing feature this would break — only when the
            validator attached a structured analysis. */}
        {request.impact && <ImpactPanel impact={request.impact} />}

        <div className="ui-parked-meta">
          <span>
            Tool <code>{request.toolName}</code>
          </span>
          {request.file && (
            <span>
              File{" "}
              <code title={request.file} dir="rtl">
                {request.file}
              </code>
            </span>
          )}
        </div>

        {request.diff && <FoldedDiff diff={request.diff} />}

        {denyMode && (
          <Field label="Why?" htmlFor={`gate-note-${request.gateId}`} optional>
            <Input
              id={`gate-note-${request.gateId}`}
              ref={noteRef}
              size="small"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              // The note is text, not answers: digits typed here must not
              // pick a choice. Enter sends the deny; Esc still reaches the
              // card and sends it too.
              onKeyDown={(e) => {
                if (e.key === "Escape") return;
                e.stopPropagation();
                if (e.key === "Enter" && !busy) {
                  e.preventDefault();
                  void resolve(false);
                }
              }}
              placeholder="Reason for denying. Sent back to the agent"
              disabled={busy}
            />
          </Field>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <ParkedQueue pending={pending} />
      </PermissionRequest>
    </ParkedShell>
  );
}
