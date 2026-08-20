// Card render of a single Block envelope. Mirrors the layout of
// aura-term/src/ui/block_card.rs:
//   header  — 7px state dot · STATE label · kind · anchor · actor … ts · dur
//   body    — intent summary (when present) + payload row + captured output
//   border  — tinted by state, brighter when focused
//
// The shell-side BlockEnvelope is simpler than aura-blocks::Block (3 kinds
// only: prompt / output / exit). We synthesise a BlockState from the kind
// + finished_at + exit_code so the visual language matches the term build.
//
// Each card carries a stable Block id (`b.id`) and exposes:
//   • collapse / expand (output cards) — saves vertical space when triaging
//   • copy as markdown — fenced code-block of the captured output
//   • re-run (prompt cards) — dispatches `aura:rerun-prompt { sessionId, text }`
// The parent AgentSurface routes the re-run event to its Composer.

import { useState } from "react";
import type { BlockEnvelope } from "../../lib/api";

type BlockState = "running" | "done" | "failed";

type Props = {
  block: BlockEnvelope;
  /** Highlight border with the state color. Single-pane views always
   *  pass true so the active card stays prominent. */
  focused?: boolean;
  /** Optional companion exit envelope so an output card can render its
   *  exit pill inline (matches the term layout) without an extra row. */
  exit?: BlockEnvelope | null;
};

export function BlockCard({ block, focused = false, exit = null }: Props) {
  const state = synthState(block, exit);
  const tone = stateTone(state);
  const label = stateLabel(state);
  const failed = state === "failed";
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const startedMs = block.started_at * 1000;
  const finishedMs = (block.finished_at ?? block.started_at) * 1000;
  const dur = relDuration(Math.max(0, finishedMs - startedMs));
  const ts = clockHm(startedMs);

  const { prefix, prefixColor, payload } = payloadRow(block);
  const shortId = block.id ? block.id.slice(0, 6) : null;

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

  function rerun() {
    if (block.kind !== "prompt" || !block.text) return;
    window.dispatchEvent(
      new CustomEvent("aura:rerun-prompt", {
        detail: { sessionId: block.session_id, text: block.text },
      }),
    );
  }

  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2.5 transition-colors group/block"
      style={{
        background: failed ? "color-mix(in srgb, var(--color-red) 10%, var(--color-bg-3))" : "var(--color-bg-3)",
        border: `1px solid ${focused ? tone : "var(--color-line)"}`,
      }}
    >
      <div className="section-label flex items-center gap-2">
        <span
          className="inline-block rounded-full"
          style={{ background: tone, width: 7, height: 7 }}
        />
        <span style={{ color: tone }} className="font-medium">{label}</span>
        <span className="text-text-3">{block.kind}</span>
        {block.kind === "exit" && block.exit_code != null && (
          <span className="text-text-3 tabular-nums">stopped with error {block.exit_code}</span>
        )}
        {shortId && (
          <span
            className="text-text-4 font-mono normal-case px-1.5 py-px rounded bg-bg-1/60 border border-line-soft"
            title={`Block id ${block.id}`}
          >
            #{shortId}
          </span>
        )}
        <span className="ml-auto text-text-3 font-mono tabular-nums normal-case">{ts}</span>
        <span className="text-text-3 font-mono tabular-nums normal-case">· {dur}</span>
        <BlockActions
          canCollapse={block.kind === "output" && !!block.text}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          canRerun={block.kind === "prompt" && !!block.text}
          onRerun={rerun}
          onCopy={copyAsMarkdown}
          copied={copied}
        />
      </div>

      {payload && (
        <div className="flex items-start gap-2.5 font-mono">
          <span style={{ color: prefixColor }} className="text-base">
            {prefix}
          </span>
          <span className="text-text-1 text-base whitespace-pre-wrap break-words flex-1 leading-relaxed">
            {payload}
          </span>
        </div>
      )}

      {block.kind === "output" && !collapsed && (
        <OutputView block={block} state={state} />
      )}
      {block.kind === "output" && collapsed && block.text && (
        <div className="text-text-4 text-xs font-mono italic">
          {linesOf(block.text)} lines collapsed · click ▸ to expand
        </div>
      )}
    </div>
  );
}

function BlockActions({
  canCollapse,
  collapsed,
  onToggleCollapsed,
  canRerun,
  onRerun,
  onCopy,
  copied,
}: {
  canCollapse: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  canRerun: boolean;
  onRerun: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <span className="ml-2 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/block:opacity-100 normal-case tracking-normal">
      {canCollapse && (
        <ActionButton
          title={collapsed ? "Expand output" : "Collapse output"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? "▸" : "▾"}
        </ActionButton>
      )}
      {canRerun && (
        <ActionButton title="Re-run this prompt" onClick={onRerun}>
          ↻
        </ActionButton>
      )}
      <ActionButton title="Copy as markdown" onClick={onCopy}>
        {copied ? "✓" : "⎘"}
      </ActionButton>
    </span>
  );
}

function ActionButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="text-text-4 hover:text-text-1 hover:bg-state-hover rounded px-1.5 py-0.5 text-xs leading-none"
    >
      {children}
    </button>
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
    if (state === "running") {
      return (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-sm text-xs font-mono"
          style={{
            background: "var(--color-bg-0)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          <span
            className="inline-block rounded-full animate-pulse"
            style={{ background: "var(--color-amber)", width: 6, height: 6 }}
          />
          <span className="text-text-3">streaming…</span>
        </div>
      );
    }
    return null;
  }
  return (
    <pre
      className="rounded-sm px-3 py-2 text-sm font-mono leading-relaxed text-text-1 whitespace-pre-wrap break-words overflow-auto max-h-[420px]"
      style={{
        background: "var(--color-bg-0)",
        border: "1px solid var(--color-line-soft)",
      }}
    >
      {block.text}
      {state === "running" && <span className="text-text-4">▌</span>}
    </pre>
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

function stateLabel(s: BlockState): string {
  switch (s) {
    case "running":
      return "RUNNING";
    case "done":
      return "DONE";
    case "failed":
      return "FAILED";
  }
}

function stateTone(s: BlockState): string {
  switch (s) {
    case "running":
      return "var(--color-amber)";
    case "done":
      return "var(--color-accent-green)";
    case "failed":
      return "var(--color-red)";
  }
}

function payloadRow(b: BlockEnvelope): {
  prefix: string;
  prefixColor: string;
  payload: string | null;
} {
  if (b.kind === "prompt") {
    return {
      prefix: "›",
      prefixColor: "var(--color-violet)",
      payload: b.text || null,
    };
  }
  if (b.kind === "exit") {
    const ok = (b.exit_code ?? 0) === 0;
    return {
      prefix: ok ? "✓" : "✗",
      prefixColor: ok ? "var(--color-accent-green)" : "var(--color-red)",
      payload: ok
      ? "Finished without errors"
      : `Stopped with error ${b.exit_code ?? 0}`,
    };
  }
  // output — payload row only renders when there's a one-line summary
  // worth showing above the captured output. We keep it empty so the
  // <pre> below carries the bytes.
  return { prefix: "$", prefixColor: "var(--color-accent-green)", payload: null };
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
