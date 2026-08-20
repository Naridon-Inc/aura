// ProvenanceChain — the "genuine records" ledger drawn as what it actually is:
// a chain. Each time the AI changes something, Aura seals that change into a
// record — a fingerprint of what was asked and what was built, signed with a key
// only this machine holds — and every record links to the one before it. Drawn
// flat it reads like a list; drawn as a connected rail you can *see* the
// chain-of-custody, which is the whole point: the past can't be quietly
// rewritten, because breaking any old record breaks the link to it.
//
// This is a readable surface over cryptography that already exists — it invents
// nothing. A sealed record shows a locked link; one that isn't sealed shows an
// open link (we don't pretend it's safe). "Public copy" means an independent
// logbook also witnessed it. Plain words only — no hashes, no jargon on screen.

import {
  LockGlyph,
  TrustBadge,
  UnlockGlyph,
  formatAttestWhen,
  humanizeIntentType,
  shortBlockId,
} from "../workpanes/SessionAttestation";

/** One sealed record, exactly as `aura attest list --json` returns it. */
export type SealedRecord = {
  id: string;
  kind: string;
  created_at?: string | number | null;
  signature: boolean;
  rekor: boolean;
  human_id?: string | null;
  intent_type?: string | null;
};

// A single link on the chain: a locked (or open) node on a connecting rail, the
// plain title of the change it sealed, its short fingerprint, and when.
function ChainLink({
  record,
  title,
  last,
  onOpen,
}: {
  record: SealedRecord;
  title: string;
  last: boolean;
  onOpen?: () => void;
}) {
  const sealed = record.signature;
  const color = sealed ? "var(--color-accent-green)" : "var(--color-text-4)";
  const clickable = !!onOpen;

  const inner = (
    <>
      {/* The rail: a ringed lock node + the connector down to the next link. */}
      <div className="flex flex-col items-center self-stretch">
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          style={{
            color,
            background: `color-mix(in oklab, ${color} 12%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 32%, transparent)`,
          }}
        >
          {sealed ? <LockGlyph /> : <UnlockGlyph />}
        </span>
        {!last ? <span aria-hidden className="mt-1 w-px flex-1 bg-line-soft" /> : null}
      </div>

      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-base text-text-1" title={title}>
            {title}
          </span>
          {record.intent_type ? (
            <span className="shrink-0 rounded border border-line-soft px-1.5 py-0.5 text-2xs text-text-3">
              {humanizeIntentType(record.intent_type)}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-text-4">
            {formatAttestWhen(record.created_at)}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-text-4" title={record.id}>
            {shortBlockId(record.id)}
          </span>
          <span className="text-text-5">·</span>
          <TrustBadge ok={sealed} label={sealed ? "Sealed" : "Not sealed"} tone="green" />
          {record.rekor ? <TrustBadge ok label="Public copy" tone="blue" /> : null}
          {record.human_id ? (
            <span className="truncate font-mono text-2xs text-text-4" title={record.human_id}>
              {record.human_id}
            </span>
          ) : null}
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
          className="group flex w-full items-start gap-2.5 rounded px-1.5 text-left transition-colors hover:bg-state-hover"
        >
          {inner}
        </button>
      </li>
    );
  }
  return <li className="flex items-start gap-2.5 px-1.5">{inner}</li>;
}

/** The whole ledger as one connected chain, newest first. `resolveTitle` maps a
 *  record to the human headline of the run that minted it (falls back to its
 *  kind); `onOpen` drills into that run. Renders real records only. */
export function ProvenanceChain({
  records,
  resolveTitle,
  onOpen,
}: {
  records: SealedRecord[];
  resolveTitle?: (record: SealedRecord) => string | undefined;
  onOpen?: (record: SealedRecord) => void;
}) {
  return (
    <section>
      <p className="mb-3 text-sm leading-relaxed text-text-3">
        Every change the AI makes is sealed into a record and linked to the one before it, so
        the history can&apos;t be quietly rewritten. Read top-to-bottom, this is the chain.
      </p>
      <ul className="flex flex-col">
        {records.map((record, i) => {
          const title = resolveTitle?.(record) || record.kind;
          return (
            <ChainLink
              key={record.id}
              record={record}
              title={title}
              last={i === records.length - 1}
              onOpen={onOpen ? () => onOpen(record) : undefined}
            />
          );
        })}
      </ul>
    </section>
  );
}
