// "Switch branch?" — asked when a branch is picked while an agent is working
// in this checkout. Cancel keeps the branch; Switch anyway goes ahead.

import { useState, type KeyboardEvent } from "react";

import { useWorkingRoots } from "../../lib/useFleetActivity";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  decideSwitch,
  rootIsWorking,
  type SwitchOutcome,
  type SwitchRequest,
} from "./branchSwitchGuard";

export type BranchSwitchConfirmProps = {
  /** The branch being asked about; the dialog is open while one is set. */
  branchName?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** `requestSwitch` switches at once with nothing running and otherwise holds
 *  the request; `dialogProps` drive the question that releases it. */
export function useBranchSwitchGuard(repoRoot: string): {
  requestSwitch: (request: SwitchRequest) => SwitchOutcome;
  dialogProps: BranchSwitchConfirmProps;
} {
  const running = rootIsWorking(useWorkingRoots(), repoRoot);
  const [held, setHeld] = useState<SwitchRequest>();
  return {
    requestSwitch: (request) => decideSwitch(running, request, setHeld),
    dialogProps: {
      branchName: held?.branchName,
      onConfirm: () => {
        setHeld(undefined);
        held?.switchBranch();
      },
      onCancel: () => setHeld(undefined),
    },
  };
}

export function BranchSwitchConfirm({
  branchName,
  onConfirm,
  onCancel,
}: BranchSwitchConfirmProps) {
  return (
    <AlertDialog open={branchName !== undefined} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent
        // Over the full-screen Git view, whose Escape handler is on the
        // window: Esc answers this question and leaves the view open.
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Switch branch?</AlertDialogTitle>
          <AlertDialogDescription>
            An agent is running in this workspace. Switching to{" "}
            <span className="ui-branch-switch-confirm-name">{branchName}</span> will change the
            files it's working on.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* The action doesn't close the dialog itself — that close would
              read as a cancel. Confirming clears the branch, which closes it. */}
          <AlertDialogAction
            data-primary-action
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            Switch anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
