// The session Alignment tab's "What changed": one item per piece, the ones
// worth a second look first. Capabilities lead — the named things a person can
// reason about (a function, a class, a component). Bare values (a local, a
// constant) are internal mechanics: kept, but folded under a quiet disclosure
// so the real features read first. With no capabilities, the values stand
// alone and open by default.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../../ui/button";
import { TraceMark } from "../../ui/trace-list";
import { TraceItems, TraceLine } from "../../ui/trace-report";
import {
  deriveNodes,
  isCapabilityNode,
  riskScore,
  type IntentReport,
  type NodeRef,
} from "../intentStory/intentReport";
import { PIECE_LIMIT, PieceItem } from "../intentStory/StoryParts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function AlignmentChanged({
  report,
  onDismiss,
}: {
  report: IntentReport;
  onDismiss?: () => void;
}) {
  const nodes = useMemo(() => deriveNodes(report), [report]);
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => {
    // Risk-first, not match-first: anything worth a second look floats up so
    // it's the first thing seen. Ordinary edits and additions settle below.
    const rank = { modified: 0, added: 1, deleted: 2 } as const;
    return [...nodes].sort((a, b) => {
      const d = riskScore(b) - riskScore(a);
      return d !== 0 ? d : rank[a.change] - rank[b.change];
    });
  }, [nodes]);
  const capabilities = useMemo(() => sorted.filter(isCapabilityNode), [sorted]);
  const values = useMemo(() => sorted.filter((n) => !isCapabilityNode(n)), [sorted]);

  const files = report.changed_files.length;
  if (nodes.length === 0) {
    return (
      <TraceLine>
        No code-level changes to break down here
        {files > 0 &&
          `. The ${plural(files, "changed file")} changed in a way Aura doesn’t track piece by piece (settings, data, or generated files)`}
        .
      </TraceLine>
    );
  }

  const shown = showAll ? capabilities : capabilities.slice(0, PIECE_LIMIT);
  const more = capabilities.length - PIECE_LIMIT;
  // A possible secret or an unfinished bit; a deletion alone isn't flagged.
  const flagged = nodes.filter((n) => riskScore(n) > 1).length;

  return (
    <div className="ui-story-did">
      <div className="ui-story-counts">
        <span>
          {plural(nodes.length, "change")}
          {files > 0 && ` · ${plural(files, "file")}`}
        </span>
        {flagged > 0 && <TraceMark tone="warn">{flagged} worth a look</TraceMark>}
      </div>
      {shown.length > 0 && <Pieces nodes={shown} onDismiss={onDismiss} />}
      {more > 0 && (
        <Button variant="ghost" size="xs" type="button" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show ${more} more`}
        </Button>
      )}
      {values.length > 0 && (
        <SupportingChanges
          nodes={values}
          onDismiss={onDismiss}
          defaultOpen={capabilities.length === 0}
        />
      )}
    </div>
  );
}

function Pieces({ nodes, onDismiss }: { nodes: NodeRef[]; onDismiss?: () => void }) {
  return (
    <TraceItems>
      {nodes.map((node, i) => (
        <PieceItem
          key={`${node.identifier}-${i}`}
          node={node}
          judge="risk"
          plainName
          onDone={onDismiss}
        />
      ))}
    </TraceItems>
  );
}

// Internal values (locals, constants) that changed — real, but not new
// features. A non-engineer can open them for the full picture.
function SupportingChanges({
  nodes,
  onDismiss,
  defaultOpen,
}: {
  nodes: NodeRef[];
  onDismiss?: () => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ui-story-supporting">
      <Button
        variant="ghost"
        size="xs"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        {plural(nodes.length, "supporting change")}
        <small>Internal values, not new features</small>
      </Button>
      {open && <Pieces nodes={nodes} onDismiss={onDismiss} />}
    </div>
  );
}
