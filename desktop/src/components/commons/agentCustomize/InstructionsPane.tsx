// Instructions pane — your house rules. The standing notes every agent reads
// before it touches your code: "always write tests", "keep components small",
// "never change the database without asking". These are the same project
// memory Aura keeps in .aura — we just give a non-engineer a plain place to
// add, read, and remove a rule. Adding one writes a real memory entry; the
// agent picks it up on its next run.

import { useState } from "react";
import { BookOpen, Plus, X } from "lucide-react";

import { api, type MemoryView } from "../../../lib/api";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsError } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Card, CountPill, EmptyHint, PaneIntro, PaneScroll, PaneSpinner } from "./customizeShared";

// House rules are real memory entries in the `conventions` section, tagged
// so this pane can tell them apart from machine-learned conventions. The
// old code wrote to a section named "rules" that the memory engine does
// not have — every "Add rule" failed silently and the rule vanished.
const RULES_SECTION = "conventions";
const RULES_TAG = "house-rule";

export function InstructionsPane({
  repoRoot,
  memory,
  loading,
  refresh,
}: {
  repoRoot: string;
  memory: MemoryView | null;
  loading: boolean;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const [addError, setAddError] = useState<string | null>(null);

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      await api.auraMemoryWriteEntry(repoRoot, RULES_SECTION, text, [RULES_TAG]);
      setDraft("");
      refresh();
    } catch (e) {
      // Never swallow the failure — the old silent catch made "Add rule"
      // look like it worked while the rule went nowhere.
      setAddError(String(e));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.auraMemoryForgetEntry(repoRoot, id);
    } finally {
      refresh();
    }
  };

  const sections = memory?.sections ?? [];
  const conventions = sections.find((s) => s.name === RULES_SECTION)?.entries ?? [];
  const rules = conventions.filter((e) => e.tags.includes(RULES_TAG));
  // Everything else the agent knows — including machine-learned conventions,
  // but not the house rules already shown above.
  const others = sections
    .map((s) =>
      s.name === RULES_SECTION
        ? { ...s, entries: s.entries.filter((e) => !e.tags.includes(RULES_TAG)) }
        : s,
    )
    .filter((s) => s.entries.length > 0);

  return (
    <PaneScroll>
      <PaneIntro
        title="Instructions"
        blurb="Standing rules every agent reads before it works on your repository. Write them in plain English. They travel with the repository, so your whole team's agents follow the same rules."
      />

      {/* Add a rule — the one primary action on this pane. */}
      <div className="ui-customize-add">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          aria-label="A new house rule"
          placeholder="e.g. Always ask before deleting a file"
        />
        <Button onClick={add} disabled={!draft.trim() || busy}>
          <Plus />
          Add rule
        </Button>
      </div>

      {addError && <SettingsError>Couldn't add that rule: {addError}</SettingsError>}

      {loading && !memory ? (
        <PaneSpinner label="Loading your rules…" />
      ) : rules.length === 0 ? (
        <EmptyHint
          icon={BookOpen}
          title="No house rules yet"
          body="Add your first one above. A good rule is short and specific. The agent will follow it on every task."
        />
      ) : (
        <Card>
          {rules.map((entry) => (
            <SettingsRow
              key={entry.id}
              className="ui-customize-rule"
              title={entry.content}
              control={
                <Button
                  variant="ghost"
                  size="iconSm"
                  className="ui-customize-remove"
                  onClick={() => remove(entry.id)}
                  aria-label="Remove rule"
                  title="Remove rule"
                >
                  <X />
                </Button>
              }
            />
          ))}
        </Card>
      )}

      {/* What the agent already knows — read-only context, so the picture is
          honest and complete without inviting edits to machine-kept notes. */}
      {others.length > 0 ? (
        <SettingsSection title="Also known about this repository">
          {others.map((s) => (
            <SettingsRow
              key={s.name}
              title={<span className="ui-customize-section-name">{s.name}</span>}
              control={<CountPill>{s.entries.length}</CountPill>}
              help={
                <ul className="ui-customize-known">
                  {s.entries.map((e) => (
                    <li key={e.id}>{e.content}</li>
                  ))}
                </ul>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </PaneScroll>
  );
}
