// SessionAttestation — the Genuine record tab of a session detail: whether
// THIS run's signed record is intact, drawn as the same report column as the
// Summary and Alignment tabs (a verdict line, then quiet sections).
//
//   • Verdict        — is the seal intact? (checked offline, on this machine)
//   • What was sealed — the plain facts, with the raw ids one click down
//   • Scope check    — the files the AI said it would touch vs what it touched
//   • Public witness — the optional independent copy, checked on demand
//
// The live checks live in `useAttestation`; the formatters are shared with the
// repo-wide ledger and the provenance chain and re-exported from here, the
// path those surfaces already import.

import { TraceReport } from "../ui/trace-report";
import {
  PublicWitness,
  ScopeCheck,
  SealVerdict,
  SealedFacts,
} from "./sessionAttestation/AttestationParts";
import {
  formatAttestWhen,
  humanizeIntentType,
  sealedPhrase,
} from "./sessionAttestation/attestFormat";
import { useAttestation } from "./sessionAttestation/useAttestation";
import "../ui/attestations.css";

export {
  formatAttestWhen,
  humanizeIntentType,
  shortBlockId,
} from "./sessionAttestation/attestFormat";

export function SessionAttestation({
  repoRoot,
  blockId,
  keyId,
  intentType,
}: {
  repoRoot: string;
  /** The run's `signed_block_id` — the durable key into `.aura/blocks/`. */
  blockId: string;
  /** The run's logged `key_id`, used as a fallback before verify resolves. */
  keyId?: string | null;
  /** The run's logged `intent_type`, shown until verify confirms it. */
  intentType?: string | null;
}) {
  const { sig, meta, incl, verifySignature, checkInclusion } = useAttestation(repoRoot, blockId);

  const result = sig.kind === "verified" ? sig.result : null;
  const type = result?.intent_type ?? meta?.intent_type ?? intentType ?? null;
  // Formatted once here, so a stamp we cannot read drops the whole row
  // instead of rendering a bare " ago" next to nothing.
  const when = formatAttestWhen(meta?.created_at);

  return (
    <TraceReport>
      <SealVerdict phase={sig} />
      <SealedFacts
        what={type ? humanizeIntentType(type) : null}
        sealed={when ? sealedPhrase(when) : null}
        signedBy={result?.human_id ?? meta?.human_id ?? null}
        checking={sig.kind === "loading"}
        onReverify={() => void verifySignature()}
        blockId={blockId}
        algo={result?.algo ?? "ed25519"}
        keyId={result?.key_id ?? keyId ?? null}
        chain={result?.recovered_via_chain ?? null}
      />
      {/* Only once the block is reconciled — older blocks carry no scope
          data, so the section is left out rather than invented. */}
      {result?.declared_writes != null && result?.actual_writes != null && (
        <ScopeCheck
          declared={result.declared_writes}
          actual={result.actual_writes}
          undeclared={result.undeclared_writes ?? []}
        />
      )}
      <PublicWitness
        phase={incl}
        hasEntry={meta?.rekor ?? false}
        metaKnown={meta !== null}
        onCheck={() => void checkInclusion()}
      />
      <p className="ui-trace-report-note">
        Every change the AI makes here is sealed the moment it happens, so you always have a true
        record of what happened that can’t be quietly altered later. Aura checks the seal right on
        your own computer, even offline. The public witness is an extra, optional copy kept in an
        independent logbook.
      </p>
    </TraceReport>
  );
}
