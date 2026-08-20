// ProofBreakdown — the plain-language "here's what we actually checked" view of
// an `aura prove` outcome, shared by the Goals workbench and the session
// Summary's per-run goal card.
//
// A goal verdict like "Reached 4/4 in place" is an aggregate; on its own it
// asks the reader to trust a number. This breaks that number back open: the
// individual checks Aura ran, each in the user's own words (the engine's
// `reason`), split into what's already in place and what's still missing, plus
// an on-demand "how you know" that names the actual code each check inspected.
// The main surface stays jargon-free (ADE audience); the AST node names live
// only inside the collapsed mechanism.

import { useState } from "react";

import {
  capabilityPhrase,
  plainCheckLine,
  statusTag,
  whyItMatters,
  finishInstruction,
  finishAllInstruction,
  type ProveOutcome,
} from "../../lib/prove";

// Shared uppercase count label above a group of checks.
function GroupLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="section-label">
      {title}
      <span className="ml-1.5 tabular-nums normal-case tracking-normal">{count}</span>
    </div>
  );
}

// The "in place" side — a plain ticked list (the reasons, not the AST names).
export function ProofGroup({
  title,
  tone,
  checks,
}: {
  title: string;
  tone: "good" | "bad";
  checks: ProveOutcome["checks"];
}) {
  const color = tone === "good" ? "var(--color-accent-green)" : "var(--color-red)";
  return (
    <section>
      <GroupLabel title={title} count={checks.length} />
      <ul className="mt-2 space-y-1">
        {checks.map((c, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-sm px-2.5 py-1.5 rounded-md border border-line-soft bg-bg-1"
          >
            <span className="shrink-0 mt-px text-xs" style={{ color }} aria-hidden>
              {tone === "good" ? "✓" : "✗"}
            </span>
            <span className="flex-1 min-w-0 text-text-1" title={c.reason}>
              {plainCheckLine(c)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The "still missing" side — the part the user acts on. Compact rows (one
// capability per line + a two-word status), grouped by cause so the "why it
// matters" note is said ONCE, not repeated identically on every row. Each row
// carries a one-tap fix to hand an agent; the group closes with a single
// "finish all of these" prompt. Arctic-blue = the thing to click.
export function MissingList({ outcome }: { outcome: ProveOutcome }) {
  const missing = outcome.checks.filter((c) => !c.passed);
  if (missing.length === 0) return null;
  const groups: { note: string; items: ProveOutcome["checks"] }[] = [];
  for (const c of missing) {
    const note = whyItMatters(c);
    const g = groups.find((x) => x.note === note);
    if (g) g.items.push(c);
    else groups.push({ note, items: [c] });
  }
  return (
    <section className="flex flex-col gap-2.5">
      <GroupLabel title="Still missing" count={missing.length} />
      {groups.map((g, gi) => (
        <div key={gi} className="flex flex-col gap-1.5">
          <ul className="flex flex-col gap-1">
            {g.items.map((c, i) => (
              <li
                key={i}
                className="flex items-center gap-2.5 rounded-md border border-line-soft bg-bg-1 px-2.5 py-1.5"
              >
                <span className="shrink-0 text-xs text-red" aria-hidden>
                  ✗
                </span>
                <span
                  className="flex-1 min-w-0 truncate text-sm text-text-1"
                  title={c.reason}
                >
                  {capabilityPhrase(c)}
                </span>
                <span className="section-label shrink-0">
                  {statusTag(c)}
                </span>
                <CopyFix text={finishInstruction(c, outcome.goal)} />
              </li>
            ))}
          </ul>
          <p className="text-xs leading-snug text-text-4">
            <span className="text-text-3">Why it matters. </span>
            {g.note}
          </p>
        </div>
      ))}
      <FinishTheRest outcome={outcome} />
    </section>
  );
}

// A compact per-row fix — copies a ready instruction so the fix drops straight
// into a coding session, closing the loop the Aura way (build → wire → prove).
function CopyFix({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked — the title still carries the instruction */
        }
      }}
      className="shrink-0 text-xs font-medium transition-opacity hover:opacity-80"
      style={{ color: copied ? "var(--color-accent-green)" : "var(--color-blue)" }}
    >
      {copied ? "✓ copied" : "Fix →"}
    </button>
  );
}

// One prompt covering every missing part, ready to paste to an agent. The
// primary affordance here — soft arctic-blue fill.
function FinishTheRest({ outcome }: { outcome: ProveOutcome }) {
  const [copied, setCopied] = useState(false);
  const prompt = finishAllInstruction(outcome);
  if (!prompt) return null;
  const n = outcome.checks.filter((c) => !c.passed).length;
  return (
    <button
      type="button"
      title={prompt}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(prompt);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="self-start inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors"
      style={{
        background: copied
          ? "color-mix(in oklab, var(--color-accent-green) 14%, transparent)"
          : "color-mix(in oklab, var(--color-blue) 14%, transparent)",
        color: copied ? "var(--color-accent-green)" : "var(--color-blue)",
      }}
    >
      <span aria-hidden>{copied ? "✓" : "↪"}</span>
      {copied ? "Copied. Paste it to your agent" : `Ask your agent to finish ${n === 1 ? "this" : `all ${n}`}`}
    </button>
  );
}

// The mechanism, on demand only — the AST node names behind each plain reason.
export function HowYouKnow({ outcome }: { outcome: ProveOutcome }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line-soft pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-text-3 hover:text-text-1 transition-colors"
      >
        <Caret open={open} />
        <span>Show how you know ({outcome.checks.length} checks)</span>
      </button>
      {open && (
        <ul className="mt-2.5 space-y-0.5">
          {outcome.checks.map((c, i) => (
            <li
              key={i}
              className={`flex items-start gap-2 px-2 py-1 rounded text-sm font-mono ${
                i % 2 === 0 ? "bg-bg-1/30" : ""
              }`}
            >
              <span className={`shrink-0 mt-0.5 text-xs ${c.passed ? "text-green" : "text-red"}`}>
                {c.passed ? "✓" : "✗"}
              </span>
              <span className="flex-1 min-w-0 truncate" title={c.reason}>
                <span className="text-text-4">{c.node_type}</span>{" "}
                <span className="text-text-1">{c.node_name}</span>
                {c.must_call ? <span className="text-text-4"> → calls {c.must_call}</span> : null}
                {c.is_stub ? <span className="text-amber"> · placeholder</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// One plain sentence on *how* the proof was arrived at — so "Reached" reads as
// a method, not a claim. No AST jargon here; that's what HowYouKnow is for.
function ProofHow() {
  return (
    <p className="text-sm leading-relaxed text-text-4">
      Aura split this goal into the parts the code needs, then read the real code
      to confirm each part is there, isn&apos;t an empty placeholder, and connects
      to what it should. Each line below is one of those checks.
    </p>
  );
}

/** The full breakdown behind a goal verdict: how it was checked, what's in
 *  place, what's missing, and (on demand) the code each check inspected.
 *  Renders nothing when the outcome carries no checks. */
export function ProofBreakdown({
  outcome,
  explainer = true,
}: {
  outcome: ProveOutcome;
  /** Lead with the one-line "how this was checked". On by default; drop it
   *  where the surrounding surface already explains the method. */
  explainer?: boolean;
}) {
  if (!outcome.checks || outcome.checks.length === 0) return null;
  const built = outcome.checks.filter((c) => c.passed);
  const missing = outcome.checks.filter((c) => !c.passed);
  return (
    <div className="flex flex-col gap-3">
      {explainer ? <ProofHow /> : null}
      {/* Lead with what's still missing — that's the actionable part — then the
          settled "in place" list, then the mechanism on demand. */}
      {missing.length > 0 ? <MissingList outcome={outcome} /> : null}
      {built.length > 0 ? <ProofGroup title="In place" tone="good" checks={built} /> : null}
      <HowYouKnow outcome={outcome} />
    </div>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      className="shrink-0 transition-transform"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
      aria-hidden
    >
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
