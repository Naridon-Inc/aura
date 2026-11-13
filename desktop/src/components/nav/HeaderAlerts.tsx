import { Button } from "../ui/button";

export type PluginStatusPill = { pluginId: string; id: string; render: string };

const TONE = {
  red: "var(--color-red)",
  amber: "var(--color-amber)",
  muted: "var(--ui-muted-fg)",
} as const;

function Dot({ tone }: { tone: keyof typeof TONE }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        flexShrink: 0,
        background: TONE[tone],
      }}
    />
  );
}

/** Things in this workspace that are waiting on you, each a door to where it
 *  gets handled. Nothing renders while nothing is waiting — the header never
 *  carries an "all clear" chip.
 *
 *  - risky actions Aura paused for you to check → the team's Trace view
 *  - merge conflicts → the conflict resolver
 *  - plugin status pills (`worker:status`) → the plugin's own click handler */
export function HeaderAlerts({
  auditUnacked,
  conflictsOpen,
  onClickAudit,
  onClickConflicts,
  pluginPills = [],
  onClickPluginPill,
}: {
  auditUnacked?: number;
  conflictsOpen?: number;
  onClickAudit: () => void;
  onClickConflicts: () => void;
  pluginPills?: PluginStatusPill[];
  onClickPluginPill?: (pluginId: string, pillId: string) => void;
}) {
  const workers = pluginPills.filter((p) => p.render === "worker:status");
  return (
    <>
      {auditUnacked !== undefined && auditUnacked > 0 && (
        <Button
          variant="ghost"
          size="sm"
          title="Risky actions Aura paused for you to check. Click to review."
          onClick={onClickAudit}
          style={{ color: TONE.red }}
        >
          <Dot tone="red" />
          <span className="tabular-nums">{auditUnacked}</span>
          to review
        </Button>
      )}
      {conflictsOpen !== undefined && conflictsOpen > 0 && (
        <Button
          variant="ghost"
          size="sm"
          title="Merge conflicts. Click to resolve"
          onClick={onClickConflicts}
          style={{ color: TONE.amber }}
        >
          <Dot tone="amber" />
          <span className="tabular-nums">{conflictsOpen}</span>
          conflict{conflictsOpen === 1 ? "" : "s"}
        </Button>
      )}
      {workers.map((p) => (
        <Button
          key={`${p.pluginId}:${p.id}`}
          variant="ghost"
          size="sm"
          title={`${p.pluginId} · ${p.id}`}
          disabled={!onClickPluginPill}
          onClick={() => onClickPluginPill?.(p.pluginId, p.id)}
        >
          <Dot tone="muted" />
          {p.id}
        </Button>
      ))}
    </>
  );
}
