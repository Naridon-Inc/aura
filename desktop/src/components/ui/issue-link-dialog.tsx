import { Command as Primitive } from "cmdk";
import { ArrowRight, CircleCheck, CircleDot, CornerDownLeft } from "lucide-react";
import type { ReactNode } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandItem, CommandList } from "./command";
import { AsciiSpinner } from "./ascii-spinner";
import "./issue-link-dialog.css";

export interface IssueLinkRow {
  number: number;
  title: string;
  open: boolean;
}

function GithubMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" role="img" aria-label="GitHub">
      <path
        fill="currentColor"
        d="M8 1a7 7 0 0 0-2.2 13.6v-1.5c-1.9.3-2.3-.8-2.6-1.4-.3-.4-.7-.6-.7-.8.9-.2 1.3.9 1.9 1.1.5.2 1 .1 1.4 0 0-.4.2-.7.4-.9C3.9 10.8 3 9.9 3 8.1c0-.9.3-1.6.9-2.2-.2-.6-.2-1.4.1-2.1.8 0 1.6.5 2.1.9a7 7 0 0 1 3.8 0c.6-.4 1.3-.9 2.1-.9.3.7.3 1.5.1 2.1.6.6.9 1.3.9 2.2 0 1.8-.9 2.7-3.2 3 .4.4.5.8.5 1.4v2.1A7 7 0 0 0 8 1Z"
      />
    </svg>
  );
}

/** The hint at a row's end, shown on the row the keyboard is on. */
function EnterHint({ children }: { children: ReactNode }) {
  return (
    <span className="ui-issue-link-hint">
      {children}
      <CornerDownLeft role="img" aria-label="Enter" />
    </span>
  );
}

/** Search the repository's GitHub issues and link one into the chat. */
export function IssueLinkDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  loading,
  issues,
  needsLogin,
  error,
  onSelect,
  onDismissLogin,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  loading: boolean;
  issues: IssueLinkRow[];
  /** `gh` is missing or signed out: the dialog offers the sign-in step. */
  needsLogin?: boolean;
  /** Any other reason the list could not load. */
  error?: string;
  onSelect: (number: number) => void;
  onDismissLogin: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const searching = query.trim().length > 0;
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      className="ui-issue-link-dialog"
      title="Search"
      description="Search issues and press Enter to link one."
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <div className="ui-issue-link-search">
        <Primitive.Input
          className="ui-issue-link-input"
          placeholder="Search issues..."
          aria-label="Search issues"
          autoFocus
          value={query}
          onValueChange={onQueryChange}
        />
      </div>
      <CommandList>
        {loading ? (
          <div className="ui-issue-link-loading">
            <AsciiSpinner />
            <span>{searching ? "Searching issues..." : "Loading your issues..."}</span>
          </div>
        ) : (
          <>
            {issues.length > 0 ? (
              <CommandGroup heading={searching ? "Search results" : "Recent issues"}>
                {issues.map((issue) => (
                  <CommandItem
                    key={issue.number}
                    value={`github-issue-${issue.number}`}
                    className="ui-issue-link-row"
                    onSelect={() => onSelect(issue.number)}
                  >
                    <GithubMark className="ui-issue-link-provider" />
                    {issue.open ? (
                      <CircleDot className="ui-issue-link-state" data-state="open" />
                    ) : (
                      <CircleCheck className="ui-issue-link-state" data-state="closed" />
                    )}
                    <span className="ui-issue-link-number">#{issue.number}</span>
                    <span className="ui-issue-link-title">{issue.title}</span>
                    <EnterHint>Link</EnterHint>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              !needsLogin && (
                <CommandEmpty className="ui-issue-link-empty">
                  <p>{error || (searching ? "No issues found" : "No open issues found")}</p>
                </CommandEmpty>
              )
            )}
            {needsLogin && !searching && (
              <CommandGroup heading="Setup">
                <CommandItem
                  value="setup-github"
                  className="ui-issue-link-row"
                  onSelect={onDismissLogin}
                >
                  <GithubMark className="ui-issue-link-setup-mark" />
                  <ArrowRight className="ui-issue-link-setup-arrow" />
                  <span>Run "gh auth login" to connect GitHub</span>
                  <EnterHint>Dismiss</EnterHint>
                </CommandItem>
              </CommandGroup>
            )}
            {needsLogin && searching && (
              <CommandEmpty className="ui-issue-link-empty">
                <p>No issues found</p>
              </CommandEmpty>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
