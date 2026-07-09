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
import { api, type DoctorReport } from "../../lib/api";

type Severity = "ok" | "attention" | "info";

type HealthItem = {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** Optional compact rows revealed behind a "Show" disclosure. */
  rows?: string[];
};

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

  const items = report ? buildItems(report) : null;

  return (
    <Dialog
      open={open}
      inline={inline}
      onClose={onClose}
      title="Project health"
      width={720}
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={run} disabled={loading}>
            {loading ? "Checking…" : "Check again"}
          </Button>
          <Button variant="default" size="xs" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? (
        <div className="text-red text-[11.5px] py-2">{error}</div>
      ) : !items && loading ? (
        <div className="text-text-4 text-[11.5px] py-8 text-center">
          Checking your project…
        </div>
      ) : !items ? (
        <div className="text-text-4 text-[11.5px]">Nothing to report.</div>
      ) : (
        <div className={`flex flex-col gap-3 ${inline ? "" : "max-h-[68vh] overflow-auto"}`}>
          <HealthHeadline items={items} />
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

// One plain-language sentence at the top: a vibecoder should read it and know
// whether to worry. Tone follows whether anything actually needs attention —
// harmless tidy-ups (old sessions, leftover backups) never make it read red.
function HealthHeadline({ items }: { items: HealthItem[] }) {
  const attention = items.filter((i) => i.severity === "attention").length;
  const tidy = items.filter((i) => i.severity === "info").length;
  const verdict =
    attention > 0
      ? { text: "A couple of things to set up", color: "var(--color-amber)" }
      : { text: "Your project's in good shape", color: "var(--color-accent-green)" };
  const chips: string[] = [];
  if (attention > 0)
    chips.push(`${attention} to set up`);
  if (tidy > 0) chips.push(`${tidy} safe to tidy up`);
  if (chips.length === 0) chips.push("Nothing needs your attention");
  return (
    <div className="flex flex-col gap-0.5 px-0.5">
      <div className="text-[13px] font-medium" style={{ color: verdict.color }}>
        {verdict.text}
      </div>
      <div className="text-[11px] text-text-3">{chips.join(" · ")}</div>
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
        <span className="shrink-0 mt-[1px] text-[12px]" style={{ color: tone.fg }}>
          {tone.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-text-1 font-medium">{item.title}</div>
          {item.detail && (
            <div className="text-[11.5px] text-text-3 leading-relaxed mt-0.5">
              {item.detail}
            </div>
          )}
          {item.rows && item.rows.length > 0 && (
            <div className="mt-1.5">
              <button
                type="button"
                className="text-[11px] text-text-4 hover:text-text-2 transition-colors"
                onClick={() => setOpen((v) => !v)}
              >
                {open ? "Hide details" : `Show details (${item.rows.length})`}
              </button>
              {open && (
                <ul className="mt-1.5 flex flex-col gap-1 max-h-[34vh] overflow-auto pr-1">
                  {shown.map((r, i) => (
                    <li
                      key={i}
                      className="text-[11px] font-mono text-text-3 leading-relaxed whitespace-pre-wrap"
                    >
                      {r}
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li className="text-[11px] text-text-4 italic">
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

// Turn the structured report into plain-language items. Order: things to set
// up first, then what's healthy, then harmless tidy-ups last. Jargon
// (sessions, snapshots, hooks, signing keys, worktrees) is translated to what
// a non-engineer actually cares about.
function buildItems(r: DoctorReport): HealthItem[] {
  const attention: HealthItem[] = [];
  const healthy: HealthItem[] = [];
  const tidy: HealthItem[] = [];

  // Capture — is Aura watching this project's commits? The one genuine
  // "set this up" item, with a real place to fix it.
  if (r.hooks_installed) {
    healthy.push({
      key: "capture",
      severity: "ok",
      title: "Aura is watching your changes",
      detail: "Every commit gets recorded and checked automatically.",
    });
  } else {
    attention.push({
      key: "capture",
      severity: "attention",
      title: "Aura isn't watching this project yet",
      detail:
        "Turn on Capture so your changes get recorded and checked as you work. Settings → Capture.",
    });
  }

  // Signing — can Aura prove who made each change?
  const signStatus = String(
    (r.signing as { status?: unknown })?.status ?? "",
  );
  if (signStatus === "ok") {
    healthy.push({
      key: "signing",
      severity: "ok",
      title: "Your changes are signed",
      detail: "Aura signs each change so it can prove who made it.",
    });
  } else if (signStatus === "unreadable" || signStatus === "no_path") {
    attention.push({
      key: "signing",
      severity: "attention",
      title: "Aura can't read your signing key",
      detail: "Your changes can't be signed until the key file is back in place.",
    });
  } // "missing" is informational — Aura mints one when first needed; stay quiet.

  // Old sessions — the big one. Harmless leftover bookkeeping, NOT a problem.
  const stuck = r.stuck_sessions ?? [];
  if (stuck.length > 0) {
    tidy.push({
      key: "sessions",
      severity: "info",
      title: `${stuck.length} old session${stuck.length === 1 ? "" : "s"} left open`,
      detail:
        "Leftover bookkeeping from past AI runs — they don't affect your code and are safe to ignore.",
      rows: stuck.map(
        (s) =>
          `${s.agent_id || "agent"} · ${s.files_touched} file${s.files_touched === 1 ? "" : "s"} · ${s.reason}`,
      ),
    });
  }

  // Backups (snapshots) — Aura keeps one before each AI edit so you can undo.
  if (r.snapshots.orphaned > 0) {
    tidy.push({
      key: "backups-orphan",
      severity: "info",
      title: `${r.snapshots.orphaned} backup${r.snapshots.orphaned === 1 ? "" : "s"} point to files that are gone`,
      detail: "Leftover backups — safe to clear, they don't affect anything.",
    });
  } else if (r.snapshots.oversized) {
    tidy.push({
      key: "backups-large",
      severity: "info",
      title: `You've saved a lot of backups (${r.snapshots.total})`,
      detail:
        "Aura keeps a backup before each AI edit so you can undo. Nothing's wrong — just a lot of history piling up.",
    });
  } else if (r.snapshots.total > 0) {
    healthy.push({
      key: "backups-ok",
      severity: "ok",
      title: "Your undo history is healthy",
      detail: `${r.snapshots.total} backup${r.snapshots.total === 1 ? "" : "s"} saved — Aura can roll any AI edit back.`,
    });
  }

  // Leftover replay workspaces — left behind when a replay run was stopped.
  const orphans = r.replay_orphans ?? [];
  if (orphans.length > 0) {
    tidy.push({
      key: "replay-orphans",
      severity: "info",
      title: `${orphans.length} leftover workspace${orphans.length === 1 ? "" : "s"} from interrupted runs`,
      detail: "Safe to clear — left behind when a replay was stopped early.",
      rows: orphans.map((o) => `${o.branch} · ${o.path}`),
    });
  }

  // Learning data waiting to sync — quiet info, only when it's actually stuck.
  if (r.skill_ledger.present && r.skill_ledger.dirty > 0) {
    tidy.push({
      key: "skill-sync",
      severity: "info",
      title: "Some learning data is waiting to sync",
      detail: "It'll upload the next time you're signed in to Aura.",
    });
  }

  return [...attention, ...healthy, ...tidy];
}
