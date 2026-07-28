// Native pull-request authoring. A single app-level host listens for create
// requests from worktree cards and edit requests from PR detail, so the dialog
// survives hover-card dismissal and both entry points share one honest form.

import { useEffect, useMemo, useState } from "react";

import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { api, type GitBranchRich } from "../../lib/api";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { invalidatePrList } from "../../lib/prsCache";
import { useEditorStore } from "../../lib/editorStore";

export const PR_AUTHOR_EVENT = "aura:author-pr";

type CreateRequest = {
  mode: "create";
  repoRoot: string;
  headBranch: string;
  title: string;
  draft?: boolean;
};

type EditRequest = {
  mode: "edit";
  repoRoot: string;
  number: number;
  title: string;
  body: string;
  baseBranch: string;
  draft: boolean;
};

export type PrAuthoringRequest = CreateRequest | EditRequest;

export function requestPrAuthoring(request: PrAuthoringRequest): void {
  window.dispatchEvent(new CustomEvent(PR_AUTHOR_EVENT, { detail: request }));
}

export function PrAuthoringDialogHost() {
  const editor = useEditorStore();
  const [request, setRequest] = useState<PrAuthoringRequest | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [draft, setDraft] = useState(false);
  const [branches, setBranches] = useState<GitBranchRich[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onRequest(event: Event) {
      const next = (event as CustomEvent<PrAuthoringRequest>).detail;
      if (!next?.repoRoot) return;
      setRequest(next);
      setTitle(next.title ?? "");
      setBody(next.mode === "edit" ? next.body : "");
      setBaseBranch(next.mode === "edit" ? next.baseBranch : "");
      setDraft(next.draft ?? false);
      setBusy(false);
      setError(null);
    }
    window.addEventListener(PR_AUTHOR_EVENT, onRequest as EventListener);
    return () =>
      window.removeEventListener(PR_AUTHOR_EVENT, onRequest as EventListener);
  }, []);

  useEffect(() => {
    if (!request) return;
    let alive = true;
    api
      .gitBranchesRich(request.repoRoot)
      .then((rows) => {
        if (alive) setBranches(rows);
      })
      .catch(() => {
        if (alive) setBranches([]);
      });
    return () => {
      alive = false;
    };
  }, [request?.repoRoot]);

  const branchOptions = useMemo(() => {
    const names = new Set<string>();
    if (baseBranch) names.add(baseBranch);
    for (const branch of branches) {
      if (!branch.isRemote) names.add(branch.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [baseBranch, branches]);

  function close() {
    if (!busy) setRequest(null);
  }

  async function submit() {
    if (!request || !title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (request.mode === "create") {
        const created = await api.prCreate({
          repoRoot: request.repoRoot,
          headBranch: request.headBranch,
          title: title.trim(),
          body: body.trim(),
          baseBranch: baseBranch || null,
          draft,
        });
        await invalidatePrList(request.repoRoot).catch(() => []);
        editor.openPrDetail(request.repoRoot, created.number, created.title);
      } else {
        await api.prEdit({
          repoRoot: request.repoRoot,
          prNumber: request.number,
          title: title.trim(),
          body: body.trim(),
          baseBranch: baseBranch || null,
          draft,
        });
        await Promise.all([
          invalidatePrList(request.repoRoot).catch(() => []),
          invalidatePrDetail(request.repoRoot, request.number).catch(() => null),
        ]);
      }
      setRequest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const editing = request?.mode === "edit";
  return (
    <Dialog
      open={request !== null}
      onClose={close}
      title={editing ? `Edit pull request #${request.number}` : "Create pull request"}
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
          >
            {busy
              ? editing
                ? "Saving…"
                : "Creating…"
              : editing
                ? "Save changes"
                : draft
                  ? "Create draft"
                  : "Create pull request"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[11.5px]">
        {!editing && request && (
          <div className="rounded border border-line-soft bg-bg-1 px-2.5 py-2 text-text-3">
            Source branch{" "}
            <span className="font-mono text-text-1">{request.headBranch}</span>
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-[10.5px] uppercase tracking-wider text-text-4">
            Title
          </span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10.5px] uppercase tracking-wider text-text-4">
            Description
          </span>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            disabled={busy}
            placeholder="What changed, why it changed, and anything reviewers should know."
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10.5px] uppercase tracking-wider text-text-4">
            Target branch
          </span>
          <select
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            disabled={busy}
            className="h-8 w-full rounded border border-line bg-bg-1 px-2 text-[12px] text-text-1 outline-none focus:border-text-4"
          >
            {!editing && <option value="">Repository default</option>}
            {branchOptions.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-text-2">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            disabled={busy}
            className="accent-accent"
          />
          Keep this pull request as a draft
        </label>
        {error && (
          <div role="alert" className="text-[11px] text-red">
            {error}
          </div>
        )}
        {!editing && (
          <div className="text-[10.5px] text-text-5">
            Creating the pull request pushes the source branch first.
          </div>
        )}
      </div>
    </Dialog>
  );
}
