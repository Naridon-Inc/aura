// Stack render of an agent PTY session. Each Block envelope renders as
// a BlockCard; we pair output→exit so the output card carries the
// terminal state dot (DONE / FAILED) instead of an extra exit pill.
//
// The backend already strips ANSI in the envelope's `text` field.
//
// The stack is WINDOWED. A long agent run leaves hundreds of cards behind,
// each holding a multi-KB <pre>, and the whole history used to stay mounted
// while new output streamed in. Only the cards near the viewport are in the
// DOM now; the rest are reserved space. Two consequences shape the code
// below: the pane's scrollbar belongs to AgentSurface (so windowing hangs
// off that ancestor via useScrollHost), and a card that scrolls out is
// unmounted — so its collapsed flag lives here, not inside the card.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAgentSession } from "../../lib/agentSessionStore";
import { useScrollHost } from "../../lib/useScrollHost";
import type { BlockEnvelope } from "../../lib/api";
import { BlockCard } from "./BlockCard";

type Props = { sessionId: string };

type Pair = { block: BlockEnvelope; exit: BlockEnvelope | null };

// `gap-2.5` between cards, `py-3` top and bottom. The virtualizer owns the
// vertical rhythm now that the cards are absolutely positioned, so these
// have to match the classes on the wrapper exactly.
const CARD_GAP = 10;
// A prompt card is short, an output card can be tall — this is only the
// first guess before each card measures itself.
const ESTIMATED_CARD_H = 120;

export function AgentBlocksView({ sessionId }: Props) {
  const { blocks } = useAgentSession(sessionId);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const host = useScrollHost(listRef);

  // Collapsed output cards, by block id. Held here because the windowed
  // list unmounts cards you scroll past — state inside the card would
  // quietly reset every time one came back.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleCollapsed = useCallback((blockId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);

  // Auto-scroll on new content. Watch the trailing block's text length so
  // a streaming output keeps the view pinned to the bottom while the
  // backend appends.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [blocks.length, blocks[blocks.length - 1]?.text.length]);

  const pairs = useMemo<Pair[]>(() => fold(blocks), [blocks]);

  const virtualizer = useVirtualizer({
    count: pairs.length,
    getScrollElement: () => host.element,
    estimateSize: () => ESTIMATED_CARD_H,
    scrollMargin: host.margin,
    gap: CARD_GAP,
    // The original flex column put a gap between the last card and the
    // trailing anchor; keep that so the scroll extent is unchanged.
    paddingEnd: CARD_GAP,
    overscan: 6,
  });

  if (pairs.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-text-4 text-sm">
          send a prompt to start the conversation
        </div>
      </div>
    );
  }

  // No scrolling ancestor (a short pane) → nothing to window against, so
  // render the lot rather than guess at a viewport.
  const items = host.element ? virtualizer.getVirtualItems() : null;

  return (
    <div className="px-4 py-3">
      {items ? (
        <div
          ref={listRef}
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((vi) => {
            const p = pairs[vi.index];
            return (
              <div
                key={p.block.id}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start - host.margin}px)`,
                }}
              >
                <BlockCard
                  block={p.block}
                  exit={p.exit}
                  focused={vi.index === pairs.length - 1}
                  collapsed={collapsedIds.has(p.block.id)}
                  onToggleCollapsed={toggleCollapsed}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div ref={listRef} className="flex flex-col gap-2.5">
          {pairs.map((p, idx) => (
            <BlockCard
              key={p.block.id}
              block={p.block}
              exit={p.exit}
              focused={idx === pairs.length - 1}
              collapsed={collapsedIds.has(p.block.id)}
              onToggleCollapsed={toggleCollapsed}
            />
          ))}
          {/* Inside the flex column so it still earns a trailing gap —
              the windowed branch buys the same 10px with `paddingEnd`. */}
          <div ref={endRef} />
        </div>
      )}
      {items ? <div ref={endRef} /> : null}
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
