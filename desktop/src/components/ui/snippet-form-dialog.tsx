// The "New snippet" form: Name and a ";"-prefixed Keyword side by side, the
// snippet's text under them, and Cancel / Save. ⌘↵ saves. Leaving with
// something typed asks first, so a half-written snippet isn't lost by an
// Escape or a click outside.

import { useState, type KeyboardEvent } from "react";
import { CornerDownLeft } from "lucide-react";

import {
  cleanKeyword,
  snippetDraftValid,
  SNIPPET_BODY_MAX,
  SNIPPET_KEYWORD_MAX,
  SNIPPET_NAME_MAX,
  type SnippetDraft,
} from "../../lib/snippets";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { Textarea } from "./textarea";
import "./snippet-dialogs.css";

const EMPTY: SnippetDraft = { name: "", body: "", keyword: "" };

export function SnippetFormDialog({
  open,
  onSave,
  onClose,
}: {
  open: boolean;
  /** Returns whether the snippet was stored; the form stays open if not. */
  onSave: (draft: SnippetDraft) => boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SnippetDraft>(EMPTY);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const dirty = draft.name !== "" || draft.body !== "" || draft.keyword !== "";
  const canSave = snippetDraftValid(draft);

  const close = () => {
    setDraft(EMPTY);
    setConfirming(false);
    setFailed(false);
    onClose();
  };
  const save = () => {
    if (!canSave) return;
    if (onSave(draft)) close();
    else setFailed(true);
  };
  /** Escape, a click outside or Cancel: straight out when nothing is typed. */
  const leave = (event?: Event) => {
    event?.preventDefault();
    if (dirty) setConfirming(true);
    else close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && leave()}>
        <DialogContent
          className="ui-snippet-form"
          showCloseButton={false}
          onEscapeKeyDown={leave}
          onInteractOutside={leave}
          onKeyDown={onKeyDown}
        >
          <DialogHeader>
            <DialogTitle>New snippet</DialogTitle>
            <DialogDescription className="sr-only">Name and write a new prompt snippet</DialogDescription>
          </DialogHeader>
          <div className="ui-snippet-form-fields">
            <div className="ui-snippet-form-row">
              <div className="ui-snippet-form-field" data-grow>
                <Label htmlFor="prompt-snippet-name">Name</Label>
                <Input
                  id="prompt-snippet-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={SNIPPET_NAME_MAX}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
              <div className="ui-snippet-form-field ui-snippet-form-keyword">
                <Label htmlFor="prompt-snippet-keyword">Keyword</Label>
                <div className="ui-snippet-form-keyword-box">
                  <span aria-hidden="true">;</span>
                  <Input
                    id="prompt-snippet-keyword"
                    value={draft.keyword}
                    onChange={(e) => setDraft({ ...draft, keyword: cleanKeyword(e.target.value) })}
                    maxLength={SNIPPET_KEYWORD_MAX}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
            <div className="ui-snippet-form-field">
              <Label htmlFor="prompt-snippet-body">Prompt snippet</Label>
              <Textarea
                id="prompt-snippet-body"
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                maxLength={SNIPPET_BODY_MAX}
              />
            </div>
            {failed && (
              <p className="ui-snippet-form-error" role="alert">
                Couldn't save the snippet on this computer.
              </p>
            )}
          </div>
          <DialogFooter className="ui-snippet-form-footer">
            <Button variant="ghost" onClick={() => leave()}>
              Cancel
            </Button>
            <Button data-primary-action disabled={!canSave} onClick={save}>
              Save
              <span className="ui-snippet-form-save-keys" aria-hidden="true">
                ⌘<CornerDownLeft />
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>This snippet won't be saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction className="ui-button-danger" onClick={close}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
