// SessionAttestation — the "Attestation" tab of a session detail: the
// cryptographic trust posture of THIS run's signed intent block, rendered
// in the same calm spec-sheet language as the Summary tab (verdict-first,
// then the facts on demand). It folds the former standalone Attestations
// dialog into the run it belongs to, the way the Intent↔AST page folded
// into the Alignment tab.
//
// A signed run carries `signed_block_id`. We verify it live:
//   • signature  — `aura attest verify <id> --no-rekor --json` (ed25519,
//     local, offline-safe — the hero keys on THIS so a flaky network can't
//     read as a bad signature),
//   • metadata   — `aura attest list --json` fills kind / created_at and
//     whether a Rekor transparency-log entry exists at all,
//   • inclusion  — `aura attest verify <id> --json` (with Rekor) runs only
//     on demand, since it re-fetches the public log over the network.
//
// No fabricated trust: a failed signature reads as a failed signature with
// the real error; an unverified Rekor entry says so plainly.
//
// The presentational atoms (lock glyphs, trust badge, id/when formatters)
// are exported so the global Attestations ledger shares one visual language.

import { useCallback, useEffect, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import type { ReactNode } from "react";
import { api } from "../../lib/api";
import { Button } from "../ui/button";

/** Structured shape of `aura attest verify --json` (see
 *  intent_block::verify_block_structured). Every field past the verified
 *  flag is best-effort — we tolerate a thinner payload rather than break. */
type VerifyResult = {
  signature_verified?: boolean;
  block_id?: string;
  algo?: string;
  key_id?: string;
  human_id?: string;
  intent_type?: string;
  recovered_via_chain?: {
    target_key_id?: string;
    local_key_id?: string;
    hop_count?: number;
    auto_pulled_from_cloud?: boolean;
  };
  rekor?: {
    status?: "verified" | "none" | "skipped" | "error";
    uuid?: string;
    log_index?: number;
    rekor_url?: string;
    error?: string;
  };
};

/** One row from `aura attest list --json`. */
type AttestListRow = {
  id: string;
  kind: string;
  created_at?: string | number | null;
  signature: boolean;
  rekor: boolean;
  human_id?: string | null;
  intent_type?: string | null;
};

type SigPhase =
  | { kind: "loading" }
  | { kind: "verified"; result: VerifyResult }
  | { kind: "failed"; message: string };

type InclusionPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "verified"; uuid?: string; logIndex?: number; url?: string }
  | { kind: "error"; message: string };

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
  const [sig, setSig] = useState<SigPhase>({ kind: "loading" });
  const [meta, setMeta] = useState<AttestListRow | null>(null);
  const [incl, setIncl] = useState<InclusionPhase>({ kind: "idle" });

  // Signature verdict — offline-safe (--no-rekor). Errors surface verbatim.
  const verifySignature = useCallback(async () => {
    if (!blockId) {
      setSig({ kind: "failed", message: "This run has no signed block id." });
      return;
    }
    setSig({ kind: "loading" });
    try {
      const res = await api.auraCli(repoRoot, [
        "attest",
        "verify",
        blockId,
        "--no-rekor",
        "--json",
      ]);
      const trimmed = res.stdout.trim();
      if (res.status !== 0 || !trimmed) {
        setSig({
          kind: "failed",
          message: (res.stderr || trimmed || `exit ${res.status}`).trim(),
        });
        return;
      }
      const parsed = JSON.parse(trimmed) as VerifyResult;
      if (parsed.signature_verified) {
        setSig({ kind: "verified", result: parsed });
      } else {
        setSig({ kind: "failed", message: "Signature did not verify." });
      }
    } catch (e) {
      setSig({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [repoRoot, blockId]);

  // Block metadata (kind, created_at, whether a Rekor entry exists) — the
  // facts verify doesn't carry. Best-effort; absence just omits the rows.
  useEffect(() => {
    let alive = true;
    void verifySignature();
    setIncl({ kind: "idle" });
    (async () => {
      try {
        const res = await api.auraCli(repoRoot, ["attest", "list", "--json"]);
        const trimmed = res.stdout.trim();
        if (!trimmed) return;
        const rows = JSON.parse(trimmed) as AttestListRow[];
        const found = Array.isArray(rows)
          ? rows.find((r) => r.id === blockId) ?? null
          : null;
        if (alive) setMeta(found);
      } catch {
        /* metadata is enrichment only */
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoRoot, blockId, verifySignature]);

  // On-demand transparency-log inclusion check — re-fetches the public Rekor
  // entry, so it's explicit (network) rather than blocking the verdict.
  const checkInclusion = useCallback(async () => {
    if (!blockId) return;
    setIncl({ kind: "checking" });
    try {
      const res = await api.auraCli(repoRoot, ["attest", "verify", blockId, "--json"]);
      const trimmed = res.stdout.trim();
      if (res.status !== 0 || !trimmed) {
        setIncl({
          kind: "error",
          message: (res.stderr || trimmed || `exit ${res.status}`).trim(),
        });
        return;
      }
      const parsed = JSON.parse(trimmed) as VerifyResult;
      const r = parsed.rekor;
      if (r?.status === "verified") {
        setIncl({ kind: "verified", uuid: r.uuid, logIndex: r.log_index, url: r.rekor_url });
      } else if (r?.status === "none") {
        setIncl({ kind: "error", message: "No transparency-log entry on this block." });
      } else {
        setIncl({ kind: "error", message: r?.error || `inclusion status: ${r?.status ?? "unknown"}` });
      }
    } catch (e) {
      setIncl({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [repoRoot, blockId]);

  const result = sig.kind === "verified" ? sig.result : null;
  const effectiveKey = result?.key_id ?? keyId ?? null;
  const effectiveType = result?.intent_type ?? meta?.intent_type ?? intentType ?? null;
  const human = result?.human_id ?? meta?.human_id ?? null;
  const chain = result?.recovered_via_chain ?? null;
  const hasRekorEntry = meta?.rekor ?? false;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 py-4">
        {/* Verdict hero — plain meaning first: is this a true, unaltered
            record of what happened? The crypto is the how, not the headline. */}
        <VerdictHero phase={sig} onReverify={() => void verifySignature()} />

        {/* What was sealed — the plain facts a non-engineer cares about. The
            raw block id / key / algorithm hide under "Technical details". */}
        <section>
          <div className="mb-2.5">
            <SectionLabel>What was sealed</SectionLabel>
          </div>
          <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
            <MetaRow label="What changed">
              {effectiveType ? (
                humanizeIntentType(effectiveType)
              ) : (
                <span className="text-text-3">What the AI changed in this run</span>
              )}
            </MetaRow>
            {meta?.created_at != null ? (
              <MetaRow label="Sealed">{formatAttestWhen(meta.created_at)} ago</MetaRow>
            ) : null}
            {human ? (
              <MetaRow label="Signed by">
                <span className="text-text-1">{human}</span>
              </MetaRow>
            ) : null}
          </div>
          <TechnicalDetails
            blockId={blockId}
            algo={result?.algo ?? "ed25519"}
            keyId={effectiveKey}
            chain={chain}
          />
        </section>

        {/* Public witness — the optional, independent copy. Framed as an extra
            witness ("not just Aura's word"), not "Rekor transparency log". */}
        <section>
          <div className="mb-2.5">
            <SectionLabel>Public witness</SectionLabel>
          </div>
          <div className="overflow-hidden rounded-lg border border-line-soft bg-bg-1">
            <div className="flex items-start gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <Inclusion
                  phase={incl}
                  hasEntry={hasRekorEntry}
                  metaKnown={meta !== null}
                />
              </div>
              {(hasRekorEntry || incl.kind !== "idle") && (
                <Button
                  variant="outline"
                  size="xs"
                  type="button"
                  onClick={() => void checkInclusion()}
                  disabled={incl.kind === "checking"}
                  className="shrink-0 text-[11px] text-text-3 hover:text-text-1"
                >
                  {incl.kind === "checking" ? "Checking…" : "Check now"}
                </Button>
              )}
            </div>
          </div>
        </section>

        {/* Quiet footer — what this whole thing is, in plain words. */}
        <p className="max-w-[560px] text-[11.5px] leading-relaxed text-text-4">
          Every change the AI makes here is sealed the moment it happens, so you always have
          a true record of what happened that can&apos;t be quietly altered later. Aura checks
          the seal right on your own computer — it works even offline. The public witness is an
          extra, optional copy kept in an independent logbook.
        </p>
      </div>
    </div>
  );
}

/** Canonical intent types → everyday words. Falls back to the raw value
 *  (title-cased) so an unknown tag still reads cleanly. Exported so the
 *  repo-wide ledger labels its rows in the same plain language. */
export function humanizeIntentType(type: string): string {
  const map: Record<string, string> = {
    FeatureAdd: "A new feature",
    BugFix: "A bug fix",
    Refactor: "Code cleanup",
    Revert: "An undo of earlier work",
    Performance: "A speed-up",
    Docs: "Documentation",
    Deps: "Dependency updates",
  };
  if (map[type]) return map[type];
  // CamelCase / snake_case → spaced words, first letter up.
  const spaced = type
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : type;
}

/** The crypto facts, available but never the headline — one click away for
 *  the few who want the block id / key / algorithm. */
function TechnicalDetails({
  blockId,
  algo,
  keyId,
  chain,
}: {
  blockId: string;
  algo: string;
  keyId: string | null;
  chain: VerifyResult["recovered_via_chain"] | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="xs"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="gap-1.5 px-0 text-[11px] text-text-4 hover:text-text-2"
      >
        <Caret open={open} />
        Technical details
      </Button>
      {open ? (
        <div className="mt-2 overflow-hidden rounded-lg border border-line-soft bg-bg-1">
          <MetaRow label="Record ID">
            <span className="font-mono text-[12px] text-text-2 break-all">{blockId || "—"}</span>
          </MetaRow>
          <MetaRow label="Method">
            {algo} signature, checked on this computer
          </MetaRow>
          <MetaRow label="Key">
            {keyId ? (
              <span className="font-mono text-[12px] text-text-2">{keyId}</span>
            ) : (
              <span className="text-text-3">—</span>
            )}
          </MetaRow>
          {chain ? (
            <MetaRow label="Key history">
              <span className="text-text-2">
                Recovered through {chain.hop_count ?? "?"}{" "}
                {chain.hop_count === 1 ? "key change" : "key changes"}
                {chain.auto_pulled_from_cloud ? (
                  <span className="text-text-3"> · pulled from the cloud</span>
                ) : null}
              </span>
            </MetaRow>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// ── Verdict hero ─────────────────────────────────────────────────────────

function VerdictHero({ phase, onReverify }: { phase: SigPhase; onReverify: () => void }) {
  // Plain meaning leads; the cryptographic error (when one exists) is demoted
  // to a small secondary line so a raw "exit 2" never becomes the headline.
  //
  // A calm, neutral card in the same language as the rest of the surface —
  // no colored fill, no filled status dot. A closed lock carries "sealed /
  // genuine"; an open lock carries "couldn't verify". Color is held back for
  // the one case that genuinely needs the alarm: a failed check.
  const failed = phase.kind === "failed";
  const loading = phase.kind === "loading";
  const label = failed
    ? "Couldn't verify the seal"
    : loading
      ? "Checking the seal…"
      : "Genuine record";
  const msg = failed
    ? "Aura couldn't confirm this record is intact — it may have been changed, or the check couldn't run. Don't rely on this history until it verifies."
    : loading
      ? "Making sure nothing in this record has been altered."
      : "This is a true record of what the AI changed here, sealed the moment it happened. Aura just re-checked the seal on your own computer — it's intact, so nothing in this history has been altered or faked.";
  const detail = failed && phase.kind === "failed" ? phase.message : undefined;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-3">
      <div className="flex items-center gap-2.5">
        <span
          className={
            failed ? "text-red" : loading ? "text-text-4 animate-pulse" : "text-text-2"
          }
        >
          {failed ? <UnlockGlyph /> : <LockGlyph />}
        </span>
        <span
          className="text-[13px] font-semibold text-text-1"
          style={failed ? { color: "var(--color-red)" } : undefined}
        >
          {label}
        </span>
        {!loading ? (
          <Button
            variant="outline"
            size="xs"
            type="button"
            onClick={onReverify}
            className="ml-auto text-[11px] text-text-3 hover:text-text-1"
          >
            Check again
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5 text-[12.5px] leading-snug text-text-2">{msg}</div>
      {detail ? (
        <div className="mt-1.5 break-words font-mono text-[11px] leading-snug text-text-4">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

// Public-witness status line — plain framing for the optional, independent
// copy. Reflects the on-demand check, falling back to whether the record
// carries a public entry at all. ("Rekor" / "transparency log" stay out of
// the user's face; the link still goes to the real public record.)
function Inclusion({
  phase,
  hasEntry,
  metaKnown,
}: {
  phase: InclusionPhase;
  hasEntry: boolean;
  metaKnown: boolean;
}) {
  if (phase.kind === "verified") {
    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-[12.5px] text-text-1">
          <Tick />
          Confirmed in a public logbook — an independent witness
        </span>
        <span className="font-mono text-[10.5px] text-text-4">
          {phase.logIndex != null ? `#${phase.logIndex} · ` : ""}
          {phase.uuid ? `${phase.uuid.slice(0, 18)}…` : ""}
        </span>
        {phase.url ? (
          <a
            href={phase.url}
            target="_blank"
            rel="noreferrer"
            onClick={onExternalAnchorClick}
            className="text-[11px] text-accent hover:underline"
          >
            View the public record →
          </a>
        ) : null}
      </div>
    );
  }
  if (phase.kind === "error") {
    return (
      <span className="flex items-start gap-2 text-[12px] text-text-2">
        <span className="mt-px text-[11px]" style={{ color: "var(--color-amber)" }}>
          ⚠
        </span>
        <span className="min-w-0 break-words">
          Couldn&apos;t check the public copy —{" "}
          <span className="font-mono text-text-3">{phase.message}</span>
        </span>
      </span>
    );
  }
  if (phase.kind === "checking") {
    return <span className="text-[12.5px] text-text-3">Checking the public logbook…</span>;
  }
  // idle
  if (hasEntry) {
    return (
      <span className="flex items-center gap-2 text-[12.5px] text-text-1">
        <Tick muted />
        Posted to a public logbook
        <span className="text-[11px] text-text-4">— check now to confirm it&apos;s there</span>
      </span>
    );
  }
  return (
    <span className="text-[12.5px] text-text-3">
      {metaKnown
        ? "Kept only on your computer — no public copy (that's optional)"
        : "Public copy status unknown"}
    </span>
  );
}

/** A small monochrome check — replaces the old filled colored status dot so a
 *  confirmed witness reads as calm confirmation, not a loud green circle. */
function Tick({ muted }: { muted?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={`shrink-0 ${muted ? "text-text-4" : "text-text-2"}`}
    >
      <path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// ── Shared spec-sheet atoms (match SessionSummary's design language) ──────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">{children}</h2>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-b-0">
      <span className="w-[92px] shrink-0 pt-px text-[11px] uppercase tracking-wide text-text-3">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-text-1">{children}</span>
    </div>
  );
}

// ── Exported atoms — reused by the global Attestations ledger so the two
//    surfaces speak one visual language. ───────────────────────────────────

/** A trust badge (Signed / Transparency log), toned green or blue, dimmed
 *  when the property is absent. */
export function TrustBadge({
  ok,
  label,
  tone,
}: {
  ok: boolean;
  label: string;
  tone: "green" | "blue";
}) {
  const color = !ok
    ? "var(--color-text-4)"
    : tone === "green"
      ? "var(--color-accent-green)"
      : "var(--color-blue)";
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
      style={{
        color,
        border: `1px solid color-mix(in oklab, ${color} 40%, transparent)`,
        background: `color-mix(in oklab, ${color} 8%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

export function LockGlyph({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function UnlockGlyph({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5a2.5 2.5 0 014.9-.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Compress a long block id to head…tail. */
export function shortBlockId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

/** Render `created_at` (unix seconds, unix millis, or ISO) as a short
 *  relative stamp, falling back to an absolute date for older entries. */
export function formatAttestWhen(value?: string | number | null): string {
  if (value == null) return "";
  let ms: number;
  if (typeof value === "number") {
    ms = value < 1e12 ? value * 1000 : value;
  } else {
    const asNum = Number(value);
    if (!Number.isNaN(asNum) && value.trim() !== "") {
      ms = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      ms = Date.parse(value);
    }
  }
  if (Number.isNaN(ms)) return typeof value === "string" ? value : "";
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
