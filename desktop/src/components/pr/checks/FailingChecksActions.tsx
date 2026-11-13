// The two things to do about failing checks, beside the Checks caption on the
// right sidebar and on a pull request's own Checks tab: Re-run (GitHub runs
// the failed jobs again) and Fix errors (a new chat gets the failing checks
// and fixes them in this branch). Each shows it is working while it runs.

import { useState } from "react";

import type { PrCheck } from "../../../lib/api";
import { runGitChat, useGitChats } from "../../../lib/gitChat";
import { prRerunFailedChecks } from "../../../lib/prApi";
import { toast } from "../../../lib/toast";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { isRerunnable } from "./fixChecksPrompt";

export function FailingChecksActions({
  repoRoot,
  prNumber,
  failing,
  onRerun,
}: {
  repoRoot: string;
  prNumber: number;
  failing: PrCheck[];
  /** Read the checks again once GitHub has queued the re-run. */
  onRerun?: () => void;
}) {
  const [rerunning, setRerunning] = useState(false);
  const fixId = `fix-errors:${prNumber}`;
  const fixing = useGitChats(repoRoot)(fixId);
  if (failing.length === 0) return null;

  const rerun = async () => {
    setRerunning(true);
    try {
      await prRerunFailedChecks(repoRoot, prNumber);
      onRerun?.();
    } catch (e) {
      toast.danger("Failed to re-run checks", e instanceof Error ? e.message : String(e));
    } finally {
      setRerunning(false);
    }
  };
  const fix = () => runGitChat(repoRoot, fixId, { action: "fix-errors", failing });

  return (
    <span className="ui-details-caption-actions">
      {failing.some(isRerunnable) && (
        <Tooltip content="Re-run failed checks">
          <Button variant="ghost" size="xs" disabled={rerunning} onClick={() => void rerun()}>
            {rerunning && <AsciiSpinner size={10} />}
            Re-run
          </Button>
        </Tooltip>
      )}
      <Button variant="ghost" size="xs" disabled={fixing} onClick={() => void fix()}>
        {fixing && <AsciiSpinner size={10} />}
        Fix errors
      </Button>
    </span>
  );
}
