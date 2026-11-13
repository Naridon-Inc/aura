import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquare,
  Pencil,
  Users,
  Check,
} from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "./dropdown-menu";
import { DiffCount } from "./sidebar";
import {
  GitWorkflowActions,
  GIT_WORKFLOW_LABELS,
  type GitWorkflow,
  type GitWorkflowAction,
} from "./git-workflow";
export interface PullRequestActivity {
  id: string;
  author: string;
  message: string;
  sha?: string;
  time: string;
  kind?: "commit" | "comment" | "event";
  /** What was said, under the line — a comment's words. */
  body?: ReactNode;
}
const ACTIVITY_ICONS = {
  commit: GitCommitHorizontal,
  comment: MessageSquare,
  event: GitPullRequest,
};
export interface PullRequestDetails {
  number: number;
  title: string;
  author: string;
  branch: string;
  targetBranch: string;
  description: string;
  added: number;
  removed: number;
  activity: PullRequestActivity[];
  reviewers: string[];
}
export function PullRequestView({
  request,
  workflow,
  onChange,
  onAction,
  availableReviewers = [],
  composer,
  description,
  details,
  children,
}: {
  request: PullRequestDetails;
  workflow: GitWorkflow;
  onChange?: (request: PullRequestDetails) => void;
  onAction?: (action: GitWorkflowAction) => void;
  availableReviewers?: string[];
  composer?: ReactNode;
  /** The description as rendered text; `request.description` stays the
   *  source the edit dialog changes. */
  description?: ReactNode;
  /** More term/value rows after Merge, as `dt`/`dd` pairs. */
  details?: ReactNode;
  /** Sections between the description and the activity. */
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState<"title" | "description">(),
    [value, setValue] = useState(""),
    [expanded, setExpanded] = useState(false),
    [oldest, setOldest] = useState(false);
  const edit = (field: "title" | "description") => {
    setValue(request[field]);
    setEditing(field);
  };
  return (
    <section className="ui-pr-view" aria-label={`Pull request ${request.number}`}>
      <div className="ui-pr-scroll">
        <header className="ui-pr-title">
          <span className="ui-pr-avatar">{request.author.slice(0, 1).toUpperCase()}</span>
          <h1>
            {request.title} <span>#{request.number}</span>
          </h1>
          {onChange && (
            <Button
              size="iconXs"
              variant="ghost"
              aria-label="Edit title"
              onClick={() => edit("title")}
            >
              <Pencil />
            </Button>
          )}
        </header>
        <div className="ui-pr-actions">
          <DiffCount added={request.added} removed={request.removed} />
          <GitWorkflowActions workflow={workflow} onAction={onAction} />
        </div>
        <dl className="ui-pr-details">
          <dt>
            <GitBranch />
            Branch
          </dt>
          <dd>
            <code>{request.branch}</code>
            <ArrowRight size={12} />
            <code>{request.targetBranch}</code>
          </dd>
          <dt>
            <Users />
            Review
          </dt>
          <dd>
            {request.reviewers.length ? request.reviewers.join(", ") : "No reviewers"}
            {availableReviewers.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" disabled={!onChange}>
                    Request review
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {availableReviewers.map((name) => (
                    <DropdownMenuCheckboxItem
                      key={name}
                      checked={request.reviewers.includes(name)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) =>
                        onChange?.({
                          ...request,
                          reviewers: checked
                            ? [...request.reviewers, name]
                            : request.reviewers.filter((r) => r !== name),
                        })
                      }
                    >
                      {name}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </dd>
          <dt>
            <Check />
            Merge
          </dt>
          <dd>{GIT_WORKFLOW_LABELS[workflow.state]}</dd>
          {details}
        </dl>
        <div className="ui-pr-description" data-expanded={expanded}>
          {description ? (
            <div className="ui-pr-description-body">{description}</div>
          ) : (
            <p>{request.description}</p>
          )}
        </div>
        <div className="ui-pr-description-actions">
          <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show more"}
          </Button>
          {onChange && (
            <Button size="xs" variant="ghost" onClick={() => edit("description")}>
              <Pencil />
              Edit description
            </Button>
          )}
        </div>
        {children}
        <div className="ui-pr-activity-heading">
          <h2>Activity</h2>
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={oldest}
            onClick={() => setOldest(!oldest)}
          >
            Show {oldest ? "newest" : "oldest"} first
          </Button>
        </div>
        <ol className="ui-pr-activity">
          {(oldest ? [...request.activity].reverse() : request.activity).map((item) => {
            const Icon = ACTIVITY_ICONS[item.kind ?? "commit"];
            return (
              <li key={item.id} data-kind={item.kind ?? "commit"}>
                <Icon size={16} />
                <div>
                  <strong>{item.author}</strong> <span>{item.message}</span>
                  {item.sha && <code>{item.sha}</code>}
                  <time>{item.time}</time>
                  {item.body && <div className="ui-pr-activity-body">{item.body}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {composer && <footer className="ui-pr-composer">{composer}</footer>}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Edit {editing}</DialogTitle>
          <DialogDescription>Update the pull request {editing}.</DialogDescription>
          {editing === "title" ? (
            <Input
              autoFocus
              aria-label="Pull request title"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <Textarea
              autoFocus
              aria-label="Pull request description"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={!value.trim()}
              onClick={() => {
                if (editing) onChange?.({ ...request, [editing]: value.trim() });
                setEditing(undefined);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
