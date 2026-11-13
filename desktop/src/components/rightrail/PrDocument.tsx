// The workspace's pull request as a document at the top of the Checks tab:
// its title, then (under the facts) its description in a box of its own
// height. Both edit in place — click to write, Enter / ⌘↵ or leaving the
// field saves, Escape abandons. Before there is one, the top of the tab says
// so, names the branch, and says what Create PR in the header will do.

import { useCallback, useRef, useState, type KeyboardEvent } from "react";

import type { PrSummary } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { MessageMarkdown } from "../ui/transcript-content";
import { BranchFact, FactsList } from "./ChecksPrFacts";
import "../ui/chat-markdown.css";
import "../ui/pr-document.css";

export type PrJobAction = { label: string; running: boolean; onClick: () => void; hint?: string };

/** Enter or Space on something drawn as a button but laid out as a block. */
const pressed = (e: KeyboardEvent, run: () => void) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
};

export function PrTitle({
  pr,
  onSaveTitle,
}: {
  pr: PrSummary;
  onSaveTitle: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Escape abandons the edit. The blur that ends it runs before the reset
  // draft re-renders, so it has to be told rather than left to compare a
  // stale draft — that comparison used to save the very text Escape threw
  // away.
  const abandoned = useRef(false);

  const commit = () => {
    const t = draft.trim();
    setEditing(false);
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    if (t && t !== pr.title) onSaveTitle(t);
  };

  return editing ? (
    <Input
      autoFocus
      aria-label="Pull request title"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          abandoned.current = true;
          setDraft(pr.title);
          e.currentTarget.blur();
        }
      }}
      onBlur={commit}
      className="ui-pr-doc-title-input"
    />
  ) : (
    <button
      type="button"
      onClick={() => {
        setDraft(pr.title);
        setEditing(true);
      }}
      title="Click to edit the PR title"
      className="ui-pr-doc-title"
    >
      {pr.title}
    </button>
  );
}

/** No pull request for this workspace yet: the branch and where it would go,
 *  and one line on what Create PR does. On the repository's own branch there
 *  is nothing to open, and it says so instead. */
export function PrCreate({
  branch,
  target,
  canOpen,
}: {
  branch: string;
  target: string;
  /** False on the default branch, where a pull request has nowhere to go. */
  canOpen: boolean;
}) {
  return (
    <>
      <div className="ui-pr-doc-title" data-static="">
        No pull request yet
      </div>
      <FactsList>
        <BranchFact head={branch} base={canOpen ? target : null} />
      </FactsList>
      <p className="ui-pr-doc-note">
        {canOpen
          ? "Create PR opens a chat where Aura commits what belongs, pushes the branch and opens the pull request, with a title and description written from what changed."
          : `This is ${branch}, the branch pull requests go into. Start a workspace to open one.`}
      </p>
    </>
  );
}

/** A text action at the end of a line, as quiet as the line itself. */
function QuietAction({ action, busyLabel }: { action: PrJobAction; busyLabel: string }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      className="ui-pr-doc-action"
      onClick={action.onClick}
      title={action.hint}
      disabled={action.running}
    >
      {action.running && <AsciiSpinner />}
      {action.running ? busyLabel : action.label}
    </Button>
  );
}

export function PrDescription({
  body,
  onSaveBody,
  action,
}: {
  /** `null` until the pull request's details are read. */
  body: string | null;
  onSaveBody: (body: string) => void;
  /** Have Aura write it (or rewrite it) from the branch; absent once the pull
   *  request is merged or closed. */
  action: PrJobAction | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Same as the title: Escape must not save. Unmounting the focused field can
  // fire its blur on the way out, and that blur still holds the typed draft.
  const abandoned = useRef(false);

  // Grow the editor with its text, up to the box's own ceiling.
  const autosize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  if (body === null) return null;

  const start = () => {
    setDraft(body);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    if (draft.trim() !== body) onSaveBody(draft);
  };

  if (editing) {
    return (
      <Textarea
        autoFocus
        aria-label="Pull request description"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autosize(e.currentTarget);
        }}
        onFocus={(e) => autosize(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            abandoned.current = true;
            e.currentTarget.blur();
          }
        }}
        onBlur={commit}
        placeholder="Add a description…"
        className="ui-pr-doc-editor"
      />
    );
  }

  if (!body) {
    return (
      <div className="ui-pr-doc-empty">
        <span
          role="button"
          tabIndex={0}
          onClick={start}
          onKeyDown={(e) => pressed(e, start)}
          title="Click to write one yourself"
        >
          No description
        </span>
        {action && <QuietAction action={action} busyLabel="Writing…" />}
      </div>
    );
  }

  return (
    <div className="ui-pr-doc-body">
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // A link opens in the browser and a code block's copy button copies;
          // neither is a click to edit.
          if ((e.target as HTMLElement).closest("a, button")) return;
          start();
        }}
        onKeyDown={(e) => pressed(e, start)}
        title="Click to edit the description"
        className="ui-pr-doc-description"
      >
        <MessageMarkdown content={body} />
      </div>
      {action && (
        <div className="ui-pr-doc-foot">
          <QuietAction action={action} busyLabel="Updating…" />
        </div>
      )}
    </div>
  );
}
