// The change story's smaller parts: who wrote a line, the pieces a change
// touched (the "Did" beat), and the mark a verdict wears. Drawn with the
// report column's pieces — an item per piece with its state glyph at the left
// edge, marks on the title line, quiet lines under it — so the story reads
// like the session Summary beside it rather than as a stack of cards.

import { useMemo, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { intentTypeChip } from "@shared/intentTypeLabels";
import { sentenceCase } from "@shared/textCase";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { humanizeIdentifier } from "../../../lib/prove";
import { AgentIcon } from "../../agent/AgentIcon";
import { StoryMarkdown } from "../../story/StoryMarkdown";
import { goToTrace } from "../../trace/traceRoute";
import { changeMark, changeWord } from "../changeNote/changeWords";
import { Button } from "../../ui/button";
import { TraceMark } from "../../ui/trace-list";
import { type TraceTone, TraceItem, TraceItems, TraceLine } from "../../ui/trace-report";
import {
  deriveNodes,
  kindNoun,
  type IntentReport,
  type NodeRef,
  type VerdictTone,
} from "./intentReport";
import "../../trace/changes/changes.css";
import "../../ui/intent-story.css";

/** Who wrote a line, and when: the agent's mark and name, then whatever
 *  says what kind of line it is. */
export function StoryByline({
  agentId,
  when,
  children,
}: {
  agentId: string;
  when: string;
  children?: ReactNode;
}) {
  const canonical = canonicalAgentId(agentId);
  const name = agentDisplayLabel(canonical);
  return (
    <div className="ui-story-byline">
      <span className="ui-story-agent" title={name}>
        <AgentIcon agentId={canonical} label={name} size={14} />
        <span>{name}</span>
      </span>
      {children}
      <small>{when}</small>
    </div>
  );
}

/** The kind of a logged line ("Feature", "Fix", …) as a quiet mark. */
export function TypeMark({ type }: { type: string }) {
  return <TraceMark>{intentTypeChip(type)}</TraceMark>;
}

const VERDICT_ICON = {
  "✓": CircleCheck,
  "–": CircleAlert,
  "✗": CircleX,
  "?": CircleHelp,
} as const;

/** The verdict's glyph as the library's 14px status icon. Takes the glyph
 *  `verdictGlyph` chose rather than deciding again, so the header and the
 *  beat can never disagree. */
export function VerdictIcon({ glyph }: { glyph: string }) {
  const Icon = VERDICT_ICON[glyph as keyof typeof VERDICT_ICON] ?? CircleHelp;
  return <Icon />;
}

/** The verdict tone as a mark's tone (the mark calls "bad" danger). */
export function markTone(tone: VerdictTone): "good" | "warn" | "danger" {
  return tone === "bad" ? "danger" : tone;
}

/** How many pieces a list draws before it offers the rest. */
export const PIECE_LIMIT = 18;

/** The heart: what changed, one item per piece. Uncovered pieces — the risk —
 *  come first. */
export function DidBeat({ report }: { report: IntentReport }) {
  const nodes = useMemo(() => deriveNodes(report), [report]);
  const [showAll, setShowAll] = useState(false);
  // All hooks run before any early return (Rules of Hooks).
  const sorted = useMemo(() => {
    const rank = { modified: 0, added: 1, deleted: 2 } as const;
    return [...nodes].sort((a, b) => {
      // Uncovered (not named in the task) is the risk — float it up.
      const ca = a.covered ? 1 : 0;
      const cb = b.covered ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return rank[a.change] - rank[b.change];
    });
  }, [nodes]);

  const files = report.changed_files.length;
  const plural = files === 1 ? "" : "s";
  if (nodes.length === 0) {
    return (
      <TraceLine>
        No code-level changes detected{files > 0 ? ` in ${files} changed file${plural}` : ""}.
      </TraceLine>
    );
  }

  const shown = showAll ? sorted : sorted.slice(0, PIECE_LIMIT);
  const uncovered = nodes.filter((n) => !n.covered).length;
  const more = sorted.length - PIECE_LIMIT;

  return (
    <div className="ui-story-did">
      <div className="ui-story-counts">
        <span>
          {nodes.length} piece{nodes.length === 1 ? "" : "s"} · {files} file{plural}
        </span>
        {uncovered > 0 && <TraceMark tone="warn">{uncovered} not in your ask</TraceMark>}
      </div>
      <TraceItems>
        {shown.map((node, i) => (
          <PieceItem key={`${node.identifier}-${i}`} node={node} />
        ))}
      </TraceItems>
      {more > 0 && (
        <Button variant="ghost" size="xs" type="button" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show ${more} more piece${more === 1 ? "" : "s"}`}
        </Button>
      )}
    </div>
  );
}

type PieceItemProps = {
  node: NodeRef;
  /** Judge the piece by the ask (settled when the task named it) or by risk
   *  alone — the session tab keeps no match score, only what is worth a look. */
  judge?: "ask" | "risk";
  /** Lead with the plain-language name, the exact symbol moved to the line
   *  under it. For readers who didn't write the code. */
  plainName?: boolean;
  /** Runs after Open / Bring this back fire. Both land in the editor, so a
   *  surface drawn over it closes here or the click looks dead. */
  onDone?: () => void;
};

function pieceTone(node: NodeRef, judge: "ask" | "risk"): TraceTone {
  if (judge === "ask") return node.covered === false ? "warn" : "good";
  if (node.contains_secret) return "bad";
  return node.is_stub ? "warn" : "good";
}

/** One changed piece: its change mark and name, what kind of thing it is,
 *  what is worth a look, and the two ways to act on it. */
export function PieceItem({ node, judge = "ask", plainName = false, onDone }: PieceItemProps) {
  const file = node.file ?? undefined;
  const line = node.start_line ?? undefined;
  const where = file ? `${file}${line ? `:${line}` : ""}` : null;
  const kind = kindNoun(node.kind);
  const word = changeWord(node.change);
  const plain = plainName
    ? sentenceCase(humanizeIdentifier(node.identifier)) || node.identifier
    : node.identifier;

  const openFile = () => {
    if (!file) return;
    window.dispatchEvent(new CustomEvent("aura:open-file", { detail: { path: file, line } }));
    onDone?.();
  };
  const bringBack = () => {
    goToTrace({ kind: "tool", tool: "rewind", arg: { identifier: node.identifier, file } });
    onDone?.();
  };

  return (
    <TraceItem
      tone={pieceTone(node, judge)}
      title={
        <>
          <span className="ui-changes-status" data-status={node.change} title={word}>
            {changeMark(node.change)}
          </span>
          <span
            className="ui-story-piece-name"
            data-plain={plainName || undefined}
            title={node.identifier}
          >
            {plain}
          </span>
        </>
      }
      marks={
        <>
          <TraceMark>{kind ? `${word} ${kind}` : word}</TraceMark>
          {judge === "ask" && node.covered === false && (
            <TraceMark tone="warn" title="This code changed, but it wasn't part of what you asked for">
              not in your ask
            </TraceMark>
          )}
          {node.is_stub && (
            <TraceMark tone="warn" title="Looks unfinished: a TODO or a placeholder">
              unfinished
            </TraceMark>
          )}
          {node.contains_secret && (
            <TraceMark tone="danger" title="Looks like a password or key written into the code">
              possible secret
            </TraceMark>
          )}
        </>
      }
      actions={
        <>
          {file && (
            <Button
              variant="outline"
              size="xs"
              type="button"
              onClick={openFile}
              title={`Open ${where}`}
            >
              Open
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            type="button"
            onClick={bringBack}
            title="Put this piece back the way it was"
          >
            Bring this back
          </Button>
        </>
      }
    >
      {plainName ? (
        <p className="ui-story-piece-where" title={where ?? node.identifier}>
          {where ? `${node.identifier} · ${where}` : node.identifier}
        </p>
      ) : (
        where && (
          <p className="ui-story-piece-where" title={file}>
            {where}
          </p>
        )
      )}
      {node.signature && (
        <p className="ui-story-piece-where" title={node.signature}>
          {node.signature}
        </p>
      )}
      {node.rationale && <StoryMarkdown compact>{node.rationale}</StoryMarkdown>}
    </TraceItem>
  );
}
