import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { AgentIcon } from "../../agent/AgentIcon";

// ── Settled Scout block ─────────────────────────────────────────────
//
// After Aura Scout finalizes, `pending_scout` clears and the live
// ScoutCard (proper Architecture / Security / UX rows) is gone. All the
// backend leaves behind are raw `Scout: spawning…` + `[security]/[arch]/
// [ux] …` system turns. These parsers + block re-present that residue as
// named agents with a status so the finalized review reads cleanly
// instead of as bracketed lowercase text.

type SettledSpecialistKind = "architecture" | "security" | "ux";

export interface SettledSpecialist {
  kind: SettledSpecialistKind;
  label: string;
  body: string;
  status: "done" | "failed";
}

const SCOUT_KIND_LABEL: Record<SettledSpecialistKind, string> = {
  architecture: "Architecture",
  security: "Security",
  ux: "UX",
};

export function isScoutSpawnLine(text: string): boolean {
  return /^\s*Scout:\s*spawning\b/i.test(text);
}

// Parse a persisted `[kind] body` specialist line. Accepts the backend's
// channel aliases (`arch`/`sec`) as well as full names. Returns null for
// anything that isn't a specialist line so the grouping pass leaves
// unrelated system turns untouched.
export function parseScoutSpecialistLine(text: string): SettledSpecialist | null {
  const m = /^\s*\[(architecture|arch|security|sec|ux)\]\s*(.*)$/i.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const kind: SettledSpecialistKind = raw.startsWith("arch")
    ? "architecture"
    : raw.startsWith("sec")
      ? "security"
      : "ux";
  const body = (m[2] ?? "").trim();
  // Treat any not-completed signal — timed out, errored, or a calm
  // "skipped" the backend now emits — as the non-done (Skipped) state.
  const status: SettledSpecialist["status"] =
    /time(?:d)?\s*out|timeout|failed|error|skip/i.test(body)
      ? "failed"
      : "done";
  return { kind, label: SCOUT_KIND_LABEL[kind], body, status };
}

// Settled plan-review pass — renders as the SAME compact tool-call row as
// the live ScoutCard (collapsed by default, expandable), not a bordered
// card. The collapsed row carries a plain-language summary; expanding it
// shows each reviewer's note. Skipped reviewers (claude missing / timed
// out) degrade quietly — no alarming "N timed out" shout.
export function SettledScoutBlock({
  specialists,
}: {
  specialists: SettledSpecialist[];
}) {
  const [open, setOpen] = useState(false);
  const total = specialists.length;
  const reviewed = specialists.filter((s) => s.status === "done").length;
  // Plain-language trailing status. All-good → "N reviewers"; partial →
  // "N of M reviewers"; none → a calm "review skipped" (build proceeded).
  const reviewerStatus =
    reviewed === 0
      ? "review skipped"
      : reviewed === total
        ? `${total} reviewer${total === 1 ? "" : "s"}`
        : `${reviewed} of ${total} reviewers`;

  return (
    <div className="mt-1 mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="aura-tool-row"
        title={open ? "Collapse" : "Expand plan review"}
      >
        <span className="aura-tool-glyph">
          <ChevronRight
            size={13}
            style={{ transform: open ? "rotate(90deg)" : undefined }}
          />
        </span>
        <span className="aura-tool-chip-verb">Reviewed the plan</span>
        <span
          className="aura-tool-chip-subject"
          style={{ color: "var(--color-text-3)" }}
        >
          {reviewerStatus}
        </span>
        <span
          className="ml-auto shrink-0"
          style={{ color: "var(--color-text-4)" }}
        >
          <ScoutChevron dir={open ? "up" : "down"} />
        </span>
      </button>
      {open && (
        <div className="aura-tool-substream">
          {specialists.map((s, i) => (
            <div
              key={`${s.kind}-${i}`}
              className="flex items-start gap-2.5 py-1"
            >
              <span className="shrink-0 mt-[1px]">
                <AgentIcon agentId="claude" size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="t-sm font-medium"
                    style={{ color: "var(--color-text-1)" }}
                  >
                    {s.label}
                  </span>
                  <SpecialistStatusChip status={s.status} />
                </div>
                {s.status === "done" && s.body && (
                  <div
                    className="t-xs mt-0.5"
                    style={{ color: "var(--color-text-2)" }}
                  >
                    {s.body}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline chevron for the settled scout row — matches the live ScoutCard's.
function ScoutChevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function SpecialistStatusChip({
  status,
}: {
  status: SettledSpecialist["status"];
}) {
  const failed = status === "failed";
  // Status colours only (green = ok, warning-amber = skipped). A skipped
  // reviewer reads as a calm "Skipped", never an alarming failure.
  const tone = failed ? "var(--color-accent)" : "var(--color-accent-green)";
  return (
    <span
      className="t-2xs t-ui px-1.5 py-0.5 shrink-0"
      style={{
        color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 40%, transparent)`,
        borderRadius: "var(--radius-xs)",
      }}
    >
      {failed ? "Skipped" : "Reviewed"}
    </span>
  );
}
