// The pull request's half of the Checks tab's Git status list, after the
// branch's own rows: each failed CI check, the running checks as one row,
// the passed checks as one row that opens out, changes requested, the
// review comments as one row, and the deployment. Same rows, same marks and
// the same quiet text action at the end as the branch's rows above them.

import { useState, type ReactElement } from "react";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react";

import type { PrCheck, PrSummary, VercelDeployment } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { DetailsCheckRow } from "../ui/details-checks";
import type { ChecksChats } from "./ChecksStatus";
import { checkHint, countLine, deployLine, fixableInBranch, rollUpChecks } from "./checksRollup";
import type { BranchChecks } from "./useBranchChecks";

export type PrRowsInput = {
  pr: PrSummary;
  checks: BranchChecks;
  deploy: VercelDeployment | null;
  chats: ChecksChats;
  /** Review comments that carry prose. */
  comments: number;
  /** Hand every comment to a new chat. */
  onAddComments: () => void;
  /** The chat id that hand-off goes out under. */
  addCommentsId: string;
  /** Open the pull request as a full tab, on its conversation. */
  onOpenPr: () => void;
  openExternal: (url: string) => void;
};

export function prStatusRows(p: PrRowsInput): ReactElement[] {
  const rows: ReactElement[] = [];
  const { checks } = p;

  if (checks.state === "reading") {
    rows.push(
      <DetailsCheckRow key="checks-reading" status="pending" icon={<AsciiSpinner />} title="Reading checks…" />,
    );
  } else if (checks.state === "failed") {
    rows.push(
      <DetailsCheckRow
        key="checks-unread"
        status="pending"
        icon={<CircleAlert size={14} />}
        title="Couldn't read the checks"
        hint="GitHub didn't answer for this pull request's checks. They are read again on the next refresh."
      />,
    );
  } else if (checks.state === "read") {
    const { failed, running, passed } = rollUpChecks(checks.checks);
    for (const c of failed) rows.push(failedRow(c, p));
    if (running.length > 0) {
      rows.push(
        <DetailsCheckRow
          key="checks-running"
          status="pending"
          icon={<AsciiSpinner />}
          title={countLine(running.length, "check", "running")}
          hint={running.map((c) => c.name).join("\n")}
        />,
      );
    }
    if (passed.length > 0) {
      rows.push(<PassedChecks key="checks-passed" passed={passed} openExternal={p.openExternal} />);
    }
  }

  if (p.pr.review_decision === "CHANGES_REQUESTED") {
    rows.push(
      <DetailsCheckRow
        key="changes-requested"
        status="failed"
        title="Changes requested"
        hint="A reviewer asked for changes. Opens the pull request's conversation."
        onClick={p.onOpenPr}
      />,
    );
  }

  if (p.comments > 0) {
    rows.push(
      <DetailsCheckRow
        key="comments"
        status={p.chats.sending(p.addCommentsId) ? "running" : "pending"}
        title={countLine(p.comments, "comment")}
        hint="Opens the pull request's conversation."
        onClick={p.onOpenPr}
        action={{ label: "Add to chat", onClick: p.onAddComments }}
      />,
    );
  }

  if (p.deploy) {
    const line = deployLine(p.deploy);
    const url = line.action?.url;
    rows.push(
      <DetailsCheckRow
        key="deploy"
        status={line.status === "running" ? "pending" : line.status}
        icon={line.status === "running" ? <AsciiSpinner /> : undefined}
        title={line.title}
        hint={p.deploy.url ?? undefined}
        action={line.action && url ? { label: line.action.label, onClick: () => p.openExternal(url) } : undefined}
      />,
    );
  }
  return rows;
}

/** A failed check on its own row. Fix opens a chat that reads its log and
 *  fixes the branch; a check that never started is a setup problem, so its
 *  row offers the log instead. Clicking the row opens the log either way. */
function failedRow(c: PrCheck, p: PrRowsInput): ReactElement {
  const fixId = `fix-errors:${p.pr.number}:${c.workflow}:${c.name}`;
  const logs = c.url ? () => p.openExternal(c.url) : undefined;
  const action = fixableInBranch(c)
    ? { label: "Fix", onClick: () => p.chats.run(fixId, { action: "fix-errors", failing: [c] }) }
    : logs
      ? { label: "Logs", onClick: logs }
      : undefined;
  return (
    <DetailsCheckRow
      key={`failed:${c.workflow}:${c.name}`}
      status={p.chats.sending(fixId) ? "running" : "failed"}
      title={c.name}
      hint={checkHint(c)}
      onClick={logs}
      action={action}
    />
  );
}

/** "4 checks passed", opening out into the checks themselves. */
function PassedChecks({ passed, openExternal }: { passed: PrCheck[]; openExternal: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <DetailsCheckRow
        status="passed"
        title={countLine(passed.length, "check", "passed")}
        hint={open ? "Hide the checks" : "Show the checks"}
        onClick={() => setOpen((o) => !o)}
        trailing={<Chevron size={14} />}
      />
      {open &&
        passed.map((c) => (
          <DetailsCheckRow
            key={`passed:${c.workflow}:${c.name}`}
            nested
            status="passed"
            title={c.name}
            hint={checkHint(c)}
            action={c.url ? { label: "Logs", onClick: () => openExternal(c.url) } : undefined}
          />
        ))}
    </>
  );
}
