// The History detail for a version on a machine.
//
// Everything here comes from one read-only answer the machine gives over its
// existing connection — `git show --stat -p` for the version — so the laptop
// is never asked about a version it does not have. The ask-and-check story
// (what was asked, whether the code matches, how to take it back) is built
// from the laptop's own record of its work, and is not drawn here rather than
// drawn from the wrong place.

import { useEffect, useState } from "react";

import { placeScope, gitShowCommit } from "../../../lib/place/workApi";
import { Beat } from "../../workpanes/IntentStory";
import { formatAbsolute } from "../../workpanes/intentStory/intentReport";
import { UnifiedDiff } from "../../diff/UnifiedDiff";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { ErrorState } from "../../ui/state";
import { TraceNote } from "../../ui/trace-detail";
import { TraceLine, TraceReport } from "../../ui/trace-report";
import { CommitFiles } from "./CommitFiles";
import { parseShownCommit, type ShownCommit } from "./shownCommit";
import "../../ui/intent-story.css";

export function MachineCommitDetail({
  repoRoot,
  sha,
  initialPath = null,
}: {
  repoRoot: string;
  sha: string;
  /** The file to open on, when the commit was reached from one of its files. */
  initialPath?: string | null;
}) {
  const scope = placeScope(repoRoot);
  const [shown, setShown] = useState<ShownCommit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(initialPath);

  useEffect(() => {
    let alive = true;
    setShown(null);
    setError(null);
    setPicked(initialPath);
    gitShowCommit(repoRoot, sha)
      .then((text) => {
        if (!alive) return;
        const read = parseShownCommit(text);
        if (read) setShown(read);
        else setError(text.trim() || "The machine had nothing to show for this version.");
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [scope, repoRoot, sha, initialPath]);

  if (error) {
    return (
      <div className="ui-intent-story">
        <ErrorState
          size="sm"
          title="Couldn’t read this version"
          message="The machine didn’t show this saved version."
          footnote={<code>{error}</code>}
        />
      </div>
    );
  }
  if (!shown) {
    return (
      <div className="ui-intent-story">
        <div className="ui-story-state" role="status">
          <AsciiSpinner />
          <span>Reading this version on the machine…</span>
        </div>
      </div>
    );
  }

  const [subject, ...rest] = shown.message.split("\n");
  const body = rest.join("\n").trim();
  return (
    <div className="ui-intent-story">
      <TraceReport>
        <header className="ui-story-head">
          <div>
            <h1>{subject || "(no message)"}</h1>
            <p>
              <code>{shown.sha.slice(0, 7)}</code>
              {shown.author && (
                <>
                  <span aria-hidden>·</span>
                  <span>{shown.author}</span>
                </>
              )}
              {shown.time > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>{formatAbsolute(shown.time)}</span>
                </>
              )}
            </p>
          </div>
        </header>

        {body && (
          <Beat label="Said" hint="what the version says about itself">
            <TraceLine>{body}</TraceLine>
          </Beat>
        )}

        <Beat label="Did" hint="the files this version changed">
          <div className="ui-story-files">
            <CommitFiles
              repoRoot={repoRoot}
              sha={sha}
              files={shown.files}
              selected={picked}
              onSelect={(p) => setPicked((cur) => (cur === p ? null : p))}
            />
            {picked ? (
              <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-content">
                <UnifiedDiff diff={shown.patches[picked] ?? ""} />
              </div>
            ) : (
              <TraceLine tone="note">Pick a file above to read exactly what changed in it.</TraceLine>
            )}
          </div>
        </Beat>

        <TraceNote title="Read from the machine">
          This version lives on the machine, so its files and changes are read
          from there. What was asked for it, and whether the code matches, is
          shown for versions saved on this laptop.
        </TraceNote>
      </TraceReport>
    </div>
  );
}
