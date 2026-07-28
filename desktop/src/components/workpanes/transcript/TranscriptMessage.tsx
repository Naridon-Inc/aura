// One transcript item, rendered as an avatar-gutter chat message — the
// reference (entire.io) session-view shape. A fixed left gutter holds the
// author avatar (user circle for the human, the agent's brand mark for
// responses); the content sits to its right. Each message opens with a quiet
// header line — author · time — flush with the avatar top, so author and time
// read at a glance and the first line of content lines up with the avatar
// (no "message sits below the avatar" drift). The author label + the avatar +
// the bordered-card-vs-prose shape are the subtle who-said-this signal.
//
// Prompts are a bordered card; responses are plain markdown prose; tool calls
// are compact collapsible intermediate-step rows. A continuation/handover
// summary (a compaction block carrying the prior session's state, often with
// embedded code) is detected and drawn as its own collapsible, code-aware card
// — kept, not dropped, since it's the substrate for agent-to-agent handover.

import { memo, useMemo, useState } from "react";
import { MarkdownInline } from "../../MarkdownView";
import { Button } from "../../ui/button";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import {
  basename,
  editLines,
  fmtClock,
  isHandoverSummary,
  KIND_COLOR,
  readRange,
  relAge,
  summaryGist,
  type Item,
  type ToolShape,
} from "./model";

const RESULT_CAP = 4000;

// Memoized: a session transcript can hold hundreds of items, and the parent
// (SessionTranscript) re-renders on scroll, filter, and expand-all toggles.
// Every prop here is stable per item — `item` is a parsed transcript object,
// `now` is a mount-time constant (useMemo(Date.now, [])), `agentId` a string —
// so shallow memo keeps an unchanged row from re-rendering (and re-parsing its
// markdown) when something unrelated in the pane updates. `expandAll` flipping
// intentionally re-renders every row, which is the one case we want.
export const TranscriptMessage = memo(function TranscriptMessage({
  item,
  agentId,
  expandAll,
  now,
}: {
  item: Item;
  agentId: string;
  expandAll: boolean;
  now: number;
}) {
  switch (item.type) {
    case "prompt": {
      // A compaction / handover summary is a prompt by transport, but it's a
      // dense context dump, not a person typing — give it its own card.
      if (isHandoverSummary(item.text)) {
        return (
          <Row avatar={<HandoverAvatar />}>
            <HandoverCard text={item.text} ts={item.ts} now={now} expandAll={expandAll} />
          </Row>
        );
      }
      const calls =
        item.calls > 0 ? `${item.calls} call${item.calls === 1 ? "" : "s"}` : "";
      return (
        <Row
          avatar={<UserAvatar />}
          header={<MsgHeader author="You" ts={item.ts} now={now} tail={calls} />}
        >
          <div className="rounded-lg border border-line-soft bg-bg-1 px-3.5 py-2.5">
            <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-1">
              {item.text}
            </div>
          </div>
        </Row>
      );
    }
    case "response":
      return (
        <Row
          avatar={<AgentAvatar agentId={agentId} />}
          header={<MsgHeader author={agentDisplayLabel(agentId)} ts={item.ts} now={now} />}
        >
          <div className="text-[13px] leading-relaxed text-text-2">
            <MarkdownInline source={item.text} className="text-[13px] leading-relaxed" />
          </div>
        </Row>
      );
    case "tool":
      return (
        <Row avatar={null}>
          <ToolRow item={item} expandAll={expandAll} />
        </Row>
      );
    case "checkpoint":
      return (
        <Row avatar={null}>
          <div className="flex items-center gap-2 py-0.5 text-[11px] text-text-4">
            <span className="text-accent-green">◇</span>
            <span>Save point</span>
            <span className="font-mono text-text-3">{basename(item.file)}</span>
            <span className="h-px flex-1 bg-line-soft/60" />
          </div>
        </Row>
      );
    case "image":
      return (
        <Row avatar={null}>
          <img
            src={`data:${item.media};base64,${item.data}`}
            alt="Transcript attachment"
            className="max-h-[320px] max-w-full rounded-lg border border-line-soft"
          />
        </Row>
      );
    case "system": {
      const tone =
        item.tone === "warn"
          ? "text-amber"
          : item.tone === "err"
            ? "text-text-3"
            : "text-text-4";
      const glyph =
        item.sub === "result"
          ? "✓"
          : item.sub === "warning"
            ? "▲"
            : item.sub === "error"
              ? "✕"
              : "·";
      return (
        <Row avatar={null}>
          <div className={"flex items-center gap-2 py-0.5 text-[11px] " + tone}>
            <span className="shrink-0">{glyph}</span>
            <span className="truncate font-mono">{item.text}</span>
          </div>
        </Row>
      );
    }
  }
});

/** Avatar-gutter layout: fixed left column for the author mark, content to the
 *  right. The optional header (author · time) is the first line of the content
 *  column, so it sits flush with the avatar top — the fix for the message
 *  drifting below the avatar. A null avatar keeps the gutter blank so tool /
 *  system rows align under the message they belong to. */
function Row({
  avatar,
  header,
  children,
}: {
  avatar: React.ReactNode;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-6 shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        {header}
        {children}
      </div>
    </div>
  );
}

/** Quiet per-message header — author then time, with the calls count trailing
 *  on prompts. The author label is the subtle human-vs-agent signal (paired
 *  with the differing avatar and the card-vs-prose body). Time is the absolute
 *  clock; its title carries the relative age on hover. Both omit cleanly when
 *  the loader didn't capture a timestamp. */
function MsgHeader({
  author,
  ts,
  now,
  tail,
}: {
  author: string;
  ts: number;
  now: number;
  tail?: string;
}) {
  const time = fmtClock(ts);
  // h-6 matches the avatar tile so the author name + time vertically center
  // against the avatar — they read as one aligned line, not name-above-avatar.
  return (
    <div className="mb-0.5 flex h-6 items-center gap-1.5 text-[11px]">
      <span className="font-medium text-text-3">{author}</span>
      {time ? (
        <span className="text-text-4" title={relAge(ts, now)}>
          {time}
        </span>
      ) : null}
      {tail ? <span className="text-text-4">· {tail}</span> : null}
    </div>
  );
}

function AgentAvatar({ agentId }: { agentId: string }) {
  // Canonicalize first so a legacy id like "MCP Agent" resolves to its real
  // brand mark (Claude) instead of falling through to an "M" monogram — the
  // header already canonicalizes via agentDisplayLabel, so this keeps the
  // avatar and the name in agreement.
  const canonical = canonicalAgentId(agentId) || "claude";
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line-soft bg-bg-2">
      <AgentIcon agentId={canonical} size={15} />
    </span>
  );
}

function UserAvatar() {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line-soft bg-bg-2 text-text-4">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M3 13c0-2.4 2.2-4 5-4s5 1.6 5 4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** The handover summary's gutter mark — a layers/stack glyph in the app accent,
 *  signalling "this is carried-over context" rather than a chat turn. */
function HandoverAvatar() {
  return (
    <span
      className="flex h-6 w-6 items-center justify-center rounded-full border bg-bg-2"
      style={{
        color: "var(--color-accent)",
        borderColor: "color-mix(in srgb, var(--color-accent) 35%, var(--color-line))",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M8 2.5l5 2.5-5 2.5-5-2.5 5-2.5Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M3 8l5 2.5L13 8M3 11l5 2.5L13 11" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** A continuation / handover summary block, drawn as a collapsible, code-aware
 *  card. Collapsed by default (these run thousands of characters) with a
 *  one-line gist; expanded it renders the full markdown — fenced code included
 *  — inside a scroll cap. It is KEPT in the transcript, never dropped: this is
 *  the dense state an agent reads to resume where another left off. */
function HandoverCard({
  text,
  ts,
  now,
  expandAll,
}: {
  text: string;
  ts: number;
  now: number;
  expandAll: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open || expandAll;
  const time = fmtClock(ts);
  const gist = useMemo(() => summaryGist(text), [text]);
  const chars = text.length;
  const approxLines = useMemo(() => text.split("\n").length, [text]);

  return (
    <div
      className="overflow-hidden rounded-lg border bg-bg-1/50"
      style={{
        borderColor: "color-mix(in srgb, var(--color-accent) 28%, var(--color-line))",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={isOpen}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-bg-2/40"
      >
        <span
          className="mt-px flex h-4 w-4 shrink-0 items-center justify-center"
          style={{ color: "var(--color-accent)" }}
          aria-hidden
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2.5l5 2.5-5 2.5-5-2.5 5-2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M3 8l5 2.5L13 8M3 11l5 2.5L13 11" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[12.5px] font-semibold text-text-1">Session handover</span>
            <span className="text-[11px] text-text-4">continued from a previous session</span>
            {time ? (
              <span className="text-[11px] text-text-4" title={relAge(ts, now)}>
                · {time}
              </span>
            ) : null}
          </span>
          {!isOpen ? (
            <span className="mt-0.5 block truncate text-[12px] text-text-3">{gist}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10.5px] text-text-4">
            {approxLines} lines · {fmtChars(chars)}
          </span>
          <span className="text-text-4">
            <Chevron open={isOpen} />
          </span>
        </span>
      </button>
      {isOpen ? (
        <div className="border-t border-line-soft/60 bg-bg-0/40">
          <div className="max-h-[520px] overflow-auto px-3.5 py-3 text-[12.5px] leading-relaxed text-text-2">
            <MarkdownInline source={text} className="text-[12.5px] leading-relaxed" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Compact char count for the handover card meta — "12.3k", "1.2M". */
function fmtChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}

type ToolStatus = "ok" | "error" | "none";

const DIFF_CAP = 16; // diff lines per side before "… N more"
const TERM_CAP = 2400; // terminal-output chars
const PREVIEW_CAP = 1600; // read / search / fetch preview chars

/** A tool call, drawn as the shape that reads best for its kind: a collapsible
 *  row (icon · verb · subject · right-meta) that expands into a tailored body —
 *  a diff for edits, a terminal for shell runs, a result list for searches, a
 *  prose summary for fetches, a checklist for plans, raw input/result for the
 *  long tail. The icon tint and right-meta are the at-a-glance signal; the body
 *  is the detail on demand. */
function ToolRow({
  item,
  expandAll,
}: {
  item: Item & { type: "tool" };
  expandAll: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open || expandAll;
  const v = item.view;
  const status: ToolStatus = !item.result
    ? "none"
    : item.result.isError
      ? "error"
      : "ok";
  const tint = status === "error" ? "var(--color-red)" : KIND_COLOR[v.kind];

  return (
    <div className="overflow-hidden rounded-md border border-line-soft/70 bg-bg-1/40">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-bg-2/50"
        aria-expanded={isOpen}
      >
        <span
          className="flex h-[15px] w-[15px] shrink-0 items-center justify-center"
          style={{ color: tint }}
          aria-hidden
        >
          <ToolGlyph shape={v.shape} />
        </span>
        <span className="shrink-0 text-[12px] font-medium text-text-2">{v.verb}</span>
        <span
          className={
            "min-w-0 flex-1 truncate text-text-3 " +
            (v.mono ? "font-mono text-[11.5px]" : "text-[12px]")
          }
        >
          {v.subject}
        </span>
        <ToolRightMeta item={item} status={status} />
        <span className="shrink-0 text-text-4">
          <Chevron open={isOpen} />
        </span>
      </button>
      {isOpen ? (
        <div className="border-t border-line-soft/60">
          <ToolBody item={item} status={status} />
        </div>
      ) : null}
    </div>
  );
}

/** Right-aligned at-a-glance signal on the collapsed row: edit churn (+a −d),
 *  a read's line window, or a shell run's exit status. Other shapes carry their
 *  signal in the icon/subject and show nothing here. */
function ToolRightMeta({
  item,
  status,
}: {
  item: Item & { type: "tool" };
  status: ToolStatus;
}) {
  const { shape } = item.view;

  if (shape === "edit" || shape === "write") {
    const el = editLines(item.name, item.input);
    if (!el || (!el.added.length && !el.removed.length)) return null;
    return (
      <span className="shrink-0 font-mono text-[10.5px]">
        {el.added.length ? (
          <span className="text-accent-green">+{el.added.length}</span>
        ) : null}
        {el.added.length && el.removed.length ? " " : null}
        {el.removed.length ? (
          <span style={{ color: "var(--color-red)" }}>−{el.removed.length}</span>
        ) : null}
      </span>
    );
  }

  if (shape === "read") {
    const r = readRange(item.input);
    return r ? (
      <span className="shrink-0 font-mono text-[10.5px] text-text-4">{r}</span>
    ) : null;
  }

  if (shape === "bash" && status !== "none") {
    const c = status === "error" ? "var(--color-red)" : "var(--color-accent-green)";
    return (
      <span
        className="flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium"
        style={{
          color: c,
          borderColor: `color-mix(in srgb, ${c} 30%, transparent)`,
          background: `color-mix(in srgb, ${c} 12%, transparent)`,
        }}
      >
        {status === "error" ? <CrossMini /> : <CheckMini />}
        {status === "error" ? "failed" : "exit 0"}
      </span>
    );
  }

  return null;
}

function ToolBody({
  item,
  status,
}: {
  item: Item & { type: "tool" };
  status: ToolStatus;
}) {
  switch (item.view.shape) {
    case "edit":
    case "write":
      return <DiffBody item={item} />;
    case "bash":
      return <TerminalBody item={item} />;
    case "web_fetch":
      return <ProseBody item={item} empty="No page content captured." />;
    case "web_search":
      return <ProseBody item={item} empty="No results captured." />;
    case "read":
      return <MonoBody item={item} empty="No preview captured." />;
    case "search":
      return <MonoBody item={item} empty="No matches captured." />;
    case "todo":
      return <TodoBody item={item} />;
    default:
      return <GenericBody item={item} status={status} />;
  }
}

// ── shape bodies ─────────────────────────────────────────────────────

function DiffBody({ item }: { item: Item & { type: "tool" } }) {
  const el = editLines(item.name, item.input);
  if (!el || (!el.added.length && !el.removed.length)) {
    return <Empty text="No diff captured." />;
  }
  const rem = el.removed.slice(0, DIFF_CAP);
  const add = el.added.slice(0, DIFF_CAP);
  return (
    <div className="py-1.5 font-mono text-[11px] leading-[1.65]">
      {rem.map((l, i) => (
        <DiffLine key={`r${i}`} sign="−" text={l} tone="del" />
      ))}
      {el.removed.length > rem.length ? (
        <DiffMore n={el.removed.length - rem.length} />
      ) : null}
      {add.map((l, i) => (
        <DiffLine key={`a${i}`} sign="+" text={l} tone="add" />
      ))}
      {el.added.length > add.length ? (
        <DiffMore n={el.added.length - add.length} />
      ) : null}
    </div>
  );
}

function DiffLine({
  sign,
  text,
  tone,
}: {
  sign: string;
  text: string;
  tone: "add" | "del";
}) {
  const c = tone === "add" ? "var(--color-accent-green)" : "var(--color-red)";
  return (
    <div
      className="flex px-2.5"
      style={{ background: `color-mix(in srgb, ${c} 10%, transparent)`, color: c }}
    >
      <span className="w-3.5 shrink-0 select-none opacity-80">{sign}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {text || " "}
      </span>
    </div>
  );
}

function DiffMore({ n }: { n: number }) {
  return (
    <div className="px-2.5 pl-6 text-[10.5px] text-text-4">
      … {n} more line{n === 1 ? "" : "s"}
    </div>
  );
}

function TerminalBody({ item }: { item: Item & { type: "tool" } }) {
  const cmd = strField(item.input, "command", "cmd") || item.view.subject;
  const out = item.result ? capText(item.result.content, TERM_CAP) : "";
  return (
    <div className="px-2.5 py-2">
      <div className="rounded-md border border-line-soft bg-bg-1 px-3 py-2 font-mono text-[11px] leading-[1.6]">
        <div className="whitespace-pre-wrap break-words text-text-2">
          <span className="mr-2 select-none text-accent-green">$</span>
          {cmd}
        </div>
        {out.trim() ? (
          <div className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap break-words text-text-4">
            {out}
          </div>
        ) : (
          <div className="mt-1 text-text-5">— no output —</div>
        )}
      </div>
    </div>
  );
}

/** Markdown-rendered prose for fetched pages / search results (these come back
 *  as readable text, not code). */
function ProseBody({
  item,
  empty,
}: {
  item: Item & { type: "tool" };
  empty: string;
}) {
  const txt = item.result?.content ?? "";
  if (!txt.trim()) return <Empty text={empty} />;
  const shown = txt.length > PREVIEW_CAP ? `${txt.slice(0, PREVIEW_CAP)} …` : txt;
  return (
    <div className="max-h-[300px] overflow-auto px-3 py-2 text-[12px] leading-relaxed text-text-3">
      <MarkdownInline source={shown} className="text-[12px] leading-relaxed" />
    </div>
  );
}

function MonoBody({
  item,
  empty,
}: {
  item: Item & { type: "tool" };
  empty: string;
}) {
  const txt = item.result ? capText(item.result.content, PREVIEW_CAP) : "";
  if (!txt.trim()) return <Empty text={empty} />;
  return (
    <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-[1.55] text-text-3">
      {txt}
    </pre>
  );
}

function TodoBody({ item }: { item: Item & { type: "tool" } }) {
  const obj = (item.input && typeof item.input === "object" ? item.input : {}) as Record<
    string,
    unknown
  >;
  const todos = Array.isArray(obj.todos) ? (obj.todos as unknown[]) : [];
  if (!todos.length) return <Empty text="No items." />;
  return (
    <ul className="flex flex-col gap-1 px-3 py-2 text-[12px]">
      {todos.map((t, i) => {
        const to = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        const st = typeof to.status === "string" ? to.status : "pending";
        const content =
          typeof to.content === "string"
            ? to.content
            : typeof to.task === "string"
              ? to.task
              : "";
        return (
          <li key={i} className="flex items-start gap-2">
            <TodoDot status={st} />
            <span
              className={
                st === "completed"
                  ? "text-text-4 line-through"
                  : st === "in_progress"
                    ? "text-text-1"
                    : "text-text-3"
              }
            >
              {content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The long tail (MCP tools, delegated tasks, anything unmapped). A delegated
 *  agent's result is itself a markdown report (headings, lists, fenced code),
 *  so we render it human-readable by default with a Raw toggle back to the
 *  verbatim text — groundwork for the richer Manager chat surface where these
 *  results are first-class. Input stays raw JSON (it's a structured call), and
 *  an error result stays raw (it's rarely markdown). */
function GenericBody({
  item,
  status,
}: {
  item: Item & { type: "tool" };
  status: ToolStatus;
}) {
  const inputJson = useMemo(() => safeJson(item.input), [item.input]);
  const hasInput = inputJson.trim() && inputJson.trim() !== "{}";
  const result = item.result?.content ?? "";
  const isErr = status === "error";
  const capped = capText(result, RESULT_CAP);
  const [raw, setRaw] = useState(false);
  const showRaw = isErr || raw;
  return (
    <div className="px-2.5 py-2">
      {hasInput ? (
        <>
          <Label>Input</Label>
          <pre className="mb-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2/60 px-2 py-1.5 font-mono text-[11px] text-text-2">
            {inputJson}
          </pre>
        </>
      ) : null}
      {item.result ? (
        <>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-text-4">
              {isErr ? "Error" : "Result"}
            </span>
            {!isErr && result.trim() ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setRaw((r) => !r)}
                className="text-[10px] text-text-4 hover:text-text-2"
              >
                {raw ? "Rendered" : "Raw"}
              </Button>
            ) : null}
          </div>
          {showRaw ? (
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2/60 px-2 py-1.5 font-mono text-[11px] text-text-3">
              {capped}
            </pre>
          ) : (
            <div className="max-h-[440px] overflow-auto rounded bg-bg-2/40 px-3 py-2 text-[12.5px] leading-relaxed text-text-2">
              <MarkdownInline source={capped} className="text-[12.5px] leading-relaxed" />
            </div>
          )}
        </>
      ) : (
        <Empty text="No result captured." />
      )}
    </div>
  );
}

// ── small parts ──────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] uppercase tracking-wide text-text-4">{children}</div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-2.5 py-2 text-[11px] text-text-4">{text}</div>;
}

function TodoDot({ status }: { status: string }) {
  const done = status === "completed";
  const prog = status === "in_progress";
  const c = done
    ? "var(--color-accent-green)"
    : prog
      ? "var(--color-accent)"
      : "var(--color-text-4)";
  return (
    <span
      className="mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center rounded-full border"
      style={{ borderColor: c, background: done ? c : "transparent" }}
      aria-hidden
    >
      {done ? (
        <svg width="7" height="7" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 6.5l2 2 5-5"
            stroke="var(--color-bg-0)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : prog ? (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      ) : null}
    </span>
  );
}

function CheckMini() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2.5 6.5l2 2 5-5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossMini() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Per-shape line glyph — the at-a-glance "what kind of step is this". */
function ToolGlyph({ shape }: { shape: ToolShape }) {
  switch (shape) {
    case "edit":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M9.5 3.2l3.3 3.3-6.6 6.6-3.6.6.6-3.6 6.3-6.3Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "write":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M4 2.5h5l3 3V13a.8.8 0 0 1-.8.8H4A.8.8 0 0 1 3.2 13V3.3A.8.8 0 0 1 4 2.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M9 2.5V5.3h3M6 9h4M6 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "read":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M4 2.5h5l3 3V13a.8.8 0 0 1-.8.8H4A.8.8 0 0 1 3.2 13V3.3A.8.8 0 0 1 4 2.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M9 2.5V5.3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "bash":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M5 6.5L7 8.3 5 10M8.4 10h2.6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "web_fetch":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M2.6 8h10.8M8 2.6c1.7 1.6 1.7 9.2 0 10.8M8 2.6c-1.7 1.6-1.7 9.2 0 10.8"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        </svg>
      );
    case "web_search":
    case "search":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M10.2 10.2L13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "todo":
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M3 4.5l1.4 1.4L7 3.4M3 11l1.4 1.4L7 9.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.5 5h3.5M9.5 11h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M9.5 3.2a2.6 2.6 0 0 0 3.3 3.3l-2 2 .9.9-3.4 3.4a1.3 1.3 0 0 1-1.8-1.8l3.4-3.4-.9-.9 2-2Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

// ── tiny pure helpers ────────────────────────────────────────────────

function strField(input: unknown, ...keys: string[]): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  return "";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function capText(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… (${s.length - cap} more chars)` : s;
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 10 10"
      className={`transition-transform ${open ? "" : "-rotate-90"}`}
      aria-hidden="true"
    >
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}
