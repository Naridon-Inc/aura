// The sections of a run's Genuine record tab, drawn with the report pieces
// the Summary and Alignment tabs use: the seal as the verdict line, then
// quiet sections of facts and items. Plain meaning leads; the crypto (block
// id, key, algorithm) sits one click down under Technical details.

import { useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Lock, LockOpen, RefreshCw } from "lucide-react";
import { openExternal } from "../../../lib/openExternal";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { TraceFact } from "../../ui/trace-detail";
import { TraceItem, TraceItems, TraceLine, TraceSection, TraceVerdict } from "../../ui/trace-report";
import type { InclusionPhase, SigPhase, VerifyResult } from "./useAttestation";

/** Is this a true, unaltered record of what happened? The crypto is the how,
 *  not the headline — a raw "exit 2" sits under the sentence, never in it. */
export function SealVerdict({ phase }: { phase: SigPhase }) {
  if (phase.kind === "loading") {
    return (
      <TraceVerdict tone="muted" icon={<AsciiSpinner size={12} />} title="Checking the seal…">
        Making sure nothing in this record has been altered.
      </TraceVerdict>
    );
  }
  if (phase.kind === "failed") {
    return (
      <TraceVerdict tone="bad" icon={<LockOpen />} title="Couldn’t verify the seal">
        Aura couldn’t confirm this record is intact. It may have been changed, or the check
        couldn’t run. Don’t rely on this history until it verifies.
        <code className="ui-attest-error">{phase.message}</code>
      </TraceVerdict>
    );
  }
  return (
    <TraceVerdict tone="good" icon={<Lock />} title="Genuine record">
      This is a true record of what the AI changed here, sealed the moment it happened. Aura just
      re-checked the seal on your own computer. It’s intact, so nothing in this history has been
      altered or faked.
    </TraceVerdict>
  );
}

/** What was sealed — the plain facts a non-engineer cares about, with the
 *  re-check on the section's edge and the raw ids under Technical details. */
export function SealedFacts({
  what,
  sealed,
  signedBy,
  checking,
  onReverify,
  blockId,
  algo,
  keyId,
  chain,
}: {
  what: string | null;
  sealed: string | null;
  signedBy: string | null;
  checking: boolean;
  onReverify: () => void;
  blockId: string;
  algo: string;
  keyId: string | null;
  chain: VerifyResult["recovered_via_chain"] | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <TraceSection
      title="What was sealed"
      trailing={
        checking ? null : (
          <Button variant="ghost" size="sm" type="button" onClick={onReverify}>
            <RefreshCw />
            Check again
          </Button>
        )
      }
    >
      <TraceFact label="What changed">
        {what ?? <span className="ui-trace-fact-aside">What the AI changed in this run</span>}
      </TraceFact>
      {sealed && <TraceFact label="Sealed">{sealed}</TraceFact>}
      {signedBy && <TraceFact label="Signed by">{signedBy}</TraceFact>}
      <div className="ui-attest-more">
        <Button
          variant="ghost"
          size="xs"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          Technical details
        </Button>
        {open && (
          <div>
            <TraceFact label="Record ID">
              <span className="ui-trace-fact-code">{blockId || "—"}</span>
            </TraceFact>
            <TraceFact label="Method">{algo} signature, checked on this computer</TraceFact>
            <TraceFact label="Key">
              {keyId ? (
                <span className="ui-trace-fact-code">{keyId}</span>
              ) : (
                <span className="ui-trace-fact-aside">Not recorded</span>
              )}
            </TraceFact>
            {chain && (
              <TraceFact label="Key history">
                Recovered through {chain.hop_count ?? "?"}{" "}
                {chain.hop_count === 1 ? "key change" : "key changes"}
                {chain.auto_pulled_from_cloud && (
                  <span className="ui-trace-fact-aside">· pulled from the cloud</span>
                )}
              </TraceFact>
            )}
          </div>
        )}
      </div>
    </TraceSection>
  );
}

/** The visible half of "did the AI do only what it said it would?". Before it
 *  edits, the agent declares which files it will touch; at commit time Aura
 *  stamps what it ACTUALLY touched, and the set difference is the catch.
 *  A note, never an alarm: the change is kept, but nothing the AI didn't
 *  mention slips past unseen. */
export function ScopeCheck({
  declared,
  actual,
  undeclared,
}: {
  declared: string[];
  actual: string[];
  undeclared: string[];
}) {
  const caught = undeclared.length > 0;
  return (
    <TraceSection title="Scope check">
      <TraceItems>
        {caught ? (
          <TraceItem tone="warn" title="A change reached beyond the plan">
            <TraceLine>
              Before this change, the AI said it would touch <FileList files={declared} />. It also
              changed <FileList files={undeclared} outside />,{" "}
              {undeclared.length === 1 ? "a file" : "files"} it didn’t mention. Aura caught it.
              The change was kept; now you know it happened.
            </TraceLine>
          </TraceItem>
        ) : (
          <TraceItem tone="good" title="Stayed in scope">
            <TraceLine>
              The AI changed exactly the {actual.length === 1 ? "file" : "files"} it said it
              would: <FileList files={actual} />. Nothing extra slipped in.
            </TraceLine>
          </TraceItem>
        )}
      </TraceItems>
    </TraceSection>
  );
}

/** File names joined with commas and a trailing "and", in mono so they read
 *  as literal files; the out-of-scope ones wear the warning colour. */
function FileList({ files, outside }: { files: string[]; outside?: boolean }) {
  if (files.length === 0) return <>nothing</>;
  return (
    <>
      {files.map((f, i) => (
        <span key={f}>
          {i > 0 ? (i === files.length - 1 ? " and " : ", ") : ""}
          <code className="ui-attest-file" data-outside={outside || undefined}>
            {f}
          </code>
        </span>
      ))}
    </>
  );
}

/** The optional, independent copy — framed as an extra witness ("not just
 *  Aura's word"), not by the log's name. The check re-fetches the public
 *  entry over the network, so it runs only when asked. */
export function PublicWitness({
  phase,
  hasEntry,
  metaKnown,
  onCheck,
}: {
  phase: InclusionPhase;
  hasEntry: boolean;
  metaKnown: boolean;
  onCheck: () => void;
}) {
  const canCheck = hasEntry || phase.kind !== "idle";
  return (
    <TraceSection
      title="Public witness"
      trailing={
        canCheck ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={onCheck}
            disabled={phase.kind === "checking"}
          >
            {phase.kind === "checking" ? "Checking…" : "Check now"}
          </Button>
        ) : null
      }
    >
      <TraceItems>
        <WitnessItem phase={phase} hasEntry={hasEntry} metaKnown={metaKnown} />
      </TraceItems>
    </TraceSection>
  );
}

function WitnessItem({
  phase,
  hasEntry,
  metaKnown,
}: {
  phase: InclusionPhase;
  hasEntry: boolean;
  metaKnown: boolean;
}) {
  if (phase.kind === "verified") {
    const ref = [
      phase.logIndex != null ? `#${phase.logIndex}` : "",
      phase.uuid ? `${phase.uuid.slice(0, 18)}…` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <TraceItem
        tone="good"
        title="Confirmed in a public logbook"
        actions={
          phase.url ? (
            <Button
              variant="outline"
              size="xs"
              type="button"
              onClick={() => void openExternal(phase.url)}
            >
              View the public record
              <ArrowUpRight />
            </Button>
          ) : null
        }
      >
        <TraceLine>An independent witness holds a copy, so this isn’t only Aura’s word.</TraceLine>
        {ref && (
          <TraceLine tone="note">
            <code className="ui-attest-file">{ref}</code>
          </TraceLine>
        )}
      </TraceItem>
    );
  }
  if (phase.kind === "error") {
    return (
      <TraceItem tone="warn" title="Couldn’t check the public copy">
        <TraceLine tone="warn">{phase.message}</TraceLine>
      </TraceItem>
    );
  }
  if (phase.kind === "checking") {
    return <TraceItem tone="muted" title="Checking the public logbook…" />;
  }
  if (hasEntry) {
    return (
      <TraceItem tone="muted" title="Posted to a public logbook">
        <TraceLine>Check now to confirm it’s there.</TraceLine>
      </TraceItem>
    );
  }
  return metaKnown ? (
    <TraceItem tone="muted" title="Kept only on your computer">
      <TraceLine>There’s no public copy. That’s optional.</TraceLine>
    </TraceItem>
  ) : (
    <TraceItem tone="muted" title="Public copy status unknown" />
  );
}
