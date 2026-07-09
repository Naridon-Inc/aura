// GoalComposer — the one-line "state a goal" affordance shared by the session
// and task goal cards. Collapsed it's a quiet "+ Set a goal…" button; expanded
// it's a single text field (optionally prefilled with the run's intent or the
// task's title) that hands the trimmed requirement back to its parent. The
// parent owns what association the new goal gets (proven against this run, or
// linked to this task) — the composer only captures the sentence.

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

export function GoalComposer({
  prefill,
  placeholder,
  cta,
  busy,
  onSubmit,
}: {
  /** Seed text when the field opens (intent headline / task title). */
  prefill?: string;
  placeholder: string;
  /** Collapsed-button label, e.g. "Set a goal for this run". */
  cta: string;
  busy?: boolean;
  onSubmit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText(prefill ?? "");
      // focus + place caret at end on next frame
      const id = requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open, prefill]);

  function submit() {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-line-soft px-2.5 py-1.5 text-[12px] text-text-3 transition-colors hover:border-line hover:text-text-1"
      >
        <span className="text-[13px] leading-none">+</span>
        {cta}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-line-soft bg-bg-1 px-1.5 py-1">
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-[13px] text-text-1 placeholder:text-text-5 focus:outline-none"
      />
      <Button
        type="button"
        variant="subtle"
        size="xs"
        onClick={submit}
        disabled={busy || !text.trim()}
        className="shrink-0 text-text-2"
      >
        {busy ? "…" : "Add"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setOpen(false)}
        className="shrink-0 text-text-5 hover:text-text-2"
      >
        Cancel
      </Button>
    </div>
  );
}
