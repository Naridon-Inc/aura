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
// Backend: `aura attest list --json` → array of rows
//   { id, kind, created_at, signature: bool, rekor: bool,
//     human_id?: string, intent_type?: string }

import { useEffect, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { LoadingState } from "../ui/state";
import { api, type IntentRow } from "../../lib/api";
import { splitIntent } from "../workpanes/IntentProse";
import { SessionDetailPane } from "../workpanes/SessionDetailPane";
import {
  LockGlyph,
  TrustBadge,
  UnlockGlyph,
  formatAttestWhen,
  humanizeIntentType,
  shortBlockId,
} from "../workpanes/SessionAttestation";
import { ProvenanceChain, type SealedRecord } from "../provenance/ProvenanceChain";

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
  // un-clickable and falls back to its block kind for a title.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .auraIntentRecent(repoRoot)
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
        width={640}
        footer={
          <>
            <Button variant="ghost" size="xs" onClick={run} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button variant="default" size="xs" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        {error ? (
          <div role="alert" className="text-red text-[11.5px] py-2 font-mono break-words">{error}</div>
        ) : loading && rows.length === 0 ? (
          <LoadingState label="Reading sealed records…" className="justify-center py-8" />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className={`flex flex-col gap-3 ${inline ? "" : "max-h-[64vh]"}`}>
            <div className="flex items-center gap-2 text-[11.5px] text-text-2">
              <LockGlyph className="text-accent-green" />
              <span>
                <span className="text-text-1 font-medium tabular-nums">{signed}</span> sealed
              </span>
              <span className="text-text-4">·</span>
              <span>
                <span className="text-text-1 font-medium tabular-nums">{logged}</span> with a public
                copy
              </span>
              <ViewToggle view={view} onChange={setView} />
            </div>
            <div className="overflow-auto pr-1">
              {view === "chain" ? (
                <ProvenanceChain records={rows} resolveTitle={resolveTitle} onOpen={openRecord} />
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {rows.map((r) => (
                    <AttestRowItem
                      key={r.id}
                      row={r}
                      intent={byBlock[r.id] ?? null}
                      onOpen={byBlock[r.id] ? () => setOpenRow(byBlock[r.id]) : undefined}
                    />
                  ))}
                </ul>
              )}
            </div>
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

function AttestRowItem({
  row,
  intent,
  onOpen,
}: {
  row: AttestRow;
  intent: IntentRow | null;
  onOpen?: () => void;
}) {
  // Prefer the run's human intent headline; fall back to the block kind.
  const title = intent ? splitIntent(intent.intent).headline || intent.intent : row.kind;
  const clickable = !!onOpen;

  const body = (
    <>
      <span className={`shrink-0 mt-0.5 ${row.signature ? "text-accent-green" : "text-text-4"}`}>
        {row.signature ? <LockGlyph /> : <UnlockGlyph />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12.5px] text-text-1 truncate" title={title}>
            {title}
          </span>
          {row.intent_type && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-line-soft text-text-3">
              {humanizeIntentType(row.intent_type)}
            </span>
          )}
          <span className="ml-auto text-[10.5px] text-text-4 tabular-nums shrink-0">
            {formatAttestWhen(row.created_at)}
          </span>
          {clickable && (
            <span className="shrink-0 text-text-4 opacity-0 transition-opacity group-hover:opacity-100">
              <ChevronRight />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="font-mono text-[10.5px] text-text-4" title={row.id}>
            {shortBlockId(row.id)}
          </span>
          <span className="text-text-5">·</span>
          <TrustBadge ok={row.signature} label={row.signature ? "Sealed" : "Not sealed"} tone="green" />
          {row.rekor && <TrustBadge ok label="Public copy" tone="blue" />}
          {row.human_id && (
            <span className="text-[10px] text-text-4 font-mono truncate" title={row.human_id}>
              {row.human_id}
            </span>
          )}
        </div>
      </div>
    </>
  );

  if (clickable) {
    return (
      <li>
        <button
          type="button"
          onClick={onOpen}
          title="Open the change this record came from"
          className="group flex w-full items-start gap-2.5 px-2.5 py-2 rounded border border-line-soft bg-bg-1 text-left transition-colors hover:bg-bg-2/60"
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2.5 px-2.5 py-2 rounded border border-line-soft bg-bg-1">
      {body}
    </li>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: LedgerView;
  onChange: (v: LedgerView) => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-0.5 rounded-md border border-line-soft p-0.5">
      {(["chain", "list"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded px-2 py-0.5 text-[10.5px] capitalize transition-colors ${
            view === v ? "bg-bg-2 text-text-1" : "text-text-4 hover:text-text-2"
          }`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

function ChevronRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="text-text-3 text-[11.5px] py-8 px-6 text-center max-w-md mx-auto leading-relaxed">
      No sealed records yet. Each time the AI makes a change, Aura seals it — a tamper-proof record
      of exactly what happened, so nobody can quietly alter the history later. Some are also kept in
      an independent public logbook. Make a change to start the record.
    </div>
  );
}
