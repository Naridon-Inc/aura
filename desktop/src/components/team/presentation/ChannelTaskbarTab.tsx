/** Team (chat) presentation — the inline Taskbar tab.
 *
 *  A simple shared checklist of what the team plans to do. Each item
 *  @mentions the teammate it's for and shows how long ago it was added;
 *  open items just keep showing day after day (that's the "rolls over to
 *  the next day" behaviour) and their age chip turns amber once they're a
 *  day old so a stale item stands out. Backed by one team-wide markdown
 *  doc (`.aura/team/channels/aura-taskbar.notes.md`) via the same
 *  channel_notes_read / channel_notes_write commands the Canvas uses, so
 *  it's git-committed and shared with the team — no new backend needed.
 *
 *  The list is the same regardless of which channel is open: it's the
 *  team's plan, not a per-channel doc. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Circle, ListTodo, Plus, X } from "lucide-react";
import { api, type NoteDoc, type TeamMember } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { MentionedText } from "../../Mentions";
import {
  daysCarried,
  formatAge,
  isCarriedOver,
  parseTaskbar,
  serializeTaskbar,
  type TaskItem,
} from "../domain/taskbar";

/** Fixed slug → one team-wide taskbar doc, shared across every channel.
 *  Must satisfy the backend's `valid_channel` (first char [a-z0-9]); the
 *  `aura-` prefix keeps it clear of any real user channel. */
const TASKBAR_CHANNEL = "aura-taskbar";

function newId(createdAt: number): string {
  return `it-${createdAt}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ChannelTaskbarTab({
  repoRoot,
  members,
  selfHandle,
}: {
  repoRoot: string;
  members: TeamMember[];
  selfHandle: string;
}) {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [newText, setNewText] = useState("");
  const fetchTokenRef = useRef(0);

  // Handles we can assign an item to: self first, then the rest of the team.
  const assignable = useMemo(() => {
    const out: string[] = [];
    if (selfHandle) out.push(selfHandle);
    for (const m of members) {
      if (m.handle && !out.includes(m.handle)) out.push(m.handle);
    }
    return out;
  }, [members, selfHandle]);

  const [assignee, setAssignee] = useState(selfHandle);
  useEffect(() => {
    // Keep a sensible default once identity/roster resolve.
    if (!assignee && assignable.length) setAssignee(assignable[0]);
  }, [assignable, assignee]);

  // ── load once per repo ──────────────────────────────────────────────
  useEffect(() => {
    if (!repoRoot) return;
    const token = ++fetchTokenRef.current;
    const loadedAt = Date.now();
    setLoading(true);
    setError(null);
    api
      .channelNotesRead(repoRoot, TASKBAR_CHANNEL)
      .then((doc: NoteDoc) => {
        if (token !== fetchTokenRef.current) return;
        setItems(parseTaskbar(doc.body ?? "", loadedAt));
      })
      .catch((err) => {
        // A missing doc is fine — start empty; only surface real errors.
        if (token !== fetchTokenRef.current) return;
        setItems([]);
        setError(String(err));
      })
      .finally(() => {
        if (token !== fetchTokenRef.current) return;
        setLoading(false);
      });
  }, [repoRoot]);

  // ── age ticker — refresh chips without a reload ─────────────────────
  useEffect(() => {
    const h = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(h);
  }, []);

  // ── persist (write the whole list on every mutation) ────────────────
  const persist = useCallback(
    (next: TaskItem[]) => {
      setItems(next);
      if (!repoRoot) return;
      setSaving(true);
      api
        .channelNotesWrite(repoRoot, TASKBAR_CHANNEL, serializeTaskbar(next))
        .then(() => setError(null))
        .catch((err) => setError(String(err)))
        .finally(() => setSaving(false));
    },
    [repoRoot],
  );

  const addItem = useCallback(() => {
    const body = newText.trim();
    if (!body) return;
    const at = Date.now();
    // Ensure the item mentions its owner, without doubling up if the author
    // already typed the @handle inline.
    const mention = assignee && !body.includes(`@${assignee}`) ? ` @${assignee}` : "";
    const item: TaskItem = {
      id: newId(at),
      text: `${body}${mention}`,
      author: selfHandle,
      createdAt: at,
      done: false,
      doneAt: null,
    };
    persist([...items, item]);
    setNewText("");
  }, [newText, assignee, selfHandle, items, persist]);

  const toggle = useCallback(
    (id: string) => {
      const at = Date.now();
      persist(
        items.map((it) =>
          it.id === id
            ? { ...it, done: !it.done, doneAt: !it.done ? at : null }
            : it,
        ),
      );
    },
    [items, persist],
  );

  const remove = useCallback(
    (id: string) => persist(items.filter((it) => it.id !== id)),
    [items, persist],
  );

  const clearDone = useCallback(
    () => persist(items.filter((it) => !it.done)),
    [items, persist],
  );

  // ── group: carried-over (stale, open) · today (open) · done ──────────
  const { carried, today, done } = useMemo(() => {
    const carried: TaskItem[] = [];
    const today: TaskItem[] = [];
    const done: TaskItem[] = [];
    for (const it of items) {
      if (it.done) done.push(it);
      else if (isCarriedOver(it, nowMs)) carried.push(it);
      else today.push(it);
    }
    carried.sort((a, b) => a.createdAt - b.createdAt); // most overdue first
    today.sort((a, b) => b.createdAt - a.createdAt); // newest first
    done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    return { carried, today, done };
  }, [items, nowMs]);

  const openCount = carried.length + today.length;

  const renderRow = (it: TaskItem) => {
    const carriedDays = !it.done ? daysCarried(it.createdAt, nowMs) : 0;
    const stale = carriedDays >= 1;
    const authorLabel = it.author ? `added by @${it.author} · ` : "";
    return (
      <div
        key={it.id}
        className="group flex items-start gap-2 rounded px-3 py-1.5 hover:bg-bg-2"
      >
        <button
          type="button"
          onClick={() => toggle(it.id)}
          className={`mt-[1px] flex-shrink-0 ${it.done ? "text-accent" : "text-text-4 hover:text-text-2"}`}
          aria-label={it.done ? "Mark as not done" : "Mark as done"}
        >
          {it.done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
        </button>

        <MentionedText
          text={it.text}
          members={members}
          className={`min-w-0 flex-1 break-words text-[12.5px] leading-snug ${
            it.done ? "text-text-4 line-through" : "text-text-1"
          }`}
        />

        <span
          className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
            stale ? "bg-amber/10 text-amber" : "bg-bg-2 text-text-4"
          }`}
          title={`${authorLabel}added ${new Date(it.createdAt).toLocaleString()}${
            stale ? ` · carried over ${carriedDays} day${carriedDays === 1 ? "" : "s"}` : ""
          }`}
        >
          {formatAge(it.createdAt, nowMs)}
        </span>

        <button
          type="button"
          onClick={() => remove(it.id)}
          className="flex-shrink-0 text-text-5 opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
          aria-label="Remove item"
        >
          <X size={13} />
        </button>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-1">
      {/* header */}
      <div className="flex h-7 flex-shrink-0 items-center gap-2 border-b border-line-soft px-3 text-[10.5px] text-text-4">
        <ListTodo size={13} aria-hidden />
        <span className="truncate">Team taskbar</span>
        <span className="text-text-5">·</span>
        {loading ? (
          <span className="flex items-center gap-1.5">
            <AsciiSpinner className="text-[10.5px]" />
            Loading…
          </span>
        ) : (
          <span>
            {openCount} open
            {done.length ? ` · ${done.length} done` : ""}
          </span>
        )}
        {saving && (
          <span className="flex items-center" aria-label="Saving">
            <AsciiSpinner className="text-[10.5px]" />
          </span>
        )}
        {error && (
          <span className="ml-auto truncate text-red" title={error}>
            couldn’t save
          </span>
        )}
      </div>

      {/* add row */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2">
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder="Add something the team plans to do…"
          className="h-7 flex-1 rounded border border-line bg-bg-2 px-2 text-[12px] text-text-1 outline-none placeholder:text-text-5 focus:border-accent"
        />
        <div className="flex items-center gap-1 text-text-4">
          <span className="text-[11px]">@</span>
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="h-7 max-w-[120px] rounded border border-line bg-bg-2 px-1.5 text-[11px] text-text-2 outline-none focus:border-accent"
            title="Who is this for?"
          >
            {assignable.length === 0 && <option value="">—</option>}
            {assignable.map((h) => (
              <option key={h} value={h}>
                {h}
                {h === selfHandle ? " (me)" : ""}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={addItem}
          disabled={!newText.trim()}
          className="flex h-7 items-center gap-1 rounded px-2.5 text-[11.5px] font-medium disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "var(--color-bg-0)" }}
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!loading && openCount === 0 && done.length === 0 && (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <ListTodo size={22} className="text-text-5" aria-hidden />
            <div className="mt-2 text-[13px] font-medium text-text-2">
              Nothing planned yet
            </div>
            <div className="mt-1 max-w-[320px] text-[11.5px] leading-snug text-text-4">
              Add what the team plans to do. Anything left unchecked rolls over
              to the next day — its age shows how long it’s been waiting.
            </div>
          </div>
        )}

        {carried.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider text-amber">
              Carried over
            </div>
            {carried.map(renderRow)}
          </>
        )}

        {today.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider text-text-5">
              Today
            </div>
            {today.map(renderRow)}
          </>
        )}

        {done.length > 0 && (
          <>
            <div className="flex items-center justify-between px-3 pb-1 pt-3">
              <span className="text-[10px] uppercase tracking-wider text-text-5">
                Done
              </span>
              <button
                type="button"
                onClick={clearDone}
                className="text-[10.5px] text-text-5 hover:text-text-3"
              >
                Clear
              </button>
            </div>
            {done.map(renderRow)}
          </>
        )}
      </div>
    </div>
  );
}
