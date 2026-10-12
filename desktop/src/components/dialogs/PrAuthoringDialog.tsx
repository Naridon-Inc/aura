// Native pull-request authoring. A single app-level host listens for create
// requests from worktree cards and edit requests from PR detail, so the dialog
// survives hover-card dismissal and both entry points share one honest form.

import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { GitBranchRich } from "../../lib/api";
import { gitBranchesRich } from "../../lib/place/workApi";
import { prCreate, prEdit } from "../../lib/prApi";
import { invalidatePrDetail } from "../../lib/prDetailCache";
import { invalidatePrList } from "../../lib/prsCache";
import { useEditorStore } from "../../lib/editorStore";
import { seedPrBody } from "./prTemplate";

export const PR_AUTHOR_EVENT = "aura:author-pr";

type CreateRequest = {
  mode: "create";
  repoRoot: string;
  headBranch: string;
  title: string;
  /** A description to open with. Absent means nobody has written one yet, and
   *  the box starts from the PR template; present — a generator that already
   *  read the diff, say — is used as given, so generated prose replaces the
   *  template rather than landing underneath it. */
  body?: string;
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
  // The compose session the template has already been offered to, as
  // repo + branch. A second create request for the same branch is the same
  // session — a click on the card behind the dialog, or a return visit after
  // a cancel — and resetting it would throw away a half-written description
  // and put the template back over one the author had deliberately emptied.
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    function onRequest(event: Event) {
      const next = (event as CustomEvent<PrAuthoringRequest>).detail;
      if (!next?.repoRoot) return;
      const session =
        next.mode === "create" ? `${next.repoRoot}\u0000${next.headBranch}` : null;
      const resuming = session !== null && session === seededFor.current;
      seededFor.current = session;
      setRequest(next);
      setTitle((current) => (resuming ? current : (next.title ?? "")));
      setBody((current) =>
        next.mode === "edit"
          ? next.body
          : seedPrBody(resuming ? current : next.body, resuming),
      );
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
    gitBranchesRich(request.repoRoot)
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
        const created = await prCreate({
          repoRoot: request.repoRoot,
          headBranch: request.headBranch,
          title: title.trim(),
          body: body.trim(),
          baseBranch: baseBranch || null,
          draft,
        });
        await invalidatePrList(request.repoRoot).catch(() => []);
        // The branch has a pull request now, so the next compose from here is
        // a new one and starts from the template again.
        seededFor.current = null;
        editor.openPrDetail(request.repoRoot, created.number, created.title);
      } else {
        await prEdit({
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
      <div className="space-y-3 text-sm">
        {!editing && request && (
          <div className="rounded border border-line-soft bg-bg-1 px-2.5 py-2 text-text-3">
            Source branch{" "}
            <span className="font-mono text-text-1">{request.headBranch}</span>
          </div>
        )}
        <label className="block space-y-1">
          <span className="section-label">
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
          <span className="section-label">
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
          <span className="section-label">
            Target branch
          </span>
          <select
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            disabled={busy}
            className="h-8 w-full rounded border border-line bg-bg-1 px-2 text-sm text-text-1 outline-none focus:border-text-4"
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
          <div role="alert" className="text-xs text-red">
            {error}
          </div>
        )}
        {!editing && (
          <div className="text-xs text-text-5">
            Creating the pull request pushes the source branch first.
          </div>
        )}
      </div>
    </Dialog>
  );
}
