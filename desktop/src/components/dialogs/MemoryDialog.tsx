// Memory — "What Aura remembers about this project."
//
// One honest home for the project's long-term memory: the decisions,
// conventions, and gotchas Aura and your agents carry into every session so
// nobody has to repeat themselves. It reads the real Aura memory engine
// (`.aura/memory.json` via cmd_memory) — NOT any one agent's private notes —
// and lets you search it (ranked: file anchor + BM25 + embeddings +
// recency), see where each fact came from, and forget anything that's wrong.
//
// Non-engineer first: a vibecoder's question is "what does my AI think it
// knows, and can I fix it if it's wrong?", so the surface is the list of
// facts, each opening to where it came from and the controls over it.
//
// Provenance: CLI-stamped entries carry source_commit / source_symbol /
// valid_from. Staleness is NOT stored — it's computed at read time by
// `aura memory why <id> --json` (a live code check), called lazily once per
// anchored entry. Entries are Ed25519-signed at mint and verified at view
// time, carry a confidence weight and a scope manifest, and can be shared to
// the team explicitly — memory stays on this machine until you do.
//
// The pieces: `memory/useMemoryStore` (reads + writes), `memory/memoryModel`
// (names, parsing, wording), `memory/MemoryEntryRow` (one fact) and
// `memory/MemoryComposer` (adding one by hand).

import { useEffect, useMemo, useState } from "react";
import { Brain, Plus, Search, X } from "lucide-react";

import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Segment } from "../ui/segment";
import { EmptyState, ErrorState } from "../ui/state";
import { MemoryComposer, MEMORY_COMPOSE_FORM_ID, type ComposeState } from "./memory/MemoryComposer";
import { MemoryEntryRow, MemoryHitRow } from "./memory/MemoryEntryRow";
import { ALL, isWritableSection, sectionLabel, SECTIONS } from "./memory/memoryModel";
import { useMemoryStore, type MemoryStore } from "./memory/useMemoryStore";
import "../ui/knowledge.css";
import "../ui/memory.css";

type MemoryDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  /** Render as a full-height Trace page instead of a centered modal. */
  inline?: boolean;
};

export function MemoryDialog({ open, repoRoot, onClose, inline = false }: MemoryDialogProps) {
  const store = useMemoryStore(repoRoot, open);
  const { memory, allEntries, liveSections } = store;

  // Active category ("__all__" = everything, newest-first).
  const [activeSection, setActiveSection] = useState<string>(ALL);
  const [composing, setComposing] = useState(false);
  const [compose, setCompose] = useState<ComposeState>({ content: "", busy: false });
  // The one fact open in place.
  const [expanded, setExpanded] = useState<string | null>(null);

  // A category that emptied (its last fact forgotten, or a write that was a
  // no-op) falls back to everything rather than showing a blank list.
  useEffect(() => {
    if (!memory || activeSection === ALL) return;
    if (!liveSections.some((s) => s.name === activeSection)) setActiveSection(ALL);
  }, [memory, liveSections, activeSection]);

  const visible = useMemo(
    () =>
      activeSection === ALL ? allEntries : allEntries.filter((r) => r.section === activeSection),
    [allEntries, activeSection],
  );

  const startCompose = () => {
    setCompose({ content: "", busy: false });
    setComposing(true);
  };

  const footer = composing ? (
    <>
      <Button variant="outline" onClick={() => setComposing(false)} disabled={compose.busy}>
        Cancel
      </Button>
      <Button type="submit" form={MEMORY_COMPOSE_FORM_ID} disabled={compose.busy || !compose.content}>
        {compose.busy ? "Saving…" : "Remember this"}
      </Button>
    </>
  ) : (
    <>
      <label className="ui-check-label ui-memory-history">
        <Checkbox
          checked={store.showHistory}
          onCheckedChange={(next) => store.setShowHistory(next === true)}
        />
        Show history
      </label>
      <Button
        variant="outline"
        onClick={store.importFromClaudeCode}
        disabled={store.importing}
        title="Bring in what Claude Code has remembered about this repository"
      >
        {store.importing ? "Importing…" : "Import from Claude Code"}
      </Button>
      {!inline && (
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      )}
      <Button onClick={startCompose}>
        <Plus />
        Add a fact
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      inline={inline}
      fill={inline}
      title={composing ? "Add a fact to memory" : "Memory"}
      width={920}
      footer={footer}
    >
      {composing ? (
        <MemoryComposer
          defaultSection={
            activeSection !== ALL && isWritableSection(activeSection) ? activeSection : "context"
          }
          onStateChange={setCompose}
          onSubmit={async (section, content, tags) => {
            await store.addFact(section, content, tags);
            setComposing(false);
            setActiveSection(section);
          }}
        />
      ) : (
        <div
          className="ui-memory"
          data-scroll={inline ? undefined : ""}
          data-fill={inline ? "" : undefined}
        >
          <MemoryHead store={store} />
          {store.notice && (
            <Alert
              variant={store.notice.startsWith("Couldn't") ? "destructive" : "default"}
              className="ui-memory-notice"
            >
              <AlertDescription>{store.notice}</AlertDescription>
              <Button
                variant="ghost"
                size="iconXs"
                aria-label="Dismiss"
                onClick={() => store.setNotice(null)}
              >
                <X />
              </Button>
            </Alert>
          )}
          {store.error ? (
            <ErrorState
              size="sm"
              title="Couldn't read memory"
              message={store.error}
              onRetry={store.reload}
            />
          ) : !memory && store.loading ? (
            <div className="ui-pattern-empty" role="status">
              <AsciiSpinner />
              Reading what Aura remembers…
            </div>
          ) : !memory ? (
            <div className="ui-pattern-empty">Memory isn't set up for this repository yet.</div>
          ) : (
            <>
              <SearchBar store={store} />
              {store.hits !== null ? (
                <SearchResults store={store} expanded={expanded} onExpand={setExpanded} />
              ) : allEntries.length === 0 ? (
                <EmptyState
                  icon={Brain}
                  title="Aura hasn't remembered anything yet"
                  body="As you and your agents work, the decisions and conventions worth keeping are recorded here and travel into every future session, so the AI stops re-asking and re-breaking the same things. You can also add a fact by hand."
                  action={{ label: "Add the first fact", onClick: startCompose }}
                />
              ) : (
                <>
                  <div className="ui-memory-toolbar">
                    <Segment
                      size="xs"
                      value={activeSection}
                      onChange={setActiveSection}
                      ariaLabel="Category"
                      options={[
                        { value: ALL, label: <Counted label="Everything" n={allEntries.length} /> },
                        ...liveSections.map((s) => ({
                          value: s.name,
                          title: SECTIONS[s.name]?.blurb,
                          label: <Counted label={sectionLabel(s.name)} n={s.entries.length} />,
                        })),
                      ]}
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={store.reload}
                      disabled={store.loading}
                      title="Read memory again and re-check which facts are out of date"
                    >
                      {store.loading ? "Refreshing…" : "Refresh"}
                    </Button>
                  </div>
                  <ul className="ui-knowledge-list" aria-label="Remembered facts">
                    {visible.map(({ entry, section }) => (
                      <MemoryEntryRow
                        key={entry.id}
                        entry={entry}
                        section={section}
                        showSection={activeSection === ALL}
                        why={store.whyById[entry.id]}
                        expanded={expanded === entry.id}
                        onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                        onCheckWhy={store.requestWhy}
                        onForget={(hard) => store.forget(entry.id, hard)}
                        onSaveEdit={(content, tags) => store.saveEdit(entry.id, content, tags)}
                        onShare={() => store.share(entry)}
                        onUnshare={() => store.unshare(entry)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Counted({ label, n }: { label: string; n: number }) {
  return (
    <>
      {label}
      <span className="ui-memory-count">{n}</span>
    </>
  );
}

/** One line on what memory is, then what Aura takes this repository to be. */
function MemoryHead({ store }: { store: MemoryStore }) {
  const identity = store.memory?.identity?.trim();
  const stack = (store.memory?.stack ?? []).filter(Boolean);
  const count = store.allEntries.length;
  return (
    <div className="ui-memory-head">
      <p>
        What Aura carries into every session: the decisions, conventions and gotchas worth
        keeping, so nobody repeats themselves. It stays on this machine until you share a fact.
      </p>
      {(identity || stack.length > 0) && (
        <div className="ui-memory-identity">
          <span>Aura sees this as</span>
          {identity && <strong>{identity}</strong>}
          {stack.slice(0, 6).map((s) => (
            <Badge key={s} variant="outline">
              {s}
            </Badge>
          ))}
          <span>
            · {count} {count === 1 ? "fact" : "facts"} remembered
          </span>
        </div>
      )}
    </div>
  );
}

function SearchBar({ store }: { store: MemoryStore }) {
  const hasResults = store.hits !== null;
  return (
    <div className="ui-memory-search">
      <Input
        type="search"
        value={store.query}
        onChange={(e) => store.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") store.runSearch();
          if (e.key === "Escape" && hasResults) store.clearSearch();
        }}
        placeholder="Ask what Aura knows… e.g. how does auth work"
        aria-label="Search memory"
        prefix={<Search size={14} />}
      />
      {hasResults ? (
        <Button variant="ghost" size="sm" onClick={store.clearSearch}>
          Clear
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={store.runSearch}
          disabled={store.searching || !store.query.trim()}
        >
          {store.searching ? "Searching…" : "Search"}
        </Button>
      )}
    </div>
  );
}

function SearchResults({
  store,
  expanded,
  onExpand,
}: {
  store: MemoryStore;
  expanded: string | null;
  onExpand: (id: string | null) => void;
}) {
  const hits = store.hits ?? [];
  if (hits.length === 0) {
    return (
      <div className="ui-pattern-empty">
        Nothing remembered matches “{store.query.trim()}”.
      </div>
    );
  }
  return (
    <>
      <p className="ui-memory-caption">
        {hits.length} {hits.length === 1 ? "match" : "matches"}, best first
      </p>
      <ul className="ui-knowledge-list" aria-label="Matching facts">
        {hits.map((h, i) => {
          const found = h.id ? store.byId.get(h.id) : undefined;
          if (!found) {
            // Legacy/identity matches carry no stored entry — show the text.
            return <MemoryHitRow key={`hit-${i}`} section={h.section} content={h.content} />;
          }
          const { entry, section } = found;
          return (
            <MemoryEntryRow
              key={`${entry.id}-${i}`}
              entry={entry}
              section={section}
              showSection
              why={store.whyById[entry.id]}
              expanded={expanded === entry.id}
              onToggle={() => onExpand(expanded === entry.id ? null : entry.id)}
              onCheckWhy={store.requestWhy}
              onForget={(hard) => store.forget(entry.id, hard)}
              onSaveEdit={(content, tags) => store.saveEdit(entry.id, content, tags)}
              onShare={() => store.share(entry)}
              onUnshare={() => store.unshare(entry)}
            />
          );
        })}
      </ul>
    </>
  );
}
