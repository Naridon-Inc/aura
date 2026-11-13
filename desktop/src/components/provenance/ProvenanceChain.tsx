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

import { Lock, LockOpen } from "lucide-react";

import { TraceMark } from "../ui/trace-list";
import { TraceStoryIntro } from "../ui/trace-story";
import { TraceTimeline, TraceTimelineEntry } from "../ui/trace-timeline";
import {
  formatAttestWhen,
  humanizeIntentType,
  shortBlockId,
} from "../workpanes/SessionAttestation";
import "../ui/attestations.css";

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

/** The lock a record wears: shut when sealed, open when not. */
export function SealMark({ record }: { record: SealedRecord }) {
  return record.signature ? (
    <Lock size={14} aria-label="Sealed" className="ui-seal" data-sealed="" />
  ) : (
    <LockOpen size={14} aria-label="Not sealed" className="ui-seal" />
  );
}

/** The quiet marks after a record's title: whether it is sealed, whether an
 *  outside logbook holds a copy, and the kind of change it sealed. `brief`
 *  keeps only the one that changes what the reader does — a record that is
 *  not sealed — for a row too narrow to carry all three beside its title. */
export function RecordMarks({ record, brief }: { record: SealedRecord; brief?: boolean }) {
  if (brief) {
    return record.signature ? null : <TraceMark tone="danger">Not sealed</TraceMark>;
  }
  return (
    <>
      {record.signature ? (
        <TraceMark tone="good">Sealed</TraceMark>
      ) : (
        <TraceMark tone="danger">Not sealed</TraceMark>
      )}
      {record.rekor && (
        <TraceMark title="An independent public logbook also holds this record">
          Public copy
        </TraceMark>
      )}
      {record.intent_type && <TraceMark>{humanizeIntentType(record.intent_type)}</TraceMark>}
    </>
  );
}

/** The whole ledger as one connected chain, newest first, on the shared
 *  timeline: each record is a moment, its seal and fingerprint under the
 *  title. `resolveTitle` maps a record to the human headline of the run that
 *  minted it (falls back to its kind); `onOpen` drills into that run, and a
 *  record with no run behind it stays a read-only point on the line. */
export function ProvenanceChain({
  records,
  resolveTitle,
  canOpen,
  onOpen,
}: {
  records: SealedRecord[];
  resolveTitle?: (record: SealedRecord) => string | undefined;
  canOpen?: (record: SealedRecord) => boolean;
  onOpen?: (record: SealedRecord) => void;
}) {
  return (
    <section className="ui-chain">
      <TraceStoryIntro>
        Every change the AI makes is sealed into a record and linked to the one before it, so
        the history can&apos;t be quietly rewritten. Read top to bottom, this is the chain.
      </TraceStoryIntro>
      <TraceTimeline label="Sealed records">
        {records.map((record) => {
          const openable = onOpen && (canOpen ? canOpen(record) : true);
          return (
            <TraceTimelineEntry
              key={record.id}
              title={resolveTitle?.(record) || record.kind}
              onSelect={openable ? () => onOpen(record) : undefined}
              detail={
                <>
                  <SealMark record={record} />
                  <span>{formatAttestWhen(record.created_at)}</span>
                  <span aria-hidden>·</span>
                  <span className="ui-chain-id" title={record.human_id || record.id}>
                    {shortBlockId(record.id)}
                  </span>
                  <RecordMarks record={record} />
                </>
              }
            />
          );
        })}
      </TraceTimeline>
    </section>
  );
}
