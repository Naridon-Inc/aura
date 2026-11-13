import { useEffect, useMemo, useState } from "react";
import { Check, Info, Minus, X } from "lucide-react";

import { relativeAge } from "../../../lib/relativeTime";
import { readRecents } from "../../../lib/recentProjects";
import {
  announceAdopted,
  count,
  defaultSelection,
  groupItems,
  importRun,
  importSourceScan,
  onImportProgress,
  projectRoom,
  selectedKeys,
  tally,
  type ImportGroup,
  type ImportItem,
  type ImportProgress,
  type ImportReport,
  type ImportScan,
  type ImportSource,
} from "../../../lib/importSources";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Progress } from "../../ui/progress";
import { SettingsEmpty, SettingsError } from "../../ui/settings-blocks";

// One app's contents, unfolded under its row on Settings → Import: what it
// holds, grouped by where it lands in Aura, with everything that can come
// over ticked. Import sends the ticked keys; the importer reports per item,
// and the page scans again so what came over reads "In Aura".

/** How many of a group's items show before "Show all". */
const FOLD_AT = 6;

export function ImportSourcePanel({
  source,
  onImported,
}: {
  source: ImportSource;
  /** An import finished: the source's counts are stale. */
  onImported: () => void;
}) {
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const rescan = async (extraRoots: string[] = []) => {
    try {
      const known = [...new Set([...readRecents(), ...extraRoots])];
      const next = await importSourceScan(source.id, known);
      setScan(next);
      setPicked(defaultSelection(next.items));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void rescan();
    // A new source is a new panel (keyed by id); nothing else re-scans it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id]);

  useEffect(() => {
    if (!running) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void onImportProgress((p) => {
      if (p.source === source.id) setProgress(p);
    }).then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [running, source.id]);

  const groups = useMemo(() => groupItems(scan?.items ?? []), [scan]);
  const keys = useMemo(() => selectedKeys(scan?.items ?? [], picked), [scan, picked]);

  const start = async () => {
    if (!scan || keys.length === 0) return;
    setRunning(true);
    setReport(null);
    setProgress({ source: source.id, done: 0, total: keys.length, title: "" });
    try {
      const recents = readRecents();
      const result = await importRun(source.id, keys, recents, projectRoom(recents));
      // The window owns the project list; hand it the folders that came in
      // before scanning again, so they read as already in Aura.
      announceAdopted(result.adopt);
      setReport(result);
      await rescan(result.adopt.filter((a) => a.project).map((a) => a.root));
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const toggle = (key: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const toggleGroup = (group: ImportGroup, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const i of group.items) {
        if (i.state !== "ready") continue;
        if (on) next.add(i.key);
        else next.delete(i.key);
      }
      return next;
    });

  if (!scan && !error) {
    return (
      <div className="ui-import-panel">
        <div className="ui-import-progress">
          <span>
            <AsciiSpinner /> Looking inside {source.name}…
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="ui-import-panel" data-source={source.id}>
      {error && <SettingsError>{error}</SettingsError>}
      {scan && groups.length === 0 && (
        <SettingsEmpty>{source.name} has nothing Aura can bring over.</SettingsEmpty>
      )}
      {groups.map((group) => (
        <Group
          key={group.kind}
          group={group}
          picked={picked}
          disabled={running}
          onToggle={toggle}
          onToggleGroup={toggleGroup}
        />
      ))}
      {scan && scan.notes.length > 0 && (
        <ul className="ui-import-notes">
          {scan.notes.map((note) => (
            <li key={note}>
              <Info size={14} aria-hidden />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="ui-import-footer">
          <Button size="sm" disabled={running || keys.length === 0} onClick={() => void start()}>
            {keys.length === 0 ? "Nothing ticked" : `Import ${count(keys.length, "item")}`}
          </Button>
          {running && progress && (
            <div className="ui-import-progress" aria-live="polite">
              <span>
                <AsciiSpinner />
                {progress.title ? `Bringing over ${progress.title}` : "Starting…"}
                {progress.total > 0 && ` · ${progress.done} of ${progress.total}`}
              </span>
              <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
            </div>
          )}
        </div>
      )}
      {report && <Result report={report} />}
    </div>
  );
}

function Group({
  group,
  picked,
  disabled,
  onToggle,
  onToggleGroup,
}: {
  group: ImportGroup;
  picked: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (key: string, on: boolean) => void;
  onToggleGroup: (group: ImportGroup, on: boolean) => void;
}) {
  const [all, setAll] = useState(false);
  const ticked = group.items.filter((i) => i.state === "ready" && picked.has(i.key)).length;
  const head: boolean | "indeterminate" =
    group.ready === 0 || ticked === 0 ? false : ticked === group.ready ? true : "indeterminate";
  const done = group.items.filter((i) => i.state === "done").length;
  const unavailable = group.items.length - group.ready - done;
  const parts = [
    group.ready > 0 && `${group.ready} to bring over`,
    done > 0 && `${done} in Aura`,
    unavailable > 0 && `${unavailable} can't come over`,
  ].filter(Boolean);
  const shown = all ? group.items : group.items.slice(0, FOLD_AT);
  const id = `import-group-${group.kind}`;
  return (
    <section className="ui-import-group" data-kind={group.kind}>
      <div className="ui-import-group-head">
        <Checkbox
          id={id}
          checked={head}
          disabled={disabled || group.ready === 0}
          onCheckedChange={(v) => onToggleGroup(group, v === true)}
          aria-label={`All ${group.label.toLowerCase()}`}
        />
        <label htmlFor={id}>{group.label}</label>
        <span className="ui-import-group-count">{parts.join(" · ")}</span>
      </div>
      <p className="ui-import-group-lands">{group.lands}.</p>
      <ul className="ui-import-items">
        {shown.map((item) => (
          <Row
            key={item.key}
            item={item}
            checked={picked.has(item.key)}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
      </ul>
      {group.items.length > FOLD_AT && (
        <Button className="ui-import-more" size="xs" variant="ghost" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${group.items.length}`}
        </Button>
      )}
    </section>
  );
}

function Row({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: ImportItem;
  checked: boolean;
  disabled: boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const age = item.when ? relativeAge(item.when) : "";
  const detail = [item.detail, age].filter(Boolean).join(" · ");
  const ready = item.state === "ready";
  return (
    <li className="ui-import-item" data-state={item.state}>
      <Checkbox
        checked={ready ? checked : item.state === "done"}
        disabled={disabled || !ready}
        onCheckedChange={(v) => onToggle(item.key, v === true)}
        aria-label={item.title}
      />
      <span className="ui-import-item-text">
        <span className="ui-import-item-title" title={item.title}>
          {item.title}
        </span>
        {detail && <span className="ui-import-item-detail">{detail}</span>}
        {item.state === "unavailable" && item.reason && (
          <span className="ui-import-item-reason">{item.reason}</span>
        )}
      </span>
      {item.state === "done" && <span className="ui-import-item-state">In Aura</span>}
    </li>
  );
}

const MARK = {
  imported: <Check size={14} />,
  skipped: <Minus size={14} />,
  failed: <X size={14} />,
};

/** What the run did: one line of counts, then every item that did not simply
 *  come over, with its reason, failures first. */
function Result({ report }: { report: ImportReport }) {
  const t = tally(report.outcomes);
  const notable = [
    ...report.outcomes.filter((o) => o.status === "failed"),
    ...report.outcomes.filter((o) => o.status === "skipped"),
  ];
  const line = [
    `${t.imported} brought over`,
    t.skipped > 0 && `${t.skipped} skipped`,
    t.failed > 0 && `${t.failed} failed`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="ui-import-result" role="status">
      <p className="ui-import-result-line">{line}.</p>
      {notable.length > 0 && (
        <ul className="ui-import-items">
          {notable.map((o) => (
            <li key={o.key} className="ui-import-item">
              <span className="ui-import-outcome-mark" data-status={o.status} aria-label={o.status}>
                {MARK[o.status]}
              </span>
              <span className="ui-import-item-text">
                <span className="ui-import-item-title">{o.title}</span>
                {o.reason && <span className="ui-import-item-reason">{o.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
