// The written half of a review: an approval with a note, or a request for
// changes. A request for changes has to say what should change — a bare
// "changes requested" tells the author nothing — so its submit stays off
// until there is something to send.

import { useEffect, useState } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Field } from "../../ui/field";
import { Textarea } from "../../ui/textarea";

export type ReviewKind = "approve" | "changes";

const COPY: Record<
  ReviewKind,
  { title: string; description: string; placeholder: string; submit: string; busy: string }
> = {
  approve: {
    title: "Approve with a note",
    description: "The author sees this note with your approval.",
    placeholder: "A note to go with your approval",
    submit: "Approve",
    busy: "Approving…",
  },
  changes: {
    title: "Request changes",
    description: "The author sees this on the pull request. Say what needs to change.",
    placeholder: "What needs to change?",
    submit: "Request changes",
    busy: "Sending…",
  },
};

export function PrReviewDialog({
  kind,
  prNumber,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  /** Which review is being written; null keeps the dialog closed. */
  kind: ReviewKind | null;
  prNumber: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  // Each opening starts blank: a note half-written for one review is not
  // the note for the next.
  useEffect(() => {
    if (kind) setBody("");
  }, [kind]);

  const copy = COPY[kind ?? "approve"];
  const empty = body.trim().length === 0;
  const canSend = !busy && !(kind === "changes" && empty);

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {copy.title} · #{prNumber}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) onSubmit(body.trim());
          }}
        >
          <Field
            label={kind === "approve" ? "Note" : "What to change"}
            htmlFor="pr-review-body"
            optional={kind === "approve"}
            error={error ?? undefined}
          >
            <Textarea
              id="pr-review-body"
              autoFocus
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
                  e.preventDefault();
                  onSubmit(body.trim());
                }
              }}
              placeholder={copy.placeholder}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={kind === "changes" ? "destructive" : "default"}
              disabled={!canSend}
            >
              {busy ? (
                <>
                  <AsciiSpinner size={10} />
                  {copy.busy}
                </>
              ) : (
                copy.submit
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
