import { useMemo } from "react";
import type { ChatTurn } from "../../../lib/api";
import { getAgentIdentity } from "../../../lib/agentIdentity";
import { Check, Circle, CircleAlert } from "lucide-react";
import { AgentIcon } from "../../agent/AgentIcon";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { ToolCall } from "../../ui/message";
import { type WaveStatus, parseWaveEvent } from "./waveEvents";
import "../../ui/chat-tool-detail.css";
import "../../ui/live-strips.css";

// ─── Wave Timeline ────────────────────────────────────────────────────
// All wave events emitted across the session aggregate into ONE
// timeline block. Each wave is a single row that PROGRESSES through
// states (dispatched → running → shipped) — not a stack of duplicate
// blocks. Rendered once at the tail of the chat so it always reflects
// current state. Per-turn wave events are filtered out (see
// AgentMessageBody) to prevent duplication.

type AggregatedWave = {
  wave: number;
  /** Latest status — drives the row color + verb. */
  status: WaveStatus;
  /** Chronological history of statuses this wave has been through. */
  history: WaveStatus[];
  /** Latest agent attribution (most recent event wins). */
  agent?: string;
  /** Commit hash if/when this wave shipped. */
  commit?: string;
  /** Latest free-form detail string for tooltip/secondary line. */
  detail: string;
  /** Timestamp of latest event. */
  at: number;
};

/** Walk chronological chat turns, parse wave events out of agent prose,
 *  and aggregate them into one row per wave number. A wave's `status`
 *  reflects the LATEST event seen; `history` keeps the transition trail
 *  for the timeline dots. */
function collectWaveTimeline(chat: ChatTurn[]): AggregatedWave[] {
  const byWave = new Map<number, AggregatedWave>();
  for (const turn of chat) {
    if (turn.role !== "manager") continue;
    const paragraphs = (turn.text ?? "").split(/\n\s*\n/);
    for (const para of paragraphs) {
      const evt = parseWaveEvent(para.trim());
      if (!evt) continue;
      const existing = byWave.get(evt.wave);
      if (!existing) {
        byWave.set(evt.wave, {
          wave: evt.wave,
          status: evt.status,
          history: [evt.status],
          agent: evt.agent,
          commit: evt.commit,
          detail: evt.detail,
          at: turn.at,
        });
      } else {
        existing.status = evt.status;
        if (existing.history[existing.history.length - 1] !== evt.status) {
          existing.history.push(evt.status);
        }
        if (evt.agent) existing.agent = evt.agent;
        if (evt.commit) existing.commit = evt.commit;
        existing.detail = evt.detail;
        existing.at = turn.at;
      }
    }
  }
  return Array.from(byWave.values()).sort((a, b) => a.wave - b.wave);
}

export function WaveTimeline({ chat }: { chat: ChatTurn[] }) {
  const waves = useMemo(() => collectWaveTimeline(chat), [chat]);
  if (waves.length === 0) return null;
  const shipped = waves.filter((w) => w.status === "shipped").length;
  const status = waves.some((w) => w.status === "blocked")
    ? "error"
    : shipped === waves.length
      ? "done"
      : "running";
  return (
    <ToolCall
      title={`Wave timeline · ${shipped} of ${waves.length} shipped`}
      status={status}
      defaultOpen
    >
      <ul className="ui-tool-steps ui-wave-timeline">
        {waves.map((w) => (
          <WaveTimelineRow key={w.wave} wave={w} />
        ))}
      </ul>
    </ToolCall>
  );
}

// One compact status indicator per wave — no multi-stop pipeline. The
// row reads at a glance: spinner/check/alert tells you state, the row
// content tells you what landed (commit + agent + detail).

/** The chat's step states: shipped is done, anything moving is in progress,
 *  the rest is still to do. Blocked keeps its own mark. */
function rowStatus(status: WaveStatus): "completed" | "in_progress" | "blocked" | "pending" {
  if (status === "shipped") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "running" || status === "firing" || status === "dispatched") return "in_progress";
  return "pending";
}

function WaveTimelineRow({ wave }: { wave: AggregatedWave }) {
  // Fall back to the lead-builder identity when the brain didn't tag
  // the wave with an agent — every wave has a runner, the prose just
  // doesn't always say which one. Better to show the lead default than
  // leave the column blank and break row alignment.
  const identity = getAgentIdentity(wave.agent ?? "claude");
  const status = rowStatus(wave.status);
  const label = wave.status.charAt(0).toUpperCase() + wave.status.slice(1);
  return (
    <li data-wave-row={wave.wave} data-status={status}>
      {status === "completed" ? (
        <Check size={14} aria-label={label} />
      ) : status === "blocked" ? (
        <CircleAlert size={14} aria-label={label} className="ui-wave-blocked" />
      ) : status === "in_progress" ? (
        <span title={label} aria-label={label}>
          <AsciiSpinner />
        </span>
      ) : (
        <Circle size={14} aria-label={label} />
      )}
      <strong className="ui-wave-number">W{wave.wave}</strong>
      <span className="ui-wave-agent" title={identity.blurb}>
        <AgentIcon agentId={identity.id} size={11} />
        {identity.tag}
      </span>
      {wave.commit && (
        <Badge variant="outline" className="ui-wave-commit" title={`Commit ${wave.commit}`}>
          {wave.commit.slice(0, 7)}
        </Badge>
      )}
      <span className="ui-wave-detail" title={wave.detail}>
        {wave.detail}
      </span>
    </li>
  );
}
