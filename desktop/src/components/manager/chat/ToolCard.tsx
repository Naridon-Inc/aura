//! Tool-call rendering for the native Aura chat.
//!
//! A turn's stream is a chronological list of `StreamBlock`s: assistant
//! prose and tool calls, interleaved. `StreamingBubble` lays them out;
//! every tool call flows through `ToolCard`, which asks the registry
//! (`describeTool`) for a normalized `ToolView` and renders it at one of
//! two visual tiers:
//!
//!   - "thinking" — context-gathering (read/grep/glob/ls/fetch). A single
//!     quiet line: glyph · verb · subject · metric. Expands on click.
//!   - "action"   — world-changing (edit/write/run/dispatch/ask). A proper
//!     card with a header, a status badge, and a body that is one of:
//!     a multi-step loader, a unified diff, or inline prose. A chevron
//!     reveals the raw input JSON + result pane.
//!
//! Tokens only — colors come from the theme so a card recolors with it.

import * as React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { StatusChip, type ChipTone } from "../../ui/statusChip";
import { AgentIcon } from "../../agent/AgentIcon";
import { describeTool } from "./toolDescribe";
import { MarkdownBody } from "./Markdown";
import { StreamingMessageText } from "./StreamingMessageText";
import { ReasoningBlock } from "./ReasoningBlock";
import { ExploringGroup, isReadOnlyTool } from "./ExploringGroup";
import { LiveToolStatus } from "./LiveToolStatus";
import { FileDiffTool, isFileDiffTool } from "./FileDiffTool";
import type {
  AskView,
  StreamBlock,
  ToolField,
  ToolGlyph,
  ToolResult,
  ToolStatus,
  ToolStep,
  ToolView,
} from "./types";

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
      <div key="who" className="aura-msg-who">
        <span className="aura-msg-av" aria-hidden>
          <AgentIcon agentId="aura-manager" size={14} />
        </span>
        <span className="name">Aura</span>
      </div>,
    );
  }
  // Only the single trailing block of a live group char-drips — earlier
  // text/reasoning are settled (the agent has moved on) and must render
  // complete/instantly so the reveal reads LINEARLY (paragraph → tool →
  // paragraph) instead of every paragraph dripping from 0 at once. `lastIdx`
  // is the array's final index, computed once; the tool-batching loop advances
  // `i` (via `i = j - 1`), so a block is "live" iff `i === lastIdx`.
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
        <div key={i} className="agent-text">
          <StreamingMessageText text={b.text} streaming={live} />
        </div>,
      );
      continue;
    }
    // b.kind === "tool" — look ahead to batch a run of consecutive read-only
    // tools into one ExploringGroup.
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
      // A lone read-only tool stays a plain card.
    } else if (!isReadOnlyTool(b)) {
      // Action-tier run — ≥2 consecutive world-changing tools (edits, runs,
      // dispatches fired for one plan) club into a single living status bar
      // that morphs through the steps. A lone action tool keeps its own
      // card / inline diff below.
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

  // Same reading-column cap as a settled assistant turn (ManagerChatView's
  // `agent-text max-w-[680px]`) so the live stream — prose, reasoning, and the
  // tool/thinking cards alike — stops "in between" instead of running the full
  // pane width.
  return (
    <div className="flex flex-col gap-1.5 w-full max-w-[680px]">{rendered}</div>
  );
}

// ── Tool card ───────────────────────────────────────────────────────────

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
  const sp = verb.indexOf(" ");
  const first = sp === -1 ? verb : verb.slice(0, sp);
  const past = VERB_PAST[first];
  if (!past) return verb;
  return sp === -1 ? past : past + verb.slice(sp);
}

/** An image the brain read, shown inline. A compact "Read · foo.png" header
 *  over the actual picture, bounded so a large image never dominates the
 *  transcript. The path is a local file on this machine resolved through the
 *  Tauri asset protocol (`convertFileSrc`); if the asset fails to load the
 *  `<img>` removes itself, leaving just the header — never a broken-image
 *  glyph. */
function ImageReadCard({
  view,
  status,
}: {
  view: ToolView;
  status: ToolStatus;
}) {
  const [failed, setFailed] = React.useState(false);
  const src = view.imagePath ? convertFileSrc(view.imagePath) : "";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="aura-tool-row" style={{ cursor: "default" }}>
        <ToolGlyphIcon view={view} status={status} />
        <span className="aura-tool-chip-verb">
          {settledVerb(view.verb, status)}
        </span>
        {view.subject && (
          <span
            className={`aura-tool-chip-subject ${view.mono ? "font-mono" : ""}`}
            title={view.subject}
          >
            {view.subject}
          </span>
        )}
        {view.metric && (
          <span className="aura-tool-chip-metric">{view.metric}</span>
        )}
      </div>
      {src && !failed && (
        <img
          src={src}
          alt={view.subject || "image"}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{
            display: "block",
            maxWidth: "min(420px, 100%)",
            maxHeight: 320,
            width: "auto",
            height: "auto",
            objectFit: "contain",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-line)",
            background: "var(--color-bg-1)",
          }}
        />
      )}
    </div>
  );
}

/** Render one `tool_use`/`tool_result` pair. Status is derived purely from
 *  the result: absent → running, error flag → error, else ok. The registry
 *  owns naming/normalization; this component owns the pixels.
 *
 *  Memoized (shallow name/input/result): a transcript holds many settled tool
 *  cards, and each render otherwise re-runs `describeTool` and rebuilds the
 *  card for every one of them on any stream update. A settled block's
 *  name/input/result refs are stable, so its card renders once and then skips;
 *  a still-running card's `result` flips from undefined to an object, which the
 *  shallow compare catches and re-renders as expected. */
export const ToolCard = React.memo(function ToolCard({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResult;
}) {
  const [open, setOpen] = React.useState(false);
  const view = describeTool(name, input, result);
  const status: ToolStatus = !result
    ? "running"
    : result.is_error
      ? "error"
      : "ok";

  // An image the brain read renders the picture itself, inline — always
  // visible, no expand needed. The user asked: "when it says a png and all,
  // can't we show the file?" This is that.
  if (view.imagePath) {
    return <ImageReadCard view={view} status={status} />;
  }

  // ── Thinking tier (collapsed) — one quiet line in the activity stream.
  // Same leading-column · verb · mono-target · trailing-cluster skeleton as
  // the action chip so a read and an edit sit in one uniform vertical list.
  if (view.tier === "thinking" && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Click to expand"
        className="aura-tool-row"
      >
        <ToolGlyphIcon view={view} status={status} />
        <span className="aura-tool-chip-verb">
          {settledVerb(view.verb, status)}
        </span>
        {view.subject && (
          <span
            className={`aura-tool-chip-subject ${view.mono ? "font-mono" : ""}`}
            title={view.subject}
          >
            {view.subject}
          </span>
        )}
        {view.aux && (
          <span className="aura-tool-chip-aux" title={view.aux}>
            {view.aux}
          </span>
        )}
        {/* Trailing meta: a command run gets the exit-status pill (the
            reference's at-a-glance "did it work"); everything else shows its
            metric, or nothing. No status mark — a finished row's past-tense
            verb says it ran; a running row pulses its leading glyph. */}
        {isRunTool(view) ? (
          <ExitBadge status={status} />
        ) : (
          view.metric && (
            <span className="aura-tool-chip-metric">{view.metric}</span>
          )
        )}
      </button>
    );
  }

  // ── Action tier (collapsed) — an inline chip. The chosen "chip → card"
  // mix: calm one-line pill by default (glyph · verb · subject · status ·
  // diffstat), expands into the full card below on click.
  if (!open) {
    return (
      <ToolChip view={view} status={status} onExpand={() => setOpen(true)} />
    );
  }

  // ── Expanded — a compact card. One identity line (glyph · verb · subject ·
  // metric · status · collapse), then the detail directly below. Conductor
  // style: no redundant second title row, no JSON wall — just the answer the
  // tool produced. Clicking the identity line collapses back to the chip.
  // What the detail section will actually paint — so an expanded card with no
  // body and no captured output doesn't show an empty strip (or a divider with
  // nothing under it). Mirrors what CardBody / ToolResultBlock render: both now
  // return null when they'd otherwise be a hatch fill.
  // A terminal tool (bash) renders ONE dark well: the command on a `>` prompt
  // line, then its output — the way a real shell shows them. The command lives
  // in the well, so the header drops its redundant aux command chip.
  const isTerminal = view.glyph === "run" && !!view.command;
  const hasInlineBody =
    !!view.ask ||
    !!view.steps ||
    !!view.diff ||
    !!view.body ||
    !!view.planMarkdown ||
    (!!view.fields && view.fields.length > 0);
  const hasResultContent = !!result?.content?.trimEnd();
  const hasDetail = isTerminal || hasInlineBody || hasResultContent;

  // Compact, inline expansion — NO bulky bordered card. The identity line
  // stays a flat tool row (same rhythm as the collapsed chip, just with an
  // up-chevron + a faint active wash), and the detail drops in directly
  // beneath it, indented under the verb so it reads as "this row's output".
  // The detail column shrink-wraps (align-items:flex-start) so a short well
  // is only as wide as it needs — it never fills the full width.
  return (
    <div className="aura-tool-expanded">
      {/* Identity line — the whole row toggles collapse. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        title="Collapse"
        className="aura-tool-row aura-tool-row-open"
      >
        <ToolGlyphIcon view={view} status={status} />
        <span className="aura-tool-chip-verb">
          {settledVerb(view.verb, status)}
        </span>
        {view.subject && (
          <span
            className={`aura-tool-chip-subject ${view.mono ? "font-mono" : ""}`}
            title={view.subject}
          >
            {view.subject}
          </span>
        )}
        {view.aux && !isTerminal && (
          <span className="aura-tool-chip-aux" title={view.aux}>
            {view.aux}
          </span>
        )}
        <span className="ml-auto shrink-0 flex items-center gap-1.5">
          {isRunTool(view) ? (
            <ExitBadge status={status} inline />
          ) : (
            view.metric && (
              <span className="aura-tool-chip-metric" style={{ marginLeft: 0 }}>
                {view.metric}
              </span>
            )
          )}
          <Chevron dir="up" />
        </span>
      </button>

      {/* Detail: a terminal well for shell tools, else structured ask options /
          humanized fields / body / diff, then the result — never raw JSON,
          never an empty fill. Indented under the verb, content-hugging. */}
      {hasDetail && (
        // Terminal wells break out of the verb indent — a command's output
        // reads as a full-bleed shell pane, not a card tucked under the icon.
        <div className={isTerminal ? "aura-tool-detail aura-tool-detail-flush" : "aura-tool-detail"}>
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
              {view.fields && view.fields.length > 0 && (
                <FieldsBlock fields={view.fields} />
              )}
              {result && <ToolResultBlock result={result} view={view} />}
            </>
          )}
        </div>
      )}
    </div>
  );
});

// ── Ask-the-user block ──────────────────────────────────────────────────

/** Render an ask-the-user tool's question(s) + options as a compact list of
 *  rows — never the raw `{questions:[…]}` JSON. Each option is one tight row
 *  (label + muted description); multi-select questions note it quietly. */
function AskBlock({ ask }: { ask: AskView }) {
  return (
    <div className="flex flex-col gap-2.5">
      {ask.questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1">
          {q.question && (
            <div
              className="text-sm leading-snug"
              style={{ color: "var(--color-text-1)" }}
            >
              {q.question}
            </div>
          )}
          <div className="flex flex-col gap-1">
            {q.options.map((o, oi) => (
              <div
                key={oi}
                className="flex flex-col gap-0.5 px-2 py-1"
                style={{
                  border: "1px solid var(--color-line-soft)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--color-bg-0)",
                }}
              >
                <span
                  className="text-sm font-medium leading-tight"
                  style={{ color: "var(--color-text-1)" }}
                >
                  {o.label}
                </span>
                {o.description && (
                  <span
                    className="text-xs leading-snug line-clamp-2"
                    style={{ color: "var(--color-text-3)" }}
                    title={o.description}
                  >
                    {o.description}
                  </span>
                )}
              </div>
            ))}
          </div>
          {q.multiSelect && (
            <span
              className="text-xs"
              style={{ color: "var(--color-text-4)" }}
            >
              Pick one or more
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Plan block ──────────────────────────────────────────────────────────

/** Render a proposed plan (ExitPlanMode) as real markdown in a calm bordered
 *  block — headings, lists and code render through the prose engine, never as a
 *  raw `{plan:"…"}` blob. Compact: a thin frame on the darkest surface so the
 *  plan reads as a distinct artifact without shouting. */
function PlanBlock({ markdown }: { markdown: string }) {
  return (
    <div
      className="w-full text-base leading-snug px-3 py-2"
      style={{
        border: "1px solid var(--color-line-soft)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-bg-0)",
        color: "var(--color-text-2)",
      }}
    >
      <MarkdownBody source={markdown} />
    </div>
  );
}

// ── Humanized fields block ──────────────────────────────────────────────

/** Render a tool's inputs as plain `label: value` rows — the friendly stand-in
 *  for the old raw INPUT JSON pane, so no tool call is ever an opaque blob. */
function FieldsBlock({ fields }: { fields: ToolField[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {fields.map((f, i) => (
        <div key={i} className="flex gap-2 text-sm leading-snug">
          <span
            className="shrink-0"
            style={{ color: "var(--color-text-4)", minWidth: 72 }}
          >
            {f.label}
          </span>
          <span
            className="min-w-0 break-words line-clamp-3"
            style={{ color: "var(--color-text-2)" }}
          >
            {f.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Tool chip (action, collapsed) ───────────────────────────────────────

/** Collapsed action tier — a calm inline pill. The default face of every
 *  world-changing tool call: glyph · verb · subject · (diffstat | metric) ·
 *  status. Clicking expands it into the full `ToolCard` (header, body, raw
 *  input, result). The "chip → card" mix: quiet by default, full detail on
 *  demand. Tokens only; accent is chat-scoped green. */
function ToolChip({
  view,
  status,
  onExpand,
}: {
  view: ToolView;
  status: ToolStatus;
  onExpand: () => void;
}) {
  const stat = view.diff ? diffStat(view.diff) : null;
  return (
    <button
      type="button"
      onClick={onExpand}
      title="Click to expand"
      className="aura-tool-chip group"
    >
      <ToolGlyphIcon view={view} status={status} />
      <span className="aura-tool-chip-verb">
        {settledVerb(view.verb, status)}
      </span>
      {view.subject && (
        <span
          className={`aura-tool-chip-subject ${view.mono ? "font-mono" : ""}`}
          title={view.subject}
        >
          {view.subject}
        </span>
      )}
      {view.aux && (
        <span className="aura-tool-chip-aux" title={view.aux}>
          {view.aux}
        </span>
      )}
      {/* Trailing meta: a command run gets the exit-status pill, an edit its
          diffstat, else the registry's metric — pushed right by the subject's
          flex-grow. */}
      {isRunTool(view) ? (
        <ExitBadge status={status} />
      ) : stat && (stat.add > 0 || stat.del > 0) ? (
        <span className="aura-tool-chip-diffstat">
          {stat.add > 0 && (
            <span style={{ color: "var(--color-accent-green)" }}>
              +{stat.add}
            </span>
          )}
          {stat.del > 0 && (
            <span style={{ color: "var(--color-red)" }}>−{stat.del}</span>
          )}
        </span>
      ) : (
        view.metric && <span className="aura-tool-chip-metric">{view.metric}</span>
      )}
    </button>
  );
}

/** Count added/removed lines in a unified diff, ignoring the `+++`/`---`
 *  file headers so the chip's diffstat reflects real edits. */
function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line[0] === "+") add++;
    else if (line[0] === "-") del++;
  }
  return { add, del };
}

/** Body of an action card: a step loader, a diff, or prose — whichever the
 *  view carries. `clamped` trims it for the collapsed state. */
function CardBody({ view, clamped }: { view: ToolView; clamped?: boolean }) {
  if (view.steps) {
    return (
      <div className={clamped ? "px-3 pb-2" : ""}>
        <StepLoader steps={view.steps} max={clamped ? 3 : undefined} />
      </div>
    );
  }
  if (view.diff) {
    return (
      <div className={clamped ? "px-3 pb-2" : ""}>
        <DiffView diff={view.diff} clamped={clamped} />
      </div>
    );
  }
  if (view.body) {
    return (
      <div
        className={
          clamped
            ? "px-3 pb-2 text-sm leading-snug break-words line-clamp-2"
            : "text-sm leading-snug whitespace-pre-wrap break-words"
        }
        style={{ color: "var(--color-text-2)" }}
      >
        {view.body}
      </div>
    );
  }
  // No body to show — render nothing. A hatch fill just reads as dead space;
  // the compact card keeps its footprint tight (collapsed already returned
  // null, expanded now does too).
  return null;
}

// ── Diff view ───────────────────────────────────────────────────────────

const DIFF_MAX_LINES = 14;

/** Render a unified-diff string as tinted hunks: `+` lines on a faint green
 *  wash, `-` lines on a faint red wash, hunk headers dimmed, everything else
 *  plain. A 1ch gutter carries the sign. Mono and small. Tokens only. */
export function DiffView({ diff, clamped }: { diff: string; clamped?: boolean }) {
  const [showAll, setShowAll] = React.useState(false);
  const lines = React.useMemo(
    () => diff.replace(/\n$/, "").split("\n"),
    [diff],
  );
  const clip = clamped || !showAll;
  const overflow = clip && lines.length > DIFF_MAX_LINES;
  const shown = overflow ? lines.slice(0, DIFF_MAX_LINES) : lines;

  return (
    <div
      className="overflow-hidden"
      style={{
        border: "1px solid var(--color-line-soft)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-bg-0)",
      }}
    >
      <pre
        className="text-xs leading-[1.55] overflow-x-auto"
        style={{ fontFamily: "var(--font-mono)", margin: 0 }}
      >
        {shown.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </pre>
      {!clamped && overflow && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="aura-block-link px-2 py-1 block"
        >
          {`SHOW ALL ${lines.length}`}
        </button>
      )}
      {clamped && lines.length > DIFF_MAX_LINES && (
        <div
          className="px-2 py-1 text-xs"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-3)",
          }}
        >
          + {lines.length - DIFF_MAX_LINES} more lines
        </div>
      )}
    </div>
  );
}

/** One diff row. Kind keys off the leading char; `@@` hunk headers and the
 *  `+++`/`---` file headers stay neutral-dim so the body changes lead. */
function DiffLine({ line }: { line: string }) {
  const head = line[0];
  const isHunk = line.startsWith("@@");
  const isFileHdr = line.startsWith("+++") || line.startsWith("---");
  const added = head === "+" && !isFileHdr;
  const removed = head === "-" && !isFileHdr;

  let sign = " ";
  let bg = "transparent";
  let fg = "var(--color-text-2)";
  if (added) {
    sign = "+";
    bg = "color-mix(in srgb, var(--color-accent-green) 12%, transparent)";
    fg = "var(--color-accent-green)";
  } else if (removed) {
    sign = "-";
    bg = "color-mix(in srgb, var(--color-red) 12%, transparent)";
    fg = "var(--color-red)";
  } else if (isHunk || isFileHdr) {
    fg = "var(--color-text-3)";
  }

  const text = added || removed ? line.slice(1) : line;

  return (
    <div
      className="flex items-start whitespace-pre"
      style={{ background: bg, color: fg }}
    >
      <span
        aria-hidden
        className="shrink-0 select-none text-center"
        style={{ width: "1.5ch", color: "var(--color-text-3)" }}
      >
        {sign}
      </span>
      <span className="min-w-0 break-words pr-2">{text || " "}</span>
    </div>
  );
}


// ── Multi-step loader ───────────────────────────────────────────────────

/** Multi-step status list (e.g. a todo plan). Each step carries a status
 *  circle: ○ pending (outline) / ● in-progress (filled, pulsing) / ✓ done.
 *  When `max` is set the list clips, anchored on the active step so the
 *  user always sees what's running now plus a slice of upcoming work. */
export function StepLoader({ steps, max }: { steps: ToolStep[]; max?: number }) {
  let visible = steps;
  let hiddenAfter = 0;
  if (max && steps.length > max) {
    const activeIdx = steps.findIndex((s) => s.status === "in_progress");
    let start = 0;
    if (activeIdx > 0 && activeIdx + max <= steps.length) start = activeIdx;
    else if (activeIdx >= 0)
      start = Math.max(0, Math.min(activeIdx, steps.length - max));
    visible = steps.slice(start, start + max);
    hiddenAfter = steps.length - (start + visible.length);
  }
  return (
    <div className="flex flex-col gap-1">
      {visible.map((step, i) => (
        <StepRow key={i} step={step} />
      ))}
      {hiddenAfter > 0 && (
        <div
          className="pl-5 text-xs"
          style={{
            color: "var(--color-text-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          + {hiddenAfter} more
        </div>
      )}
    </div>
  );
}

/** One step row: status circle + label. Active steps brighten + pulse,
 *  completed steps dim. */
export function StepRow({ step }: { step: ToolStep }) {
  const isDone = step.status === "completed";
  const isActive = step.status === "in_progress";
  const labelColor = isActive
    ? "var(--color-text-1)"
    : isDone
      ? "var(--color-text-3)"
      : "var(--color-text-2)";
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-[3px] shrink-0 inline-flex items-center justify-center ${isActive ? "animate-pulse" : ""}`}
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          border: isDone || isActive ? "none" : "1.25px solid var(--color-line)",
          background: isDone
            ? "var(--color-accent-green)"
            : isActive
              ? "var(--color-accent)"
              : "transparent",
          color: "var(--color-bg-0)",
          fontSize: 9,
          lineHeight: 1,
        }}
      >
        {isDone ? "✓" : ""}
      </span>
      <span
        className="text-sm leading-snug"
        style={{ color: labelColor }}
      >
        {step.label}
      </span>
    </div>
  );
}

// ── Result pane ─────────────────────────────────────────────────────────

/** Whether a tool's output should read as raw terminal/file text — a compact
 *  mono block (commands, reads, greps, globs) — rather than rendered markdown
 *  (a page body, a review report). Keyed off the view's glyph so it tracks the
 *  registry, not a hardcoded name list. `view` is optional so the long-standing
 *  one-arg signature still works; absent → markdown for the back-compat path. */
function isRawTextOutput(view?: ToolView): boolean {
  if (!view) return false;
  switch (view.glyph) {
    case "run":
    case "read":
    case "search":
    case "glob":
    case "list":
      return true;
    default:
      return false;
  }
}

/** Tool stdout/result, clamped to 10 lines with a "Show all" toggle so big
 *  bash dumps don't drown the chat. Three faces, all clamped uniformly:
 *   - errors          → plain red mono (stack traces stay verbatim)
 *   - terminal / read → a compact mono block; a file read gets line numbers
 *   - everything else → markdown (a page body, a review report)
 *  `view` is an optional hint (the registry's normalized description) used to
 *  pick the face; the long-standing one-arg call still resolves to markdown. */
export function ToolResultBlock({
  result,
  view,
}: {
  result: ToolResult;
  view?: ToolView;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const content = result.content?.trimEnd() || "";
  // Nothing to show — render nothing. An empty "OUTPUT" box with a hatch fill
  // is exactly the dead space the compact card is meant to avoid.
  if (!content) return null;
  const lines = content.split("\n");
  const clamped = !showAll && lines.length > 10;
  const shown = clamped ? lines.slice(0, 10) : lines;
  const raw = !result.is_error && isRawTextOutput(view);
  const numbered = raw && view?.glyph === "read";
  // The header earns its row only when it carries something: the error label,
  // or the show-all toggle for a long dump. A short clean output needs no
  // label — the mono block's own well already sets it apart from the prose.
  const showHeader = result.is_error || lines.length > 10;
  return (
    <div>
      {showHeader && (
        <div
          className="flex items-center justify-between mb-1"
          style={{ color: "var(--color-text-3)" }}
        >
          <span className="aura-block-label">
            {result.is_error ? "ERROR" : "OUTPUT"}
          </span>
          {lines.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="aura-block-link"
            >
              {showAll ? `SHOW FIRST 10 / ${lines.length}` : `SHOW ALL ${lines.length}`}
            </button>
          )}
        </div>
      )}
      {result.is_error ? (
        <pre
          className="text-xs whitespace-pre-wrap break-words"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--color-red)",
            margin: 0,
          }}
        >
          {shown.join("\n")}
          {clamped && "\n…"}
        </pre>
      ) : raw ? (
        <MonoOutput lines={shown} numbered={numbered} more={clamped} />
      ) : (
        <MarkdownBody source={clamped ? `${shown.join("\n")}\n\n…` : content} />
      )}
    </div>
  );
}

/** A compact mono output block — the terminal/read face of a tool result.
 *  Commands render as plain mono lines; a file read gets a tabular line-number
 *  gutter so the output reads like a code listing. Boxed in a hairline well so
 *  it sits apart from the prose, the same chrome the diff/input panes use. */
function MonoOutput({
  lines,
  numbered,
  more,
}: {
  lines: string[];
  numbered: boolean;
  more: boolean;
}) {
  return (
    <div
      className="overflow-hidden"
      style={{
        border: "1px solid var(--color-line-soft)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-bg-0)",
      }}
    >
      <pre
        className="text-xs leading-[1.55] overflow-x-auto"
        style={{ fontFamily: "var(--font-mono)", margin: 0, padding: "6px 8px" }}
      >
        {lines.map((line, i) => (
          <div key={i} className="flex items-start whitespace-pre">
            {numbered && (
              <span
                aria-hidden
                className="shrink-0 select-none text-right tabular-nums pr-2"
                style={{ minWidth: "2.5ch", color: "var(--color-text-4)" }}
              >
                {i + 1}
              </span>
            )}
            <span
              className="min-w-0 break-words"
              style={{ color: "var(--color-text-2)" }}
            >
              {line || " "}
            </span>
          </div>
        ))}
        {more && (
          <div style={{ color: "var(--color-text-3)" }}>…</div>
        )}
      </pre>
    </div>
  );
}

/** A terminal well — the command and its output in ONE box, the way a real
 *  shell shows them (the reference session-transcript treatment): a green `$`
 *  prompt carrying the full command, which WRAPS instead of scrolling off as a
 *  single line, then the output beneath it. A command that printed nothing says
 *  so explicitly ("— no output —") rather than reading as a lone, unexplained
 *  line. The output clamps to 10 lines with a show-all toggle so a big dump
 *  doesn't drown the chat; an errored run tints it red. Tokens only — the well
 *  is the darkest surface so it reads apart from the prose, never out-shouting
 *  it. */
function TerminalBlock({
  command,
  result,
}: {
  command: string;
  result?: ToolResult;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const out = result?.content?.trimEnd() || "";
  const lines = out ? out.split("\n") : [];
  const clamped = !showAll && lines.length > 10;
  const shown = clamped ? lines.slice(0, 10) : lines;
  const isError = !!result?.is_error;
  const hasOutput = lines.length > 0;
  return (
    <div className="aura-term-well w-full">
      <pre className="aura-term-pre">
        {/* Command prompt — a green `$`, then the full command, WRAPPED so a
            long pipeline reads in full instead of scrolling off the edge. */}
        <div className="flex items-start">
          <span
            aria-hidden
            className="shrink-0 select-none pr-2"
            style={{ color: "var(--color-accent-green)" }}
          >
            $
          </span>
          <span className="min-w-0 aura-term-cmd">{command}</span>
        </div>
        {/* Output beneath the prompt — red when the run errored, an explicit
            placeholder when the command printed nothing. */}
        {hasOutput ? (
          shown.map((line, i) => (
            <div key={i}>
              <span style={{ color: isError ? "var(--color-red)" : "var(--color-text-3)" }}>
                {line || " "}
              </span>
            </div>
          ))
        ) : (
          <div style={{ color: "var(--color-text-4)" }}>— no output —</div>
        )}
        {clamped && <div style={{ color: "var(--color-text-4)" }}>…</div>}
      </pre>
      {lines.length > 10 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="aura-term-more"
        >
          {showAll ? `Show first 10 of ${lines.length}` : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

// ── Status indicators ───────────────────────────────────────────────────

/** 6px status pip — the minimal fallback indicator for a glyph-less tool.
 *  Calm: running pulses in muted ink, a settled ok is muted (the row's mere
 *  presence says it ran), only an error keeps a hue (red). No green — a status
 *  pip is ambient, never a brand accent. */
export function ToolStatusDot({ status }: { status: ToolStatus }) {
  const bg =
    status === "error"
      ? "var(--color-red)"
      : status === "ok"
        ? "var(--color-text-4)"
        : "var(--color-text-3)";
  return (
    <span
      className={`inline-block rounded-full shrink-0 ${status === "running" ? "animate-pulse" : ""}`}
      style={{ width: 6, height: 6, background: bg }}
      aria-hidden
    />
  );
}

/** Exit-status pill for a command run — the at-a-glance signal the reference
 *  carries on every shell row: a green "exit 0" when the command succeeded, a
 *  red "failed" when it errored. Nothing while still running (the pulsing glyph
 *  already says "in flight"). This is the trailing meta for `run`-glyph rows,
 *  replacing the muted "no output"/"N lines" metric so a command run reads as a
 *  command — not an unlabeled single line. */
export function ExitBadge({
  status,
  inline,
}: {
  status: ToolStatus;
  /** Drop the `margin-left:auto` when the badge sits inside an already
   *  right-pushed cluster (the expanded header's metric/chevron group). */
  inline?: boolean;
}) {
  if (status === "running") return null;
  const ok = status !== "error";
  const c = ok ? "var(--color-accent-green)" : "var(--color-red)";
  return (
    <span
      className="aura-tool-exit"
      style={{
        color: c,
        borderColor: `color-mix(in srgb, ${c} 30%, transparent)`,
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
        ...(inline ? { marginLeft: 0 } : null),
      }}
    >
      {ok ? <CheckMini /> : <CrossMini />}
      {ok ? "exit 0" : "failed"}
    </span>
  );
}

/** Whether a tool's trailing meta should be the exit-status pill — true for any
 *  shell run (the "run" glyph), so cat/ls thinking-tier runs get the badge too,
 *  matching the reference. */
function isRunTool(view: ToolView): boolean {
  return view.glyph === "run";
}

function CheckMini() {
  return (
    <svg width={9} height={9} viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2.5 6.5l2 2 5-5"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossMini() {
  return (
    <svg width={9} height={9} viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
    </svg>
  );
}

// Green-branded chat: running pulses green (distinguished from the solid
// green "Done" by the pulse + label, not by hue), ok is green, error red.
// No blue anywhere in the chat surface.
const STATUS_BADGE: Record<ToolStatus, { tone: ChipTone; label: string }> = {
  running: { tone: "green", label: "Running" },
  ok: { tone: "green", label: "Done" },
  error: { tone: "red", label: "Error" },
};

/** Header status badge for action cards. A `StatusChip` with a leading dot;
 *  running pulses to read as live. */
export function ToolStatusBadge({ status }: { status: ToolStatus }) {
  const spec = STATUS_BADGE[status];
  return (
    <StatusChip
      tone={spec.tone}
      dot
      dense
      className={`shrink-0 ${status === "running" ? "animate-pulse" : ""}`}
    >
      {spec.label}
    </StatusChip>
  );
}

// ── Glyph table ─────────────────────────────────────────────────────────

/** Token color for the leading glyph. Calm by default: every glyph reads as
 *  muted ink (the reference's monochrome activity rows) so a build transcript
 *  isn't a wall of green action icons — the "accent"/"green" accents the
 *  registry tags action tools with collapse to muted here. Only genuinely
 *  meaningful states keep a hue: an error reds, an `amber`-tagged tool (a
 *  delete / destructive op) stays amber as a quiet warning. */
function glyphColor(view: ToolView, status: ToolStatus): string {
  if (status === "error") return "var(--color-red)";
  switch (view.accent) {
    case "red":
      return "var(--color-red)";
    case "amber":
      return "var(--color-amber)";
    default:
      return "var(--color-text-3)";
  }
}

/** Leading icon for a tool — the view's glyph rendered as an inline monoline
 *  SVG, or a status pip when no glyph is named. */
export function ToolGlyphIcon({
  view,
  status,
}: {
  view: ToolView;
  status: ToolStatus;
}) {
  // Always a fixed 16px slot (.aura-tool-glyph) so the glyph and the no-glyph
  // status dot occupy the same width — the verb after it lands at one x. The
  // glyph carries the live cue: it pulses while running, so a row reads as
  // in-flight without a trailing status dot. Settled rows sit still.
  return (
    <span
      className={`aura-tool-glyph${status === "running" ? " animate-pulse" : ""}`}
      style={view.glyph ? { color: glyphColor(view, status) } : undefined}
      aria-hidden
    >
      {view.glyph ? GLYPHS[view.glyph]() : <ToolStatusDot status={status} />}
    </span>
  );
}

/** Shared SVG frame: 13px, 1.25 stroke, rounded caps, currentColor. Calm and
 *  monoline — these sit in dense activity rows and must not shout. */
function glyph(children: React.ReactNode): React.ReactNode {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Glyph key → inline SVG. The card owns this table; the registry only names
 *  a key, keeping the two decoupled. */
const GLYPHS: Record<ToolGlyph, () => React.ReactNode> = {
  read: () =>
    glyph(
      <>
        <path d="M3 2.5h6l3.5 3.5v7.5H3z" />
        <path d="M9 2.5V6h3.5" />
        <path d="M5.5 8.5h5M5.5 11h5" />
      </>,
    ),
  search: () =>
    glyph(
      <>
        <circle cx={7} cy={7} r={4} />
        <path d="M10 10l3 3" />
      </>,
    ),
  glob: () =>
    glyph(
      <>
        <path d="M2 8h12M8 2v12" />
        <path d="M4 4l8 8M12 4l-8 8" />
      </>,
    ),
  list: () =>
    glyph(
      <>
        <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
        <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
      </>,
    ),
  fetch: () =>
    glyph(
      <>
        <circle cx={8} cy={8} r={6} />
        <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
      </>,
    ),
  edit: () =>
    glyph(
      <>
        <path d="M10.5 3l2.5 2.5L6 12.5 3 13l.5-3z" />
        <path d="M9.5 4l2.5 2.5" />
      </>,
    ),
  write: () =>
    glyph(
      <>
        <path d="M3.5 2.5h6l3 3v8h-9z" />
        <path d="M9.5 2.5v3h3" />
        <path d="M6 9h4" />
      </>,
    ),
  run: () =>
    glyph(
      <>
        <path d="M3.5 4l3 4-3 4" />
        <path d="M8 12h4.5" />
      </>,
    ),
  dispatch: () =>
    glyph(
      <>
        <circle cx={8} cy={3.5} r={1.5} />
        <circle cx={4} cy={12.5} r={1.5} />
        <circle cx={12} cy={12.5} r={1.5} />
        <path d="M8 5v2M8 7l-4 4M8 7l4 4" />
      </>,
    ),
  ask: () =>
    glyph(
      <>
        <path d="M6 6a2 2 0 113 1.7c-.6.4-1 .8-1 1.8" />
        <path d="M8 12h.01" />
      </>,
    ),
  task: () =>
    glyph(
      <>
        <rect x={3} y={3} width={10} height={10} rx={1.5} />
        <path d="M5.5 8l1.5 1.5L11 6" />
      </>,
    ),
  page: () =>
    glyph(
      <>
        <path d="M4 2.5h5l3 3v8H4z" />
        <path d="M9 2.5V6h3" />
        <path d="M6 9h4M6 11h2.5" />
      </>,
    ),
  review: () =>
    glyph(
      <>
        <circle cx={8} cy={8} r={3} />
        <path d="M1.5 8C3 5 5.5 3.5 8 3.5S13 5 14.5 8C13 11 10.5 12.5 8 12.5S3 11 1.5 8z" />
      </>,
    ),
  plan: () =>
    glyph(
      <>
        <path d="M3 3.5h10M3 8h10M3 12.5h6" />
      </>,
    ),
  generic: () =>
    glyph(
      <>
        <circle cx={8} cy={8} r={5} />
      </>,
    ),
};

// ── Local primitives ────────────────────────────────────────────────────

/** Tiny inline chevron — own SVG, not imported. */
function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
