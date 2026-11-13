// Render of a single Block envelope, on the chat's step row: the state's icon
// and the block's kind as the row, a state chip, the block id, when it started
// and how long it took; under it the prompt, the captured output as a code
// listing, or how the run ended.
//
// The shell-side BlockEnvelope is simpler than aura-blocks::Block (3 kinds
// only: prompt / output / exit). We synthesise a BlockState from the kind
// + finished_at + exit_code so a prompt, its output and its exit agree.
//
// Each card carries a stable Block id (`b.id`) and exposes:
//   • collapse / expand (output cards) — saves vertical space when triaging
//   • copy as markdown — fenced code-block of the captured output
//   • re-run (prompt cards) — dispatches `aura:rerun-prompt { sessionId, text }`
// The parent AgentSurface routes the re-run event to its Composer.

import { memo, useState } from "react";
import { Check, ChevronRight, CircleAlert, Copy, RotateCcw } from "lucide-react";

import type { BlockEnvelope } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ChatStatus } from "../ui/message";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { CodeMessage } from "../ui/transcript-content";
import "../ui/chat-tool-detail.css";
import "../ui/block-card.css";

type BlockState = "running" | "done" | "failed";

type Props = {
  block: BlockEnvelope;
  /** Highlight border with the state color. Single-pane views always
   *  pass true so the active card stays prominent. */
  focused?: boolean;
  /** Optional companion exit envelope so an output card can render its
   *  exit pill inline (matches the term layout) without an extra row. */
  exit?: BlockEnvelope | null;
  /** Collapsed state, when the list owns it. The windowed stack unmounts a
   *  card you scroll past, so a flag held inside the card would reset every
   *  time one came back — the list keeps it and passes it down. Left out,
   *  the card falls back to its own state. */
  collapsed?: boolean;
  onToggleCollapsed?: (blockId: string) => void;
};

// Memoised on a plain shallow prop compare, which is exact here: the session
// store hands out a new envelope object only for the block that actually
// changed, and the list passes stable handlers. Without this a single chunk of
// PTY output re-rendered every card in the session's history — including their
// multi-KB <pre> bodies.
export const BlockCard = memo(function BlockCard({
  block,
  focused = false,
  exit = null,
  collapsed: collapsedProp,
  onToggleCollapsed,
}: Props) {
  const state = synthState(block, exit);
  const [selfCollapsed, setSelfCollapsed] = useState(false);
  const collapsed = collapsedProp ?? selfCollapsed;
  const [copied, setCopied] = useState(false);

  const startedMs = block.started_at * 1000;
  const finishedMs = (block.finished_at ?? block.started_at) * 1000;
  const dur = relDuration(Math.max(0, finishedMs - startedMs));
  const ts = clockHm(startedMs);

  const shortId = block.id ? block.id.slice(0, 6) : null;
  const canCollapse = block.kind === "output" && !!block.text;
  const canRerun = block.kind === "prompt" && !!block.text;

  function copyAsMarkdown() {
    const md = blockToMarkdown(block);
    navigator.clipboard.writeText(md).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — silent fallback */
      },
    );
  }

  function toggleCollapsed() {
    if (onToggleCollapsed) onToggleCollapsed(block.id);
    else setSelfCollapsed((v) => !v);
  }

  function rerun() {
    if (block.kind !== "prompt" || !block.text) return;
    window.dispatchEvent(
      new CustomEvent("aura:rerun-prompt", {
        detail: { sessionId: block.session_id, text: block.text },
      }),
    );
  }

  const title = (
    <>
      {canCollapse && (
        <ChevronRight size={14} className={collapsed ? undefined : "ui-chevron-open"} />
      )}
      <StateIcon state={state} />
      <span>{KIND_TITLE[block.kind] ?? block.kind}</span>
    </>
  );

  return (
    <div
      className="ui-tool-call ui-block"
      data-status={STATE_STATUS[state]}
      data-focused={focused || undefined}
    >
      <div className="ui-block-head">
        {canCollapse ? (
          <button
            type="button"
            className="ui-tool-trigger"
            aria-expanded={!collapsed}
            title={collapsed ? "Expand output" : "Collapse output"}
            onClick={toggleCollapsed}
          >
            {title}
          </button>
        ) : (
          <div className="ui-tool-trigger">{title}</div>
        )}
        <StatusChip tone={STATE_TONE[state]} dense>
          {STATE_LABEL[state]}
        </StatusChip>
        {shortId && (
          <Badge variant="outline" className="ui-block-id" title={`Block id ${block.id}`}>
            #{shortId}
          </Badge>
        )}
        <small className="ui-block-meta ui-block-time">
          {ts} · {dur}
        </small>
        <span className="ui-block-actions">
          {canRerun && (
            <Button
              variant="ghost"
              size="iconXs"
              aria-label="Re-run this prompt"
              title="Re-run this prompt"
              onClick={rerun}
            >
              <RotateCcw />
            </Button>
          )}
          <Button
            variant="ghost"
            size="iconXs"
            aria-label={copied ? "Copied" : "Copy as markdown"}
            title={copied ? "Copied" : "Copy as markdown"}
            onClick={copyAsMarkdown}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </span>
      </div>

      <BlockBody block={block} state={state} collapsed={collapsed} />
    </div>
  );
});

const KIND_TITLE: Record<string, string> = {
  prompt: "Prompt",
  output: "Output",
  exit: "Exit",
};

const STATE_STATUS: Record<BlockState, "running" | "done" | "error"> = {
  running: "running",
  done: "done",
  failed: "error",
};

const STATE_TONE: Record<BlockState, ChipTone> = {
  running: "amber",
  done: "green",
  failed: "red",
};

const STATE_LABEL: Record<BlockState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
};

function StateIcon({ state }: { state: BlockState }) {
  if (state === "running") return <AsciiSpinner />;
  if (state === "failed") return <CircleAlert size={14} />;
  return <Check size={14} />;
}

function BlockBody({
  block,
  state,
  collapsed,
}: {
  block: BlockEnvelope;
  state: BlockState;
  collapsed: boolean;
}) {
  if (block.kind === "prompt") {
    if (!block.text) return null;
    return (
      <div className="ui-tool-content">
        <p className="ui-block-prompt">{block.text}</p>
      </div>
    );
  }
  if (block.kind === "exit") {
    const ok = (block.exit_code ?? 0) === 0;
    return (
      <div className="ui-tool-content">
        <p className="ui-block-exit" data-ok={ok || undefined}>
          {ok ? "Finished without errors" : `Stopped with error ${block.exit_code ?? 0}`}
        </p>
      </div>
    );
  }
  if (collapsed && block.text) {
    return (
      <div className="ui-tool-content">
        <p className="ui-tool-quiet">{linesOf(block.text)} lines folded</p>
      </div>
    );
  }
  return (
    <div className="ui-tool-content">
      <OutputView block={block} state={state} />
    </div>
  );
}

function linesOf(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (const c of s) if (c === "\n") n++;
  return n;
}

function blockToMarkdown(b: BlockEnvelope): string {
  const head = `### Block ${b.id?.slice(0, 8) ?? "?"} · ${b.kind}`;
  const sub = b.kind === "exit" ? `exit code: ${b.exit_code ?? 0}` : "";
  const body = b.text ?? "";
  const fenced = body ? `\n\n\`\`\`\n${body}\n\`\`\`` : "";
  return [head, sub].filter(Boolean).join("\n") + fenced + "\n";
}

function OutputView({
  block,
  state,
}: {
  block: BlockEnvelope;
  state: BlockState;
}) {
  if (!block.text) {
    if (state === "running") return <ChatStatus state="working">Streaming…</ChatStatus>;
    return null;
  }
  return (
    <div className="ui-tool-output ui-tool-terminal">
      <CodeMessage language="Output">
        {block.text}
        {state === "running" && <span className="ui-tool-quiet">▌</span>}
      </CodeMessage>
    </div>
  );
}

function synthState(b: BlockEnvelope, exit: BlockEnvelope | null): BlockState {
  if (b.kind === "exit") {
    return (b.exit_code ?? 0) === 0 ? "done" : "failed";
  }
  if (exit) {
    return (exit.exit_code ?? 0) === 0 ? "done" : "failed";
  }
  if (b.finished_at == null) return "running";
  return "done";
}

function clockHm(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function relDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  if (s > 0) return `${s}s`;
  return `${ms}ms`;
}
