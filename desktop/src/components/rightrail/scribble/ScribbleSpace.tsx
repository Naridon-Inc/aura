/** Scribble — one writing space (Team or Personal).
 *
 *  A day-bucketed, forever-scrolling board of discrete *blocks*. Each block is a
 *  short unit of freeform markdown (bold / italic / @mention / inline gif) that
 *  can be a plain note or a task, and remembers who wrote it and when. Today's
 *  blocks are live editors — Enter starts a new block below, hover to pin or
 *  remove; scroll down for previous days, preserved read-only. Open tasks carry
 *  into today automatically (computed, never rewritten). Pinned blocks surface
 *  in a strip up top. Team saves debounce + poll so teammates' (and agents')
 *  writes merge in; Personal is machine-local. Local edits are never clobbered
 *  by a poll. */

import { Pin, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TeamMember } from "../../../lib/api";
import { InlineText } from "./InlineText";
import { ScribbleBlock } from "./ScribbleBlock";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import {
  bucketDays,
  dayLabel,
  newBlockId,
  parseScribble,
  serializeScribble,
  type ScribbleBlock as Block,
} from "./scribbleModel";
import {
  readPersonalCanvas,
  readTeamCanvas,
  writePersonalCanvas,
  writeTeamCanvas,
} from "./scribbleStore";

const POLL_MS = 15000;
const SAVE_DEBOUNCE_MS = 600;
const TICK_MS = 30000;

type Scope = "team" | "personal";

let blockSeq = 0;

function makeEmpty(): Block {
  const createdAt = Date.now();
  return {
    id: newBlockId(createdAt, blockSeq++),
    text: "",
    isTask: false,
    done: false,
    doneBy: null,
    doneAt: null,
    author: "", // stamped with the author once it gains text
    createdAt,
    pinned: false,
  };
}

/** Keep exactly one empty draft at the tail so there's always a place to type
 *  and a visible "next line". A block being edited keeps its id (text is
 *  updated in place), so appending a fresh tail never steals focus. */
function withTrailing(list: Block[]): Block[] {
  const last = list[list.length - 1];
  if (last && last.text.trim() === "") return list;
  return [...list, makeEmpty()];
}

function insertAfter(list: Block[], id: string, nb: Block): Block[] {
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return [...list, nb];
  return [...list.slice(0, i + 1), nb, ...list.slice(i + 1)];
}

// A checkbox typed at the start of a line turns a note into a task.
const TASK_PREFIX = /^\s*(?:[-*]\s+)?\[([ xX]?)\]\s+([\s\S]*)$/;

export function ScribbleSpace({
  repoRoot,
  scope,
  members,
  selfHandle,
}: {
  repoRoot: string;
  scope: Scope;
  members: TeamMember[];
  selfHandle: string;
}) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [focusId, setFocusId] = useState<string | null>(null);

  const dirty = useRef(false); // unsaved local edits — poll must not clobber
  const saving = useRef(false); // a team write is scheduled / in flight
  const saveTimer = useRef<number | null>(null);

  const read = useCallback(
    () =>
      scope === "team"
        ? readTeamCanvas(repoRoot)
        : Promise.resolve(readPersonalCanvas(repoRoot)),
    [scope, repoRoot],
  );

  const save = useCallback(
    (next: Block[]) => {
      const blob = serializeScribble(next);
      if (scope === "personal") {
        writePersonalCanvas(repoRoot, blob);
        dirty.current = false;
        return;
      }
      saving.current = true;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void writeTeamCanvas(repoRoot, blob)
          .catch(() => {})
          .finally(() => {
            saving.current = false;
            dirty.current = false;
          });
      }, SAVE_DEBOUNCE_MS);
    },
    [scope, repoRoot],
  );

  // Mutate blocks, keep a trailing draft, mark dirty, and persist.
  const apply = useCallback(
    (updater: (prev: Block[]) => Block[]) => {
      setBlocks((prev) => {
        const next = withTrailing(updater(prev));
        dirty.current = true;
        save(next);
        return next;
      });
    },
    [save],
  );

  // Load / poll. Adopt the remote copy only when no local edit is in flight.
  useEffect(() => {
    let alive = true;
    const hydrate = async () => {
      const md = await read();
      if (!alive) return;
      if (dirty.current || saving.current) {
        setLoaded(true);
        return;
      }
      setBlocks(withTrailing(parseScribble(md, Date.now())));
      setLoaded(true);
    };
    void hydrate();
    if (scope !== "team")
      return () => {
        alive = false;
      };
    const id = window.setInterval(hydrate, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [read, scope]);

  // Age chips + day-rollover: recompute buckets on a slow tick.
  useEffect(() => {
    const h = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(h);
  }, []);

  const onChangeText = useCallback(
    (id: string, raw: string) => {
      // A block is a single line — collapse any pasted newlines to spaces so it
      // never serializes into multiple markdown lines (which would reparse as
      // several blocks — the "duplication" bug).
      const text = raw.replace(/\r?\n/g, " ");
      apply((prev) =>
        prev.map((b) => {
          if (b.id !== id) return b;
          const gained = b.text.trim() === "" && text.trim() !== "";
          let next: Block = { ...b, text };
          // Typing a checkbox at the start converts the note into a task.
          const m = TASK_PREFIX.exec(text);
          if (m) {
            const done = m[1].toLowerCase() === "x";
            next = {
              ...next,
              text: m[2],
              isTask: true,
              done,
              doneBy: done ? selfHandle : b.doneBy,
              doneAt: done ? Date.now() : b.doneAt,
            };
          }
          if (gained) {
            next.author = next.author || selfHandle;
            next.createdAt = Date.now();
          }
          return next;
        }),
      );
    },
    [apply, selfHandle],
  );

  const onEnter = useCallback(
    (id: string): boolean => {
      const nb = makeEmpty();
      apply((prev) => insertAfter(prev, id, nb));
      setFocusId(nb.id);
      return true; // swallow the newline — blocks stay single-line
    },
    [apply],
  );

  const onToggleTask = useCallback(
    (id: string) =>
      apply((prev) => prev.map((b) => (b.id === id ? { ...b, isTask: true } : b))),
    [apply],
  );

  const onToggleDone = useCallback(
    (id: string) =>
      apply((prev) =>
        prev.map((b) => {
          if (b.id !== id) return b;
          const done = !b.done;
          return {
            ...b,
            done,
            doneBy: done ? selfHandle : null,
            doneAt: done ? Date.now() : null,
          };
        }),
      ),
    [apply, selfHandle],
  );

  const onTogglePin = useCallback(
    (id: string) =>
      apply((prev) => prev.map((b) => (b.id === id ? { ...b, pinned: !b.pinned } : b))),
    [apply],
  );

  const onRemove = useCallback(
    (id: string) => apply((prev) => prev.filter((b) => b.id !== id)),
    [apply],
  );

  const days = useMemo(() => bucketDays(blocks, nowMs), [blocks, nowMs]);
  const pinned = useMemo(
    () => blocks.filter((b) => b.pinned && b.text.trim().length > 0),
    [blocks],
  );
  const openCount = useMemo(
    () => blocks.filter((b) => b.isTask && !b.done && b.text.trim().length > 0).length,
    [blocks],
  );

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-text-4">
        <AsciiSpinner className="text-[10px]" />
        <span>Opening your notes…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pinned strip — many pins allowed; unpin inline. */}
      {pinned.length > 0 && (
        <div className="flex-shrink-0 border-b border-line-soft/60 bg-bg-2/40 px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1 px-1 text-[9px] font-semibold uppercase tracking-wider text-text-5">
            <Pin size={9} className="text-accent" /> Pinned
          </div>
          <div className="flex flex-col gap-0.5">
            {pinned.map((b) => (
              <div key={b.id} className="group flex items-start gap-1.5 px-1">
                <InlineText
                  text={b.text}
                  members={members}
                  className="min-w-0 flex-1 break-words text-[12px] leading-snug text-text-2"
                />
                <button
                  type="button"
                  onClick={() => onTogglePin(b.id)}
                  title="Unpin"
                  aria-label="Unpin"
                  className="flex-shrink-0 p-0.5 text-text-5 opacity-0 transition-opacity hover:text-text-2 group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Forever scroll — today (live) first, then previous days (read-only). */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
        {days.map((day) => (
          <div key={day.key} className="mb-1">
            <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-bg-1/95 px-3 py-1 backdrop-blur">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-4">
                {dayLabel(day.ts, nowMs)}
              </span>
              {!day.isToday && <span className="text-[9px] text-text-5">· read-only</span>}
            </div>
            <div className="px-1">
              {day.blocks.map((b) => (
                <ScribbleBlock
                  key={b.id}
                  block={b}
                  members={members}
                  nowMs={nowMs}
                  editable={day.isToday}
                  autoFocus={b.id === focusId}
                  onChangeText={(text) => onChangeText(b.id, text)}
                  onToggleTask={() => onToggleTask(b.id)}
                  onToggleDone={() => onToggleDone(b.id)}
                  onTogglePin={() => onTogglePin(b.id)}
                  onRemove={() => onRemove(b.id)}
                  onEnter={() => onEnter(b.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer — open task count. */}
      <div className="flex-shrink-0 border-t border-line-soft/60 px-3 py-1 text-[10px] text-text-5">
        {openCount === 0
          ? "No open tasks"
          : `${openCount} open task${openCount === 1 ? "" : "s"}`}
      </div>
    </div>
  );
}
