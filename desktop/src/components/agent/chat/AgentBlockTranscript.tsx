//! The readable chat for an agent whose protocol we don't parse yet.
//!
//! `NormalizedTranscript` turns a structured event stream into rich cards, and
//! it is wonderful — but it only works for an engine that has an adapter under
//! `lib/agentProtocol/adapters/`, which today means Claude Code alone. Every
//! other CLI we ship (Gemini, Codex, Cursor, Kimi) resolved to "no normalizer",
//! and the surface responded by hiding the Chat view entirely. So the answer to
//! "how good is the chat view for a normal terminal agent" was: there wasn't
//! one. Those agents had a terminal and nothing else.
//!
//! There is real, already-parsed content for them, though, and it has been
//! there the whole time. The PTY layer frames every session into blocks: when
//! anything is sent through `agent_pty_send_prompt` the backend closes a Prompt
//! block holding the exact text that was typed and opens an Output block for
//! what comes back, and its vte performer has already stripped the ANSI down to
//! printable text. That is a (what I asked, what it answered) pair — which is
//! precisely what a chat transcript is. This file draws those pairs with the
//! same chat furniture the rest of the app uses, so a Gemini session reads like
//! a conversation instead of a wall of bytes.
//!
//! What it deliberately does NOT do is pretend to be the structured view. There
//! are no tool cards here, because a block is not a tool call and inventing one
//! would mean guessing at the CLI's output format — exactly the parser-drift
//! bug factory the surface's own header comment says drove the retreat to
//! terminal-only. The agent's answer is shown as what it honestly is: its
//! terminal output, in the terminal's own typeface, flush and unstyled. When an
//! adapter lands for one of these engines, `NormalizedTranscript` takes over
//! for it automatically and this file stops being reached for that agent.

import { useMemo } from "react";

import type { BlockEnvelope } from "../../../lib/api";
import { LinkifiedText } from "../normalized/TaskChip";

/** One exchange: what was sent, and what came back. `output` is null while the
 *  agent has been asked something but hasn't written anything yet, which is how
 *  the "working" state is drawn without inventing a separate event. */
type Exchange = {
  id: string;
  prompt: BlockEnvelope | null;
  output: BlockEnvelope | null;
  exit: BlockEnvelope | null;
};

export function AgentBlockTranscript({
  blocks,
  repoRoot,
  running,
}: {
  blocks: BlockEnvelope[];
  repoRoot: string;
  /** The stream store's view of whether this agent is mid-turn. Drives the
   *  live caret on the trailing exchange. */
  running: boolean;
}) {
  const exchanges = useMemo(() => foldExchanges(blocks), [blocks]);

  if (exchanges.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[760px] px-5 py-4 flex flex-col gap-3">
      {exchanges.map((x, i) => (
        <ExchangeRow
          key={x.id}
          exchange={x}
          repoRoot={repoRoot}
          live={running && i === exchanges.length - 1}
        />
      ))}
    </div>
  );
}

/** Fold the flat envelope list into conversational pairs.
 *
 *  The backend already guarantees the ordering we rely on — a Prompt block is
 *  closed and an Output block opened by the same `send_prompt` call — so this
 *  is a fold, not a heuristic. An Output with no Prompt before it is still kept
 *  on its own row: that is what the agent's own welcome banner is, and dropping
 *  it would silently lose the first thing the user sees. An `exit` envelope
 *  merges onto the Output it terminates so the pair can show one state instead
 *  of trailing a bare exit row, matching how `AgentBlocksView` folds them. */
export function foldExchanges(blocks: BlockEnvelope[]): Exchange[] {
  const out: Exchange[] = [];
  for (const b of blocks) {
    if (b.kind === "prompt") {
      out.push({ id: b.id, prompt: b, output: null, exit: null });
      continue;
    }
    if (b.kind === "output") {
      const last = out[out.length - 1];
      // Attach to the prompt that opened this output; a second output under the
      // same prompt (the CLI reopening a block) starts its own row rather than
      // being concatenated, so nothing is silently merged across turns.
      if (last && last.prompt && !last.output) {
        last.output = b;
      } else {
        out.push({ id: b.id, prompt: null, output: b, exit: null });
      }
      continue;
    }
    // exit — colours the state of the output it followed.
    const last = out[out.length - 1];
    if (last && last.output && !last.exit) {
      last.exit = b;
    }
  }
  return out;
}

function ExchangeRow({
  exchange,
  repoRoot,
  live,
}: {
  exchange: Exchange;
  repoRoot: string;
  live: boolean;
}) {
  const body = exchange.output ? tidyOutput(exchange.output.text) : "";
  const failed = (exchange.exit?.exit_code ?? 0) !== 0;
  return (
    <div className="flex flex-col gap-2">
      {exchange.prompt && exchange.prompt.text.trim().length > 0 && (
        <div className="self-end max-w-[88%]">
          <div
            // `break-words` is load-bearing, not decoration: prompts routinely
            // carry an absolute path, a URL or a commit sha, and
            // `whitespace-pre-wrap` alone will not break inside one. A single
            // long token then stretches the bubble past the column and the whole
            // pane gains a horizontal scrollbar.
            className="rounded-lg px-3 py-2 text-base leading-relaxed whitespace-pre-wrap break-words"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
              color: "var(--color-text-1)",
              border:
                "1px solid color-mix(in srgb, var(--color-accent) 22%, transparent)",
            }}
          >
            <LinkifiedText text={exchange.prompt.text} repoRoot={repoRoot} />
          </div>
        </div>
      )}
      {body.length > 0 && (
        <div className="self-start w-full">
          {/* The agent's answer is terminal output, so it keeps the terminal's
              typeface and sits flush on the page rather than inside a card —
              boxing it would fight the box drawing the TUI already emits. */}
          <pre
            className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed select-text"
            style={{ color: failed ? "var(--color-red)" : "var(--color-text-2)" }}
          >
            {body}
            {/* The same pulsing block the brain's markdown body ends on while
                it streams, so a live turn reads identically in both chats. */}
            {live && (
              <span
                className="inline-block w-1.5 h-3 ml-0.5 align-text-bottom animate-pulse"
                style={{
                  background: "color-mix(in srgb, var(--color-text-2) 60%, transparent)",
                }}
                aria-hidden
              />
            )}
          </pre>
        </div>
      )}
      {failed && (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-red)" }}>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--color-red)" }}
          />
          <span className="font-medium">
            Ended with an error{exchange.exit ? ` · exit ${exchange.exit.exit_code}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/** Make a full-screen TUI's output legible without editing what it said.
 *
 *  The performer strips the escape codes but not their consequences: a REPL
 *  that repaints its frame leaves long runs of blank lines and trailing pad
 *  spaces behind. Collapsing those is safe because they carry no content. We
 *  stop there on purpose — anything cleverer (dropping box-drawing rows,
 *  guessing at spinner frames) starts deleting things the agent actually said,
 *  and a transcript that quietly omits output is worse than an untidy one. */
export function tidyOutput(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
