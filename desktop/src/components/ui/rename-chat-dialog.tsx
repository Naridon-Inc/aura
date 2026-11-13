// The dialog a chat tab's "Rename chat" opens: a narrow sheet with the chat
// mark in its title, one field holding the current name — selected, so typing
// replaces it — and Cancel / OK. Enter is OK. A blank or unchanged name closes
// it without renaming.

import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";

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
import "./rename-chat-dialog.css";

export function RenameChatDialog({
  open,
  currentTitle,
  onOpenChange,
  onRename,
}: {
  open: boolean;
  currentTitle: string;
  onOpenChange: (open: boolean) => void;
  /** Called with the trimmed new name, only when it differs from the old. */
  onRename: (title: string) => void;
}) {
  const [value, setValue] = useState(currentTitle);
  // A fresh field each time it opens, holding whatever the chat is called now.
  useEffect(() => {
    if (open) setValue(currentTitle);
  }, [open, currentTitle]);

  const submit = () => {
    onOpenChange(false);
    const next = value.trim();
    if (next && next !== currentTitle.trim()) onRename(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ui-rename-chat">
        <DialogHeader>
          <DialogTitle className="ui-rename-chat-title">
            <MessageSquareText size={20} aria-hidden />
            Rename chat
          </DialogTitle>
          <DialogDescription className="ui-rename-chat-sr">
            Enter a new name for this chat
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Chat name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-primary-action onClick={submit}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
