// TaskDescriptionEditor — Tiptap-on-task-description wrapper.
//
// The notes `TiptapEditor` is generic — it owns a local doc and pushes
// markdown out via `onChange`. Tasks have two extra constraints:
//
//   1. Persistence is a Tauri round-trip (`tasks_update`) so we must
//      not fire on every keystroke. We debounce 800 ms and force-flush
//      on blur, mirroring the same contract the page editor in
//      NotesWorkpane uses.
//   2. Some tasks are archived → the description must be read-only.
//      We render the dense Tiptap with `editable=false` (via a wrapper
//      div that swallows pointer events on the editor surface) plus a
//      muted hint banner so the reader understands why edits don't
//      take.
//
// Everything else (markdown round-trip, slash menu, link handling,
// placeholder) is inherited from the underlying TiptapEditor.

import { useCallback, useEffect, useRef, useState } from "react";
import { TiptapEditor } from "../notes/TiptapEditor";
import { cn } from "../../lib/utils";

type Props = {
  /** Current persisted markdown — drives the editor's initial value
   *  and is re-applied when the parent swaps tasks. */
  value: string;
  /** Persistence callback. Receives the latest markdown; resolves
   *  once the backend has acked. */
  onSave: (markdown: string) => Promise<void>;
  /** When true, render the editor read-only with an "archived" hint.
   *  Click-to-edit is suppressed; markdown still renders. */
  readOnly?: boolean;
  /** Debounce window for save fires. Default 800 ms matches Plane's
   *  doc autosave cadence. */
  debounceMs?: number;
  placeholder?: string;
  className?: string;
};

export function TaskDescriptionEditor({
  value,
  onSave,
  readOnly = false,
  debounceMs = 800,
  placeholder = "Describe the work, paste a spec, drop @mentions…",
  className,
}: Props) {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef(value);
  const savedRef = useRef(value);

  // Keep refs in sync so the debounced flush sees the latest draft +
  // last-saved snapshot without re-creating the timer.
  useEffect(() => {
    latestRef.current = draft;
  }, [draft]);

  // External `value` change (parent swapped tasks, or another agent
  // pushed an edit) — reset the buffer + cancel any pending flush.
  useEffect(() => {
    setDraft(value);
    latestRef.current = value;
    savedRef.current = value;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [value]);

  const flush = useCallback(async () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = latestRef.current;
    if (next === savedRef.current) return;
    savedRef.current = next;
    await onSave(next);
  }, [onSave]);

  const onChange = useCallback(
    (markdown: string) => {
      setDraft(markdown);
      latestRef.current = markdown;
      if (readOnly) return;
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        void flush();
      }, debounceMs);
    },
    [readOnly, debounceMs, flush],
  );

  // Flush pending saves when the document loses focus (blur bubbles
  // up from the editor's inner contenteditable) AND on unmount.
  useEffect(() => {
    return () => {
      // Final flush — fire-and-forget; the component is going away
      // anyway so we can't await without risking a setState-after-
      // unmount warning.
      if (latestRef.current !== savedRef.current) {
        void onSave(latestRef.current);
      }
    };
    // Intentionally only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (readOnly) {
    return (
      <div className={cn("space-y-2", className)}>
        <div
          className="text-[10.5px] uppercase tracking-wider"
          style={{ color: "var(--color-text-4)", letterSpacing: "0.04em" }}
        >
          Archived — description is read-only
        </div>
        <div className="pointer-events-none opacity-90">
          <TiptapEditor
            value={value}
            onChange={() => {
              /* swallowed — pointer-events-none keeps the surface idle */
            }}
            placeholder={placeholder}
            dense
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={className}
      onBlur={() => {
        // The wrapper bubbles a blur whenever focus leaves any inner
        // element. Force-flush so the user's last edits land before
        // the next round-trip.
        void flush();
      }}
    >
      <TiptapEditor
        value={draft}
        onChange={onChange}
        placeholder={placeholder}
        dense
      />
    </div>
  );
}
