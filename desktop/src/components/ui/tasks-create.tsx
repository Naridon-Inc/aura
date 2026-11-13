import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { X } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import type { WorkspacesCreateChip, WorkspacesCreateNote } from "./workspaces-create";
import "./workspaces-create.css";
import "./tasks-create.css";

/** The frame of the new-task dialog: the new-workspace frame, with a one-line
 *  title over the description instead of a single prompt. The caller owns
 *  every value and every action; this only lays them out.
 *
 *  Enter in the title creates; ⌘/Ctrl-Enter creates from anywhere; Escape and
 *  a click outside close. */
export function TasksCreateDialog({
  open,
  onOpenChange,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  footer,
  chips = [],
  notes = [],
  onSubmit,
  busy = false,
  titleRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onTitleChange: (next: string) => void;
  description: string;
  onDescriptionChange: (next: string) => void;
  footer: ReactNode;
  chips?: WorkspacesCreateChip[];
  notes?: WorkspacesCreateNote[];
  onSubmit: () => void;
  busy?: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const onFormKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="ui-workspaces-create ui-tasks-create"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogDescription className="sr-only">
          Name the task and, if you like, describe it. Everything else is set on
          the task once it exists.
        </DialogDescription>
        <form onSubmit={submit} onKeyDown={onFormKey}>
          <header>
            <DialogTitle className="ui-tasks-create-heading">New task</DialogTitle>
          </header>
          <input
            ref={titleRef}
            className="ui-tasks-create-name"
            aria-label="Task title"
            placeholder="Task title"
            value={title}
            disabled={busy}
            onChange={(e) => onTitleChange(e.target.value)}
            onKeyDown={onTitleKey}
          />
          <textarea
            aria-label="Description"
            placeholder="Add a description…"
            value={description}
            disabled={busy}
            onChange={(e) => onDescriptionChange(e.target.value)}
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
