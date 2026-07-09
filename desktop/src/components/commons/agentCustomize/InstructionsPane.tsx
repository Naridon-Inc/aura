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
import {
  Card,
  EmptyHint,
  PaneIntro,
  PaneScroll,
  PaneSpinner,
} from "./customizeShared";

// House rules live in a single, human-named section so the surface stays
// simple; other sections (architecture, decisions…) still render read-only
// below so nothing the agent already knows is hidden.
const RULES_SECTION = "rules";

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

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.auraMemoryWriteEntry(repoRoot, RULES_SECTION, text, []);
      setDraft("");
      refresh();
    } catch {
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
  const rules = sections.find((s) => s.name === RULES_SECTION)?.entries ?? [];
  const others = sections.filter(
    (s) => s.name !== RULES_SECTION && s.entries.length > 0,
  );

  return (
    <PaneScroll>
      <PaneIntro
        title="Instructions"
        blurb="Standing rules every agent reads before it works on your project. Write them in plain English — they travel with the project, so your whole team's agents follow the same rules."
      />

      {/* Add a rule — the one primary action on this pane. */}
      <div className="mb-4 flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="e.g. Always ask before deleting a file"
          className="h-9 flex-1"
        />
        <Button
          size="sm"
          onClick={add}
          disabled={!draft.trim() || busy}
          className="shrink-0 gap-1"
        >
          <Plus size={14} />
          Add rule
        </Button>
      </div>

      {loading && !memory ? (
        <PaneSpinner label="Loading your rules…" />
      ) : rules.length === 0 ? (
        <EmptyHint
          icon={<BookOpen size={22} />}
          title="No house rules yet"
          body="Add your first one above. A good rule is short and specific — the agent will follow it on every task."
        />
      ) : (
        <Card>
          {rules.map((entry, i) => (
            <div
              key={entry.id}
              className={`group flex items-start gap-3 px-3.5 py-2.5 ${
                i > 0 ? "border-t border-line-soft" : ""
              }`}
            >
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--color-accent)" }}
              />
              <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-text-1">
                {entry.content}
              </div>
              <button
                type="button"
                onClick={() => remove(entry.id)}
                aria-label="Remove rule"
                className="shrink-0 text-text-4 opacity-0 transition-opacity hover:text-text-1 group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </Card>
      )}

      {/* What the agent already knows — read-only context, so the picture is
          honest and complete without inviting edits to machine-kept notes. */}
      {others.length > 0 ? (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.07em] text-text-4">
            Also known about this project
          </div>
          <div className="space-y-3">
            {others.map((s) => (
              <Card key={s.name} className="px-3.5 py-3">
                <div className="mb-1.5 text-[11.5px] font-medium capitalize text-text-2">
                  {s.name}
                </div>
                <ul className="space-y-1">
                  {s.entries.map((e) => (
                    <li
                      key={e.id}
                      className="text-[12px] leading-relaxed text-text-3"
                    >
                      {e.content}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </PaneScroll>
  );
}
