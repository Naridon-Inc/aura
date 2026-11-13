// Impacts on me: a teammate changed, on another branch, a function your work
// leans on. Each one says what moved and where, and you either acknowledge it
// or open the file to deal with it. Quiet means nothing you depend on moved.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { ImpactAlert } from "../../../lib/api";
import { fetchImpacts, resolveImpact } from "../../../lib/ambientCache";
import { useEditorStore } from "../../../lib/editorStore";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { EmptyState, LoadingState } from "../../ui/state";
import { TraceFact } from "../../ui/trace-detail";
import { TraceMark } from "../../ui/trace-list";
import { TraceToolbar } from "../../ui/trace-page";
import "../../ui/impacts.css";

export function ImpactsPane({ repoRoot }: { repoRoot: string }) {
  const [alerts, setAlerts] = useState<ImpactAlert[] | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchImpacts(repoRoot)
      .then(setAlerts)
      .catch(() => setAlerts(null))
      .finally(() => setLoading(false));
  }, [repoRoot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The engine returns acknowledged alerts too. Without dropping them here an
  // acknowledged row comes straight back on the next read, and the all-clear
  // could never show.
  const live = alerts?.filter((a) => !a.resolved) ?? [];

  return (
    <div className="ui-impacts-page">
      <TraceToolbar
        search={
          <span className="ui-trace-toolbar-meta">
            Changes on other branches to code your work depends on.
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          disabled={loading}
          title="Check again"
          aria-label="Check again"
        >
          <RefreshCw />
        </Button>
      </TraceToolbar>
      <div className="ui-impacts-body">
        {loading && alerts === null ? (
          <LoadingState label="Checking what moved…" size="md" />
        ) : live.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="Nothing's reaching your work"
            body="When a teammate changes a function on another branch that your code leans on, it shows up here, so a change you didn't make can't quietly break you."
            footnote="A count appears on Impacts on me the moment something needs your eyes."
          />
        ) : (
          <ol className="ui-impacts" aria-label="Changes reaching your work">
            {live.map((a) => (
              <ImpactRow
                key={a.id || `${a.function}-${a.timestamp}`}
                alert={a}
                repoRoot={repoRoot}
                onResolved={refresh}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const SEVERITY_TONE: Record<string, "danger" | "warn" | undefined> = {
  critical: "danger",
  high: "danger",
  medium: "warn",
};

function ImpactRow({
  alert,
  repoRoot,
  onResolved,
}: {
  alert: ImpactAlert;
  repoRoot: string;
  onResolved: () => void;
}) {
  const editor = useEditorStore();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const filePath = useMemo(() => {
    if (!alert.file) return null;
    if (alert.file.startsWith("/")) return alert.file;
    return `${repoRoot.replace(/\/$/, "")}/${alert.file.replace(/^\//, "")}`;
  }, [alert.file, repoRoot]);

  const acknowledge = async () => {
    if (!alert.id || busy) return;
    setBusy(true);
    try {
      await resolveImpact(repoRoot, alert.id);
      onResolved();
    } catch {
      // The next read shows the row again if the write didn't take.
      setBusy(false);
    }
  };

  const openFile = async () => {
    if (!filePath) return;
    try {
      await editor.open(filePath, { defaultView: "diff" });
    } catch {
      // A file that's gone leaves the row as it is.
    }
  };

  const severity = alert.severity || "info";
  return (
    <li className="ui-impact">
      <div className="ui-impact-head">
        <TraceMark tone={SEVERITY_TONE[severity]}>{severity}</TraceMark>
        <button
          type="button"
          className="ui-impact-name"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {alert.function || "(unknown)"}
        </button>
        {alert.branch && <span className="ui-impact-branch">on {alert.branch}</span>}
      </div>
      {alert.message && <p className="ui-impact-message">{alert.message}</p>}
      {expanded && (
        <div className="ui-impact-facts">
          {alert.file && <TraceFact label="File">{alert.file}</TraceFact>}
          {alert.timestamp > 0 && (
            <TraceFact label="When">{new Date(alert.timestamp * 1000).toLocaleString()}</TraceFact>
          )}
          {alert.id && <TraceFact label="Alert">{alert.id}</TraceFact>}
        </div>
      )}
      <div className="ui-impact-actions">
        <Button variant="outline" size="xs" onClick={acknowledge} disabled={busy || !alert.id}>
          {busy ? (
            <>
              <AsciiSpinner size={10} />
              Acknowledging…
            </>
          ) : (
            "Acknowledge"
          )}
        </Button>
        <Button variant="ghost" size="xs" onClick={openFile} disabled={!filePath}>
          See the change
        </Button>
      </div>
    </li>
  );
}
