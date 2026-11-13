// A goal, opened, told as a short story in Trace's one column: what it means,
// what shows it is done and what is still missing, and where in the code it
// lives. Each part is one plain line with one muted line under it. Back, or
// Esc, returns to the list with the same goal marked.

import { useEffect, useState } from "react";
import { useEditorStore } from "../../../lib/editorStore";
import { writeClipboardText } from "../../../lib/clipboard";
import { plainPreview } from "../../../lib/plainPreview";
import { shortDate } from "../../../lib/calendarDate";
import { isEditableTarget } from "../../../lib/keymap";
import {
  capabilityPhrase,
  finishAllInstruction,
  humanizeIdentifier,
  statusTag,
  whyItMatters,
  type ProveCheck,
  type ProveOutcome,
} from "../../../lib/prove";
import { useGoalsForTask, verdictFromOutcome, type GoalRun } from "../../../lib/goalStore";
import { VERDICT } from "../../../lib/goalVerdict";
import type { TaskGoal } from "../../../lib/taskGoals";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { TraceMark } from "../../ui/trace-list";
import {
  TraceStory,
  TraceStoryBack,
  TraceStoryChapter,
  TraceStoryMeta,
  TraceStoryText,
  TraceStoryTitle,
} from "../../ui/trace-story";
import { TraceTimeline, TraceTimelineEntry } from "../../ui/trace-timeline";
import { CheckedWhen, VerdictMark, boardFacts } from "./GoalMoment";
import { MomentFacts } from "./SessionMoment";
import { StoryLinks } from "./StoryLinks";
import { clipText } from "./sessionStoryText";
import { PARTS_SHOWN, claimsDoneButNot, partsSentence, requirementTitle, splitPath } from "./goalStoryText";

type Copy = "idle" | "copied" | "failed";

export function GoalStory({
  repoRoot,
  goal,
  outcome,
  busy,
  errored,
  onCheck,
  onBack,
}: {
  repoRoot: string;
  goal: TaskGoal;
  /** The full proof from a check run since the page opened, when there is one. */
  outcome: ProveOutcome | null;
  busy: boolean;
  errored: boolean;
  onCheck: () => void;
  onBack: () => void;
}) {
  const editor = useEditorStore();
  const [allParts, setAllParts] = useState(false);
  const [allFiles, setAllFiles] = useState(false);
  const [copy, setCopy] = useState<Copy>("idle");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isEditableTarget(e.target)) return;
      e.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // The freshest answer wins: a check run now, else the one the ledger kept.
  const fresh = outcome ? verdictFromOutcome(outcome) : null;
  const verdict = fresh?.verdict ?? goal.verdict;
  const ok = fresh?.ok ?? goal.ok;
  const total = fresh?.total ?? goal.total;
  // The ledger's record: its newest run knows the commit and the files, and its
  // cached breakdown names the parts before anything is checked.
  const record = useGoalsForTask(repoRoot, goal.taskId)[0] ?? null;
  const latestRun: GoalRun | null = record?.runs[0] ?? null;
  const requirements = record?.decomposition?.requirements ?? [];
  const meaning = plainPreview(goal.description);
  const doneButNot = claimsDoneButNot(goal.taskStatus, verdict);
  const checks: ProveCheck[] = outcome
    ? [...outcome.checks.filter((c) => !c.passed), ...outcome.checks.filter((c) => c.passed)]
    : [];
  const finish = outcome ? finishAllInstruction(outcome) : "";
  const openTask = () => editor.openTaskDetail(goal.taskId, repoRoot);

  const copyFinish = async () => {
    const done = await writeClipboardText(finish);
    setCopy(done ? "copied" : "failed");
    window.setTimeout(() => setCopy("idle"), 1800);
  };

  const meta = (
    <MomentFacts
      facts={[
        errored ? (
          <TraceMark tone="danger">Couldn&apos;t check</TraceMark>
        ) : (
          <VerdictMark verdict={busy ? "unknown" : verdict} ok={ok} total={total} />
        ),
        goal.at ? <CheckedWhen at={goal.at} /> : null,
        ...boardFacts(goal, verdict),
      ]}
    />
  );

  const check = (
    <Button variant="ghost" size="xs" onClick={onCheck} disabled={busy} title="Check it against the code as it is now">
      {busy ? "Checking…" : goal.at || outcome ? "Check again" : "Check it now"}
    </Button>
  );

  const shownChecks = allParts ? checks : checks.slice(0, PARTS_SHOWN);
  const shownReqs = allParts ? requirements : requirements.slice(0, PARTS_SHOWN);
  const files = latestRun?.files ?? [];
  const shownFiles = allFiles ? files : files.slice(0, PARTS_SHOWN);

  return (
    <TraceStory label="Goal">
      <TraceStoryBack onBack={onBack} actions={check}>
        Goals
      </TraceStoryBack>
      <TraceStoryTitle meta={meta}>{goal.text}</TraceStoryTitle>

      {meaning && (
        <TraceStoryChapter title="What it means">
          <TraceStoryText>{clipText(meaning).text}</TraceStoryText>
        </TraceStoryChapter>
      )}

      <TraceStoryChapter title="What shows it's done">
        {busy ? (
          <TraceStoryMeta>
            <AsciiSpinner size={10} /> Reading the code for each part…
          </TraceStoryMeta>
        ) : (
          <>
            {doneButNot && (
              <TraceStoryText>
                It&apos;s marked done on the board, but the code doesn&apos;t fully back that up yet.
              </TraceStoryText>
            )}
            {verdict !== "unknown" && (
              <TraceStoryText>{partsSentence(ok, total) ?? VERDICT[verdict].hint}</TraceStoryText>
            )}
            {outcome?.error && <TraceStoryMeta>{outcome.error}</TraceStoryMeta>}
            {errored && (
              <TraceStoryMeta>The check couldn&apos;t run. Check your setup, then try again.</TraceStoryMeta>
            )}
          </>
        )}

        {!busy && checks.length > 0 && (
          <TraceTimeline label="Parts this goal needs">
            {shownChecks.map((c, i) => (
              <TraceTimelineEntry
                key={`${c.node_name}-${i}`}
                title={capabilityPhrase(c)}
                detail={
                  c.passed ? (
                    <MomentFacts facts={[<TraceMark key="m" tone="good">in place</TraceMark>]} />
                  ) : (
                    <MomentFacts facts={[<TraceMark key="m" tone="warn">{statusTag(c)}</TraceMark>, whyItMatters(c)]} />
                  )
                }
              />
            ))}
          </TraceTimeline>
        )}
        {!busy && !outcome && requirements.length > 0 && (
          <TraceTimeline label="Parts this goal needs">
            {shownReqs.map((r, i) => (
              <TraceTimelineEntry
                key={`${r.nodeName}-${i}`}
                title={requirementTitle(r)}
                detail={
                  r.mustCall ? <MomentFacts facts={[`should reach ${humanizeIdentifier(r.mustCall)}`]} /> : undefined
                }
              />
            ))}
          </TraceTimeline>
        )}
        {!busy && !outcome && (
          <TraceStoryMeta>
            {requirements.length === 0
              ? "Check it to see what was built and what is still missing."
              : verdict === "unknown"
                ? "Check it to see which of these the code has."
                : "Check again to see which of these are in place."}
          </TraceStoryMeta>
        )}
        {!busy && outcome && checks.length > 0 && (
          <TraceStoryMeta>Aura read the code for each part. It didn&apos;t run anything.</TraceStoryMeta>
        )}
        <StoryLinks
          links={[
            !busy && Math.max(checks.length, outcome ? 0 : requirements.length) > PARTS_SHOWN && !allParts && {
              label: `Show all ${Math.max(checks.length, outcome ? 0 : requirements.length)} parts`,
              go: () => setAllParts(true),
            },
            !busy && !!finish && {
              label:
                copy === "copied"
                  ? "Copied. Paste it to your agent"
                  : copy === "failed"
                    ? "Couldn't copy"
                    : "Ask your agent to finish the rest",
              go: () => void copyFinish(),
              title: finish,
            },
          ]}
        />
      </TraceStoryChapter>

      {latestRun && (files.length > 0 || latestRun.commit) && (
        <TraceStoryChapter title="Where it lives">
          {files.length > 0 ? (
            <TraceTimeline label="Files that deliver it">
              {shownFiles.map((f) => {
                const p = splitPath(f);
                return <TraceTimelineEntry key={f} title={p.name} detail={<MomentFacts facts={[<code key="f">{p.folder}</code>]} />} />;
              })}
            </TraceTimeline>
          ) : (
            <TraceStoryText>It was checked, but no files were pinpointed yet.</TraceStoryText>
          )}
          <LastChecked run={latestRun} />
          <StoryLinks
            links={[
              files.length > PARTS_SHOWN && !allFiles && { label: `Show all ${files.length} files`, go: () => setAllFiles(true) },
            ]}
          />
        </TraceStoryChapter>
      )}

      <StoryLinks links={[{ label: "Open this task on the board", go: openTask }]} />
    </TraceStory>
  );
}

function LastChecked({ run }: { run: GoalRun }) {
  const when = run.at ? shortDate(run.at) : null;
  if (!run.commit && !when) return null;
  return (
    <MomentFacts
      facts={[run.commit && <>Last checked at commit <code>{run.commit}</code></>, when]}
    />
  );
}
