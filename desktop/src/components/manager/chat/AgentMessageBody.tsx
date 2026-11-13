import { useMemo } from "react";
import { type EngineErrorEvent, parseEngineErrorEvent } from "../../../lib/engineErrorEvent";
import { EngineErrorRow } from "./EngineErrorRow";
import { MarkdownBody } from "./Markdown";
import { HookEventBlock } from "./SystemRows";
import {
  type ProverReport,
  extractProverBlock,
  ProverBlock,
} from "./ProverBlock";
import { type WaveEvent, parseWaveEvent } from "./waveEvents";

/** `engine` names who wrote the turn ("OpenCode"), so an error event from it
 *  can say whose sign-in failed. */
export function AgentMessageBody({ source, engine }: { source: string; engine?: string | null }) {
  const segments = useMemo(
    // Wave events are intentionally filtered — they aggregate into the
    // session-level WaveTimeline so each wave renders as ONE entity that
    // progresses through states, not N separate blocks per status change.
    () => splitAgentSegments(source).filter((s) => s.kind !== "wave"),
    [source],
  );
  if (segments.length === 0) return null;
  if (segments.length === 1 && segments[0].kind === "prose") {
    return <MarkdownBody source={segments[0].text} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {segments.map((seg, i) =>
        seg.kind === "hook" ? (
          <HookEventBlock key={i} text={seg.text} />
        ) : seg.kind === "engineError" ? (
          <EngineErrorRow key={i} event={seg.event} engine={engine} />
        ) : seg.kind === "prover" ? (
          <ProverBlock key={i} report={seg.report} />
        ) : seg.kind === "prose" ? (
          <MarkdownBody key={i} source={seg.text} />
        ) : null,
      )}
    </div>
  );
}

type AgentSegment =
  | { kind: "prose"; text: string }
  | { kind: "wave"; event: WaveEvent }
  | { kind: "hook"; text: string }
  | { kind: "engineError"; event: EngineErrorEvent }
  | { kind: "prover"; report: ProverReport };

// Split an agent message into structured segments. Each non-empty
// paragraph is tested against the wave-event pattern; matching ones
// become structured events. Prose paragraphs are coalesced so the
// renderer doesn't insert extra gaps between successive non-event
// sentences.
function splitAgentSegments(source: string): AgentSegment[] {
  // Aura Prover spans many lines (header + bullets + report). Extract
  // it first as a whole multi-line block so the per-paragraph loop
  // doesn't shred it into prose.
  const { stripped, prover } = extractProverBlock(source);
  const paragraphs = stripped.split(/\n\s*\n/);
  const out: AgentSegment[] = [];
  if (prover) out.push({ kind: "prover", report: prover });
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const wave = parseWaveEvent(trimmed);
    if (wave) {
      out.push({ kind: "wave", event: wave });
      continue;
    }
    // An engine run as a plain CLI writes its error event where its answer
    // goes, so a failed turn's text is that event's JSON. Never show it.
    const engineError = parseEngineErrorEvent(trimmed);
    if (engineError) {
      out.push({ kind: "engineError", event: engineError });
      continue;
    }
    if (/^hook\s+blocked\b/i.test(trimmed)) {
      out.push({ kind: "hook", text: trimmed });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "prose") {
      last.text += `\n\n${trimmed}`;
    } else {
      out.push({ kind: "prose", text: trimmed });
    }
  }
  return out;
}
