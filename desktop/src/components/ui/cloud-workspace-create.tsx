import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  GitPullRequest,
  GitFork,
  Lock,
  Users,
  Plus,
  Paperclip,
  Link,
  X,
  CornerDownLeft,
  CircleDot,
} from "lucide-react";
import { Button } from "./button";
import { AsciiSpinner } from "./ascii-spinner";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./dropdown-menu";
import {
  ModelPicker,
  type ModelOption,
  type ModelSelection,
} from "./model-picker";
/** An open pull request the workspace can start from. */
export interface CloudPullRequestStart {
  number: number;
  title: string;
  /** The pull request's own branch: the workspace works on it. */
  branch: string;
  draft?: boolean;
  /** Why this one can't be started here, in a sentence. Picking it says so
   *  instead of starting. */
  unavailable?: string | null;
}
export interface CloudWorkspaceDraft {
  prompt: string;
  repository: string;
  branch: string;
  access: "organization" | "restricted";
  model: ModelSelection;
  attachments: string[];
  source: string;
  /** The pull request picked as the starting point, if one was. */
  pullRequest: CloudPullRequestStart | null;
}
type PullRequestList = {
  repository: string;
  rows: CloudPullRequestStart[] | null;
  error?: string;
};
export function CloudWorkspaceCreateDialog({
  open,
  onOpenChange,
  repositories,
  models,
  model,
  onCreate,
  orgName = "Studio",
  branches = ["main", "develop"],
  startingPoints = true,
  contextMenu = true,
  privateReason,
  onManageRepositories,
  fallbackRepository = "interface-system",
  repositoryIcon,
  noModels,
  blocked,
  step,
  pullRequests,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: string[];
  models: ModelOption[];
  model: ModelSelection;
  /** A promise keeps the dialog open until it settles; a rejection's message
   *  is shown under the prompt and nothing is cleared. */
  onCreate: (draft: CloudWorkspaceDraft) => void | Promise<void>;
  /** Who "Everyone" is. */
  orgName?: string;
  /** Branches to start from. Empty leaves the starting point to the server. */
  branches?: string[];
  /** Offer a pull request or an issue as the starting point. */
  startingPoints?: boolean;
  /** Offer files and links as context. */
  contextMenu?: boolean;
  /** Why a workspace can't be made private here, when it can't. */
  privateReason?: string;
  onManageRepositories?: () => void;
  /** The repository shown before any are listed. */
  fallbackRepository?: string;
  /** The repository's picture beside its name; null (or left out) draws the
   *  folder. */
  repositoryIcon?: (repository: string) => ReactNode;
  /** Shown in the model picker's place while there are no models: the way
   *  to set an agent up. Null leaves the place empty (when the note above
   *  already offers it). */
  noModels?: ReactNode;
  /** Why nothing would answer a workspace made now, and the one thing that
   *  fixes it. Create waits until it's gone. */
  blocked?: { message: string; action?: { label: string; onClick: () => void } } | null;
  /** What creating is doing right now, while it takes a while. */
  step?: string | null;
  /** The chosen repository's open pull requests, read when the starting
   *  point menu opens. Picking one puts the workspace on its branch. */
  pullRequests?: (repository: string) => Promise<CloudPullRequestStart[]>;
}) {
  const [prompt, setPrompt] = useState(""),
    [repository, setRepository] = useState(
      repositories[0] ?? fallbackRepository,
    ),
    [branch, setBranch] = useState(branches[0] ?? ""),
    [access, setAccess] =
      useState<CloudWorkspaceDraft["access"]>("organization"),
    [selection, setSelection] = useState(model),
    [attachments, setAttachments] = useState<string[]>([]),
    [source, setSource] = useState(""),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [pull, setPull] = useState<CloudPullRequestStart | null>(null),
    [pulls, setPulls] = useState<PullRequestList | null>(null),
    [pullSearch, setPullSearch] = useState("");
  const file = useRef<HTMLInputElement>(null),
    text = useRef<HTMLTextAreaElement>(null);
  // Repositories and models can arrive after the dialog is mounted.
  useEffect(() => {
    if (repositories.length && !repositories.includes(repository))
      setRepository(repositories[0]);
  }, [repositories, repository]);
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === selection.model))
      setSelection(model);
  }, [models, model, selection.model]);
  // A pull request belongs to its repository: another repository drops it.
  const pulledFrom = useRef(repository);
  useEffect(() => {
    if (pulledFrom.current === repository) return;
    pulledFrom.current = repository;
    if (!pull) return;
    setPull(null);
    setSource("");
    setBranch(branches[0] ?? "");
  }, [repository, pull, branches]);
  const readPullRequests = () => {
    if (!pullRequests || !repository) return;
    if (pulls?.repository === repository && !pulls.error) return;
    const asked = repository;
    setPulls({ repository: asked, rows: null });
    pullRequests(asked).then(
      (rows) => setPulls((now) => (now?.repository === asked ? { repository: asked, rows } : now)),
      (e) =>
        setPulls((now) =>
          now?.repository === asked
            ? { repository: asked, rows: [], error: e instanceof Error ? e.message : String(e) }
            : now,
        ),
    );
  };
  const pickPull = (pr: CloudPullRequestStart) => {
    if (pr.unavailable) {
      setError(pr.unavailable);
      return;
    }
    setError("");
    setPull(pr);
    setBranch(pr.branch);
    setSource(`PR #${pr.number} · ${pr.title}`);
  };
  const pullRows = (pulls?.repository === repository ? pulls.rows : null) ?? null;
  const q = pullSearch.trim().toLowerCase();
  const shownPulls = (pullRows ?? []).filter(
    (pr) =>
      !q ||
      String(pr.number).includes(q) ||
      pr.title.toLowerCase().includes(q) ||
      pr.branch.toLowerCase().includes(q),
  );
  const create = async () => {
    if (!prompt.trim() || busy || blocked) return;
    setError("");
    const done = onCreate({
      prompt: prompt.trim(),
      repository,
      branch,
      access,
      model: selection,
      attachments,
      source,
      pullRequest: pull,
    });
    if (done) {
      setBusy(true);
      try {
        await done;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setBusy(false);
      }
    }
    setPrompt("");
    setAttachments([]);
    setSource("");
    setPull(null);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="ui-cloud-create-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          text.current?.focus();
        }}
      >
        <DialogTitle className="ui-sr-only">New workspace</DialogTitle>
        <DialogDescription className="ui-sr-only">
          Draft the first message, then create and send it.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <header>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  {(repository && repositoryIcon?.(repository)) || <Folder />}
                  {repository.split("/").pop() || "No repository"}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="ui-cloud-create-repositories"
              >
                <input
                  className="ui-cloud-menu-search"
                  aria-label="Search repositories"
                  placeholder="Search repositories…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                {repositories
                  .filter((r) => r.toLowerCase().includes(search.toLowerCase()))
                  .map((r) => (
                    <DropdownMenuItem key={r} onSelect={() => setRepository(r)}>
                      {repositoryIcon?.(r) || <Folder />}
                      {r}
                      {repository === r && <Check />}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    if (onManageRepositories) onManageRepositories();
                    else setSource("Choose repositories in Cloud computer settings");
                  }}
                >
                  Manage repositories…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="ui-cloud-create-spacer" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Workspace access">
                  {access === "restricted" ? <Lock /> : <Users />}
                  {access === "restricted" ? "Private" : "Everyone"}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setAccess("organization")}>
                  <Users />
                  Everyone at {orgName}{access === "organization" && <Check />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!!privateReason}
                  title={privateReason}
                  onSelect={() => setAccess("restricted")}
                >
                  <Lock />
                  Private{access === "restricted" && <Check />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {(branches.length > 0 || startingPoints || pullRequests) && (
              <>
            <i />
            <DropdownMenu onOpenChange={(o) => o && readPullRequests()}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Starting point">
                  <GitFork />
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="ui-cloud-create-starts">
                <DropdownMenuItem disabled>Start from</DropdownMenuItem>
                {branches.map((b) => (
                  <DropdownMenuItem
                    key={b}
                    onSelect={() => {
                      setBranch(b);
                      setSource(b === branches[0] ? "" : "Branch: " + b);
                    }}
                  >
                    <GitBranch />
                    {b}
                    {branch === b && !pull && <Check />}
                  </DropdownMenuItem>
                ))}
                {pullRequests && (
                  <>
                    {branches.length > 0 && <DropdownMenuSeparator />}
                    {(pullRows?.length ?? 0) > 6 && (
                      <input
                        className="ui-cloud-menu-search"
                        aria-label="Search pull requests"
                        placeholder="Search pull requests…"
                        value={pullSearch}
                        onChange={(e) => setPullSearch(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    )}
                    <DropdownMenuItem disabled>Pull requests</DropdownMenuItem>
                    {!repository ? (
                      <DropdownMenuItem disabled>Pick a repository first</DropdownMenuItem>
                    ) : pullRows === null ? (
                      <DropdownMenuItem disabled>
                        <AsciiSpinner /> Reading pull requests…
                      </DropdownMenuItem>
                    ) : pulls?.error ? (
                      <DropdownMenuItem disabled title={pulls.error}>
                        <span>{pulls.error}</span>
                      </DropdownMenuItem>
                    ) : shownPulls.length === 0 ? (
                      <DropdownMenuItem disabled>
                        {q ? "No pull requests match" : "No open pull requests"}
                      </DropdownMenuItem>
                    ) : (
                      shownPulls.map((pr) => (
                        <DropdownMenuItem
                          key={pr.number}
                          title={pr.unavailable ?? pr.branch}
                          onSelect={() => pickPull(pr)}
                        >
                          <GitPullRequest />
                          <span>{`#${pr.number} ${pr.title}`}</span>
                          {pull?.number === pr.number ? (
                            <Check />
                          ) : (
                            (pr.unavailable || pr.draft) && (
                              <small>{pr.unavailable ? "fork" : "draft"}</small>
                            )
                          )}
                        </DropdownMenuItem>
                      ))
                    )}
                  </>
                )}
                {startingPoints && (
                  <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setBranch("feature/keyboard-shortcuts");
                    setSource("PR #42 · Keyboard shortcuts");
                  }}
                >
                  <GitPullRequest />
                  Pull request…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    setSource("UI-128 · Refine shared navigation")
                  }
                >
                  <CircleDot />
                  Linear issue…
                </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
              </>
            )}
          </header>
          <textarea
            ref={text}
            aria-label="New workspace prompt"
            placeholder={
              pull ? `What should happen on #${pull.number}?` : "What do you want to work on?"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                create();
              }
            }}
          />
          {(source || attachments.length > 0) && (
            <div className="ui-cloud-create-context">
              {source && (
                <span>
                  {source}
                  <button
                    type="button"
                    aria-label="Remove starting context"
                    onClick={() => {
                      setSource("");
                      setPull(null);
                      setBranch(branches[0] ?? "");
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              )}
              {attachments.map((a, i) => (
                <span key={i}>
                  {a}
                  <button
                    type="button"
                    aria-label={"Remove " + a}
                    onClick={() =>
                      setAttachments((as) => as.filter((_, j) => j !== i))
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {blocked && (
            <div className="ui-cloud-create-blocked" role="status">
              <span>{blocked.message}</span>
              {blocked.action && (
                <Button type="button" variant="secondary" size="sm" onClick={blocked.action.onClick}>
                  {blocked.action.label}
                </Button>
              )}
            </div>
          )}
          <footer>
            {!models.length && noModels !== undefined ? (
              noModels
            ) : (
              <ModelPicker
                models={models}
                value={selection}
                onChange={setSelection}
              />
            )}
            <span className="ui-cloud-create-spacer" />
            {contextMenu && (
              <>
            <input
              ref={file}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                setAttachments((as) => [
                  ...as,
                  ...Array.from(e.target.files ?? [], (f) => f.name),
                ]);
                e.target.value = "";
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Add context to new workspace"
                >
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => file.current?.click()}>
                  <Paperclip />
                  Attach files…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    setAttachments((as) => [...as, "Workspace command menu"])
                  }
                >
                  <Link />
                  Link workspace…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    setAttachments((as) => [
                      ...as,
                      "UI-128 Refine shared navigation",
                    ])
                  }
                >
                  <CircleDot />
                  Link issue…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
              </>
            )}
            {busy && step ? (
              <span className="ui-cloud-create-step" role="status">
                {step}
              </span>
            ) : (
              error && (
                <span className="ui-cloud-create-error" role="alert">
                  {error}
                </span>
              )
            )}
            <Button type="submit" size="sm" disabled={!prompt.trim() || busy || !!blocked}>
              {busy ? "Creating…" : "Create"}
              <CornerDownLeft size={13} />
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
