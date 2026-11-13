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
//
// Drawn as the shared check-run list: one row per probe with its mark, its
// title and one quiet line under it, in a single bordered box. "Needs a look"
// is the one state the list did not have, so it adds a yellow mark beside the
// green tick; nothing else about the row changes.

import { Fragment, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Circle } from "lucide-react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import "../ui/check-report.css";
import { ErrorState, LoadingState } from "../ui/state";
import { api, type DoctorReport } from "../../lib/api";
import {
  buildHealthItems,
  healthHeadline,
  type HealthItem,
  type Severity,
} from "../../lib/doctorHealth";
import { createLatestOnly } from "../../lib/latestOnly";

type DoctorDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  inline?: boolean;
};

// Cap how many detail rows we ever render — a repo can carry hundreds of
// stale sessions and mounting them all is both slow and pointless.
const ROW_CAP = 40;

// How long this card is willing to wait before it says something true.
//
// The backend has its own, shorter bound, so under normal failure this never
// fires. It exists for the case the backend itself does not answer, because
// the failure that brought people here was precisely a card that sat on
// "Checking your project..." and never changed. A screen that cannot say what
// went wrong must at least say that it does not know.
const CHECK_TIMEOUT_MS = 60_000;

export function DoctorDialog({ open, repoRoot, onClose, inline }: DoctorDialogProps) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the newest check may paint, and no check waits forever. Switching
  // project starts a second one while the first is still out, and without this
  // the slower of the two wins — one project's health under another project's
  // name. The rules and their tests live in lib/latestOnly.
  const checks = useRef(createLatestOnly());

  const run = async () => {
    setLoading(true);
    setError(null);
    setReport(null);

    const settled = await checks.current.run(
      () => api.auraDoctorJson(repoRoot),
      CHECK_TIMEOUT_MS,
      "The check is taking longer than it should. Try again.",
    );

    // A stale answer is not this screen's to paint, and not its to stop
    // loading either — the run that replaced it owns both.
    if (settled.kind === "stale") return;
    if (settled.kind === "ok") setReport(settled.value);
    else setError(settled.message);
    setLoading(false);
  };

  useEffect(() => {
    if (open) void run();
    // Closing, or moving to another project, retires whatever is in flight so
    // its answer cannot arrive later and overwrite the screen.
    return () => checks.current.retire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoRoot]);

  const items = report ? buildHealthItems(report) : null;

  return (
    <Dialog
      open={open}
      inline={inline}
      onClose={onClose}
      title="Repository health"
      width={720}
      footer={
        // Inline, this is a TAB, and the tab strip already owns closing it. A
        // filled "Close" there made dismissal the loudest control on a
        // diagnostic page while "Check again" — the only thing you actually
        // come back to do — sat quiet beside it. So inline gets the re-check
        // alone, promoted; the real modal keeps both.
        inline ? (
          <Button onClick={run} disabled={loading}>
            {loading ? "Checking…" : "Check again"}
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={run} disabled={loading}>
              {loading ? "Checking…" : "Check again"}
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
          title="Couldn’t check your repository"
          message={error}
          onRetry={() => void run()}
        />
      ) : !items && loading ? (
        <LoadingState label="Checking your repository…" />
      ) : !items || !report ? (
        <div className="ui-pattern-empty">Nothing to report.</div>
      ) : (
        <div className="ui-check-report" data-scroll={inline ? undefined : ""}>
          <HealthHeadline items={items} report={report} />
          <div className="ui-check-runs ui-check-box">
            {items.map((it) => (
              <HealthRow key={it.key} item={it} />
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
function HealthHeadline({
  items,
  report,
}: {
  items: HealthItem[];
  report: DoctorReport;
}) {
  const verdict = healthHeadline(items, report);
  return (
    <header className="ui-verdict" data-tone={verdict.tone}>
      <strong>{verdict.text}</strong>
      <span>{verdict.chips.join(" · ")}</span>
    </header>
  );
}

const STATUS: Record<Severity, string> = {
  ok: "passed",
  attention: "attention",
  info: "pending",
};

function HealthRow({ item }: { item: HealthItem }) {
  const [open, setOpen] = useState(false);
  const rows = item.rows ?? [];
  const shown = rows.slice(0, ROW_CAP);
  const hidden = rows.length - shown.length;
  return (
    <Fragment>
      <div data-status={STATUS[item.severity]}>
        {item.severity === "ok" ? (
          <Check size={14} />
        ) : item.severity === "attention" ? (
          <AlertTriangle size={14} />
        ) : (
          <Circle size={14} />
        )}
        <span>
          {item.title}
          {item.detail && <small>{item.detail}</small>}
        </span>
        {rows.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : `Show ${rows.length}`}
          </Button>
        )}
      </div>
      {open && rows.length > 0 && (
        <ul className="ui-check-box-rows">
          {shown.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {hidden > 0 && <li className="ui-check-box-more">…and {hidden} more</li>}
        </ul>
      )}
    </Fragment>
  );
}
