// CommitDetailPane — the right side of the History tab: the full story of one
// saved version (commit). This is the line between Git and Git+Aura. A plain
// git log shows a message and a diff; here a commit reads top-to-bottom as a
// story a non-engineer can follow:
//
//   A  Header     — the title + "lines up?" verdict pill (StoryHeader)
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
// commit message.

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
import { CommitFiles } from "./detail/CommitFiles";
import { MeaningStrip, useCommitMeanings } from "./detail/MeaningStrip";
import { CommittedFileDiff } from "./CommittedFileDiff";

// Beat numbering, kept contiguous when optional beats (Said, In-real-terms)
// drop out. Always-present beats before "Lines up?" are Asked + Did (= 2);
// Said and Meaning each add one when present. `offset` is 0 for "Lines up?"
// and 1 for "Recover", the two beats that always follow.
function beatN(hasSaid: boolean, hasMeaning: boolean, offset: number): number {
  return 2 + (hasSaid ? 1 : 0) + (hasMeaning ? 1 : 0) + 1 + offset;
}

export function CommitDetailPane({
  repoRoot,
  sha,
  sessions,
}: {
  repoRoot: string;
  sha: string;
  sessions: ClaudeSession[];
}) {
  const { report, loading, error } = useIntentReport(repoRoot, sha);
  // The real-world meaning of the functions this version touched (Code Atlas).
  // Resolved up front so the "In real terms" section header only renders when
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
      <div className="px-6 py-8 text-[12px] text-text-4">
        Reading this version’s story…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-6 py-8 font-mono text-[11px] text-red-400">{error}</div>
    );
  }
  if (!report) {
    return (
      <div className="px-6 py-8 text-[12px] text-text-4">
        Pick a saved version on the left to read its story.
      </div>
    );
  }

  // Same rule the Alignment tab uses: the user's real prompt as "Asked", every
  // genuine logged intent as "Said".
  const { asked, said } = deriveAskedSaid(report, sessions);
  const hasSaid = said.length > 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 py-6">
        {/* A — Header: title + verdict pill. */}
        <StoryHeader report={report} />

        <div className="mt-6 space-y-6">
          {/* B — Why: what was asked, and what the AI logged as it worked. */}
          <Beat n={1} label="Asked" hint="closest recorded signal">
            <AskedBeat asked={asked} />
          </Beat>
          {hasSaid && (
            <Beat n={2} label="Said" hint="what the AI logged as it worked">
              <SaidBeat said={said} />
            </Beat>
          )}

          {/* C + D — Did: the real files this version touched, then the actual
              committed diff for whichever one is picked. This is the part a
              plain intent log can't give you. */}
          <Beat n={hasSaid ? 3 : 2} label="Did" hint="the files this version changed">
            <div className="space-y-3">
              <CommitFiles
                repoRoot={repoRoot}
                sha={sha}
                selected={picked}
                onSelect={(p) => setPicked((cur) => (cur === p ? null : p))}
              />
              {picked ? (
                <CommittedFileDiff repoRoot={repoRoot} sha={sha} path={picked} />
              ) : (
                <div className="rounded-lg border border-dashed border-line-soft px-4 py-3 text-[12px] text-text-4">
                  Pick a file above to read exactly what changed in it.
                </div>
              )}
            </div>
          </Beat>

          {/* E — Meaning: in real-world terms, which parts of the app moved.
              Only shown when the Code Atlas actually resolved meanings for this
              version's symbols — otherwise the section is skipped, and the beat
              numbers below shift up by one to stay contiguous. */}
          {meanings.length > 0 && (
            <Beat
              n={hasSaid ? 4 : 3}
              label="In real terms"
              hint="what this touched, for a person"
            >
              <MeaningStrip meanings={meanings} />
            </Beat>
          )}

          {/* Lines up? — the verdict, between meaning and recovery. */}
          <Beat
            n={beatN(hasSaid, meanings.length > 0, 0)}
            label="Lines up?"
            hint="does the code match the ask"
          >
            <VerdictBeat report={report} />
          </Beat>

          {/* F — Recover: and if something's wrong, how to take it back. */}
          <Beat
            n={beatN(hasSaid, meanings.length > 0, 1)}
            label="Recover"
            hint="if something's wrong"
            last
          >
            <RecoverBeat repoRoot={repoRoot} report={report} />
          </Beat>
        </div>
      </div>
    </div>
  );
}
