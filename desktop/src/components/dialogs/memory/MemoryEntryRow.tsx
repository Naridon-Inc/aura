// One remembered fact, as a row of the same bordered list Team knowledge
// draws. Closed, the row is the fact itself plus the marks that change what
// you do next (out of date, signature broken, a correction your team never
// got). Open, it says where the fact came from in plain lines and offers the
// controls: share, stop sharing, edit, forget — or erase, for history.

import { useEffect, useState } from "react";

import { agentDisplayLabel } from "../../../lib/agentIdentity";
import type { MemoryEntry } from "../../../lib/api";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Code } from "../../ui/code";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { TraceMark } from "../../ui/trace-list";
import {
  confidenceLabel,
  fmtDate,
  fmtTs,
  parseTags,
  scopeTooltip,
  sectionLabel,
  shortSymbol,
  type WhyInfo,
} from "./memoryModel";

type RowProps = {
  entry: MemoryEntry;
  section: string;
  /** Show the category badge — in "Everything" and in search, not when the
   *  list is already filtered to one category. */
  showSection: boolean;
  why: WhyInfo | undefined;
  expanded: boolean;
  onToggle: () => void;
  onCheckWhy: (id: string) => void;
  onForget: (hard: boolean) => void;
  onSaveEdit: (content: string, tags: string[]) => Promise<void>;
  onShare: () => void;
  onUnshare: () => void;
};

export function MemoryEntryRow({
  entry,
  section,
  showSection,
  why,
  expanded,
  onToggle,
  onCheckWhy,
  onForget,
  onSaveEdit,
  onShare,
  onUnshare,
}: RowProps) {
  // Lazy read-time verification, for the two things only the engine knows:
  // whether an anchored fact has gone stale, and whether the wording this one
  // corrected had already been shared. The store caches per id, so drawing a
  // row triggers at most one call.
  useEffect(() => {
    if (entry.source_symbol || entry.supersedes) onCheckWhy(entry.id);
  }, [entry.id, entry.source_symbol, entry.supersedes, onCheckWhy]);

  const [editing, setEditing] = useState(false);
  // Closed rows only show under "Show history": superseded by an edit, or
  // soft-forgotten. They are read-only audit trail (plus Erase).
  const closed = !!entry.valid_to;
  // A fact written over MCP is stamped "MCP Agent"; resolve it to the real
  // agent ("Claude Code"). Human names pass through.
  const whoRaw = entry.added_by?.trim();
  const who = whoRaw ? agentDisplayLabel(whoRaw) : undefined;
  const when = fmtTs(entry.added_at);

  return (
    <li className="ui-knowledge-entry ui-memory-entry" data-closed={closed || undefined}>
      <button
        type="button"
        className="ui-knowledge-row ui-memory-row"
        aria-expanded={expanded}
        onClick={() => {
          if (expanded) setEditing(false);
          onToggle();
        }}
      >
        {showSection && <Badge variant="secondary">{sectionLabel(section)}</Badge>}
        <span className="ui-memory-fact">{entry.content}</span>
        <MemoryMarks entry={entry} why={why} closed={closed} />
        {(who || when) && <small>{[who, when].filter(Boolean).join(" · ")}</small>}
      </button>
      {expanded && (
        <div className="ui-knowledge-answer">
          {editing ? (
            <EditFact
              entry={entry}
              onCancel={() => setEditing(false)}
              onSave={async (content, tags) => {
                await onSaveEdit(content, tags);
                setEditing(false);
              }}
            />
          ) : (
            <>
              <MemoryDetails entry={entry} why={why} closed={closed} who={who} />
              <div className="ui-knowledge-actions">
                {closed ? (
                  <Button
                    variant="outlineDestructive"
                    size="xs"
                    onClick={() => onForget(true)}
                    title="Removes even the history copy. This is the privacy switch."
                  >
                    Erase completely
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={onShare}
                      title={
                        entry.shared_at
                          ? "Sending again replaces your team's copy with this wording"
                          : "Memory stays on this machine until you share a fact"
                      }
                    >
                      {entry.shared_at ? "Share again" : "Share with team"}
                    </Button>
                    {entry.shared_at && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={onUnshare}
                        title="Aura stops serving it. A copy someone already pulled isn't reached."
                      >
                        Stop sharing
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setEditing(true)}
                      title="The old wording is kept as history"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => onForget(false)}
                      title="Aura stops carrying it into sessions; kept under Show history until erased"
                    >
                      Forget
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** A ranked search hit with no stored entry behind it (legacy or identity
 *  text): the same row, nothing to open. */
export function MemoryHitRow({ section, content }: { section: string; content: string }) {
  return (
    <li className="ui-knowledge-entry ui-memory-entry">
      <div className="ui-knowledge-row ui-memory-row" data-static="">
        {section && <Badge variant="secondary">{sectionLabel(section)}</Badge>}
        <span className="ui-memory-fact">{content}</span>
      </div>
    </li>
  );
}

/** The marks a closed row wears. Only what changes the reader's next move,
 *  or says the fact has left this machine. */
function MemoryMarks({
  entry,
  why,
  closed,
}: {
  entry: MemoryEntry;
  why: WhyInfo | undefined;
  closed: boolean;
}) {
  const marks: { key: string; text: string; tone?: "danger" | "warn"; title?: string }[] = [];
  if (closed) {
    marks.push({ key: "closed", text: entry.supersedes ? "Replaced" : "Forgotten" });
  }
  if (entry.signed === "invalid") {
    marks.push({ key: "sig", text: "Signature broken", tone: "danger" });
  }
  if (why?.stale) {
    marks.push({ key: "stale", text: "May be out of date", tone: "warn", title: why.reason });
  }
  if (!entry.shared_at && why?.supersedesSharedAt) {
    marks.push({ key: "correction", text: "Correction not shared", tone: "warn" });
  }
  if (entry.shared_at) {
    marks.push({ key: "shared", text: "Shared", title: `Shared on ${fmtDate(entry.shared_at)}` });
  } else if (entry.shared_retracted_at) {
    marks.push({ key: "withdrawn", text: "Withdrawn" });
  }
  if (marks.length === 0) return null;
  return (
    <span className="ui-trace-row-marks ui-memory-marks">
      {marks.map((m) => (
        <TraceMark key={m.key} tone={m.tone} title={m.title}>
          {m.text}
        </TraceMark>
      ))}
    </span>
  );
}

/** Where the fact came from and what has happened to it, one plain line
 *  each. These used to be tooltips on chips, which only a mouse could read. */
function MemoryDetails({
  entry,
  why,
  closed,
  who,
}: {
  entry: MemoryEntry;
  why: WhyInfo | undefined;
  closed: boolean;
  who: string | undefined;
}) {
  const confidence = confidenceLabel(entry.importance);
  const scope = scopeTooltip(entry.scope);
  const added =
    entry.added_at > 0
      ? new Date(entry.added_at * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  return (
    <ul className="ui-memory-details">
      {(who || added) && (
        <li>
          Remembered{who ? ` by ${who}` : ""}
          {added ? ` on ${added}` : ""}.
        </li>
      )}
      {closed && (
        <li>
          {entry.supersedes
            ? "This wording was replaced by an edit and is kept as history."
            : "Forgotten — kept as history until erased."}
        </li>
      )}
      {why?.stale && (
        <li data-tone="warn">
          {why.reason ?? "The code this fact referenced has changed since it was written."}
        </li>
      )}
      {!entry.shared_at && why?.supersedesSharedAt && (
        <li data-tone="warn">
          You corrected this here, but the wording it replaced was shared on{" "}
          {fmtDate(why.supersedesSharedAt)} and is still what your team has.
        </li>
      )}
      {entry.signed === "invalid" && (
        <li data-tone="danger">
          This fact carries a signature that does not verify — it may have been altered since it
          was written.
        </li>
      )}
      {entry.signed === "valid" && (
        <li title={entry.sig_key_id}>Signed, and the signature checks out.</li>
      )}
      {entry.shared_at ? (
        <li>
          Shared with your team on {fmtDate(entry.shared_at)}
          {entry.shared_signature === "signed"
            ? " — signed, so they can verify it came from you."
            : " — your team can read it, but not verify who wrote it."}
        </li>
      ) : entry.shared_retracted_at ? (
        <li>
          Withdrawn on {fmtDate(entry.shared_retracted_at)} — your team can no longer read it
          through Aura, but a copy someone already pulled isn't reached.
        </li>
      ) : (
        !closed && <li>Only on this machine.</li>
      )}
      {entry.source_symbol && (
        <li>
          Anchored to <Code size="sm" title={entry.source_symbol}>{shortSymbol(entry.source_symbol)}</Code>
          {entry.source_commit && (
            <>
              {" "}
              at commit <Code size="sm">{entry.source_commit.slice(0, 8)}</Code>
            </>
          )}
        </li>
      )}
      {!entry.source_symbol && entry.source_commit && (
        <li>
          Learned at commit <Code size="sm">{entry.source_commit.slice(0, 8)}</Code>
        </li>
      )}
      {(confidence || entry.tags.length > 0) && (
        <li>
          {[confidence, entry.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join(" · ")}
        </li>
      )}
      {scope && <li>{scope}</li>}
    </ul>
  );
}

function EditFact({
  entry,
  onSave,
  onCancel,
}: {
  entry: MemoryEntry;
  onSave: (content: string, tags: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(entry.content);
  const [draftTags, setDraftTags] = useState(entry.tags.join(", "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await onSave(content, parseTags(draftTags));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ui-memory-edit">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        aria-label="Edit this fact"
        autoFocus
      />
      <Input
        value={draftTags}
        onChange={(e) => setDraftTags(e.target.value)}
        placeholder="Tags, separated by commas"
        aria-label="Tags"
      />
      <div className="ui-knowledge-actions">
        <Button size="xs" onClick={save} disabled={saving || !draft.trim()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <small>The previous wording is kept — nothing is silently rewritten.</small>
      </div>
    </div>
  );
}
