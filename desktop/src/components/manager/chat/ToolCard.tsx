//! Tool-call rendering for the native Aura chat.
//!
//! A turn's stream is a chronological list of `StreamBlock`s: assistant
//! prose and tool calls, interleaved. `StreamingBubble` lays them out, and
//! every tool call becomes one shared step row (`ToolCall`): the title says
//! what ran and what it ran on, the status mark says how it went, and opening
//! it shows the detail from `ToolDetail`. Runs of reads or actions fold into
//! a step group so a long turn reads as a few lines, not a wall of rows.

import * as React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageLightbox } from "../../media/ImageLightbox";

import { AgentIcon } from "../../agent/AgentIcon";
import { Message, MessageBody, ToolCall } from "../../ui/message";
import { describeTool } from "./toolDescribe";
import { StreamingMessageText } from "./StreamingMessageText";
import { ReasoningBlock } from "./ReasoningBlock";
import { ExploringGroup, isReadOnlyTool } from "./ExploringGroup";
import { LiveToolStatus } from "./LiveToolStatus";
import { FileDiffTool, isFileDiffTool } from "./FileDiffTool";
import {
  AskBlock,
  CardBody,
  diffStat,
  FieldsBlock,
  PlanBlock,
  TerminalBlock,
  toolCallStatus,
  ToolResultBlock,
} from "./ToolDetail";
import { toolStatus } from "./types";
import type { StreamBlock, ToolResult, ToolStatus, ToolView } from "./types";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** A read-only tool that should fold into an `ExploringGroup`. An image read
 *  is read-only too, but its whole point is the inline picture a collapsed
 *  group would hide — so it's excluded here and renders as its own card. */
function isGroupableRead(block: ToolBlock): boolean {
  if (!isReadOnlyTool(block)) return false;
  return !describeTool(block.name, block.input, block.result).imagePath;
}

// ── Streaming bubble ────────────────────────────────────────────────────

/** Render one turn's accumulated stream in emission order. Each block kind
 *  gets its own treatment:
 *   - reasoning → a collapsible `ReasoningBlock` disclosure (extended thinking)
 *   - text      → `StreamingMessageText` (cosmetic char-drip while streaming)
 *   - tool      → a `ToolCard`, EXCEPT:
 *       • a run of ≥2 consecutive read-only tools collapses into one
 *         `ExploringGroup` (so a context-gathering burst is one line)
 *       • an edit/write with extractable content renders as an inline
 *         `FileDiffTool` (Monaco side-by-side) instead of the generic card.
 *
 *  `streaming` is true while the turn is live — it drives the text drip and
 *  the reasoning auto-open/close; false on the persisted-reload path (the
 *  timeline renders finished turns through other components, but a parent may
 *  still reuse this with streaming=false). */
export function StreamingBubble({
  blocks,
  streaming = true,
  identity = false,
}: {
  blocks: StreamBlock[];
  streaming?: boolean;
  /** Prepend the "Aura" identity row (avatar + name) so the live turn
   *  matches a settled assistant group's header. The model suffix is
   *  omitted here — the brain isn't persisted until the turn lands. */
  identity?: boolean;
}) {
  const rendered: React.ReactNode[] = [];
  if (identity) {
    rendered.push(
      <div key="who" className="ui-chat-agent-header">
        <AgentIcon agentId="aura-manager" size={14} />
        <span>Aura</span>
      </div>,
    );
  }
  const lastIdx = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const live = streaming && i === lastIdx;
    if (b.kind === "reasoning") {
      rendered.push(<ReasoningBlock key={i} text={b.text} streaming={live} />);
      continue;
    }
    if (b.kind === "text") {
      rendered.push(
        <Message key={i} role="assistant">
          <MessageBody className="ui-chat-answer">
            <StreamingMessageText text={b.text} streaming={live} />
          </MessageBody>
        </Message>,
      );
      continue;
    }
    // Two or more steps in a row fold into one group: reads gather while the
    // agent explores, actions gather while it works. An image read stays on
    // its own so the picture it brought back is not hidden in a group.
    if (isGroupableRead(b)) {
      const group: ToolBlock[] = [b];
      let j = i + 1;
      while (j < blocks.length) {
        const nb = blocks[j]!;
        if (nb.kind !== "tool" || !isGroupableRead(nb)) break;
        group.push(nb);
        j++;
      }
      if (group.length >= 2) {
        rendered.push(<ExploringGroup key={i} tools={group} />);
        i = j - 1; // skip the batched run
        continue;
      }
    } else if (!isReadOnlyTool(b)) {
      const group: ToolBlock[] = [b];
      let j = i + 1;
      while (j < blocks.length) {
        const nb = blocks[j]!;
        if (nb.kind !== "tool" || isReadOnlyTool(nb)) break;
        group.push(nb);
        j++;
      }
      if (group.length >= 2) {
        rendered.push(<LiveToolStatus key={i} tools={group} />);
        i = j - 1; // skip the batched run
        continue;
      }
    }
    if (isFileDiffTool(b.name, b.input)) {
      rendered.push(
        <FileDiffTool key={i} name={b.name} input={b.input} result={b.result} />,
      );
      continue;
    }
    rendered.push(
      <ToolCard key={i} name={b.name} input={b.input} result={b.result} />,
    );
  }

  return <div className="ui-chat-stream">{rendered}</div>;
}

/** Leading-word present→past map. The registry names verbs in the present
 *  continuous ("Running", "Reading") because that reads right while a tool is
 *  in flight; once it has settled we say what it *did* ("Ran", "Read"), so a
 *  finished step never lies with a live-sounding "Running". Only the first
 *  word is rewritten — "Listing tasks" → "Listed tasks" — and unknown leads
 *  (noun labels like "Aura status") pass through untouched. */
const VERB_PAST: Record<string, string> = {
  Reading: "Read",
  Finding: "Found",
  Searching: "Searched",
  Listing: "Listed",
  Fetching: "Fetched",
  Proving: "Proved",
  Reviewing: "Reviewed",
  Writing: "Wrote",
  Editing: "Edited",
  Running: "Ran",
  Waiting: "Waited",
  Planning: "Planned",
  Asking: "Asked",
  Bringing: "Brought",
  Creating: "Created",
  Updating: "Updated",
  Resolving: "Resolved",
  Saving: "Saved",
  Recording: "Recorded",
  Pushing: "Pushed",
  Pulling: "Pulled",
  Messaging: "Messaged",
  Claiming: "Claimed",
  Releasing: "Released",
  Suggesting: "Suggested",
  Watching: "Watched",
  Resuming: "Resumed",
  Summarizing: "Summarized",
  Recalling: "Recalled",
  Narrating: "Narrated",
  Compacting: "Compacted",
  Forgetting: "Forgot",
  Handing: "Handed",
  Skimming: "Skimmed",
  Checking: "Checked",
  Verifying: "Verified",
  Looking: "Looked",
  Dispatching: "Dispatched",
  Routing: "Routed",
};

/** The verb to show for a tool at a given status. A running tool keeps its
 *  present-tense verb; a settled one (ok/error) reads in the past tense. */
function settledVerb(verb: string, status: ToolStatus): string {
  if (status === "running") return verb;
  if (status === "cancelled") return "Cancelled";
  if (status === "unknown") return "No result";
  if (status === "error") return "Failed";
  const sp = verb.indexOf(" ");
  const first = sp === -1 ? verb : verb.slice(0, sp);
  const past = VERB_PAST[first];
  if (!past) return verb;
  return sp === -1 ? past : past + verb.slice(sp);
}

/** The picture an image read brought back, bounded so a large image never
 *  dominates the transcript. The path is a local file resolved through the
 *  asset protocol; if it fails to load the image removes itself rather than
 *  showing a broken-image glyph. */
function ToolImage({ view }: { view: ToolView }) {
  const [failed, setFailed] = React.useState(false);
  const src = view.imagePath ? convertFileSrc(view.imagePath) : "";
  if (!src || failed) return null;
  return (
    <ImageLightbox
      src={src}
      alt={view.subject || "image"}
      name={view.imagePath?.split("/").pop() || view.subject}
      loading="lazy"
      onError={() => setFailed(true)}
      className="chat-media"
      style={{ maxWidth: "min(420px, 100%)" }}
    />
  );
}

/** A step's one-line title: what it did and what it did it to. */
export function toolTitle(view: ToolView, status: ToolStatus): string {
  return [settledVerb(view.verb, status), view.subject].filter(Boolean).join(" ");
}

/** Render one `tool_use`/`tool_result` pair as a step row: the title says what
 *  ran, opening it shows the detail — a terminal well for a command, the
 *  question and its options for an ask, the plan for a plan, else the diff,
 *  fields and result. An image read opens by default so its picture shows.
 *
 *  Memoized (shallow name/input/result): a transcript holds many settled
 *  steps, and each render otherwise re-runs `describeTool` for every one of
 *  them on any stream update. A still-running step's `result` flips from
 *  undefined to an object, which the shallow compare catches. */
export const ToolCard = React.memo(function ToolCard({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResult;
}) {
  const view = describeTool(name, input, result);
  const status = toolStatus(result);
  const title = toolTitle(view, status);

  if (view.imagePath) {
    return (
      <ToolCall title={title} status={toolCallStatus(status)} defaultOpen>
        <ToolImage view={view} />
      </ToolCall>
    );
  }

  const isTerminal = view.glyph === "run" && !!view.command;
  const stat = view.diff ? diffStat(view.diff) : null;
  return (
    <ToolCall title={title} status={toolCallStatus(status)}>
      {(view.aux || view.metric || (stat && (stat.add > 0 || stat.del > 0))) && !isTerminal && (
        <p className="ui-tool-meta">
          {view.aux && <span title={view.aux}>{view.aux}</span>}
          {stat && (stat.add > 0 || stat.del > 0) ? (
            <span className="ui-diff-count">
              <span>+{stat.add}</span>
              <span>−{stat.del}</span>
            </span>
          ) : (
            view.metric && <span>{view.metric}</span>
          )}
        </p>
      )}
      {isTerminal ? (
        <TerminalBlock command={view.command || ""} result={result} />
      ) : (
        <>
          {view.planMarkdown ? (
            <PlanBlock markdown={view.planMarkdown} />
          ) : view.ask ? (
            <AskBlock ask={view.ask} />
          ) : (
            <CardBody view={view} />
          )}
          {view.fields && view.fields.length > 0 && <FieldsBlock fields={view.fields} />}
          {result && <ToolResultBlock result={result} view={view} />}
        </>
      )}
    </ToolCall>
  );
});
