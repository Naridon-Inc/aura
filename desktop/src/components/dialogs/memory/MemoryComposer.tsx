// Adding a fact by hand: the same plain form Team knowledge uses for a new
// entry. The surface's footer carries Cancel and "Remember this", which
// submit this form by its id.

import { useState } from "react";

import { Alert, AlertDescription } from "../../ui/alert";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { isWritableSection, parseTags, SECTIONS, WRITABLE_SECTIONS } from "./memoryModel";

export const MEMORY_COMPOSE_FORM_ID = "memory-compose";

// Only entry-shaped sections are writable: `decisions` and `architecture`
// are maintained by Aura itself, and hand-written entries there used to
// corrupt the store.
const OPTIONS = WRITABLE_SECTIONS.map((id) => ({ value: id, label: SECTIONS[id].label }));

export type ComposeState = { content: string; busy: boolean };

export function MemoryComposer({
  defaultSection,
  onSubmit,
  onStateChange,
}: {
  defaultSection: string;
  onSubmit: (section: string, content: string, tags: string[]) => Promise<void>;
  /** Lets the footer's "Remember this" know whether there's anything to
   *  save and whether a save is running. */
  onStateChange: (state: ComposeState) => void;
}) {
  const [section, setSection] = useState(
    isWritableSection(defaultSection) ? defaultSection : "context",
  );
  const [content, setContent] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    onStateChange({ content: text, busy: true });
    try {
      await onSubmit(section, text, parseTags(tagsRaw));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onStateChange({ content: text, busy: false });
    }
  };

  return (
    <form
      id={MEMORY_COMPOSE_FORM_ID}
      className="ui-knowledge-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="ui-form-field">
        What should every future session know?
        <Textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            onStateChange({ content: e.target.value.trim(), busy });
          }}
          rows={4}
          placeholder="e.g. Green is the primary colour for buttons; orange only marks the agent."
          disabled={busy}
          autoFocus
        />
      </label>
      <div className="ui-knowledge-form-row">
        <label className="ui-form-field">
          Category
          <Select
            value={section}
            onChange={setSection}
            options={OPTIONS}
            aria-label="Category"
          />
          <small className="ui-memory-hint">{SECTIONS[section]?.blurb}</small>
        </label>
        <label className="ui-form-field">
          Tags, separated by commas
          <Input
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="auth, perf, p0"
            disabled={busy}
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
