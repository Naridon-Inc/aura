// CommitDetailPane — the right side of the History tab: the full story of one
// saved version (commit). This is the line between Git and Git+Aura. A plain
// git log shows a message and a diff; here a commit reads top-to-bottom as a
// story a non-engineer can follow:
//
//   A  Header     — the title + "lines up?" verdict mark (StoryHeader)
//   B  Why        — what was asked, and what the AI said as it worked
//   C  Files      — which files this version touched, and how much (CommitFiles)
//   D  The change — the real committed diff for the picked file, with its
//                   per-file "why" card (CommittedFileDiff)
//   E  Meaning    — in real-world terms, which parts of the app moved
//                   (MeaningStrip, via the Code Atlas)
//   F  Recover    — and if something's wrong, how to take it back
//
// The Asked/Said/Verdict/Recover beats are the same intent story the Trace and
// Alignment surfaces use, reused whole — so the narration stays consistent
// across the app. The files/diff/meaning middle is what makes this the History
// detail and not just an intent log: real git data, not a re-statement of the
// commit message. Drawn as the same report column the change story is.

import { useEffect, useState } from "react";

import { type ClaudeSession } from "../../lib/api";
import {
  useIntentReport,
  deriveAskedSaid,
  StoryHeader,
  Beat,
  AskedBeat,
  SaidBeat,
  VerdictBeat,
  RecoverBeat,
} from "../workpanes/IntentStory";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { TraceNote } from "../ui/trace-detail";
import { TraceLine, TraceReport } from "../ui/trace-report";
import { CommitFiles } from "./detail/CommitFiles";
import { MachineCommitDetail } from "./detail/MachineCommitDetail";
import { remotePlaceForRoot } from "../../lib/activeMachine";
import { MeaningStrip, useCommitMeanings } from "./detail/MeaningStrip";
import { CommittedFileDiff } from "./CommittedFileDiff";
import "../ui/intent-story.css";
import { ErrorState } from "../ui/state";

type CommitDetailProps = {
  repoRoot: string;
  sha: string;
  sessions: ClaudeSession[];
};

/** A version on a machine is read from the machine. Asking the laptop about
 *  it fails — the laptop does not have it — and the failure read as the
 *  version being broken. */
export function CommitDetailPane(props: CommitDetailProps) {
  return remotePlaceForRoot(props.repoRoot) ? (
    <MachineCommitDetail repoRoot={props.repoRoot} sha={props.sha} />
  ) : (
    <LaptopCommitDetail {...props} />
  );
}

function LaptopCommitDetail({ repoRoot, sha, sessions }: CommitDetailProps) {
  const { report, loading, error } = useIntentReport(repoRoot, sha);
  // The real-world meaning of the functions this version touched (Code Atlas).
  // Resolved up front so the "In real terms" section only renders when
  // there's actually something to say.
  const { meanings } = useCommitMeanings(repoRoot, sha);
  // The file picked in the "Files changed" list, whose real committed diff
  // shows below. Reset whenever the version changes so we never show one
  // commit's file against another's diff.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setPicked(null);
  }, [sha]);

  if (loading) {
    return (
      <div className="ui-intent-story">
        <div className="ui-story-state" role="status">
          <AsciiSpinner />
          <span>Reading this version’s story…</span>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="ui-intent-story">
        <ErrorState
          size="sm"
          title="Couldn’t read this version"
          message="The story behind this saved version didn’t load."
          footnote={<code>{error}</code>}
        />
      </div>
    );
  }
  if (!report) {
    return (
      <div className="ui-intent-story">
        <TraceNote title="No version picked">
          Pick a saved version on the left to read its story.
        </TraceNote>
      </div>
    );
  }

  // Same rule the Alignment tab uses: the user's real prompt as "Asked", every
  // genuine logged intent as "Said".
  const { asked, said } = deriveAskedSaid(report, sessions);

  return (
    <div className="ui-intent-story">
      <TraceReport>
        {/* A — Header: title + verdict. */}
        <StoryHeader report={report} />

        {/* B — Why: what was asked, and what the AI logged as it worked. */}
        <Beat label="Asked" hint="closest recorded signal">
          <AskedBeat asked={asked} />
        </Beat>
        {said.length > 0 && (
          <Beat label="Said" hint="what the AI logged as it worked">
            <SaidBeat said={said} />
          </Beat>
        )}

        {/* C + D — Did: the real files this version touched, then the actual
            committed diff for whichever one is picked. This is the part a
            plain intent log can't give you. */}
        <Beat label="Did" hint="the files this version changed">
          <div className="ui-story-files">
            <CommitFiles
              repoRoot={repoRoot}
              sha={sha}
              selected={picked}
              onSelect={(p) => setPicked((cur) => (cur === p ? null : p))}
            />
            {picked ? (
              <CommittedFileDiff repoRoot={repoRoot} sha={sha} path={picked} />
            ) : (
              <TraceLine tone="note">Pick a file above to read exactly what changed in it.</TraceLine>
            )}
          </div>
        </Beat>

        {/* E — Meaning: in real-world terms, which parts of the app moved.
            Only shown when the Code Atlas actually resolved meanings for this
            version's symbols. */}
        {meanings.length > 0 && (
          <Beat label="In real terms" hint="what this touched, for a person">
            <MeaningStrip meanings={meanings} />
          </Beat>
        )}

        {/* Lines up? — the verdict, between meaning and recovery. */}
        <Beat label="Lines up?" hint="does the code match the ask">
          <VerdictBeat report={report} />
        </Beat>

        {/* F — Recover: and if something's wrong, how to take it back. */}
        <Beat label="Recover" hint="if something's wrong">
          <RecoverBeat repoRoot={repoRoot} report={report} />
        </Beat>
      </TraceReport>
    </div>
  );
}
