// The card that answers a permission prompt.
//
// When an agent runs in chat mode it has no terminal to draw its own
// prompt in, so claude asks through Aura's MCP bridge instead: the request
// crosses a socket, parks a thread, and waits. There is no timeout on that
// wait. Until somebody clicks, the agent is simply stopped — no error, no
// output, no explanation. This card is the other end of that wait.
//
// Three answers, because the question genuinely has three:
//   Deny          — no, and tell the agent why not (it carries on, refused)
//   Allow         — yes, this once
//   Always allow  — yes, and stop asking for this tool on this agent
//
// Deny is one click, not two. Denying is the safe answer, and making the
// safe answer the slow one is backwards — the gate card's confirm step
// exists because denying *there* strands a half-finished operation, which
// isn't true here.

import { useCallback, useState } from "react";
import { Ban, Check, Infinity as InfinityIcon } from "lucide-react";

import type { PermissionPrompt } from "../../../lib/api";
import { decidePrompt } from "../../../lib/permissionStore";
import { getChannelMeta } from "../../../lib/agentStreamStore";
import { Button } from "../../ui/button";
import { ParkedHeader, ParkedShell } from "./dock";
import { describeToolCall, KIND_LABEL, type ToolKind } from "./toolCall";
import { titleCaseName } from "../../../lib/textCase";

// Chip tone by what kind of thing the tool does. Amber for anything that
// changes a file, runs a command or leaves the machine; neutral for the
// read-only ones. Red is deliberately unused: red means "we checked this
// and it's risky", and here we haven't checked anything — claiming danger
// we can't prove would only teach people to click through it.
const KIND_TONE: Record<ToolKind, { text: string; bg: string; border: string; dot: string }> = {
  reads: { text: "text-text-2", bg: "bg-bg-2", border: "border-line", dot: "bg-text-3" },
  changes: { text: "text-amber", bg: "bg-amber/10", border: "border-amber/40", dot: "bg-amber" },
  runs: { text: "text-amber", bg: "bg-amber/10", border: "border-amber/40", dot: "bg-amber" },
  network: { text: "text-amber", bg: "bg-amber/10", border: "border-amber/40", dot: "bg-amber" },
  connection: { text: "text-amber", bg: "bg-amber/10", border: "border-amber/40", dot: "bg-amber" },
  other: { text: "text-text-2", bg: "bg-bg-2", border: "border-line", dot: "bg-text-3" },
};

/** "claude · New Git" — only worth rendering when we know both halves. */
function subjectLine(channel: string): string | null {
  const { agentId, repoRoot } = getChannelMeta(channel);
  if (!agentId) return null;
  const agent = titleCaseName(agentId);
  if (!repoRoot) return agent;
  const project = repoRoot.split("/").filter(Boolean).pop();
  return project ? `${agent} · ${project}` : agent;
}

export function PermissionCard({
  prompt,
  pending,
}: {
  prompt: PermissionPrompt;
  /** How many more agents are queued behind this one. */
  pending: number;
}) {
  const facet = describeToolCall(prompt.tool_name, prompt.input);
  const tone = KIND_TONE[facet.kind];
  const subject = subjectLine(prompt.channel);

  const [busy, setBusy] = useState(false);

  const answer = useCallback(
    async (decision: "allow" | "allow_always" | "deny") => {
      if (busy) return;
      setBusy(true);
      // `decidePrompt` drops the prompt from the store optimistically —
      // which unmounts this card — and swallows a failed round-trip. So
      // there is no error branch to hold the card open for: the only way
      // it resolves nothing is a slot that already vanished, meaning the
      // agent stopped waiting anyway.
      await decidePrompt(prompt.prompt_id, decision);
    },
    [busy, prompt.prompt_id],
  );

  // Enter = Allow, Esc = Deny — the same keymap as the gate card, and
  // deliberately no shortcut for "always". A standing permission should
  // cost a deliberate click, not a keystroke you can hit by reflex.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void answer("allow");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        void answer("deny");
      }
    },
    [busy, answer],
  );

  return (
    <ParkedShell label={facet.title} onKeyDown={onKeyDown}>
      <ParkedHeader
        since={prompt.ts}
        subject={subject}
        chip={
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.border} ${tone.text}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
            {KIND_LABEL[facet.kind]}
          </span>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 space-y-3">
        <h2 className="text-text-1 text-md font-medium leading-snug">
          {facet.title}
        </h2>

        <p className="text-text-2 text-base leading-relaxed">{facet.body}</p>

        {/* The verbatim half. Our sentence above is a summary and could be
            wrong about intent; this is the actual thing being agreed to, so
            it is never trimmed or prettified beyond wrapping. */}
        {facet.detail && (
          <div>
            <div className="section-label mb-1">
              {facet.detail.label}
            </div>
            {facet.detail.mono ? (
              // `break-words`, not `break-all`: a flag like `--frozen-lockfile`
              // should wrap to the next line whole rather than be sliced down
              // the middle, which is how you misread a command you're being
              // asked to approve. Anything genuinely too long for one line
              // still breaks.
              <code className="block max-h-[220px] overflow-auto bg-bg-2 border border-line-soft rounded px-2.5 py-1.5 text-sm font-mono text-text-1 whitespace-pre-wrap break-words">
                {facet.detail.value}
              </code>
            ) : (
              <p className="text-text-1 text-base leading-relaxed break-words">
                {facet.detail.value}
              </p>
            )}
          </div>
        )}

        <p className="text-text-4 text-xs leading-snug">
          Your agent asked before doing this and is waiting for your answer.
          Nothing happens until you pick one.
        </p>
      </div>

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
            onClick={() => void answer("deny")}
            disabled={busy}
            // Deny hovers red rather than to the neutral wash every other
            // button uses. This is the one control where the answer is
            // irreversible in the direction that matters, and the colour
            // is what stops a reflex click landing on the wrong one.
            className="text-text-2 gap-1 hover:bg-red/10 hover:text-red hover:border-red/40"
          >
            <Ban size={13} />
            Deny
          </Button>
          {/* Absent for a capability prompt. That question is about one
              specific act — this symbol, this teammate's file, this piece
              of work — and Aura's gate deliberately refuses to remember
              the answer, so offering the button would promise something
              that doesn't happen. A standing yes lives in the project's
              `[authority]` rules instead, where it lands in a diff. */}
          {facet.alwaysAllowable !== false && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void answer("allow_always")}
              disabled={busy}
              className="text-text-2 gap-1"
              // The scope is narrow and worth stating exactly — this is a
              // security decision, and "always" is the word people fear.
              title={`Stop asking about ${prompt.tool_name} for this agent in this project, until you quit Aura`}
            >
              <InfinityIcon size={13} />
              Always allow
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => void answer("allow")}
            disabled={busy}
            className="bg-accent-green text-bg-deep hover:opacity-90 gap-1"
          >
            <Check size={13} />
            {busy ? "Sending…" : "Allow"}
          </Button>
        </div>
      </footer>
    </ParkedShell>
  );
}
