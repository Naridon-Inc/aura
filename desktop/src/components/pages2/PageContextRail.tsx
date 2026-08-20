// PageContextRail — the right column of the Pages surface. Four thin-row
// sections: Outline (live H1–H3 anchors), Linked from (backlinks), Mentions
// (people/tasks/pages referenced in this page), and Info (author, dates,
// word count, visibility). No bulky cards — every section is a label + thin
// rows on the content surface.

import { useEffect, useMemo, useState } from "react";
import { Hash, FileText, AtSign, Clock, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { shortDate } from "../../lib/calendarDate";
import { Avatar } from "../team/presentation/Avatar";
import { extractHandles } from "../../lib/mentions";
import {
  notesBacklinks,
  pageKey,
  type Note,
  type NoteSummary,
} from "./pagesApi";
import type { MentionSources } from "./mentionSources";
import { sentenceCase } from "../../lib/textCase";

type Heading = { id: string; level: number; text: string };

type Props = {
  repoRoot: string;
  note: Note | null;
  /** Live editor body markdown — drives Outline + Mentions without a save. */
  body: string;
  mentionSources?: MentionSources;
  /** Hide the rail (the header "×"). Mirrors the header kebab's outline toggle. */
  onClose?: () => void;
  /** Scroll the editor to a heading anchor (by slug). */
  onJumpToHeading: (slug: string) => void;
  onOpenByTitle: (title: string) => void;
  onOpenSummary: (s: NoteSummary) => void;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Parse ATX headings (`#`, `##`, `###`) outside fenced code blocks.
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      const text = m[2].replace(/[#*`]+$/g, "").trim();
      out.push({ id: slugify(text), level: m[1].length, text });
    }
  }
  return out;
}

// Page-link titles referenced in the body via `[[Title]]` (pipe-aware).
function parsePageLinks(md: string): string[] {
  const set = new Set<string>();
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) set.add(m[1].trim());
  return [...set];
}

// Task ids referenced via `aura://task/<id>` links.
function parseTaskRefs(md: string): string[] {
  const set = new Set<string>();
  const re = /aura:\/\/task\/([A-Za-z0-9._-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) set.add(m[1]);
  return [...set];
}

function wordCount(md: string): number {
  const text = md.replace(/[#>*_`~\-]/g, " ").trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return shortDate(t);
}

export function PageContextRail({
  repoRoot,
  note,
  body,
  mentionSources,
  onClose,
  onJumpToHeading,
  onOpenByTitle,
  onOpenSummary,
}: Props) {
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([]);

  const headings = useMemo(() => parseHeadings(body), [body]);
  const handles = useMemo(() => extractHandles(body), [body]);
  const linkedTitles = useMemo(() => parsePageLinks(body), [body]);
  const taskRefs = useMemo(() => parseTaskRefs(body), [body]);
  const words = useMemo(() => wordCount(body), [body]);

  // Merge body-parsed handles with the backend's persisted extraction.
  const allHandles = useMemo(() => {
    const set = new Set(handles);
    for (const h of note?.frontmatter.mentioned_handles ?? []) set.add(h);
    return [...set];
  }, [handles, note]);

  useEffect(() => {
    let cancelled = false;
    const title = note?.frontmatter.title?.trim();
    if (!title) {
      setBacklinks([]);
      return;
    }
    notesBacklinks(repoRoot, title)
      .then((rows) => {
        if (!cancelled) setBacklinks(rows.filter((r) => r.id !== note?.id));
      })
      .catch(() => {
        if (!cancelled) setBacklinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, note?.frontmatter.title, note?.id]);

  const taskItems = useMemo(() => {
    if (!mentionSources) return [];
    return taskRefs.map((id) => {
      const found = mentionSources.tasks.find((t) => t.id === id);
      return { id, label: found?.label ?? "Task", sublabel: found?.sublabel };
    });
  }, [taskRefs, mentionSources]);

  if (!note) {
    return (
      <aside className="w-[232px] flex-shrink-0 border-l border-line-soft bg-bg-content" />
    );
  }

  const fm = note.frontmatter;

  return (
    <aside className="w-[232px] flex-shrink-0 border-l border-line-soft bg-bg-content overflow-y-auto">
      <div className="p-2.5 flex flex-col gap-3">
        {onClose && (
          <div className="flex items-center justify-between -mb-1">
            <span className="section-label">
              Outline
            </span>
            <button
              type="button"
              aria-label="Hide outline"
              title="Hide outline"
              onClick={onClose}
              className="flex items-center justify-center w-5 h-5 rounded text-text-4 hover:bg-state-hover hover:text-text-1 transition-colors"
            >
              <X className="w-3 h-3" strokeWidth={1.5} />
            </button>
          </div>
        )}
        <Section icon={<Hash className="w-3 h-3" />} label="Outline">
          {headings.length === 0 ? (
            <Empty>No headings</Empty>
          ) : (
            <div className="flex flex-col">
              {headings.map((h, i) => (
                <button
                  key={`${h.id}-${i}`}
                  type="button"
                  onClick={() => onJumpToHeading(h.id)}
                  className="text-left truncate rounded px-1 py-[2px] text-xs leading-4 text-text-3 hover:bg-state-hover hover:text-text-1"
                  style={{ paddingLeft: (h.level - 1) * 10 }}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section icon={<FileText className="w-3 h-3" />} label="Linked from">
          {backlinks.length === 0 ? (
            <Empty>No pages link here</Empty>
          ) : (
            <div className="flex flex-col">
              {backlinks.map((b) => (
                <button
                  key={pageKey(b)}
                  type="button"
                  onClick={() => onOpenSummary(b)}
                  className="flex items-center gap-1.5 text-left truncate py-0.5 text-sm text-text-3 hover:text-text-1"
                >
                  <FileText
                    className="w-3 h-3 flex-shrink-0 text-text-5"
                    strokeWidth={1.5}
                  />
                  <span className="truncate">{b.title || "Untitled"}</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section icon={<AtSign className="w-3 h-3" />} label="Mentions">
          {allHandles.length === 0 &&
          linkedTitles.length === 0 &&
          taskItems.length === 0 ? (
            <Empty>No mentions</Empty>
          ) : (
            <div className="flex flex-col gap-0.5">
              {allHandles.map((h) => (
                <button
                  key={`p-${h}`}
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("aura:open-dm", { detail: { handle: h } }),
                    )
                  }
                  className="flex items-center gap-1.5 text-left py-0.5 text-sm text-text-3 hover:text-text-1"
                >
                  <Avatar name={h} size={16} />
                  <span className="truncate">@{h}</span>
                </button>
              ))}
              {taskItems.map((t) => (
                <button
                  key={`t-${t.id}`}
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("aura:open-task", {
                        detail: { id: t.id },
                      }),
                    )
                  }
                  className="flex items-center gap-1.5 text-left py-0.5 text-sm text-text-3 hover:text-text-1"
                >
                  <span className="aura-ident text-accent text-xs flex-shrink-0">
                    {t.label}
                  </span>
                  {t.sublabel && (
                    <span className="truncate text-text-4">{t.sublabel}</span>
                  )}
                </button>
              ))}
              {linkedTitles.map((title) => (
                <button
                  key={`g-${title}`}
                  type="button"
                  onClick={() => onOpenByTitle(title)}
                  className="flex items-center gap-1.5 text-left py-0.5 text-sm text-text-3 hover:text-text-1"
                >
                  <FileText
                    className="w-3 h-3 flex-shrink-0 text-text-5"
                    strokeWidth={1.5}
                  />
                  <span className="truncate">{title}</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section icon={<Clock className="w-3 h-3" />} label="Info">
          <dl className="flex flex-col gap-1 text-sm">
            <InfoRow label="Author" value={fm.author || "—"} />
            <InfoRow label="Created" value={fmtDate(fm.created_at)} />
            <InfoRow label="Updated" value={fmtDate(fm.updated_at)} />
            <InfoRow label="Words" value={String(words)} />
            <InfoRow
              label="Visibility"
              value={fm.visibility ? sentenceCase(fm.visibility) : "—"}
            />
            {fm.locked ? <InfoRow label="Status" value="Locked" /> : null}
          </dl>
        </Section>
      </div>
    </aside>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 mb-1 text-text-4">
        {icon}
        <span className="section-label">
          {label}
        </span>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-0.5 text-xs text-text-5">{children}</div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-text-4">{label}</dt>
      <dd className={cn("text-text-2 truncate text-right")}>{value}</dd>
    </div>
  );
}

