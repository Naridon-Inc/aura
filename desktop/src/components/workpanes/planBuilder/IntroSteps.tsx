// The plan builder's first three pages: the goal, what Aura will read to plan
// it, and the design calls it makes on its own.

import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { LoadingState } from "../../ui/state";
import { Textarea } from "../../ui/textarea";
import "../../ui/plan-builder.css";

/** The newest reasons recorded in this repository, most recent first — a
 *  quick start when the goal is close to something already under way. */
function useRecentWork(repoRoot: string): string[] {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .readFile(`${repoRoot}/.aura/intent_log.jsonl`)
      .then((f) => {
        if (cancelled || f.status !== "ok" || !f.text) return;
        const lines = f.text.trim().split(/\r?\n/).filter(Boolean).reverse();
        const out: string[] = [];
        for (const ln of lines) {
          try {
            const obj = JSON.parse(ln);
            const text = (obj.intent ?? obj.text ?? obj.summary ?? "").trim();
            if (text && text.length > 6 && !out.includes(text)) out.push(text);
          } catch {
            // A torn line is skipped; the rest of the log still reads.
          }
          if (out.length >= 4) break;
        }
        setRecent(out);
      })
      .catch(() => {
        // No log yet: the page simply offers no recent work.
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);
  return recent;
}

export function GoalStep({
  value,
  onChange,
  onSubmit,
  repoRoot,
}: {
  value: string;
  onChange: (v: string) => void;
  /** ⌘↵ moves on, the same as pressing Continue. */
  onSubmit: () => void;
  repoRoot: string;
}) {
  const recent = useRecentWork(repoRoot);
  return (
    <>
      <header>
        <h1>What do you want built?</h1>
        <p>Aura splits it into waves of small tasks. Name the features; it doesn't need a full spec.</p>
      </header>
      <Textarea
        autoFocus
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="e.g. Let invited teammates sign in with a magic link"
        aria-label="What you want built"
        className="ui-plan-goal"
      />
      {recent.length > 0 && (
        <section className="ui-plan-recent" aria-label="Recent work">
          <small>Start from recent work</small>
          <div className="ui-cloud-agent-connections">
            {recent.map((r) => (
              <button key={r} type="button" onClick={() => onChange(r)} title={r}>
                <span>{r}</span>
                <small>Use</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export function ContextStep({
  repoRoot,
  projectLabel,
}: {
  repoRoot: string;
  projectLabel: string;
}) {
  const [info, setInfo] = useState<{ files: number; branch: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.gitStatusV2(repoRoot).catch(() => []),
      api.gitBranch(repoRoot).catch(() => "—"),
    ]).then(([entries, branch]) => {
      if (!cancelled) setInfo({ files: entries.length, branch });
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);
  return (
    <>
      <header>
        <h1>What Aura will read</h1>
        <p>
          The plan is grounded in this repository: its files, its recent commits and the reasons
          recorded for them.
        </p>
      </header>
      <dl className="ui-plan-facts">
        <div>
          <dt>Repository</dt>
          <dd title={repoRoot}>
            {projectLabel}
            <small>{repoRoot}</small>
          </dd>
        </div>
        {info ? (
          <>
            <div>
              <dt>Branch</dt>
              <dd>{info.branch}</dd>
            </div>
            <div>
              <dt>Changed files</dt>
              <dd>{info.files}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Branch</dt>
            <dd>
              <LoadingState label="Reading…" />
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

export function DecisionsStep() {
  return (
    <header>
      <h1>Design choices</h1>
      <p>
        Aura makes the small design calls for this plan itself. You can change every wave and task
        on the next page, before anything runs.
      </p>
    </header>
  );
}
