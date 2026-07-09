// ChangeNoteCard — the per-file "intent" that sits with a committed file's
// diff. It answers, for THIS file in THIS commit, in one compact narrative:
// what changed (the symbol delta), why (the commit's recorded reason), and
// where it ripples (the reverse call-graph blast radius). It opens collapsed —
// a single calm sentence — and expands on demand to the full symbol list +
// blast radius, so it never crowds the diff it annotates.
//
// Every value comes from `aura change-note <sha> --json` (AST diff + call
// graph). No AI tokens. The whole commit's notes are fetched once and cached
// per (repo, commit), so flicking between files in the same commit is instant.

import { useEffect, useState } from "react";
import { fetchChangeNoteReport } from "../../lib/changeNoteCache";
import type {
  FileChangeNote,
  ChangedSymbol,
} from "../../lib/api";

const VERB: Record<string, { glyph: string; tone: string; word: string }> = {
  added: { glyph: "+", tone: "text-accent-green", word: "added" },
  modified: { glyph: "~", tone: "text-accent", word: "modified" },
  deleted: { glyph: "−", tone: "text-red", word: "deleted" },
};

function SymbolRow({ s }: { s: ChangedSymbol }) {
  const v = VERB[s.change] ?? VERB.modified;
  return (
    <li className="flex items-baseline gap-1.5 leading-relaxed">
      <span
        className={"w-2 shrink-0 text-center font-mono text-[11px] " + v.tone}
        title={v.word}
      >
        {v.glyph}
      </span>
      <span className="font-mono text-[12px] text-text-1">{s.identifier}</span>
      <span className="shrink-0 text-[10.5px] text-text-4">
        {prettyKind(s.kind)}
      </span>
      {s.rationale ? (
        <span className="min-w-0 text-[11.5px] text-text-3">
          — {s.rationale}
        </span>
      ) : null}
    </li>
  );
}

/** tree-sitter kind → a short human word. Unknown kinds pass through. */
function prettyKind(kind: string): string {
  switch (kind) {
    case "function_item":
    case "function_declaration":
    case "function_definition":
    case "arrow_function":
    case "method_definition":
    case "method_declaration":
      return "fn";
    case "struct_item":
      return "struct";
    case "impl_item":
      return "impl";
    case "class_declaration":
    case "class_definition":
      return "class";
    case "enum_item":
      return "enum";
    case "trait_item":
      return "trait";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
    case "type_item":
      return "type";
    default:
      return kind;
  }
}

/** Where it affects — the deterministic blast radius, phrased for a reader. */
function AffectsRow({ note }: { note: FileChangeNote }) {
  if (note.features.length) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-text-3">Affects</span>
        {note.features.slice(0, 6).map((f) => (
          <span
            key={`${f.file}:${f.entrySymbol}`}
            title={`${prettyEntryKind(f.kind)} · ${f.entrySymbol} (${f.file})`}
            className="rounded border border-accent/30 bg-accent/10 px-1.5 py-px text-[11px] text-accent"
          >
            {f.name}
          </span>
        ))}
        {note.truncated ? (
          <span className="text-[10.5px] text-text-4">(+ more)</span>
        ) : null}
      </div>
    );
  }
  if (note.direct_callers.length) {
    const names = note.direct_callers.slice(0, 4).map((c) => c.symbol);
    const extra = note.dependent_count - names.length;
    return (
      <div className="text-[11.5px] text-text-3">
        <span className="text-text-2">Re-check </span>
        {names.map((n, i) => (
          <span key={n}>
            <span className="font-mono text-[11px] text-text-1">{n}</span>
            {i < names.length - 1 ? <span>, </span> : null}
          </span>
        ))}
        {extra > 0 ? (
          <span className="text-text-4"> and {extra} more</span>
        ) : null}
      </div>
    );
  }
  if (note.leaf) {
    return (
      <div className="text-[11.5px] text-text-3">
        Nothing else calls this — safe in isolation.
      </div>
    );
  }
  return null;
}

function prettyEntryKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** A short, reader-facing summary of the blast radius for the collapsed line —
 *  the "how far it ripples" clause, kept to a single phrase. */
function blastSummary(note: FileChangeNote): string | null {
  if (note.features.length) {
    const n = note.features.length;
    return `powers ${n} feature${n === 1 ? "" : "s"}${note.truncated ? "+" : ""}`;
  }
  if (note.dependent_count > 0) {
    const n = note.dependent_count;
    return `${n} other place${n === 1 ? "" : "s"} to re-check`;
  }
  if (note.leaf) return "safe in isolation";
  return null;
}

/** First non-empty line of the commit message — the human "why". Conventional
 *  prefixes (`feat(x):`) are kept; they read fine as a reason clause. */
function commitReason(message: string): string | null {
  const first = (message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? null;
}

/** Everything in the commit message AFTER the subject line — the elaboration:
 *  the root-cause, the thinking, the trade-offs. The collapsed line already
 *  carries the subject, so this is the part a reader opens for the full "why",
 *  never a repeat of it. Null when the commit recorded only a one-liner. */
function commitBody(message: string): string | null {
  const lines = (message ?? "").split("\n");
  const subjectIdx = lines.findIndex((l) => l.trim().length > 0);
  if (subjectIdx < 0) return null;
  const rest = lines.slice(subjectIdx + 1).join("\n").trim();
  return rest.length ? rest : null;
}

/** The other files that moved in the SAME change — the "surrounding changes".
 *  Drawn straight from the change-note we already fetched (every file in the
 *  commit, symbol-tracked or not), minus the one we're annotating. */
function siblingFiles(
  files: { file: string }[],
  otherFiles: string[],
  self: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...files.map((x) => x.file), ...otherFiles]) {
    if (f === self || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/** Just the file name for a chip; the directory is the tooltip. */
function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** A short relative stamp for "when this was recorded". `commit_time` is unix
 *  seconds; tolerate millis too. */
function relWhen(value: number): string {
  if (!value) return "";
  const ms = value < 1e12 ? value * 1000 : value;
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      className={
        "shrink-0 text-text-4 transition-transform " + (open ? "rotate-90" : "")
      }
      aria-hidden
    >
      <path
        d="M3 2l4 3-4 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChangeNoteCard({
  repoRoot,
  commit,
  path,
}: {
  repoRoot: string;
  /** The commit that landed this file. Required — notes are per-commit. */
  commit: string;
  path: string;
}) {
  const [note, setNote] = useState<FileChangeNote | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // The fuller "why" + surrounding-changes context, all from the same fetched
  // change-note (no extra round-trip): the commit-message body, the other files
  // that moved with this one, and who/when recorded it.
  const [story, setStory] = useState<{
    body: string | null;
    alongside: string[];
    author: string;
    when: number;
  } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Collapsed by default: the diff is the star, the note is a one-line caption
  // the reader opens only when they want the full symbol + blast-radius detail.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setNote(null);
    setReason(null);
    setStory(null);
    setOpen(false);
    fetchChangeNoteReport(repoRoot, commit)
      .then((report) => {
        if (!alive) return;
        const match = report.files.find((f) => f.file === path) ?? null;
        setNote(match);
        setReason(commitReason(report.commit_message));
        setStory({
          body: commitBody(report.commit_message),
          alongside: siblingFiles(report.files, report.other_files, path),
          author: report.author,
          when: report.commit_time,
        });
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, commit, path]);

  // Stay quiet on the unhappy paths: a missing note or an engine hiccup must
  // never crowd the diff. The card only appears when it has something real.
  if (state !== "ready" || !note) return null;

  const blast = blastSummary(note);
  const symbolCount = note.symbols.length;

  return (
    <div className="shrink-0 border-b border-line-soft bg-bg-1/60">
      {/* Collapsed header: one compact narrative line — what · why · how far.
          The whole row is the toggle, so a click anywhere expands the detail. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-bg-2/40"
      >
        <Chevron open={open} />
        <span className="shrink-0 rounded bg-bg-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-text-4">
          Change
        </span>
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-text-1">
          {note.note}
          {reason ? (
            <span className="text-text-3">
              {" "}
              — <span className="italic">{reason}</span>
            </span>
          ) : null}
          {blast ? (
            <span className="text-text-4"> · {blast}</span>
          ) : null}
        </span>
        {!open && symbolCount > 0 ? (
          <span className="shrink-0 text-[10.5px] text-text-4">
            {symbolCount} update{symbolCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </button>

      {/* Expanded detail: the full story for this file in this change —
          why (the reasoning), what (the symbol delta), where it ripples (blast
          radius), and what moved alongside it (the surrounding changes). */}
      {open ? (
        <div className="space-y-2.5 px-3 pb-2.5 pl-[2.1rem]">
          {/* Why — the fuller reasoning, when the commit recorded more than a
              one-liner. The root-cause / thought-process the user can recover. */}
          {story?.body ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-4">
                Why this changed
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-text-2">
                {story.body}
              </p>
            </div>
          ) : null}

          {/* What — the symbol-level delta. */}
          {symbolCount ? (
            <ul className="space-y-0.5">
              {note.symbols.map((s) => (
                <SymbolRow key={`${s.change}:${s.identifier}`} s={s} />
              ))}
            </ul>
          ) : null}

          {/* Where it ripples. */}
          <AffectsRow note={note} />

          {/* Surrounding changes — the other files that moved in the same edit,
              so a reader sees this file in the context of the whole change. */}
          {story?.alongside.length ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-4">
                Changed alongside
                <span className="ml-1 text-text-4">{story.alongside.length}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {story.alongside.slice(0, 12).map((f) => (
                  <span
                    key={f}
                    title={f}
                    className="rounded border border-line-soft bg-bg-2 px-1.5 py-px font-mono text-[10.5px] text-text-3"
                  >
                    {baseName(f)}
                  </span>
                ))}
                {story.alongside.length > 12 ? (
                  <span className="text-[10.5px] text-text-4">
                    +{story.alongside.length - 12} more
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Who / when — the accountability footer for this file's change. */}
          {story?.author ? (
            <div className="pt-0.5 text-[10.5px] text-text-4">
              Recorded by{" "}
              <span className="text-text-3">{story.author}</span>
              {story.when ? ` · ${relWhen(story.when)}` : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
