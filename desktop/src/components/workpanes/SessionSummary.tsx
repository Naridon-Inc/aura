// SessionSummary — the Summary tab body of a session detail. It reads
// top-to-bottom like a short report rather than a data dump:
//
//   1. What happened — the intent / prompt body in plain language, with code
//      entities highlighted and any changed-file name clickable (jumps to
//      Changes). The one-line headline already lives in the header, so this is
//      the elaboration, not a repeat.
//   2. Files changed — the files this run touched, each a shortcut into the
//      Changes tab with its own +/− churn.
//   3. Details — the facts a reader only wants on demand (exact time, signature
//      provenance). Agent / type / file-count already sit as header chips, so we
//      don't restate them here.
//
// Built for an audience that increasingly includes non-developers: clear
// hierarchy, generous spacing, no jargon walls.

import type { ReactNode } from "react";
import type { IntentRow, IntentChangesetFile } from "../../lib/api";
import { IntentProse } from "./IntentProse";
import { SessionGoals } from "../goals/SessionGoals";
import { LockGlyph, UnlockGlyph, TrustBadge, shortBlockId } from "./SessionAttestation";
import { Button } from "../ui/button";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
      {children}
    </h2>
  );
}

/** One compact label/value row in the Details card — horizontal, divider
 *  separated, so the facts read as a tidy spec block. */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
      <span className="w-[84px] shrink-0 pt-px text-[11px] uppercase tracking-wide text-text-3">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-text-1">
        {children}
      </span>
    </div>
  );
}

function FileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-text-4"
    >
      <path
        d="M4 1.6h5L13 5.6v8.8H4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 1.6V5.6h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-text-4 opacity-0 transition-opacity group-hover:opacity-100"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A changed-file row — the whole row is a shortcut into the Changes tab at
 *  this file. Directory dimmed, name emphasised, churn on the right. */
function FileRow({
  file,
  onOpen,
}: {
  file: IntentChangesetFile;
  onOpen: (path: string) => void;
}) {
  const p = file.path;
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const adds = file.additions ?? 0;
  const dels = file.deletions ?? 0;
  return (
    <button
      type="button"
      onClick={() => onOpen(p)}
      title={`Open ${p} in Changes`}
      className="group flex w-full items-center gap-2.5 border-b border-line-soft px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-bg-2/60"
    >
      <FileIcon />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
        {dir ? <span className="text-text-4">{dir}</span> : null}
        <span className="text-text-1">{name}</span>
      </span>
      {adds || dels ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {adds ? <span className="text-accent-green">+{adds}</span> : null}
          {adds && dels ? <span className="text-text-4"> </span> : null}
          {dels ? <span className="text-text-3">−{dels}</span> : null}
        </span>
      ) : null}
      <ChevronRight />
    </button>
  );
}

/** The trust floor for the whole report, woven in at the top rather than
 *  hidden behind a separate tab. When a run is sealed, Aura recorded exactly
 *  what the AI changed and why and locked that record — so the story below
 *  can't have been quietly edited afterward. Deliberately plain: no
 *  "signature", "ed25519", or "block" here; the full proof lives one tab over. */
function GenuineRecordSeal({ row }: { row: IntentRow }) {
  const signed = !!row.signed_block_id;
  if (!signed) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-line-soft bg-bg-1 px-3.5 py-2.5">
        <span className="mt-px shrink-0 text-text-4">
          <UnlockGlyph />
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium text-text-2">Not sealed</span>
          <p className="mt-0.5 text-[12px] leading-relaxed text-text-3">
            This change wasn't locked with a tamper-proof seal, so Aura can't
            promise the record below is exactly as it happened.
          </p>
        </div>
      </div>
    );
  }
  const green = "var(--color-accent-green)";
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg px-3.5 py-2.5"
      style={{
        border: `1px solid color-mix(in oklab, ${green} 30%, transparent)`,
        background: `color-mix(in oklab, ${green} 6%, transparent)`,
      }}
    >
      <span className="mt-px shrink-0" style={{ color: green }}>
        <LockGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-text-1">Genuine record</span>
          <TrustBadge ok label="Sealed" tone="green" />
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-text-3">
          Aura locked exactly what the AI changed and why. Nothing in this
          record has been altered since.
        </p>
      </div>
    </div>
  );
}

export function SessionSummary({
  row,
  repoRoot,
  files,
  symbols,
  bodyText,
  bodyLabel,
  whenAbsolute,
  rel,
  onOpenFile,
}: {
  row: IntentRow;
  /** Repo root — threaded so the Goals section can prove against this repo. */
  repoRoot: string;
  files: IntentChangesetFile[];
  /** Changed-symbol names (from this run's change-note) to chip in the prose. */
  symbols: string[];
  /** The intent/prompt body (elaboration after the header headline). */
  bodyText: string;
  /** "Prompt" when correlated to a real session, else "Reason". */
  bodyLabel: string;
  whenAbsolute: string;
  rel: string;
  /** Jump to Changes; with a path, open that file directly. */
  onOpenFile: (path?: string) => void;
}) {
  const signed = !!row.signed_block_id;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 py-4">
        {/* 0 · Trust floor — is this record genuine? Woven in at the top so it
            frames the whole story, not buried in a separate verification tab. */}
        <GenuineRecordSeal row={row} />

        {/* 1 · What happened — plain-language body with live entities. */}
        {bodyText ? (
          <section>
            <div className="mb-2.5">
              <SectionLabel>{bodyLabel}</SectionLabel>
            </div>
            <IntentProse
              source={bodyText}
              files={files}
              symbols={symbols}
              onOpenFile={onOpenFile}
            />
          </section>
        ) : null}

        {/* 2 · Files changed — each a shortcut into Changes. */}
        {files.length ? (
          <section>
            <div className="mb-2.5 flex items-baseline justify-between gap-3">
              <SectionLabel>
                Files changed
                <span className="ml-1.5 font-normal text-text-4">{files.length}</span>
              </SectionLabel>
              <Button
                variant="link"
                size="xs"
                type="button"
                onClick={() => onOpenFile()}
                className="px-0 text-[11px] text-accent"
              >
                Open in Changes →
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
              {files.map((f) => (
                <FileRow key={f.path} file={f} onOpen={onOpenFile} />
              ))}
            </div>
          </section>
        ) : null}

        {/* 3 · Goals — what this run was meant to achieve, proven against the
            code. Bound to the run's key, so the same verdict shows on any task
            this goal is linked to. */}
        <SessionGoals repoRoot={repoRoot} row={row} hasChanges={files.length > 0} />

        {/* 4 · Details — facts on demand. */}
        <section>
          <div className="mb-2.5">
            <SectionLabel>Details</SectionLabel>
          </div>
          <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
            <MetaRow label="When">
              {whenAbsolute} <span className="text-text-3">({rel})</span>
            </MetaRow>
            <MetaRow label="Record">
              {signed ? (
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span className="text-text-2">
                    Sealed — the full proof is on the Genuine record tab.
                  </span>
                  <span className="font-mono text-[11px] text-text-4">
                    {shortBlockId(row.signed_block_id ?? "")}
                  </span>
                </span>
              ) : (
                <span className="text-text-3">Not sealed.</span>
              )}
            </MetaRow>
          </div>
        </section>
      </div>
    </div>
  );
}
