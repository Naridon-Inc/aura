// What new work starts from: a branch, an open pull request, or a GitHub
// issue. One search filters all three. A branch or PR resolves to the git
// start point of the new copy; an issue starts from HEAD and hands the dialog
// the issue as its objective.
//
// Real data only: branches from `gitBranchesRich`, PRs through the cached
// list so opening the menu never waits on a cold `gh pr list`, issues from
// `githubIssueList`. The lists load when the menu opens.

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleDot,
  GitBranch,
  GitFork,
  GitPullRequest,
} from "lucide-react";

import { Button } from "../ui/button";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { api, type GitBranchRich, type GithubIssue, type PrSummary } from "../../lib/api";
import { fetchPrList, getPrListCached } from "../../lib/prsCache";
import { prStartPoint, prStartSelection, type PrStartSelection } from "../../lib/prStartPoint";

export type CreateFromSelection = {
  kind: "branch" | "pr" | "issue";
  /** Git start point — a branch name, or a PR's head (fork PRs use the
   *  `pull/<n>/head:<local>` spelling the backend fetches). */
  ref: string;
  /** e.g. "main" or "#36 Retry with backoff". */
  label: string;
  /** An issue hands the dialog this complete objective. */
  prompt?: string;
  issueNumber?: number;
  /** A pull request from this repo: the work goes on its own branch. */
  continues?: PrStartSelection["continues"];
};

/** The branch a new workspace starts from unless you pick another: main,
 *  else master, else the branch checked out now. The dialog seeds its start
 *  with this and the menu tags the same row, so the two never disagree. */
export function defaultStartBranch(branches: GitBranchRich[]): GitBranchRich | undefined {
  const locals = branches.filter((b) => !b.isRemote);
  return (
    locals.find((b) => b.name === "main") ??
    locals.find((b) => b.name === "master") ??
    locals.find((b) => b.isCurrent) ??
    locals[0]
  );
}

function issuePrompt(issue: GithubIssue): string {
  return [
    `Work on GitHub issue #${issue.number}: ${issue.title}`,
    issue.body.trim(),
    `Issue: ${issue.url}`,
    "Implement the issue completely, verify the behavior, and report any decisions or remaining risks.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function CreateFromPicker({
  repoRoot,
  value,
  onPick,
  open,
  onOpenChange,
}: {
  repoRoot: string | null;
  value: CreateFromSelection | null;
  onPick: (selection: CreateFromSelection) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Starting point" disabled={!repoRoot}>
          <GitFork />
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ui-workspaces-create-starts">
        {repoRoot && <StartPoints repoRoot={repoRoot} value={value} onPick={onPick} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StartPoints({
  repoRoot,
  value,
  onPick,
}: {
  repoRoot: string;
  value: CreateFromSelection | null;
  onPick: (selection: CreateFromSelection) => void;
}) {
  const [branches, setBranches] = useState<GitBranchRich[] | null>(null);
  const [prs, setPrs] = useState<PrSummary[]>(() => getPrListCached(repoRoot) ?? []);
  const [issues, setIssues] = useState<GithubIssue[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    // Best-effort: an unreadable repository shows no rows, not a broken menu.
    api
      .gitBranchesRich(repoRoot)
      .then((rows) => alive && setBranches(rows))
      .catch(() => alive && setBranches([]));
    fetchPrList(repoRoot)
      .then((list) => alive && setPrs(list))
      .catch(() => {
        /* offline / no gh — keep what the cache had */
      });
    api
      .githubIssueList(repoRoot)
      .then((rows) => alive && setIssues(rows))
      .catch(() => alive && setIssues([]));
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  const q = query.trim().toLowerCase();
  const fallback = useMemo(() => defaultStartBranch(branches ?? []), [branches]);
  // The default leads, then the branch checked out now, then the rest.
  const localBranches = useMemo(() => {
    const locals = (branches ?? []).filter((b) => !b.isRemote);
    const rows = q ? locals.filter((b) => b.name.toLowerCase().includes(q)) : locals;
    const rank = (b: GitBranchRich) => (b === fallback ? 0 : b.isCurrent ? 1 : 2);
    return [...rows].sort((a, b) => rank(a) - rank(b));
  }, [branches, q, fallback]);
  // Only open PRs are something to check out.
  const openPrs = useMemo(
    () =>
      prs.filter(
        (p) =>
          p.state.toLowerCase() === "open" &&
          (!q ||
            String(p.number).includes(q) ||
            p.title.toLowerCase().includes(q) ||
            p.head_ref.toLowerCase().includes(q)),
      ),
    [prs, q],
  );
  const matchingIssues = useMemo(
    () =>
      (issues ?? []).filter(
        (i) =>
          !q ||
          String(i.number).includes(q) ||
          i.title.toLowerCase().includes(q) ||
          i.body.toLowerCase().includes(q) ||
          i.labels.some((l) => l.toLowerCase().includes(q)),
      ),
    [issues, q],
  );

  const picked = (kind: CreateFromSelection["kind"], ref: string, issueNumber?: number) =>
    value != null &&
    value.kind === kind &&
    value.ref === ref &&
    (kind !== "issue" || value.issueNumber === issueNumber);

  return (
    <>
      <input
        className="ui-workspaces-create-search"
        aria-label="Search branches, pull requests and issues"
        placeholder="Search branches, pull requests and issues…"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
        }}
      />
      <DropdownMenuLabel>Start from</DropdownMenuLabel>
      {branches === null ? (
        <DropdownMenuItem disabled>
          <AsciiSpinner /> Reading branches…
        </DropdownMenuItem>
      ) : localBranches.length === 0 ? (
        <DropdownMenuItem disabled>No branches match</DropdownMenuItem>
      ) : (
        localBranches.map((b) => (
          <DropdownMenuItem
            key={`br-${b.name}`}
            onSelect={() => onPick({ kind: "branch", ref: b.name, label: b.name })}
          >
            <GitBranch />
            <span>{b.name}</span>
            {picked("branch", b.name) ? (
              <Check />
            ) : (
              b === fallback && <small>default</small>
            )}
          </DropdownMenuItem>
        ))
      )}
      {openPrs.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Pull requests</DropdownMenuLabel>
          {openPrs.map((pr) => (
            <DropdownMenuItem
              key={`pr-${pr.number}`}
              title={
                pr.is_cross_repository
                  ? `From ${pr.head_repo_owner ? `${pr.head_repo_owner}'s` : "a"} fork. Aura fetches its branch for you.`
                  : `Continues on ${pr.head_ref}`
              }
              onSelect={() => onPick(prStartSelection(pr))}
            >
              <GitPullRequest />
              <span>{`#${pr.number} ${pr.title}`}</span>
              {picked("pr", prStartPoint(pr)) ? (
                <Check />
              ) : (
                (pr.is_draft || pr.is_cross_repository) && (
                  <small>{pr.is_draft ? "draft" : "fork"}</small>
                )
              )}
            </DropdownMenuItem>
          ))}
        </>
      )}
      {(issues === null || matchingIssues.length > 0) && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Issues</DropdownMenuLabel>
          {issues === null ? (
            <DropdownMenuItem disabled>
              <AsciiSpinner /> Reading issues…
            </DropdownMenuItem>
          ) : (
            matchingIssues.map((issue) => (
              <DropdownMenuItem
                key={`issue-${issue.number}`}
                title={issue.labels.join(" · ") || undefined}
                onSelect={() =>
                  onPick({
                    kind: "issue",
                    ref: "HEAD",
                    label: `#${issue.number} ${issue.title}`,
                    prompt: issuePrompt(issue),
                    issueNumber: issue.number,
                  })
                }
              >
                <CircleDot />
                <span>{`#${issue.number} ${issue.title}`}</span>
                {picked("issue", "HEAD", issue.number) && <Check />}
              </DropdownMenuItem>
            ))
          )}
        </>
      )}
    </>
  );
}
