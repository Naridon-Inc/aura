// "Ask Aura" — ask a plain-language question about the project and get a
// plain-language answer, with the past decisions it was drawn from shown
// underneath. The engine (lib/askEngine) reads the project's own recorded
// reasoning (`.aura/intent_log.jsonl`) — no cloud, no daemon — so the answer
// is grounded in what agents actually did here, not a guess.
//
// Layout is deliberately answer-first: the single most relevant recorded
// decision, phrased plainly, sits at the top; the ranked "where this comes
// from" list underneath is the trail of conversations that shaped the code.

import { useEffect, useRef, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { ask as runAsk, relativeTime, type AskResult } from "../../lib/askEngine";

type AskTurn = {
  q: string;
  result: AskResult | null;
  err: string | null;
  loading: boolean;
};

// Starter questions shown before the first ask, so a non-engineer knows what
// Aura can answer — it draws on the project's recorded history of what was
// built and why, so "what / how / why" questions land best.
const EXAMPLES = [
  "What changed recently?",
  "How does login work?",
  "What handles email?",
  "Why was this built this way?",
];

type AskDialogProps = {
  open: boolean;
  repoRoot: string;
  initialQuery?: string;
  onClose: () => void;
};

const BLUE = "var(--color-blue)";
const BLUE_TINT = "color-mix(in oklab, var(--color-blue) 9%, transparent)";
const BLUE_EDGE = "color-mix(in oklab, var(--color-blue) 40%, transparent)";

export function AskDialog({ open, repoRoot, initialQuery, onClose }: AskDialogProps) {
  const [draft, setDraft] = useState(initialQuery ?? "");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Focus on open; drop a prefilled question (e.g. `/ask how does email work`)
  // straight into the draft ready to send.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    if (initialQuery && initialQuery.trim()) setDraft(initialQuery);
  }, [open, initialQuery]);

  // Auto-scroll to the latest turn whenever a new answer arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, turns[turns.length - 1]?.loading]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function ask() {
    const q = draft.trim();
    if (!q) return;
    setTurns((t) => [...t, { q, result: null, err: null, loading: true }]);
    setDraft("");
    try {
      const result = await runAsk(repoRoot, q);
      setTurns((t) =>
        t.map((x, i) => (i === t.length - 1 ? { ...x, result, loading: false } : x)),
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
      width={720}
      footer={
        <>
          <span className="text-text-4 text-xs mr-auto">⌘↵ to ask · esc to close</span>
          <Button variant="ghost" size="xs" onClick={() => setTurns([])} disabled={turns.length === 0}>
            Clear
          </Button>
          <Button variant="default" size="xs" onClick={ask} disabled={!draft.trim()}>
            Ask
          </Button>
        </>
      }
    >
      <div ref={scrollRef} className="overflow-y-auto pr-0.5" style={{ maxHeight: "56vh" }}>
        {turns.length === 0 && (
          <div className="py-8 px-1">
            <div className="flex items-center gap-2 justify-center mb-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: BLUE }} />
              <span className="text-text-2 text-base font-medium">Ask about this project</span>
            </div>
            <div className="text-text-4 text-sm text-center mb-4 max-w-[440px] mx-auto leading-relaxed">
              Aura remembers what was built here and why. Ask in plain words. How a
              part works, what changed, or why it was done that way.
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setDraft(q);
                    inputRef.current?.focus();
                  }}
                  className="text-sm text-text-2 bg-bg-1 border border-line rounded-lg px-3 py-1.5 transition-colors"
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = BLUE_EDGE)}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, ti) => (
          <div key={ti} className="mb-5 last:mb-1">
            {/* The question */}
            <div className="flex items-baseline gap-2 mb-2.5">
              <span className="section-label shrink-0 mt-0.5">
                You asked
              </span>
              <span className="text-text-1 text-base font-medium leading-snug">{t.q}</span>
            </div>

            {t.loading ? (
              <div className="flex items-center gap-2 text-text-4 text-sm py-2 pl-0.5">
                <AsciiSpinner />
                <span>Looking through your project's history…</span>
              </div>
            ) : t.err ? (
              <div role="alert" className="text-red text-sm py-1">{t.err}</div>
            ) : t.result ? (
              <AnswerBlock
                result={t.result}
                turnIdx={ti}
                expanded={expanded}
                onToggle={toggle}
              />
            ) : null}
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
        placeholder="Ask anything about this project…"
        rows={2}
        className="mt-3 w-full resize-none rounded-lg bg-bg-1 border border-line text-text-1 text-base px-3 py-2.5 outline-none focus:border-line"
      />
    </Dialog>
  );
}

function AnswerBlock({
  result,
  turnIdx,
  expanded,
  onToggle,
}: {
  result: AskResult;
  turnIdx: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (result.kind === "empty") {
    return (
      <div className="rounded-lg border border-line bg-bg-1 px-3.5 py-3">
        <div className="text-text-2 text-base leading-relaxed">
          This project doesn't have any saved history yet.
        </div>
        <div className="text-text-4 text-sm leading-relaxed mt-1">
          Once agents make changes here, Aura remembers what changed and why. 
          then you can ask and get real answers.
        </div>
      </div>
    );
  }

  if (result.kind === "no-match") {
    return (
      <div className="rounded-lg border border-line bg-bg-1 px-3.5 py-3">
        <div className="text-text-2 text-base leading-relaxed">
          I looked through {result.total.toLocaleString()} saved{" "}
          {result.total === 1 ? "decision" : "decisions"} but nothing matched that.
        </div>
        <div className="text-text-4 text-sm leading-relaxed mt-1">
          Try naming the part you mean, like “email”, “login”, or “payments”.
        </div>
      </div>
    );
  }

  const { answer, sources } = result;
  return (
    <div>
      {/* The answer — plain language, grounded in the record. */}
      <div
        className="rounded-lg px-3.5 py-3"
        style={{
          background: BLUE_TINT,
          border: `1px solid ${BLUE_EDGE}`,
          borderLeft: `2px solid ${BLUE}`,
        }}
      >
        <div className="section-label mb-1.5">
          What your project's history shows
        </div>
        <div className="text-text-1 text-md leading-relaxed">{answer}</div>
      </div>

      {/* Where it came from — the trail of past decisions. */}
      <div className="mt-3">
        <div className="section-label mb-2 pl-0.5">
          Where this comes from · {sources.length} past{" "}
          {sources.length === 1 ? "decision" : "decisions"}
        </div>
        <div className="flex flex-col gap-1.5">
          {sources.map((s, si) => {
            const key = `${turnIdx}:${si}`;
            const isOpen = expanded.has(key);
            const when = relativeTime(s.ts);
            const hasMore = s.text.trim().length > s.title.trim().length + 8;
            return (
              <button
                key={key}
                onClick={() => hasMore && onToggle(key)}
                className="text-left rounded-lg border border-line bg-bg-1 px-3 py-2 transition-colors"
                style={{ cursor: hasMore ? "pointer" : "default" }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = BLUE_EDGE)}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
              >
                <div className="text-text-2 text-sm leading-snug">
                  {isOpen ? s.text : s.title}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 text-text-4 text-2xs">
                  <span>{s.agent}</span>
                  {when && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{when}</span>
                    </>
                  )}
                  {hasMore && (
                    <>
                      <span aria-hidden>·</span>
                      <span style={{ color: BLUE }}>{isOpen ? "less" : "the full story"}</span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
