// TimelineMomentDetail — the story of the moment the playhead is parked on.
//
// As you scrub the bottom timeline, this answers "what happened here, and why?"
// in plain language. It reads as a STORY, not a commit dump:
//
//   • a type pill + headline (the first sentence of the intent — never the whole
//     wall of text),
//   • who/when,
//   • "The reasoning" — the rest of the intent, broken into sentence-beats,
//     ALWAYS expanded by default (the *why* is the point of a timeline; the
//     reader should never have to ask for it),
//   • "What changed" — the real files it touched, the supporting evidence,
//     COLLAPSED by default behind a disclosure (the count stays visible so the
//     scale reads at a glance; the file list opens on demand — story first,
//     diff second),
//   • a quiet "the project so far" strip showing how far the build had come.

import { useEffect, useState } from "react";
import { AgentBadge } from "../../agent/AgentBadge";
import { intentTypeChip } from "../../../lib/intentTypeLabels";
import {
  cumulativeAt,
  momentStamp,
  relTimeOf,
  sentenceBeats,
  splitIntentStory,
  type TimelineModel,
} from "../../../lib/timelineModel";

// Plain-language names for the canonical intent types come from the one shared
// map (`lib/intentTypeLabels`), so a "BugFix" reads the same everywhere.

// A calm accent tint per type, so the eye reads "fix vs feature" before words.
const TYPE_TONE: Record<string, string> = {
  FeatureAdd: "border-[color-mix(in_oklab,var(--color-accent)_40%,transparent)] text-[var(--color-accent)]",
  BugFix: "border-amber-500/40 text-amber-300",
  Refactor: "border-line-soft text-text-2",
  Revert: "border-red-500/40 text-red-300",
  Performance: "border-[color-mix(in_oklab,var(--color-accent)_40%,transparent)] text-[var(--color-accent)]",
  Docs: "border-line-soft text-text-2",
  Deps: "border-line-soft text-text-2",
};

// Plain words for a git status letter or word.
function statusWord(s: string): string {
  const t = (s || "").toLowerCase();
  if (t.startsWith("a")) return "added";
  if (t.startsWith("d")) return "removed";
  if (t.startsWith("r")) return "renamed";
  if (t.startsWith("c")) return "copied";
  return "changed";
}

function statusTone(s: string): string {
  const w = statusWord(s);
  if (w === "added") return "text-[var(--color-accent)]";
  if (w === "removed") return "text-red-400";
  return "text-text-3";
}

/** Just the file name (last path segment) for the headline; the dir is dimmed. */
function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: "", name: path };
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function TimelineMomentDetail({
  model,
  index,
  nowSecs,
  onOpenSession,
}: {
  model: TimelineModel;
  index: number;
  /** Current wall-clock in unix seconds, for the "2h ago" relative stamp. The
   *  caller owns the clock read so this component stays pure/testable. */
  nowSecs: number;
  /** Jump to this moment's full Trace Session detail (transcript, changes,
   *  attestation). Omitted → the affordance is hidden. */
  onOpenSession?: () => void;
}) {
  const moment = model.moments[index];

  // The story split: first sentence = headline, remainder = sentence-beats.
  const { headline, rest } = splitIntentStory(moment?.intent ?? "");
  const beats = sentenceBeats(rest);

  // The *why* is the point of a timeline, so the reasoning is ALWAYS expanded by
  // default — the reader should never have to ask for it. "What changed" (the
  // file list) is the supporting evidence, so it starts COLLAPSED behind its own
  // disclosure: the story first, the diff on demand. Both reset to that default
  // whenever the playhead moves to a new beat.
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => {
    setReasoningOpen(true);
    setFilesOpen(false);
  }, [index]);

  if (!moment) return null;

  const chapter = model.sessions[moment.sessionIndex];
  const chapterNo = moment.sessionIndex + 1;
  const beat = chapter.momentIndices.indexOf(index) + 1; // 1-based in the chapter
  const typeLabel = moment.intentType ? intentTypeChip(moment.intentType) : null;
  const typeTone = moment.intentType ? TYPE_TONE[moment.intentType] ?? "border-line-soft text-text-2" : "";
  const cum = cumulativeAt(model, index);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto px-7 pb-56 pt-7">
      {/* Chapter ribbon — which session/run this beat belongs to, with a jump
          to that run's full Session detail (transcript + changes + safety). */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-4">
        <span className="font-medium tabular-nums text-text-3">
          Chapter {chapterNo} of {model.sessions.length}
        </span>
        <span className="text-text-4">·</span>
        <span className="min-w-0 max-w-[18rem] truncate">{chapter.title}</span>
        <span className="text-text-4">·</span>
        <span className="tabular-nums">
          step {beat} of {chapter.momentIndices.length}
        </span>
        {onOpenSession && (
          <button
            type="button"
            onClick={onOpenSession}
            title="Open this run's full session detail"
            className="ml-auto flex items-center gap-1 rounded-md border border-line-soft px-2 py-1 text-xs text-text-2 transition-colors hover:border-[color-mix(in_oklab,var(--color-accent)_45%,transparent)] hover:text-text-1"
          >
            <span>View session</span>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
        )}
      </div>

      {/* Type pill ABOVE the headline — the kind of change reads first as a calm
          label, then the headline lands on its own line at full width. */}
      <div className="mt-3.5">
        {typeLabel && (
          <span
            className={`mb-2 inline-block rounded-full border px-2 py-0.5 text-2xs font-medium ${typeTone}`}
          >
            {typeLabel}
          </span>
        )}
        <h2 className="text-xl font-semibold leading-snug tracking-[-0.01em] text-text-1">
          {headline || "A change with no logged reason"}
        </h2>
      </div>

      {/* Who + when. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-text-3">
        <AgentBadge agentId={moment.agentId} />
        <span className="text-text-4">·</span>
        <span className="text-text-2">{momentStamp(moment.ts)}</span>
        <span className="text-text-4">·</span>
        <span className="tabular-nums">{relTimeOf(Math.max(0, nowSecs - moment.ts))}</span>
      </div>

      {/* The reasoning — the rest of the intent, as calm sentence-beats behind a
          disclosure. Collapsed by default when long so it never walls. */}
      {beats.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setReasoningOpen((o) => !o)}
            className="section-label flex items-center gap-1.5 transition-colors hover:text-text-2"
          >
            <Chevron open={reasoningOpen} />
            <span>The reasoning</span>
            {!reasoningOpen && (
              <span className="tabular-nums text-text-4/80">· {beats.length} note{beats.length === 1 ? "" : "s"}</span>
            )}
          </button>
          {reasoningOpen && (
            <ul className="mt-2 space-y-1.5 border-l border-line-soft pl-3.5">
              {beats.map((b, i) => (
                <li
                  key={i}
                  className="relative text-base leading-relaxed text-text-2"
                >
                  <span
                    className="absolute -left-[18px] top-[9px] h-1 w-1 rounded-full"
                    style={{ background: "color-mix(in oklab, var(--color-accent) 55%, var(--color-line))" }}
                  />
                  {b}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* What changed — the supporting evidence, COLLAPSED by default behind its
          own disclosure so the story (headline + reasoning) reads first. The
          count summary stays visible on the closed header so the reader still
          sees the scale at a glance; the file list opens on demand. */}
      <div className="mt-5">
        <button
          type="button"
          onClick={() => setFilesOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 text-left transition-colors"
        >
          <span className="section-label flex items-center gap-1.5 transition-colors group-hover:text-text-2">
            <Chevron open={filesOpen} />
            <span>What changed</span>
          </span>
          {moment.files.length > 0 ? (
            <span className="text-xs tabular-nums text-text-4">
              {moment.fileCount} file{moment.fileCount === 1 ? "" : "s"}
              {/* Line counts only when they were actually recorded. Most intent
                  rows carry none, and "+0 −0" beside a real file count doesn't
                  read as missing data — it reads as a change that touched
                  files without touching a line. */}
              {moment.adds > 0 || moment.dels > 0 ? (
                <>
                  {" · "}
                  <span className="text-[var(--color-accent)]">+{moment.adds}</span>{" "}
                  <span className="text-red-400">−{moment.dels}</span>
                </>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-text-4">a note, not an edit</span>
          )}
        </button>
        {filesOpen &&
          (moment.files.length === 0 ? (
            <div className="mt-2 rounded-md border border-dashed border-line px-4 py-7 text-center text-sm text-text-4">
              No file changes were recorded for this moment. It was a note, not
              an edit.
            </div>
          ) : (
            <ul className="mt-2 overflow-hidden rounded-md border border-line">
              {moment.files.map((f, i) => {
                const { dir, name } = splitPath(f.path);
                return (
                  <li
                    key={`${f.path}-${i}`}
                    className="flex items-center gap-2.5 border-b border-line-soft bg-bg-1 px-3 py-2 text-sm last:border-b-0"
                  >
                    <span
                      className={`w-14 shrink-0 text-2xs ${statusTone(f.status)}`}
                    >
                      {statusWord(f.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-text-4">{dir}</span>
                      <span className="text-text-1">{name}</span>
                    </span>
                    {(f.additions > 0 || f.deletions > 0) && (
                      <span className="shrink-0 tabular-nums text-xs">
                        <span className="text-[var(--color-accent)]">+{f.additions}</span>{" "}
                        <span className="text-red-400">−{f.deletions}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
      </div>

      {/* The project so far — how far the build had come by this beat.
          The Lines card only earns a column when line counts were recorded:
          this history's intent rows mostly carry none, so it rendered a green
          "+0" and a red "−0" beside "6 files touched" — a stat card asserting
          a figure it can't back, and asserting the wrong one. Three columns
          when it's absent, four when it's real. */}
      {cum.adds > 0 || cum.dels > 0 ? (
        <div className="mt-6 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-line bg-line">
          <Stat label="Moments" value={cum.moments} />
          <Stat label="Sessions" value={cum.sessions} />
          <Stat label="Files touched" value={cum.files} />
          <Stat
            label="Lines"
            value={
              <span className="tabular-nums">
                <span className="text-[var(--color-accent)]">+{cum.adds}</span>{" "}
                <span className="text-red-400">−{cum.dels}</span>
              </span>
            }
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
          <Stat label="Moments" value={cum.moments} />
          <Stat label="Sessions" value={cum.sessions} />
          <Stat label="Files touched" value={cum.files} />
        </div>
      )}
      <div className="mt-1.5 text-center text-2xs text-text-4">
        the project, by this point in its life
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-bg-1 px-3 py-2.5 text-center">
      <div className="text-lg font-semibold tabular-nums text-text-1">
        {value}
      </div>
      <div className="section-label mt-0.5">
        {label}
      </div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
