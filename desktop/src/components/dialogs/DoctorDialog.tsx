// Project health — the "is anything wrong with how Aura is tracking this
// project?" self-check, in plain language for non-engineers.
//
// It reads the STRUCTURED report (`aura doctor --json` via auraDoctorJson),
// not the raw text dump. That matters: the text path lists every stale
// session as its own line, so a repo with hundreds of old sessions used to
// render a wall of hundreds of scary "Active but no interaction for 1106
// minutes" rows under a calm headline. Here each probe collapses to ONE
// plain-language item; the few that have detail (old sessions, leftover
// workspaces) tuck it behind a "Show" disclosure, capped so the DOM never
// explodes. Read-only — no repairs are performed here.

import { useEffect, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { ErrorState, LoadingState } from "../ui/state";
import { api, type DoctorReport } from "../../lib/api";
import {
  buildHealthItems,
  healthHeadline,
  type HealthItem,
  type Severity,
} from "../../lib/doctorHealth";

type DoctorDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  inline?: boolean;
};

// Cap how many detail rows we ever render — a repo can carry hundreds of
// stale sessions and mounting them all is both slow and pointless.
const ROW_CAP = 40;

export function DoctorDialog({ open, repoRoot, onClose, inline }: DoctorDialogProps) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.auraDoctorJson(repoRoot));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoRoot]);

  const items = report ? buildHealthItems(report) : null;

  return (
    <Dialog
      open={open}
      inline={inline}
      onClose={onClose}
      title="Project health"
      width={720}
      footer={
        // Inline, this is a TAB, and the tab strip already owns closing it. A
        // filled "Close" there made dismissal the loudest control on a
        // diagnostic page while "Check again" — the only thing you actually
        // come back to do — sat quiet beside it. So inline gets the re-check
        // alone, promoted; the real modal keeps both.
        inline ? (
          <Button variant="outline" size="xs" onClick={run} disabled={loading}>
            {loading ? "Checking…" : "Check again"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={run} disabled={loading}>
              {loading ? "Checking…" : "Check again"}
            </Button>
            <Button variant="default" size="xs" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {error ? (
        // Was the raw `String(e)` in red. This screen is read by people who
        // did not write the code; the shared error state gives them a plain
        // heading and a retry instead of a stack-flavoured string alone.
        <ErrorState
          title="Couldn’t check your project"
          message={error}
          onRetry={() => void run()}
        />
      ) : !items && loading ? (
        <LoadingState label="Checking your project…" />
      ) : !items || !report ? (
        <div className="text-text-4 text-sm">Nothing to report.</div>
      ) : (
        <div className={`flex flex-col gap-3 ${inline ? "" : "max-h-[68vh] overflow-auto"}`}>
          <HealthHeadline items={items} report={report} />
          <div className="flex flex-col gap-2">
            {items.map((it) => (
              <ItemCard key={it.key} item={it} />
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// One plain-language sentence at the top, from `healthHeadline` — which is
// where the guard lives: it refuses to go green while the engine's own count
// of problems is larger than what the items below account for.
const VERDICT_FG: Record<"attention" | "good" | "unknown", string> = {
  attention: "var(--color-amber)",
  good: "var(--color-accent-green)",
  unknown: "var(--color-amber)",
};

function HealthHeadline({
  items,
  report,
}: {
  items: HealthItem[];
  report: DoctorReport;
}) {
  const verdict = healthHeadline(items, report);
  return (
    <div className="flex flex-col gap-0.5 px-0.5">
      <div
        className="text-base font-medium"
        style={{ color: VERDICT_FG[verdict.tone] }}
      >
        {verdict.text}
      </div>
      <div className="text-xs text-text-3">{verdict.chips.join(" · ")}</div>
    </div>
  );
}

function ItemCard({ item }: { item: HealthItem }) {
  const [open, setOpen] = useState(false);
  const tone = TONES[item.severity];
  const shown = item.rows ? item.rows.slice(0, ROW_CAP) : [];
  const hidden = item.rows ? item.rows.length - shown.length : 0;
  return (
    <div
      className="rounded-md border bg-bg-3 px-3.5 py-2.5"
      style={{ borderColor: tone.border }}
    >
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 mt-[1px] text-sm" style={{ color: tone.fg }}>
          {tone.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-base text-text-1 font-medium">{item.title}</div>
          {item.detail && (
            <div className="text-sm text-text-3 leading-relaxed mt-0.5">
              {item.detail}
            </div>
          )}
          {item.rows && item.rows.length > 0 && (
            <div className="mt-1.5">
              <button
                type="button"
                className="text-xs text-text-4 hover:text-text-2 transition-colors"
                onClick={() => setOpen((v) => !v)}
              >
                {open ? "Hide details" : `Show details (${item.rows.length})`}
              </button>
              {open && (
                <ul className="mt-1.5 flex flex-col gap-1 max-h-[34vh] overflow-auto pr-1">
                  {shown.map((r, i) => (
                    <li
                      key={i}
                      className="text-xs font-mono text-text-3 leading-relaxed whitespace-pre-wrap"
                    >
                      {r}
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li className="text-xs text-text-4 italic">
                      …and {hidden} more
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const TONES: Record<Severity, { fg: string; border: string; glyph: string }> = {
  ok: { fg: "var(--color-accent-green)", border: "var(--color-line)", glyph: "✓" },
  attention: { fg: "var(--color-amber)", border: "var(--color-amber)", glyph: "!" },
  info: { fg: "var(--color-text-4)", border: "var(--color-line)", glyph: "·" },
};
