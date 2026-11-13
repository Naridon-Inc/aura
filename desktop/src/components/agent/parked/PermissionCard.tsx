// The card that answers a permission prompt.
//
// When an agent runs in chat mode it has no terminal to draw its own
// prompt in, so claude asks through Aura's MCP bridge instead: the request
// crosses a socket, parks a thread, and waits. There is no timeout on that
// wait. Until somebody clicks, the agent is simply stopped — no error, no
// output, no explanation. This card is the other end of that wait.
//
// Three answers, because the question genuinely has three:
//   Allow once               — yes, this once
//   Allow for this session   — yes, and stop asking for this tool on this
//                              agent until Aura quits
//   Deny                     — no (it carries on, refused)
//
// Deny is one click, not two. Denying is the safe answer, and making the
// safe answer the slow one is backwards — the gate card's confirm step
// exists because denying *there* strands a half-finished operation, which
// isn't true here.

import { useCallback, useState, type KeyboardEvent } from "react";

import type { PermissionPrompt } from "../../../lib/api";
import { decidePrompt } from "../../../lib/permissionStore";
import { getChannelMeta } from "../../../lib/agentStreamStore";
import { PermissionRequest, type PermissionChoice } from "../../ui/chat-decisions";
import { ParkedLine, ParkedQueue, ParkedShell } from "./dock";
import { describeToolCall, type ToolKind } from "./toolCall";
import { titleCaseName } from "@shared/textCase";

type Decision = "allow" | "allow_always" | "deny";

// The card's mark turns to caution for anything that changes a file, runs a
// command or leaves the machine; it stays plain for the read-only ones. Never
// the danger tone: that means "we checked this and it's risky", and here we
// haven't checked anything — claiming danger we can't prove would only teach
// people to click through it.
const CAUTION: Record<ToolKind, "warn" | undefined> = {
  reads: undefined,
  changes: "warn",
  runs: "warn",
  network: "warn",
  connection: "warn",
  other: undefined,
};

/** "Claude · New Git" — only worth rendering when we know both halves. */
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
  const subject = subjectLine(prompt.channel);

  const [busy, setBusy] = useState(false);

  const answer = useCallback(
    async (decision: Decision) => {
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

  // The request answers to its number keys once it has focus; Esc is Deny,
  // the safe answer, from anywhere on the card.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (busy || e.key !== "Escape") return;
      e.preventDefault();
      void answer("deny");
    },
    [busy, answer],
  );

  const choices: PermissionChoice[] = [
    { id: "allow", label: busy ? "Sending…" : "Allow once", primary: true },
    // Absent for a capability prompt. That question is about one specific
    // act — this symbol, this teammate's file, this piece of work — and
    // Aura's gate deliberately refuses to remember the answer, so offering
    // it would promise something that doesn't happen. A standing yes lives
    // in the project's `[authority]` rules instead, where it lands in a diff.
    ...(facet.alwaysAllowable === false
      ? []
      : [
          {
            id: "allow_always",
            label: "Allow for this session",
            // The real scope is narrower still (this agent, this project);
            // the line errs broad, so nobody reads it as smaller than it is.
            description: `Stops asking about ${prompt.tool_name} until you quit Aura`,
          },
        ]),
    { id: "deny", label: "Deny" },
  ];

  return (
    <ParkedShell label={facet.title} tone={CAUTION[facet.kind]} onKeyDown={onKeyDown}>
      <PermissionRequest
        title={facet.title}
        agent={<ParkedLine lead={subject} since={prompt.ts} />}
        description={facet.body}
        // The verbatim half. The sentence above is a summary and could be
        // wrong about intent; this is the actual thing being agreed to, so
        // it is never trimmed or prettified beyond wrapping.
        command={facet.detail?.value}
        choices={choices}
        pending={busy}
        onChoose={(choice) => void answer(choice as Decision)}
      >
        <ParkedQueue pending={pending} />
      </PermissionRequest>
    </ParkedShell>
  );
}
