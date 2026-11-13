// What the safety check found, below its verdict.
//
//   • Worth fixing — the things actually wrong (rules broken + clashes with
//     another version), as rows of the shared check list. The only blocking
//     list.
//   • Good to know — context, folded: what else it touches, changes with no
//     note, style nudges. Real engine output, but not defects, so it never
//     inflates the headline.

import { AlertTriangle, X } from "lucide-react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { humanizeFindingText } from "../../lib/humanizeFinding";

type Severity = "high" | "med";

// Category derived from where a finding came from, mapped onto Aura's
// invariant model: forbidden call → security, layer rule → architecture,
// cross-branch → conflict.
type Category = "security" | "architecture" | "conflict";

export type Finding = {
  severity: Severity;
  source: string;
  text: string;
  category: Category;
};

export function WorthFixing({ problems }: { problems: Finding[] }) {
  if (problems.length === 0) return null;
  return (
    <section>
      <div className="ui-log-note-files-head">
        <span>Worth fixing</span>
        <span className="ui-log-note-count">{problems.length}</span>
      </div>
      <div className="ui-check-runs ui-check-box">
        {problems.map((f, i) => (
          <div key={i} data-status={f.severity === "high" ? "failed" : "attention"}>
            {f.severity === "high" ? <X size={14} /> : <AlertTriangle size={14} />}
            <span>
              {humanizeFindingText(f.text)}
              {/* The kind of problem is a label, not an alarm: the mark
                  already carries the "look at me". */}
              <small>
                {categoryLabel(f.category)} · {sourceLabel(f.source)}
              </small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

const IMPACT_CAP = 80;
const TASTE_CAP = 40;

export function GoodToKnow({
  impact,
  unverified,
  unverifiedTotal,
  taste,
}: {
  impact: string[];
  unverified: Record<string, number>;
  unverifiedTotal: number;
  taste: string[];
}) {
  const count = impact.length + unverifiedTotal + taste.length;
  if (count === 0) return null;
  return (
    <section>
      <div className="ui-log-note-files-head">
        <span>Good to know</span>
        <span className="ui-log-note-count">{count}</span>
      </div>
      <Accordion type="multiple">
        {impact.length > 0 && (
          <AccordionItem value="impact">
            <AccordionTrigger>What else this touches · {impact.length}</AccordionTrigger>
            <AccordionContent>
              <p>Other parts of the code that lean on what changed. Worth a look, but not problems.</p>
              <Capped items={impact} cap={IMPACT_CAP} />
            </AccordionContent>
          </AccordionItem>
        )}
        {unverifiedTotal > 0 && (
          <AccordionItem value="unnoted">
            <AccordionTrigger>Changes with no note · {unverifiedTotal}</AccordionTrigger>
            <AccordionContent>
              <p>
                Some logic changed without a note saying why. Adding a quick note keeps the history
                clear for later.
              </p>
              <ul className="ui-check-report-list">
                {Object.entries(unverified)
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, n]) => (
                    <li key={kind} data-count="">
                      <span>{kind}</span>
                      <span>{n}</span>
                    </li>
                  ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        )}
        {taste.length > 0 && (
          <AccordionItem value="style">
            <AccordionTrigger>Style · {taste.length}</AccordionTrigger>
            <AccordionContent>
              <p>
                Small style suggestions Aura picked up from this repository. Not problems, just
                gentle nudges.
              </p>
              <Capped items={taste} cap={TASTE_CAP} />
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </section>
  );
}

function Capped({ items, cap }: { items: string[]; cap: number }) {
  return (
    <ul className="ui-check-report-list">
      {items.slice(0, cap).map((t, i) => (
        <li key={i}>{t}</li>
      ))}
      {items.length > cap && <li className="ui-check-box-more">…and {items.length - cap} more</li>}
    </ul>
  );
}

// Plain-word labels — non-engineers don't read "architecture" / "invariant" /
// "cross-branch".
function categoryLabel(c: Category): string {
  switch (c) {
    case "security":
      return "Safety";
    case "architecture":
      return "Structure";
    case "conflict":
    default:
      return "Clash";
  }
}

function sourceLabel(source: string): string {
  if (source === "invariant") return "broke a rule";
  if (source === "cross-branch") return "clashes with another version";
  return source;
}

// Derive a finding's severity + category from the engine's own wording
// rather than hardcoding "high" on every row. The four real invariant shapes
// (pr.rs): "Forbidden Call…", "Layer Violation…", "Protected Node
// Modified…", "Protected Node Deleted…". Deleting a protected node or making
// a forbidden/layer-crossing call blocks a merge (high); *modifying* a
// protected-but-allowed block is a warning to look twice (med).
export function classifyViolation(text: string): { severity: Severity; category: Category } {
  if (text.startsWith("Forbidden")) return { severity: "high", category: "security" };
  if (text.startsWith("Layer Violation")) return { severity: "high", category: "architecture" };
  if (text.startsWith("Protected Node Deleted")) return { severity: "high", category: "security" };
  if (text.startsWith("Protected Node Modified")) return { severity: "med", category: "security" };
  // Unknown invariant text → treat as a blocking architectural finding.
  return { severity: "high", category: "architecture" };
}
