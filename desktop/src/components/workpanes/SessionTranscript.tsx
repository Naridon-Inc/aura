// SessionTranscript — the session's real JSONL read as the reference session
// view (entire.io): an avatar-gutter chat in the middle, a FILTERS rail on the
// right. User prompts are bordered cards with an age · calls meta line; the
// agent's responses are plain markdown under its brand mark; tool calls are
// compact intermediate-step rows. The rail toggles each category (and folds
// tool calls into their kinds) with live counts.
//
// HONESTY RULE: every item is a real event from the session file. Nothing is
// synthesised; an absent transcript says so plainly. The rail counts are
// derived from the same items the stream renders, so the numbers always agree.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type StreamEvent } from "../../lib/api";
import {
  loadSessionEvents,
  type TranscriptSource,
} from "../../lib/sessionDataCache";
import { TranscriptMessage } from "./transcript/TranscriptMessage";
import { FiltersPanel } from "./transcript/FiltersPanel";
import { Button } from "../ui/button";
import {
  countItems,
  filterKeyOf,
  foldItems,
  groupTurns,
  isHandoverSummary,
  type FilterKey,
} from "./transcript/model";

const NARROW_PX = 720;
const TOOL_KEYS: FilterKey[] = ["edit", "bash", "read", "other"];
type Order = "newest" | "oldest";

export function SessionTranscript({
  filePath,
  agentId = "claude",
  source = "claude",
}: {
  /** For a Claude session this is the JSONL `file_path`; for a native Aura
   *  chat (`source="manager"`) it is the manager session id. */
  filePath: string;
  agentId?: string;
  /** Which on-disk store to replay from. Defaults to a Claude JSONL read. */
  source?: TranscriptSource;
}) {
  const [events, setEvents] = useState<StreamEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [enabled, setEnabled] = useState<Set<FilterKey>>(
    () => new Set(["prompt", "response", "edit", "bash", "read", "other", "checkpoint"]),
  );
  const [showHidden, setShowHidden] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  // Reading order. Default newest-first — the user opens a session to see where
  // it left off, so the latest turn leads. Reversal is at the TURN level (see
  // groupTurns) so a turn still reads prompt → tools → response internally.
  const [order, setOrder] = useState<Order>("newest");

  // Captured once per mount so relative ages are stable across re-renders.
  const now = useMemo(() => Date.now(), []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setEvents(null);
    loadSessionEvents(filePath, 1000, source)
      .then((evts) => {
        if (alive) setEvents(Array.isArray(evts) ? evts : []);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filePath, source]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setNarrow(e.contentRect.width < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items = useMemo(() => (events ? foldItems(events) : []), [events]);
  const counts = useMemo(() => countItems(items), [items]);

  const visible = useMemo(
    () =>
      items.filter((it) => {
        if (it.type === "system") return showHidden;
        const k = filterKeyOf(it);
        return k ? enabled.has(k) : true;
      }),
    [items, enabled, showHidden],
  );

  // Turn-grouped reorder: flip whole turns for newest-first, never the raw
  // items, so causality inside a turn (a tool result still follows its call)
  // survives the flip. Kept as groups (not flattened) so each turn's user
  // prompt can stick to the top while its own activity scrolls past.
  const orderedGroups = useMemo(() => {
    const groups = groupTurns(visible);
    if (order === "newest") groups.reverse();
    return groups;
  }, [visible, order]);

  function toggle(k: FilterKey) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toolsAll(on: boolean) {
    setEnabled((prev) => {
      const next = new Set(prev);
      for (const k of TOOL_KEYS) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  const jumpLatest = () => {
    // Latest lives at the top when newest-first, at the bottom otherwise.
    if (order === "newest") {
      topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    } else {
      endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    setPanelOpen(false);
  };

  const panel = (
    <FiltersPanel
      counts={counts}
      enabled={enabled}
      onToggle={toggle}
      onToolsAll={toolsAll}
      showHidden={showHidden}
      onShowHidden={() => setShowHidden((v) => !v)}
      expandAll={expandAll}
      onExpandAll={() => setExpandAll((v) => !v)}
      newestFirst={order === "newest"}
      onToggleOrder={() => setOrder((o) => (o === "newest" ? "oldest" : "newest"))}
      onJumpLatest={jumpLatest}
    />
  );

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 w-full">
      {/* timeline */}
      <div className="flex min-h-0 flex-1 flex-col">
        {narrow ? (
          <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-3 py-1.5">
            <span className="text-[11px] text-text-4">
              {visible.length} of {items.length} steps
            </span>
            <Button
              variant="outline"
              size="xs"
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className="text-[11px] text-text-3 hover:text-text-1"
            >
              Filters
            </Button>
          </div>
        ) : null}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-4 text-[12px] text-text-4">Loading…</div>
          ) : error ? (
            <div className="px-4 py-4 text-[12px] text-text-3">
              Couldn&rsquo;t load this session.
              <span className="mt-1 block font-mono text-[11px] text-text-4">{error}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-4">
              Nothing was recorded for this run.
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-4">
              Everything&rsquo;s hidden — turn a filter back on, on the right.
            </div>
          ) : (
            <div className="mx-auto flex max-w-[780px] flex-col px-4 py-5">
              <div ref={topRef} />
              {orderedGroups.map((group) => {
                const head = group[0];
                if (!head) return null;
                // The opening user prompt of a turn sticks to the top while the
                // rest of that turn (its tool calls + responses) scrolls under
                // it — an "intelligent scroll" that keeps the question in view
                // until its answer is done. Handover cards are big context
                // dumps, not turn headers, so they don't pin.
                const sticky = head.type === "prompt" && !isHandoverSummary(head.text);
                return (
                  <div key={head.key} className="flex flex-col gap-4 pb-6">
                    {sticky ? (
                      <div className="sticky top-0 z-10 -mx-4 bg-bg-content/92 px-4 pt-2 backdrop-blur-sm">
                        <TranscriptMessage
                          item={head}
                          agentId={agentId}
                          expandAll={expandAll}
                          now={now}
                        />
                      </div>
                    ) : (
                      <TranscriptMessage
                        item={head}
                        agentId={agentId}
                        expandAll={expandAll}
                        now={now}
                      />
                    )}
                    {group.slice(1).map((it) => (
                      <TranscriptMessage
                        key={it.key}
                        item={it}
                        agentId={agentId}
                        expandAll={expandAll}
                        now={now}
                      />
                    ))}
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>

      {/* filters — inline on wide, overlay on narrow */}
      {!narrow ? (
        <div className="h-full w-[240px] shrink-0 overflow-y-auto border-l border-line-soft">
          {panel}
        </div>
      ) : panelOpen ? (
        <>
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setPanelOpen(false)}
            className="absolute inset-0 z-10 bg-black/20"
          />
          <div className="absolute right-0 top-0 z-20 h-full w-[260px] overflow-y-auto border-l border-line-soft bg-bg-content shadow-xl">
            {panel}
          </div>
        </>
      ) : null}
    </div>
  );
}
