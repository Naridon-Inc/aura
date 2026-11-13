// Snippets in the chat composer. With snippets saved, "Add snippet" and ⌘;
// put a ";" at the caret, which opens the composer's snippet list; typing a
// snippet's keyword after ";" inserts it outright. With none saved yet, they
// open the snippet picker, whose "Create snippet" row opens the form, and a
// saved snippet lands back in the picker to insert.

import { useMemo, useRef, useState, type RefObject } from "react";

import {
  createSnippet,
  insertSnippetChar,
  useSnippets,
  type Snippet,
  type SnippetDraft,
} from "../../lib/snippets";
import type { ComposerSuggestion } from "../ui/composer";

/** ⌘; on a Mac, Ctrl+; elsewhere. */
export function isInsertSnippetKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? event.metaKey : event.ctrlKey;
  return mod && !event.shiftKey && !event.altKey && event.key === ";";
}

/** A saved snippet as a row of the composer's ";" list. */
export function snippetRow(snippet: Snippet): ComposerSuggestion {
  return {
    id: snippet.id,
    label: snippet.name,
    detail: snippet.body,
    insertText: snippet.body,
    kind: "snippet",
    keyword: snippet.keyword,
  };
}

export function useSnippetInsert({
  field,
  setText,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  setText: (value: string) => void;
}) {
  const snippets = useSnippets();
  const rows = useMemo(() => snippets.map(snippetRow), [snippets]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  // The picker closing because the form is opening leaves focus to the form.
  const toForm = useRef(false);

  /** Writes `text` over the field's selection and puts the caret after it. */
  const put = (build: (value: string, start: number, end: number) => { value: string; caret: number }) => {
    const el = field.current;
    if (!el) return;
    const next = build(el.value, el.selectionStart, el.selectionEnd);
    setText(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const trigger = () => {
    if (snippets.length === 0) {
      setPickerOpen(true);
      return;
    }
    put((value, _start, end) => insertSnippetChar(value, end));
  };

  return {
    rows,
    trigger,
    picker: {
      open: pickerOpen,
      onOpenChange: setPickerOpen,
      snippets,
      onInsert: (snippet: Snippet) => {
        setPickerOpen(false);
        put((value, start, end) => ({
          value: value.slice(0, start) + snippet.body + value.slice(end),
          caret: start + snippet.body.length,
        }));
      },
      onCreate: () => {
        toForm.current = true;
        setPickerOpen(false);
        setFormOpen(true);
      },
      onCloseAutoFocus: (event: Event) => {
        event.preventDefault();
        if (!toForm.current) field.current?.focus();
        toForm.current = false;
      },
    },
    form: {
      open: formOpen,
      onSave: (draft: SnippetDraft) => createSnippet(draft) !== null,
      // Saved or not, the form goes back to the picker it came from.
      onClose: () => {
        setFormOpen(false);
        setPickerOpen(true);
      },
    },
  };
}
