import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { X } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import "./workspaces-create.css";

export interface WorkspacesCreateChip {
  key: string;
  label: string;
  /** Present when the chip can be taken back off. */
  onRemove?: () => void;
}

export interface WorkspacesCreateNote {
  key: string;
  tone?: "danger" | "success" | "warning";
  children: ReactNode;
}

/** The frame of the new-workspace dialog. The caller owns every value and
 *  every action; this only lays them out, so the dialog reads the same
 *  wherever work is created from. */
export function WorkspacesCreateDialog({
  open,
  onOpenChange,
  header,
  footer,
  chips = [],
  notes = [],
  prompt,
  onPromptChange,
  onSubmit,
  busy = false,
  textRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  header: ReactNode;
  footer: ReactNode;
  chips?: WorkspacesCreateChip[];
  notes?: WorkspacesCreateNote[];
  prompt: string;
  onPromptChange: (next: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  textRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="ui-workspaces-create"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Create workspace</DialogTitle>
        <DialogDescription className="sr-only">
          Choose a repository, where it runs and what it starts from, then say
          what you want to work on.
        </DialogDescription>
        <form onSubmit={submit}>
          <header>{header}</header>
          <textarea
            ref={textRef}
            aria-label="New workspace prompt"
            placeholder="What do you want to work on?"
            value={prompt}
            disabled={busy}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={onKey}
          />
          {chips.length > 0 && (
            <div className="ui-workspaces-create-context">
              {chips.map((chip) => (
                <span key={chip.key}>
                  <span>{chip.label}</span>
                  {chip.onRemove && (
                    <button
                      type="button"
                      aria-label={`Remove ${chip.label}`}
                      onClick={chip.onRemove}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {notes.map((note) => (
            <p key={note.key} className="ui-workspaces-create-note" data-tone={note.tone}>
              {note.children}
            </p>
          ))}
          <footer>{footer}</footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
