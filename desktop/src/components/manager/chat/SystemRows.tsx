import { AlertTriangle, Check, ListTree } from "lucide-react";
import type { RibbonEntry } from "../../../lib/api";
import { MarkdownBody } from "./Markdown";

// ── Persisted bubbles + system lines ────────────────────────────────────

export function SystemLine({
  text,
  tone,
}: {
  text: string;
  tone: "info" | "warn" | "ok";
}) {
  const cls =
    tone === "warn"
      ? "system-line warn"
      : tone === "ok"
        ? "system-line ok"
        : "system-line";
  return (
    <div className={cls}>
      <span style={{ opacity: 0.7 }}>· </span>
      {text}
    </div>
  );
}

// A slash-command result (`/help`, `/loop`, `/agents`, …) — a full markdown
// document, rendered through the chat's own MarkdownBody so lists, bold, code
// and clickable file/symbol chips all land. It reads like any normal message:
// NO box, NO border, NO "Aura" masthead — the slash the user typed already
// echoes as their own bubble just above, so the result needs no header. A
// `warn`/`ok` result keeps a single quiet leading glyph in the tone colour as
// a subtle signal; the default `info` tone gets no chrome at all.
export function SystemCard({
  text,
  tone,
}: {
  text: string;
  tone: "info" | "warn" | "ok";
}) {
  if (tone === "info") {
    return (
      <div className="my-1.5">
        <MarkdownBody source={text} />
      </div>
    );
  }
  const accent =
    tone === "warn" ? "var(--color-accent)" : "var(--color-accent-green)";
  const Glyph = tone === "warn" ? AlertTriangle : Check;
  return (
    <div className="my-1.5 flex items-start gap-1.5">
      <Glyph
        size={13}
        className="mt-[3px] shrink-0"
        style={{ color: accent }}
      />
      <div className="min-w-0 flex-1">
        <MarkdownBody source={text} />
      </div>
    </div>
  );
}

// A designed mode-switch notice (Auto → Plan). It replaces a flat italic
// markdown run that read as one unbroken wall of prose — here it's a compact
// card: an accent glyph, a "Plan mode" headline, a body line that wraps with
// real leading, and a muted footnote. Calm, not bulky. The accent is the
// chat-scoped `--color-accent` (the same green as the Plan mode chip), so the
// notice visually ties to the chip the user flips back from.
export function PlanModeNotice() {
  return (
    <div
      className="my-2 flex items-start gap-2.5 rounded-md border px-3 py-2.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-accent) 26%, transparent)",
        borderLeftColor: "var(--color-accent)",
        borderLeftWidth: "2px",
        background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
      }}
    >
      <span
        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        <ListTree size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="text-base font-semibold leading-5"
          style={{ color: "var(--color-text-1)" }}
        >
          Plan mode
        </div>
        <p
          className="mt-0.5 text-base leading-relaxed"
          style={{ color: "var(--color-text-2)" }}
        >
          You asked for a plan, so I&rsquo;ll lay one out first instead of
          building straight away. Review it, then hit{" "}
          <strong style={{ color: "var(--color-text-1)", fontWeight: 600 }}>
            Build
          </strong>{" "}
          to run it.
        </p>
        <p
          className="mt-1 text-sm leading-snug"
          style={{ color: "var(--color-text-3)" }}
        >
          Switch back to Auto from the mode chip anytime.
        </p>
      </div>
    </div>
  );
}

export function ribbonAsSystem(
  entry: RibbonEntry,
): { text: string; tone: "info" | "warn" | "ok" } | null {
  const ev = entry.event;
  switch (ev.kind) {
    case "task_dispatched":
      return {
        text: `Sent task #${ev.task_id} to ${ev.agent_id}`,
        tone: "info",
      };
    case "task_completed":
      return ev.exit_code === 0
        ? { text: `Task #${ev.task_id} done`, tone: "ok" }
        : {
            text: `Task #${ev.task_id} exited with ${ev.exit_code}`,
            tone: "warn",
          };
    case "task_failed":
      return { text: `Task #${ev.task_id} failed: ${ev.error}`, tone: "warn" };
    case "zone_collision":
      return { text: `Stuck. Zone claimed by ${ev.claimer}`, tone: "warn" };
    case "manual_override":
      return { text: `Override #${ev.task_id}: ${ev.mode}`, tone: "info" };
    case "rebase_conflict": {
      const head = `Task #${ev.task_id} rebase onto ${ev.onto_ref} hit conflicts`;
      const sample = ev.files.slice(0, 3).join(", ");
      const more = ev.files.length > 3 ? ` (+${ev.files.length - 3} more)` : "";
      return {
        text: sample ? `${head}: ${sample}${more}` : head,
        tone: "warn",
      };
    }
    case "semantic_alert": {
      const n = ev.deletions.length;
      const head = `. Aura: task #${ev.task_id} flagged ${n} function deletion${n === 1 ? "" : "s"}`;
      const sample = ev.deletions.slice(0, 3).join(", ");
      const more =
        ev.deletions.length > 3 ? ` (+${ev.deletions.length - 3} more)` : "";
      const detail = sample ? ` · ${sample}${more}` : "";
      const tail = ev.reason ? ` · ${ev.reason}` : "";
      return {
        text: `${head}${detail}${tail}. Review the worktree before merging.`,
        tone: "warn",
      };
    }
    case "paused":
      return { text: "Paused", tone: "info" };
    case "resumed":
      return { text: "Resumed", tone: "info" };
    case "cancelled":
      return { text: "Cancelled", tone: "warn" };
    case "plan_ready":
    case "manager_speech":
      return null;
  }
}

export function HookEventBlock({ text }: { text: string }) {
  return (
    <div
      className="aura-block flex items-start gap-2 px-2.5 py-1.5"
      style={{ background: "var(--color-bg-1)" }}
    >
      <span
        className="aura-block-label shrink-0 mt-[2px]"
        style={{ color: "var(--color-red)" }}
      >
        HOOK
      </span>
      <span className="text-sm leading-snug min-w-0" style={{ color: "var(--color-text-2)" }}>
        {text.replace(/^hook\s+/i, "")}
      </span>
    </div>
  );
}
