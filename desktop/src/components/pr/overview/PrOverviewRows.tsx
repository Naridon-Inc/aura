// The rows a pull request's details list adds after Branch, Review and
// Merge: its checks, the safety check, labels, the stack it sits in, the
// issues it closes, who it's assigned to and its open review threads. Each
// is a term and a value in the page's one details list.

import { useEffect, useState } from "react";
import {
  ChevronDown,
  CircleCheck,
  CircleDot,
  Layers,
  MessagesSquare,
  ShieldCheck,
  Tag,
  UserRound,
} from "lucide-react";
import type { AuraReviewPayload, PrLabel, PrRelatedIssue, PrStackNode } from "../../../lib/api";
import { useEditorStore } from "../../../lib/editorStore";
import { onExternalAnchorClick } from "../../../lib/openExternal";
import { prLabelsList, prLabelsSet, prStack } from "../../../lib/prApi";
import { invalidatePrDetail } from "../../../lib/prDetailCache";
import { fetchPrList, invalidatePrList, patchCachedPr } from "../../../lib/prsCache";
import { REVIEW_CHANNELS } from "../../../lib/reviewVerdict";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { TraceMark } from "../../ui/trace-list";
import { riskMarkTone, stackOrder, type PrChecksTally } from "./prOverviewModel";
import { useSafetyCheck } from "./useSafetyCheck";

export function ChecksRow({ checks, onView }: { checks: PrChecksTally | null; onView: () => void }) {
  return (
    <>
      <dt>
        <CircleCheck />
        Checks
      </dt>
      <dd>
        {!checks ? (
          "Not reported"
        ) : checks.total === 0 ? (
          "No checks"
        ) : (
          <>
            {checks.passing}/{checks.total} passed
            {checks.failing > 0 && <TraceMark tone="danger">{checks.failing} failing</TraceMark>}
            {checks.pending > 0 && <TraceMark tone="warn">{checks.pending} running</TraceMark>}
          </>
        )}
        <Button variant="ghost" size="xs" onClick={onView}>
          View checks
        </Button>
      </dd>
    </>
  );
}

/** Channel colour as a mark tone; the calmer channels stay neutral. */
function channelTone(tone: string): "danger" | "warn" | undefined {
  return tone === "red" ? "danger" : tone === "amber" ? "warn" : undefined;
}

export function SafetyRow({
  repoRoot,
  prNumber,
  baseRef,
  review,
  reviewError,
  onViewFindings,
}: {
  repoRoot: string;
  prNumber: number;
  baseRef: string;
  review: AuraReviewPayload | null;
  /** Why the report couldn't be read, when it couldn't. */
  reviewError: string | null;
  onViewFindings: () => void;
}) {
  const check = useSafetyCheck(repoRoot, prNumber, baseRef);
  const error = check.error ?? reviewError;
  return (
    <>
      <dt title="A second set of eyes: broken rules, what else the change touches, and anything left unproven">
        <ShieldCheck />
        Safety
      </dt>
      <dd>
        {check.running ? (
          <>
            <AsciiSpinner />
            <span>Checking… {check.elapsed}s</span>
          </>
        ) : review ? (
          <>
            <TraceMark tone={riskMarkTone(review.risk_score)} title="How risky this change looks, scored 0–100">
              {review.risk_label || "Risk"} · {review.risk_score}/100
            </TraceMark>
            {REVIEW_CHANNELS.map((ch) => {
              const n = ch.items(review).length;
              return n > 0 ? (
                <TraceMark key={ch.key} tone={channelTone(ch.tone)} title={ch.label}>
                  {n} {n === 1 ? ch.one : ch.many}
                </TraceMark>
              ) : null;
            })}
          </>
        ) : (
          <span>Not checked yet</span>
        )}
        {error && !check.running && (
          <TraceMark tone="danger" title={error.length > 800 ? `${error.slice(0, 800)}…` : error}>
            check failed
          </TraceMark>
        )}
        <span className="ui-pr-row-actions">
          {review && (
            <Button variant="ghost" size="xs" onClick={onViewFindings}>
              View findings
            </Button>
          )}
          <Button variant="ghost" size="xs" disabled={check.running} onClick={() => void check.run()}>
            {review ? "Re-run" : "Run safety check"}
          </Button>
        </span>
      </dd>
    </>
  );
}

/** A label's GitHub colour, as the chip's dot. */
function labelDot(hex: string): string | undefined {
  return /^[0-9a-f]{6}$/i.test(hex.trim()) ? `#${hex.trim()}` : undefined;
}

export function LabelsRow({ repoRoot, prNumber }: { repoRoot: string; prNumber: number }) {
  const [labels, setLabels] = useState<PrLabel[]>([]);
  const [all, setAll] = useState<PrLabel[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPrList(repoRoot)
      .then((list) => {
        const me = list.find((p) => p.number === prNumber);
        if (alive && me) setLabels(me.labels);
      })
      .catch(() => {
        /* keep what's shown */
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, prNumber]);

  const loadAll = (open: boolean) => {
    if (!open || all) return;
    prLabelsList(repoRoot)
      .then(setAll)
      .catch(() => setAll([]));
  };

  const toggle = async (label: PrLabel, on: boolean) => {
    const next = on ? [...labels, label] : labels.filter((l) => l.name !== label.name);
    const before = labels;
    setLabels(next);
    try {
      await prLabelsSet(repoRoot, prNumber, next.map((l) => l.name));
      // Other panes read the cached list; patch it, then refetch for truth.
      patchCachedPr(repoRoot, prNumber, { labels: next });
      void invalidatePrList(repoRoot);
      void invalidatePrDetail(repoRoot, prNumber);
    } catch (e) {
      setLabels(before);
      window.dispatchEvent(
        new CustomEvent("aura:toast", {
          detail: { kind: "error", text: `Couldn't change labels: ${e instanceof Error ? e.message : String(e)}` },
        }),
      );
    }
  };

  const chosen = new Set(labels.map((l) => l.name));
  return (
    <>
      <dt>
        <Tag />
        Labels
      </dt>
      <dd>
        {labels.length === 0
          ? "None"
          : labels.map((l) => (
              <span key={l.name} className="ui-pr-label" title={l.description || l.name}>
                <i style={{ background: labelDot(l.color) }} />
                {l.name}
              </span>
            ))}
        <DropdownMenu onOpenChange={loadAll}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs">
              Edit labels
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Labels</DropdownMenuLabel>
            {all == null ? (
              <DropdownMenuLabel>
                <AsciiSpinner />
              </DropdownMenuLabel>
            ) : all.length === 0 ? (
              <DropdownMenuLabel>This repository has no labels.</DropdownMenuLabel>
            ) : (
              all.map((l) => (
                <DropdownMenuCheckboxItem
                  key={l.name}
                  checked={chosen.has(l.name)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) => void toggle(l, on === true)}
                >
                  <span className="ui-pr-label" data-bare>
                    <i style={{ background: labelDot(l.color) }} />
                    {l.name}
                  </span>
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </dd>
    </>
  );
}

export function StackRow({ repoRoot, prNumber }: { repoRoot: string; prNumber: number }) {
  const editor = useEditorStore();
  const [nodes, setNodes] = useState<PrStackNode[]>([]);
  useEffect(() => {
    let alive = true;
    prStack(repoRoot, prNumber)
      .then((list) => {
        if (alive) setNodes(stackOrder(list));
      })
      .catch(() => {
        if (alive) setNodes([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, prNumber]);
  // A pull request alone isn't a stack.
  if (nodes.length < 2) return null;
  return (
    <>
      <dt>
        <Layers />
        Stack
      </dt>
      <dd>
        {nodes.map((n, i) => (
          <span key={n.number} className="ui-pr-stack-step">
            {i > 0 && <span aria-hidden>→</span>}
            <button
              type="button"
              className="ui-pr-stack-link"
              data-current={n.number === prNumber || undefined}
              data-state={n.state.toLowerCase()}
              title={n.title}
              disabled={n.number === prNumber}
              onClick={() => editor.openPrDetail(repoRoot, n.number, n.title)}
            >
              #{n.number}
            </button>
          </span>
        ))}
      </dd>
    </>
  );
}

export function IssuesRow({ issues }: { issues: PrRelatedIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <>
      <dt>
        <CircleDot />
        Closes
      </dt>
      <dd>
        {issues.map((i) => (
          <a
            key={i.number}
            className="ui-pr-issue"
            href={i.url}
            onClick={onExternalAnchorClick}
            title={i.title}
            data-state={i.state.toLowerCase()}
          >
            #{i.number} {i.title}
          </a>
        ))}
      </dd>
    </>
  );
}

export function AssigneesRow({ assignees }: { assignees: string[] }) {
  if (assignees.length === 0) return null;
  return (
    <>
      <dt>
        <UserRound />
        Assigned
      </dt>
      <dd>{assignees.join(", ")}</dd>
    </>
  );
}

export function ThreadsRow({
  threads,
  onOpen,
}: {
  threads: { total: number; unresolved: number };
  onOpen: () => void;
}) {
  if (threads.total === 0) return null;
  return (
    <>
      <dt>
        <MessagesSquare />
        Threads
      </dt>
      <dd>
        {threads.unresolved === 0 ? (
          <>All {threads.total} resolved</>
        ) : (
          <>
            <TraceMark tone="warn">{threads.unresolved} open</TraceMark>
            of {threads.total}
          </>
        )}
        <Button variant="ghost" size="xs" onClick={onOpen}>
          Open threads
        </Button>
      </dd>
    </>
  );
}
