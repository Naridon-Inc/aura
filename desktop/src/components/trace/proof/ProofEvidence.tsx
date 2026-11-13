// The evidence column beside a commit: one line saying where its proof
// stands, the facts the manifest carries, and the button that asks the CLI to
// check the signature.

import { Button } from "../../ui/button";
import { TraceFact } from "../../ui/trace-detail";
import { TraceVerdict } from "../../ui/trace-report";
import { statusHint, statusTone, type ManifestRecord } from "./proofManifest";

export function ProofEvidence({
  record,
  onVerify,
}: {
  record: ManifestRecord;
  onVerify?: () => void;
}) {
  const verdict = (
    <TraceVerdict tone={statusTone(record.status)} title={statusHint(record.status)}>
      {record.path
        ? null
        : record.status === "checking"
          ? "Looking for this commit’s evidence…"
          : "No signed evidence found for this commit. You can still review the diff, but Aura cannot verify who produced this change yet."}
    </TraceVerdict>
  );
  return (
    <aside className="ui-proof-evidence" aria-label="Trust evidence">
      <div className="ui-proof-evidence-title">Trust evidence</div>
      <div className="ui-proof-evidence-body">
        {verdict}
        {record.path ? (
          <>
            <div className="ui-proof-facts">
              <TraceFact label="Evidence file" title={record.path}>
                {record.path.split("/").pop() ?? "?"}
              </TraceFact>
              <TraceFact label="Identity" title={record.identity ?? undefined}>
                {record.identity ?? "—"}
              </TraceFact>
              <TraceFact label="Task hash" title={record.intent_hash ?? undefined}>
                <code>{record.intent_hash ?? "—"}</code>
              </TraceFact>
              <TraceFact label="Code hash" title={record.ast_hash ?? undefined}>
                <code>{record.ast_hash ?? "—"}</code>
              </TraceFact>
            </div>
            {record.detail ? (
              <pre className="ui-proof-detail" data-tone={record.status}>
                {record.detail}
              </pre>
            ) : null}
            <Button
              variant="outline"
              size="xs"
              disabled={record.status === "verifying" || !onVerify}
              onClick={onVerify}
            >
              {record.status === "verifying" ? "Verifying…" : "Verify evidence"}
            </Button>
          </>
        ) : null}
      </div>
    </aside>
  );
}
