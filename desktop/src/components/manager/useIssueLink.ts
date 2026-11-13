// The composer's "Link issue" dialog: loads the repository's open GitHub
// issues through `gh` when it opens, narrows them as the user types, and
// attaches the picked issue as a markdown file the agent reads.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, type GithubIssue } from "../../lib/api";
import {
  ghNeedsLogin,
  githubIssueFile,
  issueIsOpen,
  searchIssues,
} from "../../lib/githubIssueLink";
import type { IssueLinkDialog } from "../ui/issue-link-dialog";

type DialogProps = Parameters<typeof IssueLinkDialog>[0];

/** Issues already read for a repo, shown at once while a fresh read runs. */
const cache = new Map<string, GithubIssue[]>();

/** ⌘I (Ctrl+I off the Mac) with no other modifier. */
export function isLinkIssueKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i";
}

export function useIssueLink({
  repoRoot,
  field,
  onAttach,
  onClosed,
}: {
  repoRoot?: string | null;
  /** The composer's field. ⌘I opens this composer's dialog while focus is
   *  in it, or anywhere outside a field when it is the only composer. */
  field: RefObject<HTMLTextAreaElement | null>;
  onAttach: (file: File) => void;
  /** Runs once the dialog has closed, to put the caret back in the field. */
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<GithubIssue[] | undefined>();
  const [error, setError] = useState<string>();
  const [loginDismissed, setLoginDismissed] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!repoRoot) {
      setIssues([]);
      setError("This chat has no repository to read issues from.");
      return;
    }
    let alive = true;
    setIssues(cache.get(repoRoot));
    setError(undefined);
    api
      .githubIssueList(repoRoot)
      .then((rows) => {
        cache.set(repoRoot, rows);
        if (alive) setIssues(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setIssues([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [open, repoRoot]);

  const shown = useMemo(() => searchIssues(issues ?? [], query), [issues, query]);
  const needsLogin = !!error && ghNeedsLogin(error) && !loginDismissed;

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const toggle = () => (open ? close() : setOpen(true));
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isLinkIssueKey(event)) return;
      const el = field.current;
      if (!el?.isConnected) return;
      const active = document.activeElement;
      const composer = el.closest(".ui-composer");
      const inField = !!composer && !!active && composer.contains(active);
      const outsideFields =
        (!active || active === document.body) &&
        document.querySelectorAll(".ui-composer").length === 1;
      if (!openRef.current && !inField && !outsideFields) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [field]);

  const dialog: DialogProps = {
    open,
    onOpenChange: (next) => (next ? setOpen(true) : close()),
    query,
    onQueryChange: setQuery,
    loading: open && issues === undefined && !error,
    issues: shown.map((issue) => ({
      number: issue.number,
      title: issue.title,
      open: issueIsOpen(issue),
    })),
    needsLogin,
    error: error && !ghNeedsLogin(error) ? error : undefined,
    onSelect: (number) => {
      const issue = shown.find((row) => row.number === number);
      if (issue) onAttach(githubIssueFile(issue));
      close();
    },
    onDismissLogin: () => {
      setLoginDismissed(true);
      close();
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault();
      onClosed();
    },
  };

  return {
    dialog,
    /** The add menu's "Link issue" row; ⌘I does the same. */
    toggle,
  };
}
