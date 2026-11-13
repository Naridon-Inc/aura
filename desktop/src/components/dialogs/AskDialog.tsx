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
import { Kbd } from "../ui/kbd";
import { ChatStatus, Message, MessageBody } from "../ui/message";
import { Textarea } from "../ui/textarea";
import "../ui/ask-aura.css";
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
          <p className="ui-ask-aura-keys">
            <Kbd>⌘↵</Kbd> to ask · <Kbd>Esc</Kbd> to close
          </p>
          <Button variant="outline" onClick={() => setTurns([])} disabled={turns.length === 0}>
            Clear
          </Button>
          <Button onClick={ask} disabled={!draft.trim()}>
            Ask
          </Button>
        </>
      }
    >
      <div ref={scrollRef} className="ui-ask-aura-thread">
        {turns.length === 0 && (
          <div className="ui-pattern-empty ui-ask-aura-empty">
            <strong>Ask about this repository</strong>
            <p>
              Aura remembers what was built here and why. Ask in plain words. How a part works,
              what changed, or why it was done that way.
            </p>
            <div className="ui-ask-aura-examples">
              {EXAMPLES.map((q) => (
                <Button
                  key={q}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(q);
                    inputRef.current?.focus();
                  }}
                >
                  {q}
                </Button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, ti) => (
          <section key={ti} className="ui-ask-aura-turn" aria-label={`Question ${ti + 1}`}>
            <Message role="user">
              <MessageBody tone="user">{t.q}</MessageBody>
            </Message>
            {t.loading ? (
              <ChatStatus state="working">Looking through your repository's history…</ChatStatus>
            ) : t.err ? (
              <ChatStatus state="error">{t.err}</ChatStatus>
            ) : t.result ? (
              <AnswerBlock result={t.result} turnIdx={ti} expanded={expanded} onToggle={toggle} />
            ) : null}
          </section>
        ))}
      </div>

      <Textarea
        ref={inputRef}
        className="ui-ask-aura-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            ask();
          }
        }}
        aria-label="Your question"
        placeholder="Ask anything about this repository…"
        rows={2}
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
      <Message role="assistant">
        <MessageBody>
          <p>This repository doesn't have any saved history yet.</p>
          <p className="ui-ask-aura-muted">
            Once agents make changes here, Aura remembers what changed and why. Then you can ask
            and get real answers.
          </p>
        </MessageBody>
      </Message>
    );
  }

  if (result.kind === "no-match") {
    return (
      <Message role="assistant">
        <MessageBody>
          <p>
            I looked through {result.total.toLocaleString()} saved{" "}
            {result.total === 1 ? "decision" : "decisions"} but nothing matched that.
          </p>
          <p className="ui-ask-aura-muted">
            Try naming the part you mean, like “email”, “login”, or “payments”.
          </p>
        </MessageBody>
      </Message>
    );
  }

  const { answer, sources } = result;
  return (
    <>
      {/* The answer — plain language, grounded in the record. */}
      <Message role="assistant">
        <MessageBody>
          <p className="ui-ask-aura-label">What your repository's history shows</p>
          <p>{answer}</p>
        </MessageBody>
      </Message>

      {/* Where it came from — the trail of past decisions. */}
      <section className="ui-ask-aura-sources" aria-label="Where this comes from">
        <h4>
          Where this comes from · {sources.length} past{" "}
          {sources.length === 1 ? "decision" : "decisions"}
        </h4>
        <ul>
          {sources.map((s, si) => {
            const key = `${turnIdx}:${si}`;
            const isOpen = expanded.has(key);
            const when = relativeTime(s.ts);
            const hasMore = s.text.trim().length > s.title.trim().length + 8;
            const body = (
              <>
                <span>{isOpen ? s.text : s.title}</span>
                <small>
                  {s.agent}
                  {when && ` · ${when}`}
                  {hasMore && <em>{isOpen ? " · less" : " · the full story"}</em>}
                </small>
              </>
            );
            return (
              <li key={key}>
                {hasMore ? (
                  <button
                    type="button"
                    className="ui-ask-aura-source"
                    aria-expanded={isOpen}
                    onClick={() => onToggle(key)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="ui-ask-aura-source">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
