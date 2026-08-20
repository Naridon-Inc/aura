// Stack render of an agent PTY session. Each Block envelope renders as
// a BlockCard; we pair output→exit so the output card carries the
// terminal state dot (DONE / FAILED) instead of an extra exit pill.
//
// The backend already strips ANSI in the envelope's `text` field.

import { useEffect, useMemo, useRef } from "react";
import { useAgentSession } from "../../lib/agentSessionStore";
import type { BlockEnvelope } from "../../lib/api";
import { BlockCard } from "./BlockCard";

type Props = { sessionId: string };

type Pair = { block: BlockEnvelope; exit: BlockEnvelope | null };

export function AgentBlocksView({ sessionId }: Props) {
  const { blocks } = useAgentSession(sessionId);
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content. Watch the trailing block's text length so
  // a streaming output keeps the view pinned to the bottom while the
  // backend appends.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [blocks.length, blocks[blocks.length - 1]?.text.length]);

  const pairs = useMemo<Pair[]>(() => fold(blocks), [blocks]);

  if (pairs.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-text-4 text-sm">
          send a prompt to start the conversation
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 flex flex-col gap-2.5">
      {pairs.map((p, idx) => (
        <BlockCard
          key={p.block.id}
          block={p.block}
          exit={p.exit}
          focused={idx === pairs.length - 1}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

// Fold raw envelopes into render units: each prompt/output stays on its
// own row; an `exit` envelope merges into the immediately preceding
// output so its exit_code colors that card's state dot. A trailing exit
// without an output (rare) renders standalone.
function fold(blocks: BlockEnvelope[]): Pair[] {
  const out: Pair[] = [];
  for (const b of blocks) {
    if (b.kind === "exit") {
      const last = out[out.length - 1];
      if (last && last.block.kind === "output" && !last.exit) {
        last.exit = b;
        continue;
      }
    }
    out.push({ block: b, exit: null });
  }
  return out;
}
