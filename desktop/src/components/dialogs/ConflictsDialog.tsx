// Durable AST-level conflict resolver. Lists open ConflictedNode rows
// from `.aura/conflicts.jsonl` (jj-style: a conflict is a first-class
// persistent object, not a transient ribbon). Click a row → side-by-
// side ours/theirs editor → Resolve (ours / theirs / custom) writes
// the chosen body and stamps the row resolved_at + resolved_in_commit.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Dialog } from "../Dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Code } from "../ui/code";
import { Textarea } from "../ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import "../ui/conflicts.css";
import { api, type ConflictedNode } from "../../lib/api";
import { fetchAstConflicts, resolveAstConflict } from "../../lib/ambientCache";

type ConflictsDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

type Strategy = "ours" | "theirs" | "custom";

export function ConflictsDialog({ open, repoRoot, onClose }: ConflictsDialogProps) {
  const [rows, setRows] = useState<ConflictedNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy>("ours");
  const [customBody, setCustomBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    setErr(null);
    try {
      const list = await fetchAstConflicts(repoRoot);
      setRows(list);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setStrategy("ours");
      setCustomBody("");
      setErr(null);
      void refresh();
    }
  }, [open, refresh]);

  const visibleRows = useMemo(
    () => rows.filter((r) => (showResolved ? true : r.resolved_at === null)),
    [rows, showResolved],
  );

  const target = useMemo(
    () => (selected ? rows.find((r) => r.id === selected) ?? null : null),
    [rows, selected],
  );

  // When the user picks a conflict, prefill the custom buffer with
  // whichever side they're already leaning toward so they can edit
  // a merged body without retyping.
  useEffect(() => {
    if (!target) {
      setCustomBody("");
      return;
    }
    setCustomBody(strategy === "theirs" ? target.theirs : target.ours);
  }, [target, strategy]);

  async function resolve() {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      const headSha = await api.gitShowHead(repoRoot, ".").catch(() => "");
      await resolveAstConflict(repoRoot, {
        conflict_id: target.id,
        strategy,
        custom_body: strategy === "custom" ? customBody : null,
        resolved_in_commit: headSha ? headSha.trim().split("\n")[0] : null,
      });
      setSelected(null);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const openCount = rows.filter((r) => r.resolved_at === null).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Clashes to sort out (${openCount})`}
      width={780}
      footer={
        <>
          <label className="ui-check-label ui-conflicts-show-resolved">
            <Checkbox
              checked={showResolved}
              onCheckedChange={(next) => setShowResolved(next === true)}
            />
            Show resolved
          </label>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={resolve}
            disabled={busy || !target}
            title={target ? strategyVerb(strategy) : "Pick a clash first"}
          >
            {busy ? "Saving…" : target ? strategyVerb(strategy) : "Keep one"}
          </Button>
        </>
      }
    >
      {err && (
        <Alert variant="destructive" className="ui-conflicts-alert">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}
      {loading && rows.length === 0 ? (
        <p className="ui-conflicts-state" role="status">
          <AsciiSpinner /> Looking for clashes…
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="ui-conflicts-state">
          {showResolved ? "Nothing clashes." : "Nothing clashes right now."}
        </p>
      ) : (
        <div className="ui-conflicts">
          <ul className="ui-conflicts-list" aria-label="Clashes">
            {visibleRows.map((row) => {
              const isSel = selected === row.id;
              const resolved = row.resolved_at !== null;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="ui-conflicts-row"
                    aria-pressed={isSel}
                    onClick={() => setSelected(isSel ? null : row.id)}
                  >
                    <span className="ui-conflicts-row-title">
                      <strong>{row.identifier}</strong>
                      {resolved && <Check aria-label="Settled" />}
                    </span>
                    <small>{row.file}</small>
                    <small>
                      {row.ours_agent} vs {row.theirs_agent}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="ui-conflicts-detail">
            {!target ? (
              <p className="ui-conflicts-state">Pick a clash on the left to sort out.</p>
            ) : (
              <>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-label="Which version to keep"
                  value={strategy}
                  // A single group reports "" when the pressed choice is
                  // pressed again; one version is always chosen.
                  onValueChange={(next) => {
                    if (next === "ours" || next === "theirs" || next === "custom") {
                      setStrategy(next);
                    }
                  }}
                >
                  <ToggleGroupItem value="ours">This one ({target.ours_agent})</ToggleGroupItem>
                  <ToggleGroupItem value="theirs">
                    The other ({target.theirs_agent})
                  </ToggleGroupItem>
                  <ToggleGroupItem value="custom">Write my own</ToggleGroupItem>
                </ToggleGroup>
                <div className="ui-conflicts-sides">
                  <Side label={`This one · ${target.ours_agent}`} body={target.ours} />
                  <Side label={`The other · ${target.theirs_agent}`} body={target.theirs} />
                </div>
                {strategy === "custom" && (
                  <label className="ui-form-field">
                    Your combined version
                    <Textarea
                      className="ui-conflicts-custom"
                      value={customBody}
                      onChange={(e) => setCustomBody(e.target.value)}
                      rows={10}
                    />
                  </label>
                )}
                <p className="ui-conflicts-meta">
                  Based on <Code size="sm">{target.base_hash || "(none)"}</Code>
                  {target.resolved_in_commit && (
                    <>
                      {" · settled in "}
                      <Code size="sm">{target.resolved_in_commit.slice(0, 8)}</Code>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// Plain action verb for the confirm button — non-engineers don't read
// "Resolve as ours/theirs/custom".
function strategyVerb(s: Strategy): string {
  if (s === "ours") return "Keep this one";
  if (s === "theirs") return "Keep the other";
  return "Use my version";
}

function Side({ label, body }: { label: string; body: string }) {
  return (
    <section className="ui-conflicts-side">
      <h3>{label}</h3>
      <pre>{body || "(empty)"}</pre>
    </section>
  );
}
