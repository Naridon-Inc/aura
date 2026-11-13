// Attestations ledger — the repo-wide roll of signed, tamper-evident intent
// blocks. It speaks the SAME visual language as the per-run Attestation tab
// (SessionAttestation): one calm row per signed block under `.aura/blocks/`,
// a verdict lock, the canonical id, and the trust badges (Signed · in the
// transparency log). The cryptography is unchanged — this is a readable
// surface over it.
//
// Every block here was minted by a run, so each row is keyed back to that
// run's intent: we cross-reference `aura attest list` against the intent log
// so a block reads with its human title and clicks through into the very same
// session detail (landing on its Attestation tab), closing the loop between
// the ledger and the run.
//
// Both views are the trace page's own: the chain is its timeline, the flat
// list is its row list, and the records' marks are its quiet word-marks.
//
// Backend: `aura attest list --json` → array of rows
//   { id, kind, created_at, signature: bool, rekor: bool,
//     human_id?: string, intent_type?: string }

import { useEffect, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Segment } from "../ui/segment";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { TraceList, TraceRow } from "../ui/trace-list";
import { TraceStoryHead } from "../ui/trace-story";
import { api, type IntentRow } from "../../lib/api";
import { fetchIntentRows } from "../../lib/intentCache";
import { splitIntent } from "../workpanes/IntentProse";
import { SessionDetailPane } from "../workpanes/SessionDetailPane";
import { formatAttestWhen, shortBlockId } from "../workpanes/SessionAttestation";
import {
  ProvenanceChain,
  RecordMarks,
  SealMark,
  type SealedRecord,
} from "../provenance/ProvenanceChain";

type AttestRow = SealedRecord;

type LedgerView = "chain" | "list";

type AttestationsDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  inline?: boolean;
};

export function AttestationsDialog({ open, repoRoot, onClose, inline }: AttestationsDialogProps) {
  const [rows, setRows] = useState<AttestRow[]>([]);
  // block id → the intent-log run that minted it, so a ledger row carries its
  // human title and can drill into the run's session detail.
  const [byBlock, setByBlock] = useState<Record<string, IntentRow>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The run whose session detail is layered over the ledger (null = closed).
  const [openRow, setOpenRow] = useState<IntentRow | null>(null);
  // Default to the chain — the records *are* a chain, and seeing the links is
  // the point. The flat list stays a click away for scanning.
  const [view, setView] = useState<LedgerView>("chain");

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.auraCli(repoRoot, ["attest", "list", "--json"]);
      const trimmed = res.stdout.trim();
      if (!trimmed) {
        if (res.status !== 0) setError(res.stderr.trim() || `exit ${res.status}`);
        setRows([]);
        return;
      }
      const parsed = JSON.parse(trimmed) as AttestRow[];
      setRows(Array.isArray(parsed) ? parsed : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoRoot]);

  // Best-effort run cross-reference — absence just means a ledger row stays
  // un-clickable and falls back to its block kind for a title. This used to ask
  // for the backend's default of 50 rows, which meant older ledger entries were
  // silently un-clickable; the whole history is shared with every other surface
  // now, so asking for all of it costs nothing extra.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchIntentRows(repoRoot)
      .then((intents) => {
        if (!alive) return;
        const map: Record<string, IntentRow> = {};
        for (const r of intents) {
          if (r.signed_block_id) map[r.signed_block_id] = r;
        }
        setByBlock(map);
      })
      .catch(() => {
        if (alive) setByBlock({});
      });
    return () => {
      alive = false;
    };
  }, [open, repoRoot]);

  const signed = rows.filter((r) => r.signature).length;
  const logged = rows.filter((r) => r.rekor).length;

  // A ledger row's human title + drill-through come from the run that minted the
  // block (cross-referenced above); both the chain and the flat list share them.
  const resolveTitle = (r: SealedRecord): string | undefined => {
    const intent = byBlock[r.id];
    if (!intent) return undefined;
    return splitIntent(intent.intent).headline || intent.intent;
  };
  const openRecord = (r: SealedRecord) => {
    const intent = byBlock[r.id];
    if (intent) setOpenRow(intent);
  };

  return (
    <>
      <Dialog
        open={open}
        inline={inline}
        onClose={onClose}
        title="Genuine records"
        width={760}
        footer={
          // Inline this is a tab whose strip already closes it.
          inline ? (
            <Button onClick={run} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={run} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </Button>
            </>
          )
        }
      >
        {error ? (
          <ErrorState
            title="Couldn’t read the sealed records"
            message={error}
            onRetry={() => void run()}
            size="sm"
          />
        ) : loading && rows.length === 0 ? (
          <LoadingState label="Reading sealed records…" className="justify-center py-8" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No sealed records yet"
            size="sm"
            body="Each time the AI changes something, Aura seals it. A record of exactly what happened that nobody can quietly alter later. Some are copied to an independent public logbook too. Make a change to start the record."
          />
        ) : (
          <div className="ui-attest" data-scroll={inline ? undefined : ""}>
            <TraceStoryHead
              icon={<Lock aria-hidden />}
              control={
                <Segment
                  size="xs"
                  value={view}
                  onChange={setView}
                  ariaLabel="Show the records as"
                  options={[
                    { value: "chain", label: "Chain", title: "Each record linked to the one before it" },
                    { value: "list", label: "List", title: "One row per record" },
                  ]}
                />
              }
            >
              <strong>{signed}</strong> sealed · <strong>{logged}</strong> with a public copy
            </TraceStoryHead>
            {view === "chain" ? (
              <ProvenanceChain
                records={rows}
                resolveTitle={resolveTitle}
                canOpen={(r) => !!byBlock[r.id]}
                onOpen={openRecord}
              />
            ) : (
              <TraceList label="Sealed records">
                {rows.map((r) => (
                  <TraceRow
                    key={r.id}
                    status={<SealMark record={r} />}
                    title={resolveTitle(r) || r.kind}
                    marks={r.signature ? undefined : <RecordMarks record={r} brief />}
                    where={<span className="ui-chain-id">{shortBlockId(r.id)}</span>}
                    whereTitle={r.human_id || r.id}
                    time={formatAttestWhen(r.created_at)}
                    onOpen={byBlock[r.id] ? () => openRecord(r) : undefined}
                  />
                ))}
              </TraceList>
            )}
          </div>
        )}
      </Dialog>

      {/* Drill into the run that minted a block — its full session detail,
          opening on the Attestation tab. Portals over the whole window; Esc
          returns to the ledger. */}
      {openRow ? (
        <SessionDetailPane
          repoRoot={repoRoot}
          row={openRow}
          onBack={() => setOpenRow(null)}
        />
      ) : null}
    </>
  );
}
