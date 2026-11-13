// ChangeNoteCard — the note over a committed file's diff. For THIS file in
// THIS commit it says what changed (the pieces), why (the commit's recorded
// reason) and how far it ripples (the reverse call graph). It opens folded — a
// single calm line — and unfolds to the full list, so it never crowds the diff
// it annotates.
//
// Every value comes from `aura change-note <sha> --json` (AST diff + call
// graph); no model is asked. The whole commit's notes are fetched once and
// cached per (repo, commit), so moving between files in one commit is instant.
// The wording is shared with the diff header (`changeNote/changeWords`), so
// the two read the same.

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import type { ChangedSymbol, FileChangeNote } from "../../lib/api";
import { fetchChangeNoteReport } from "../../lib/changeNoteCache";
import { relativeAgeAuto } from "../../lib/relativeTime";
import { Code } from "../ui/code";
import {
  baseName,
  blastSummary,
  changeMark,
  changeWord,
  commitBody,
  commitReason,
  prettyEntryKind,
  prettyKind,
  siblingFiles,
  titleize,
} from "./changeNote/changeWords";
import "../ui/change-note.css";

/** How many of each list the open note names before it says "and N more". */
const FEATURES_SHOWN = 6;
const CALLERS_SHOWN = 4;
const ALONGSIDE_SHOWN = 12;

/** One changed piece: its mark, its plain name (the identifier in the hover),
 *  its kind, and the recorded reason for it when there is one. */
function PieceRow({ s }: { s: ChangedSymbol }) {
  return (
    <li>
      <span className="ui-changes-status" data-status={s.change} title={changeWord(s.change)}>
        {changeMark(s.change)}
      </span>
      <span className="ui-change-note-name" title={s.identifier}>
        {titleize(s.identifier)}
      </span>
      <small>{prettyKind(s.kind)}</small>
      {s.rationale ? <span className="ui-change-note-rationale">· {s.rationale}</span> : null}
    </li>
  );
}

/** Where the change ripples: the features it powers, else the places that
 *  call it, else the plain fact that nothing does. */
function Ripple({ note }: { note: FileChangeNote }) {
  if (note.features.length) {
    const shown = note.features.slice(0, FEATURES_SHOWN);
    return (
      <p className="ui-change-note-ripple">
        <span className="ui-change-note-label">Affects </span>
        {shown.map((f, i) => (
          <span key={`${f.file}:${f.entrySymbol}`}>
            <strong title={`${prettyEntryKind(f.kind)} · ${f.entrySymbol} (${f.file})`}>
              {f.name}
            </strong>
            {i < shown.length - 1 ? ", " : null}
          </span>
        ))}
        {note.truncated ? <small> and more</small> : null}
      </p>
    );
  }
  if (note.direct_callers.length) {
    const names = note.direct_callers.slice(0, CALLERS_SHOWN).map((c) => c.symbol);
    const extra = note.dependent_count - names.length;
    return (
      <p className="ui-change-note-ripple">
        <span className="ui-change-note-label">Re-check </span>
        {names.map((n, i) => (
          <span key={n}>
            <Code size="sm">{n}</Code>
            {i < names.length - 1 ? ", " : null}
          </span>
        ))}
        {extra > 0 ? <small> and {extra} more</small> : null}
      </p>
    );
  }
  if (note.leaf) {
    return <p className="ui-change-note-ripple">Nothing else calls this. Safe in isolation.</p>;
  }
  return null;
}

type Story = {
  /** The commit message after its subject line — the fuller "why". */
  body: string | null;
  /** The other files that moved in the same commit. */
  alongside: string[];
  author: string;
  when: number;
};

export function ChangeNoteCard({
  repoRoot,
  commit,
  path,
}: {
  repoRoot: string;
  /** The commit that landed this file. Required — notes are per commit. */
  commit: string;
  path: string;
}) {
  const [note, setNote] = useState<FileChangeNote | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Folded by default: the diff is the point, the note a one-line caption the
  // reader opens for the full detail.
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
        setNote(report.files.find((f) => f.file === path) ?? null);
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

  // Quiet on the unhappy paths: a missing note or an engine hiccup must never
  // crowd the diff. The note only appears when it has something real.
  if (state !== "ready" || !note) return null;

  const blast = blastSummary(note);
  const pieceCount = note.symbols.length;
  const alongside = story?.alongside ?? [];

  return (
    <section className="ui-change-note" aria-label="What changed in this file">
      <button
        type="button"
        className="ui-change-note-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight aria-hidden />
        <span className="ui-change-note-label">Change</span>
        <span className="ui-change-note-line">
          {note.note}
          {reason ? <em> · {reason}</em> : null}
          {blast ? <small> · {blast}</small> : null}
        </span>
        {!open && pieceCount > 0 ? (
          <small>
            {pieceCount} update{pieceCount === 1 ? "" : "s"}
          </small>
        ) : null}
      </button>

      {open ? (
        <div className="ui-change-note-detail">
          {story?.body ? (
            <div>
              <h4>Why this changed</h4>
              <p className="ui-change-note-body">{story.body}</p>
            </div>
          ) : null}

          {pieceCount ? (
            <ul className="ui-change-note-pieces">
              {note.symbols.map((s) => (
                <PieceRow key={`${s.change}:${s.identifier}`} s={s} />
              ))}
            </ul>
          ) : null}

          <Ripple note={note} />

          {alongside.length ? (
            <div>
              <h4>
                Changed alongside <small>{alongside.length}</small>
              </h4>
              <p className="ui-change-note-files">
                {alongside.slice(0, ALONGSIDE_SHOWN).map((f) => (
                  <Code key={f} size="sm" title={f}>
                    {baseName(f)}
                  </Code>
                ))}
                {alongside.length > ALONGSIDE_SHOWN ? (
                  <small>+{alongside.length - ALONGSIDE_SHOWN} more</small>
                ) : null}
              </p>
            </div>
          ) : null}

          {story?.author ? (
            <p className="ui-change-note-facts">
              <span>
                Recorded by <strong>{story.author}</strong>
              </span>
              {story.when ? <span>{relativeAgeAuto(story.when)}</span> : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
