// The selected commit, read: its subject and who made it, the rest of its
// message, then each file's change in the shared file diff. A large commit
// shows its first stretch of lines and offers the rest, so opening a sweeping
// change doesn't stall the page.

import { useMemo, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { type CommitEntry } from "../../../lib/api";
import { shortDateFromSecs } from "../../../lib/calendarDate";
import { parseUnifiedDiff } from "../../../lib/diff";
import { Button } from "../../ui/button";
import { EmptyState, LoadingState } from "../../ui/state";
import { TraceLine } from "../../ui/trace-report";
import { FileDiff, type DiffLine } from "../../ui/workspace-patterns";
import { messageParagraphs, splitCommitShow } from "./proofManifest";

/** Lines drawn before the rest of a commit waits behind a button. */
const LINE_BUDGET = 1500;

export function ProofCommit({
  commit,
  diff,
  loading,
}: {
  commit: CommitEntry | null;
  diff: string;
  loading: boolean;
}) {
  const [whole, setWhole] = useState(false);
  const read = useMemo(() => {
    const { body, files, rest } = splitCommitShow(diff);
    return {
      body,
      rest,
      files: files.map((f) => ({ path: f.path, lines: parseUnifiedDiff(f.patch) })),
    };
  }, [diff]);

  if (!commit) {
    return (
      <div className="ui-proof-commit">
        <EmptyState
          icon={GitCommitHorizontal}
          title="Pick a commit to review."
          size="sm"
          className="ui-proof-commit-empty"
        />
      </div>
    );
  }

  let budget = whole ? Infinity : LINE_BUDGET;
  let held = 0;
  const shown: { path: string; lines: DiffLine[] }[] = [];
  for (const f of read.files) {
    if (budget <= 0) {
      held += f.lines.length;
      continue;
    }
    const take = f.lines.slice(0, budget);
    held += f.lines.length - take.length;
    budget -= take.length;
    shown.push({ path: f.path, lines: take });
  }

  return (
    <div className="ui-proof-commit">
      <header className="ui-proof-commit-head">
        <h2>{commit.subject}</h2>
        <div className="ui-proof-commit-meta">
          <code>{commit.sha}</code>
          <span>{commit.author}</span>
          <span>{shortDateFromSecs(commit.timestamp, { empty: "—" })}</span>
        </div>
      </header>
      <div className="ui-proof-commit-body">
        {loading ? (
          <LoadingState label="Reading the change…" size="sm" />
        ) : (
          <>
            {read.body ? (
              <div className="ui-proof-message">
                {messageParagraphs(read.body).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            ) : null}
            {read.rest ? <pre className="ui-proof-raw">{read.rest}</pre> : null}
            {read.files.length === 0 && !read.rest ? (
              <TraceLine tone="note">This commit changes no files.</TraceLine>
            ) : null}
            {shown.map((f) => (
              <FileDiff key={f.path} name={f.path} lines={f.lines} />
            ))}
            {held > 0 ? (
              <div className="ui-proof-more">
                <TraceLine tone="note">
                  {held.toLocaleString()} more line{held === 1 ? "" : "s"} in this commit.
                </TraceLine>
                <Button variant="outline" size="xs" onClick={() => setWhole(true)}>
                  Show the whole commit
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
