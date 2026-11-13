// Team knowledge browser. Replaces the raw `aura team knowledge query`
// terminal dump with a live-search list. Backed by `aura team knowledge
// query --json` (added in this stage). Each entry expands inline; the
// upvote button calls `aura team knowledge upvote <id>`. New entries
// go through `aura team knowledge store --question --answer --category`.

import { useEffect, useState } from "react";
import { ArrowUp, Plus } from "lucide-react";
import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Code } from "../ui/code";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import "../ui/knowledge.css";
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

/** A new entry while it is being written. */
type Draft = { question: string; answer: string; category: string; tags: string };

const EMPTY_DRAFT: Draft = { question: "", answer: "", category: "general", tags: "" };

const CATEGORIES = [
  { value: "general", label: "General" },
  { value: "bug", label: "Bug" },
  { value: "pattern", label: "Pattern" },
  { value: "decision", label: "Decision" },
  { value: "gotcha", label: "Gotcha" },
  { value: "rfc", label: "RFC" },
];

/** The form's id, so the footer's Save button can submit it. */
const COMPOSE_FORM_ID = "knowledge-compose";

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
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const canSave = !saving && !!draft.question.trim() && !!draft.answer.trim();

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

  const openCompose = () => {
    setDraft(EMPTY_DRAFT);
    setSaveErr(null);
    setComposeOpen(true);
  };

  const store = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const tags = draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const args = [
        "team",
        "knowledge",
        "store",
        "--question",
        draft.question.trim(),
        "--answer",
        draft.answer.trim(),
        "--category",
        draft.category,
      ];
      if (tags.length > 0) args.push("--tags", tags.join(","));
      const res = await api.auraCli(repoRoot, args);
      if (res.status !== 0) {
        throw new Error(res.stderr.trim() || `exit ${res.status}`);
      }
      setComposeOpen(false);
      await search(query);
    } catch (e) {
      setSaveErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={composeOpen ? "New knowledge entry" : "Team knowledge"}
      width={780}
      footer={
        composeOpen ? (
          <>
            <Button variant="outline" onClick={() => setComposeOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form={COMPOSE_FORM_ID} disabled={!canSave}>
              {saving ? "Saving…" : "Save entry"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={openCompose}>
              <Plus />
              New entry
            </Button>
          </>
        )
      }
    >
      {composeOpen ? (
        <ComposeForm
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          onSubmit={store}
          error={saveErr}
          disabled={saving}
        />
      ) : (
        <div className="ui-knowledge">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search team knowledge…"
            aria-label="Search team knowledge"
            autoFocus
          />
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : loading && results.length === 0 ? (
            <div className="ui-pattern-empty" role="status">
              <AsciiSpinner />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="ui-pattern-empty">
              {query.trim() ? "No matches. Try different words." : "No team knowledge stored yet."}
            </div>
          ) : (
            <ul className="ui-knowledge-list">
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
    <li className="ui-knowledge-entry">
      <button
        type="button"
        className="ui-knowledge-row"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <Badge variant="secondary">{entry.category || "general"}</Badge>
        <span className="ui-knowledge-question">{entry.question}</span>
        <small>
          {entry.username || "?"} · ↑ {entry.upvotes ?? 0}
        </small>
      </button>
      {expanded && (
        <div className="ui-knowledge-answer">
          <p>{entry.answer}</p>
          <div className="ui-knowledge-actions">
            <Button variant="outline" size="xs" onClick={onUpvote}>
              <ArrowUp />
              Upvote
            </Button>
            <Code size="sm">{entry.id}</Code>
          </div>
        </div>
      )}
    </li>
  );
}

function ComposeForm({
  draft,
  onChange,
  onSubmit,
  error,
  disabled,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onSubmit: () => void;
  error: string | null;
  disabled: boolean;
}) {
  return (
    <form
      id={COMPOSE_FORM_ID}
      className="ui-knowledge-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="ui-form-field">
        Question
        <Input
          value={draft.question}
          onChange={(e) => onChange({ question: e.target.value })}
          placeholder="How does retry logic work?"
          disabled={disabled}
          autoFocus
        />
      </label>
      <label className="ui-form-field">
        Answer
        <Textarea
          className="ui-knowledge-answer-input"
          value={draft.answer}
          onChange={(e) => onChange({ answer: e.target.value })}
          rows={6}
          placeholder="Exponential backoff with jitter, capped at 60s. See src/retry.rs."
          disabled={disabled}
        />
      </label>
      <div className="ui-knowledge-form-row">
        <label className="ui-form-field">
          Category
          <Select
            value={draft.category}
            onChange={(category) => onChange({ category })}
            options={CATEGORIES}
            aria-label="Category"
          />
        </label>
        <label className="ui-form-field">
          Tags, separated by commas
          <Input
            value={draft.tags}
            onChange={(e) => onChange({ tags: e.target.value })}
            placeholder="auth, retry, p0"
            disabled={disabled}
          />
        </label>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
