// "Ask Aura" — interactive query against the daemon's knowledge of the
// project. Wraps `aura ask <prompt>` so the user can type a free-form
// question (e.g. "where is the OAuth flow handled?") and see the answer
// inline, with the raw command output in a scrollable monospace pane.
//
// Why a dedicated dialog instead of the OutputDialog: questions can be
// long, the answer can be long, and the user often wants to refine the
// question without losing the previous answer. So we keep a small
// rolling history inside the dialog session.

import { useEffect, useRef, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { api } from "../../lib/api";

type AskTurn = {
  q: string;
  a: string;
  err: string | null;
  loading: boolean;
};

type AskDialogProps = {
  open: boolean;
  repoRoot: string;
  initialQuery?: string;
  onClose: () => void;
};

export function AskDialog({ open, repoRoot, initialQuery, onClose }: AskDialogProps) {
  const [draft, setDraft] = useState(initialQuery ?? "");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Focus the input each time the dialog opens — a question dialog the
  // user has to click into is broken UX.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Auto-scroll to the latest turn whenever a new answer arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, turns[turns.length - 1]?.loading]);

  async function ask() {
    const q = draft.trim();
    if (!q) return;
    const turn: AskTurn = { q, a: "", err: null, loading: true };
    setTurns((t) => [...t, turn]);
    setDraft("");
    try {
      const r = await api.auraCli(repoRoot, ["ask", q]);
      const a = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
      setTurns((t) =>
        t.map((x, i) =>
          i === t.length - 1
            ? { ...x, a: a || `(exit ${r.status})`, loading: false, err: r.status !== 0 ? `exit ${r.status}` : null }
            : x,
        ),
      );
    } catch (e) {
      setTurns((t) =>
        t.map((x, i) =>
          i === t.length - 1 ? { ...x, err: String(e), loading: false } : x,
        ),
      );
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ask Aura"
      width={760}
      footer={
        <>
          <span className="text-text-4 text-[10.5px] mr-auto">⌘↵ to ask · esc to close</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setTurns([])}
            disabled={turns.length === 0}
          >
            Clear
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={ask}
            disabled={!draft.trim()}
          >
            Ask
          </Button>
        </>
      }
    >
      <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight: "55vh" }}>
        {turns.length === 0 && (
          <div className="text-text-4 text-[12px] py-6 text-center">
            ask Aura anything about this project
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="mb-4 last:mb-2">
            <div className="text-text-2 text-[12.5px] mb-1.5 flex items-baseline gap-2">
              <span className="text-text-4 text-[10.5px] uppercase tracking-wider">you</span>
              <span>{t.q}</span>
            </div>
            <div className="bg-bg-1 border border-line rounded p-3">
              {t.loading ? (
                <span className="text-text-4 text-[11.5px]">thinking…</span>
              ) : t.err ? (
                <span className="text-red text-[11.5px]">{t.err}</span>
              ) : (
                <pre className="text-[11.5px] font-mono leading-relaxed text-text-2 whitespace-pre-wrap">
                  {t.a}
                </pre>
              )}
            </div>
          </div>
        ))}
      </div>

      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            ask();
          }
        }}
        placeholder="What do you want to know about this codebase?"
        rows={3}
        className="mt-3 w-full resize-none rounded bg-bg-1 border border-line text-text-1 text-[12.5px] px-3 py-2 outline-none focus:border-line"
      />
    </Dialog>
  );
}
