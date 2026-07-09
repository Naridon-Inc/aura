// The one-time "What's new" modal shown after a MAJOR update. Built on the
// Radix Dialog primitive, so it dismisses three ways for free — Esc, click
// outside, and the X — plus an explicit "Got it". Dismissing (any path) marks
// the version seen upstream, so it never shows again.
//
// Plain-language only: the highlights say what the user can now do, never the
// mechanism. Arctic-blue accent for the one bit of color.

import { Sparkles } from "lucide-react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { ReleaseNote } from "../lib/releaseNotes";

type Props = {
  note: ReleaseNote;
  onDismiss: () => void;
};

export function WhatsNewModal({ note, onDismiss }: Props) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
              style={{
                background:
                  "color-mix(in srgb, var(--color-accent) 16%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="text-left">
              <DialogTitle>{note.title}</DialogTitle>
              <DialogDescription>
                What&rsquo;s new in Aura {note.version}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <ul className="flex flex-col gap-2.5 py-1">
          {note.highlights.map((h, i) => (
            <li
              key={i}
              className="flex gap-2.5 text-sm leading-relaxed text-text-1"
            >
              <span
                className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--color-accent)" }}
                aria-hidden="true"
              />
              <span>{h}</span>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button onClick={onDismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
