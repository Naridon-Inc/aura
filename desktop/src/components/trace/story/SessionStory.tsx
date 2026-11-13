// A session, opened, told as a short story in Trace's one column: what was
// asked, what the agent did, what changed, and whether it was checked. Each
// chapter is a few plain sentences. The whole conversation, every changed line
// and the comparison of the ask with the change sit one link down, in the
// session's deep view, opened on the part the link names. Back, or Esc,
// returns to the list with the same moment marked.

import { useEffect } from "react";
import type { IntentRow } from "../../../lib/api";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { isEditableTarget } from "../../../lib/keymap";
import { intentTypeSentence } from "@shared/intentTypeLabels";
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
import { SessionActions } from "../../workpanes/SessionActions";
import type { SessionDetailView } from "../../workpanes/SessionDetailPane";
import { SealCheck } from "../SealCheck";
import { useSessionDetail } from "../useSessionDetail";
import { LinesChanged, MomentFacts, filesWord } from "./SessionMoment";
import { StoryLinks, type StoryLink } from "./StoryLinks";
import {
  FILES_SHOWN,
  clipText,
  fileStory,
  whatItSaid,
  whatWasAsked,
  workSentence,
} from "./sessionStoryText";

export function SessionStory({
  repoRoot,
  row,
  paused = false,
  onBack,
  onOpenDeep,
}: {
  repoRoot: string;
  row: IntentRow;
  /** The deep view is open over the story: it owns Esc until it closes. */
  paused?: boolean;
  onBack: () => void;
  onOpenDeep: (view: SessionDetailView, file?: string) => void;
}) {
  const detail = useSessionDetail({ repoRoot, row });
  const { sess, files, isBlocked, churn, symbolsByFile, workers } = detail;

  useEffect(() => {
    if (paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isEditableTarget(e.target)) return;
      e.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused, onBack]);

  const asked = whatWasAsked(sess?.first_prompt, detail.provenance, detail.statement);
  const said = isBlocked ? null : whatItSaid(detail.provenance, detail.statement, asked, detail.shownHeadline);
  const work = workSentence(sess?.step_count ?? 0, sess?.turn_count ?? 0, workers.length);
  const sealed = !!row.signed_block_id;
  const askedClip = asked ? clipText(asked) : null;
  // A stopped commit's reason, less the line the title already says.
  const stopped = isBlocked ? whatItSaid("stated", detail.statement, asked, detail.shownHeadline) : null;
  const saidClip = said ? clipText(said.text) : null;

  const meta = (
    <MomentFacts
      lock={sealed ? "sealed" : "open"}
      facts={[
        <time key="t" dateTime={new Date(row.timestamp * 1000).toISOString()} title={detail.whenAbsolute}>
          {detail.rel}
        </time>,
        agentDisplayLabel(canonicalAgentId(row.agent_id)),
        files.length > 0 && filesWord(files.length),
        churn.hasChurn && <LinesChanged added={churn.adds} removed={churn.dels} />,
        isBlocked && <TraceMark tone="danger">Stopped by a check</TraceMark>,
        !isBlocked && row.intent_type && intentTypeSentence(row.intent_type),
        row.branch && `on ${row.branch}`,
      ]}
    />
  );

  const actions = (
    <SessionActions
      repoRoot={repoRoot}
      sess={sess}
      managerSessionId={detail.managerSessionId}
      managerLabel={detail.title}
      files={files}
      symbolsByFile={symbolsByFile}
      agentId={row.agent_id}
      worktree={row.worktree ?? null}
      onDismiss={onBack}
    />
  );

  const conversation: StoryLink | null = detail.hasTranscript
    ? { label: "Read the whole conversation", go: () => onOpenDeep("transcript") }
    : null;

  return (
    <TraceStory label="Session">
      {/* A commit that was stopped never landed: nothing to resume or rewind. */}
      <TraceStoryBack onBack={onBack} actions={isBlocked ? undefined : actions} />
      <TraceStoryTitle meta={meta}>{detail.shownHeadline}</TraceStoryTitle>
      {/* The story is the short read; the full session is every message and
          tool call with its filters. One click from the top, not a link
          buried under the chapter that happens to clip. */}
      <StoryLinks
        links={[
          {
            label: "Open full session",
            title: "Every message, tool call and change, with filters",
            go: () => onOpenDeep(detail.hasTranscript ? "transcript" : "summary"),
          },
        ]}
      />

      {(askedClip || !isBlocked) && (
        <TraceStoryChapter title="What was asked">
          {askedClip ? (
            <TraceStoryText>{askedClip.text}</TraceStoryText>
          ) : (
            <TraceStoryMeta>Nobody wrote down what was asked. What changed is below.</TraceStoryMeta>
          )}
          {askedClip?.clipped && !said && <StoryLinks links={[conversation]} />}
        </TraceStoryChapter>
      )}

      {isBlocked ? (
        <TraceStoryChapter title="What happened">
          <TraceStoryText>
            Aura stopped the commit before it reached your history. Your code was left exactly as it was.
          </TraceStoryText>
          {stopped && <TraceStoryMeta>Why it was stopped: {clipText(stopped.text, 300).text}</TraceStoryMeta>}
        </TraceStoryChapter>
      ) : (
        <>
          <TraceStoryChapter title="What the agent did">
            {saidClip && <TraceStoryText>{saidClip.text}</TraceStoryText>}
            {said && <TraceStoryMeta>{said.source}</TraceStoryMeta>}
            {work && <TraceStoryText>{work}</TraceStoryText>}
            {!said && !work && <TraceStoryMeta>Nothing was recorded about how it went about the work.</TraceStoryMeta>}
            <StoryLinks
              links={[
                conversation,
                workers.length > 0 && { label: "See the workers", go: () => onOpenDeep("subagents") },
              ]}
            />
          </TraceStoryChapter>

          <TraceStoryChapter title="What changed">
            {files.length === 0 ? (
              <TraceStoryMeta>No files changed.</TraceStoryMeta>
            ) : (
              <TraceTimeline label="Files changed">
                {files.slice(0, FILES_SHOWN).map((f) => {
                  const told = fileStory(f, symbolsByFile[f.path] ?? f.symbols ?? []);
                  return (
                    <TraceTimelineEntry
                      key={f.path}
                      title={told.title}
                      onSelect={() => onOpenDeep("changes", f.path)}
                      detail={
                        <MomentFacts
                          facts={[
                            <code key="p">{told.where}</code>,
                            <LinesChanged key="l" added={f.additions ?? 0} removed={f.deletions ?? 0} />,
                          ]}
                        />
                      }
                    />
                  );
                })}
              </TraceTimeline>
            )}
            {files.length > 0 && (
              <StoryLinks
                links={[
                  {
                    label: files.length > FILES_SHOWN ? `See all ${filesWord(files.length)}` : "See every line changed",
                    go: () => onOpenDeep("changes"),
                  },
                ]}
              />
            )}
          </TraceStoryChapter>

          <TraceStoryChapter title="Was it checked">
            {sealed ? (
              <TraceStoryText>
                Sealed. Aura locked this record when the change was made, so nothing in it has been altered
                since.
                {detail.provenance !== "stated" && " The words above weren't stated by whoever made the change."}
              </TraceStoryText>
            ) : (
              <TraceStoryText>Not sealed, so Aura can&apos;t promise this record is exactly as it happened.</TraceStoryText>
            )}
            {sealed && row.signed_block_id && (
              <TraceStoryMeta>
                <SealCheck repoRoot={repoRoot} blockId={row.signed_block_id} spelled />
              </TraceStoryMeta>
            )}
            <StoryLinks
              links={[
                detail.showAlignment && {
                  label: "Compare what was asked with what changed",
                  go: () => onOpenDeep("alignment"),
                },
              ]}
            />
          </TraceStoryChapter>
        </>
      )}
    </TraceStory>
  );
}
