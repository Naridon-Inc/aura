// Team knowledge browser. Replaces the raw `aura team knowledge query`
// terminal dump with a live-search list. Backed by `aura team knowledge
// query --json` (added in this stage). Each entry expands inline; the
// upvote button calls `aura team knowledge upvote <id>`. New entries
// go through `aura team knowledge store --question --answer --category`.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { api } from "../../lib/api";

type KnowledgeEntry = {
  id: string;
  question: string;
  answer: string;
  category: string;
  username: string;
  upvotes: number;
  created_at?: number;
};

type KnowledgeDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

export function KnowledgeDialog({ open, repoRoot, onClose }: KnowledgeDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const search = async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const args = ["team", "knowledge", "query", "--limit", "50", "--json"];
      if (q.trim()) args.splice(3, 0, q.trim());
      const res = await api.auraCli(repoRoot, args);
      const out = res.stdout.trim();
      if (!out) {
        setResults([]);
        if (res.status !== 0) {
          setError(res.stderr.trim() || `exit ${res.status}`);
        }
        return;
      }
      try {
        const parsed = JSON.parse(out) as { results?: KnowledgeEntry[] };
        setResults(parsed.results ?? []);
      } catch (e) {
        setError(`Could not parse knowledge output: ${String(e)}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(query), query ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  const upvote = async (id: string) => {
    try {
      await api.auraCli(repoRoot, ["team", "knowledge", "upvote", id]);
      setResults((rs) =>
        rs.map((r) => (r.id === id ? { ...r, upvotes: r.upvotes + 1 } : r)),
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const store = async (question: string, answer: string, category: string, tags: string[]) => {
    const args = [
      "team",
      "knowledge",
      "store",
      "--question",
      question,
      "--answer",
      answer,
      "--category",
      category,
    ];
    if (tags.length > 0) args.push("--tags", tags.join(","));
    const res = await api.auraCli(repoRoot, args);
    if (res.status !== 0) {
      throw new Error(res.stderr.trim() || `exit ${res.status}`);
    }
    setComposeOpen(false);
    await search(query);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Team knowledge"
      width={780}
      footer={
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setComposeOpen(true)}
          >
            + New entry
          </Button>
          <Button variant="default" size="xs" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {composeOpen ? (
        <ComposeForm onCancel={() => setComposeOpen(false)} onSubmit={store} />
      ) : (
        <div className="flex flex-col gap-3 max-h-[64vh]">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search team knowledge…"
            autoFocus
          />
          {error ? (
            <div className="text-red text-[11.5px]">{error}</div>
          ) : loading && results.length === 0 ? (
            <div className="text-text-4 text-[11.5px] py-6 text-center">searching…</div>
          ) : results.length === 0 ? (
            <div className="text-text-4 text-[11.5px] py-6 text-center">
              {query.trim()
                ? "no matches — try a different query"
                : "no team knowledge stored yet"}
            </div>
          ) : (
            <ul className="overflow-auto pr-1 flex flex-col gap-1.5">
              {results.map((r) => (
                <KnowledgeRow
                  key={r.id}
                  entry={r}
                  expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  onUpvote={() => upvote(r.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

function KnowledgeRow({
  entry,
  expanded,
  onToggle,
  onUpvote,
}: {
  entry: KnowledgeEntry;
  expanded: boolean;
  onToggle: () => void;
  onUpvote: () => void;
}) {
  return (
    <li className="rounded border border-line-soft bg-bg-1">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-bg-2"
      >
        <span className="text-[11.5px] text-text-1 flex-1 min-w-0">
          <span className="text-[10.5px] uppercase tracking-wide text-text-4 mr-2">
            {entry.category || "general"}
          </span>
          {entry.question}
        </span>
        <span className="shrink-0 text-[10.5px] text-text-4">
          {entry.username || "?"} · ↑ {entry.upvotes ?? 0}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-line-soft">
          <div className="text-[11.5px] text-text-1 whitespace-pre-wrap break-words">
            {entry.answer}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Button variant="subtle" size="xs" onClick={onUpvote}>
              ↑ Upvote
            </Button>
            <span className="text-[10.5px] text-text-4 font-mono">{entry.id}</span>
          </div>
        </div>
      )}
    </li>
  );
}

function ComposeForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (q: string, a: string, cat: string, tags: string[]) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [category, setCategory] = useState("general");
  const [tagsRaw, setTagsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const categories = useMemo(
    () => ["general", "bug", "pattern", "decision", "gotcha", "rfc"],
    [],
  );

  const submit = async () => {
    if (!question.trim() || !answer.trim()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const tags = tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await onSubmit(question.trim(), answer.trim(), category, tags);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] text-text-1">New knowledge entry</div>
      {err && <div className="text-red text-[11.5px]">{err}</div>}
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] text-text-3 uppercase tracking-wide">Question</span>
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="How does retry logic work?"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] text-text-3 uppercase tracking-wide">Answer</span>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={6}
          placeholder="Exponential backoff with jitter, capped at 60s. See src/retry.rs."
          className="px-2 py-1.5 rounded bg-bg-1 border border-line-soft text-text-1 text-[11.5px] font-mono resize-y"
        />
      </label>
      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10.5px] text-text-3 uppercase tracking-wide">Category</span>
          <Select
            value={category}
            onChange={setCategory}
            options={categories.map((c) => ({ value: c, label: c }))}
            aria-label="Category"
          />
        </label>
        <label className="flex flex-col gap-1 flex-[2]">
          <span className="text-[10.5px] text-text-3 uppercase tracking-wide">
            Tags (comma-separated)
          </span>
          <Input
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="auth, retry, p0"
          />
        </label>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <Button
          variant="default"
          size="xs"
          onClick={submit}
          disabled={submitting || !question.trim() || !answer.trim()}
        >
          {submitting ? "Saving…" : "Save entry"}
        </Button>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
