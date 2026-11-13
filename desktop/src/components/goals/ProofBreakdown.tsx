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
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  capabilityPhrase,
  plainCheckLine,
  statusTag,
  whyItMatters,
  finishInstruction,
  finishAllInstruction,
  type ProveOutcome,
} from "../../lib/prove";
import { Button } from "../ui/button";
import { TraceMark } from "../ui/trace-list";
import { TraceItem, TraceItems, TraceLine, TraceStatusGlyph } from "../ui/trace-report";
import "./goals.css";

function GroupLabel({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="ui-goal-part-title">
      {title}
      <small>{count}</small>
    </h3>
  );
}

/** A settled list of checks — what is in place, or what isn't. The engine's
 *  own reason rides on the line as its tooltip. */
export function ProofGroup({
  title,
  tone,
  checks,
}: {
  title: string;
  tone: "good" | "bad";
  checks: ProveOutcome["checks"];
}) {
  return (
    <section className="ui-goal-part">
      <GroupLabel title={title} count={checks.length} />
      <TraceItems>
        {checks.map((c, i) => (
          <TraceItem key={i} tone={tone} title={<span title={c.reason}>{plainCheckLine(c)}</span>} />
        ))}
      </TraceItems>
    </section>
  );
}

/** What's still missing, grouped by why it matters, each with the instruction
 *  that would finish it ready to copy to an agent. */
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
    <section className="ui-goal-part">
      <GroupLabel title="Still missing" count={missing.length} />
      {groups.map((g, gi) => (
        <div key={gi} className="ui-goal-missing-group">
          <TraceItems>
            {g.items.map((c, i) => (
              <TraceItem
                key={i}
                tone="bad"
                title={<span title={c.reason}>{capabilityPhrase(c)}</span>}
                marks={
                  <>
                    <TraceMark>{statusTag(c)}</TraceMark>
                    <CopyFix text={finishInstruction(c, outcome.goal)} />
                  </>
                }
              />
            ))}
          </TraceItems>
          <TraceLine tone="note">Why it matters: {g.note}</TraceLine>
        </div>
      ))}
      <FinishTheRest outcome={outcome} />
    </section>
  );
}

function useCopied(ms: number) {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), ms);
    } catch {
      /* clipboard blocked — the title still carries the instruction */
    }
  };
  return { copied, copy };
}

function CopyFix({ text }: { text: string }) {
  const { copied, copy } = useCopied(1600);
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="ui-goal-copy-fix"
      title={text}
      onClick={() => void copy(text)}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : "Copy the fix"}
    </Button>
  );
}

function FinishTheRest({ outcome }: { outcome: ProveOutcome }) {
  const { copied, copy } = useCopied(1800);
  const prompt = finishAllInstruction(outcome);
  if (!prompt) return null;
  const n = outcome.checks.filter((c) => !c.passed).length;
  return (
    <div className="ui-goal-finish">
      <Button type="button" variant="secondary" size="sm" title={prompt} onClick={() => void copy(prompt)}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied. Paste it to your agent" : `Ask your agent to finish ${n === 1 ? "this" : `all ${n}`}`}
      </Button>
    </div>
  );
}

/** The mechanism, on demand: the actual code each check inspected. */
export function HowYouKnow({ outcome }: { outcome: ProveOutcome }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ui-goal-part">
      <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        Show how you know ({outcome.checks.length} checks)
      </Button>
      {open && (
        <ul className="ui-goal-how">
          {outcome.checks.map((c, i) => (
            <li key={i} title={c.reason}>
              <TraceStatusGlyph tone={c.passed ? "good" : "bad"} />
              <code>
                <span>{c.node_type}</span> {c.node_name}
                {c.must_call ? <span> → calls {c.must_call}</span> : null}
                {c.is_stub ? <span data-tone="warn"> · placeholder</span> : null}
              </code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProofHow() {
  return (
    <TraceLine>
      Aura split this goal into the parts the code needs, then read the real code to confirm
      each part is there, isn&apos;t an empty placeholder, and connects to what it should. Each
      line below is one of those checks.
    </TraceLine>
  );
}

/** The whole breakdown: what's missing first (the actionable part), then
 *  what's in place, then the mechanism on demand. */
export function ProofBreakdown({
  outcome,
  explainer = true,
}: {
  outcome: ProveOutcome;
  explainer?: boolean;
}) {
  if (!outcome.checks || outcome.checks.length === 0) return null;
  const built = outcome.checks.filter((c) => c.passed);
  const missing = outcome.checks.filter((c) => !c.passed);
  return (
    <div className="ui-goal-proof">
      {explainer ? <ProofHow /> : null}
      {missing.length > 0 ? <MissingList outcome={outcome} /> : null}
      {built.length > 0 ? <ProofGroup title="In place" tone="good" checks={built} /> : null}
      <HowYouKnow outcome={outcome} />
    </div>
  );
}
