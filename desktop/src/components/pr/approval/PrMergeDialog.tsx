// The one merge in the app: how to merge, whether the branch goes with it,
// and — when checks are red — an explicit "merge anyway" before the button
// turns on. Every control that starts a merge lands here, so there is one
// method picker and one failing-checks gate to keep honest.

import { useEffect, useState } from "react";
import { GitMerge } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Field } from "../../ui/field";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import "../../ui/pr-review.css";

export type MergeMethod = "squash" | "merge" | "rebase";

const METHODS: { value: MergeMethod; label: string; submit: string; says: string }[] = [
  {
    value: "squash",
    label: "Squash",
    submit: "Squash and merge",
    says: "Every commit on the branch lands as one commit.",
  },
  {
    value: "merge",
    label: "Merge commit",
    submit: "Merge",
    says: "The branch's commits land as they are, joined by a merge commit.",
  },
  {
    value: "rebase",
    label: "Rebase",
    submit: "Rebase and merge",
    says: "The branch's commits are replayed on top, with no merge commit.",
  },
];

export function PrMergeDialog({
  open,
  prNumber,
  baseRef,
  failingChecks,
  pendingChecks,
  busy,
  error,
  onCancel,
  onMerge,
}: {
  open: boolean;
  prNumber: number;
  baseRef: string | null;
  failingChecks: number;
  pendingChecks: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onMerge: (method: MergeMethod, deleteBranch: boolean) => void;
}) {
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [override, setOverride] = useState(false);
  // The override is for this merge only; it re-arms every time the dialog
  // opens so red checks are acknowledged each time, not once forever.
  useEffect(() => {
    if (open) setOverride(false);
  }, [open]);

  const picked = METHODS.find((m) => m.value === method) ?? METHODS[0];
  const blocked = failingChecks > 0 && !override;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge pull request #{prNumber}</DialogTitle>
          <DialogDescription>
            {baseRef ? (
              <>
                Into <code>{baseRef}</code>.{" "}
              </>
            ) : null}
            {picked.says}
          </DialogDescription>
        </DialogHeader>
        <div className="ui-pr-merge-body">
          <Field label="Merge method">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Merge method"
              value={method}
              // A single group reports "" when the pressed item is pressed
              // again; a merge always has a method.
              onValueChange={(next) => {
                if (next === "squash" || next === "merge" || next === "rebase") setMethod(next);
              }}
            >
              {METHODS.map((m) => (
                <ToggleGroupItem key={m.value} value={m.value}>
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <label className="ui-pr-review-check">
            <Checkbox checked={deleteBranch} onCheckedChange={(v) => setDeleteBranch(v === true)} />
            Delete the branch after merging
          </label>
          {failingChecks > 0 && (
            <Alert variant="destructive">
              <AlertTitle>
                {failingChecks} check{failingChecks === 1 ? " is" : "s are"} failing
              </AlertTitle>
              <AlertDescription>
                <label className="ui-pr-review-check">
                  <Checkbox checked={override} onCheckedChange={(v) => setOverride(v === true)} />
                  Merge anyway
                </label>
              </AlertDescription>
            </Alert>
          )}
          {failingChecks === 0 && pendingChecks > 0 && (
            <Alert>
              <AlertDescription>
                {pendingChecks} check{pendingChecks === 1 ? " is" : "s are"} still running.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <p role="alert" className="ui-pr-merge-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || blocked}
            title={blocked ? "Tick “Merge anyway” to merge over failing checks" : undefined}
            onClick={() => onMerge(method, deleteBranch)}
          >
            {busy ? <AsciiSpinner size={10} /> : <GitMerge />}
            {busy ? "Merging…" : picked.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
