// The live checks behind a run's Genuine record tab.
//
// A signed run carries `signed_block_id`. We verify it live:
//   • signature  — `aura attest verify <id> --no-rekor --json` (ed25519,
//     local, offline-safe — the verdict keys on THIS so a flaky network can't
//     read as a bad signature),
//   • metadata   — `aura attest list --json` fills kind / created_at and
//     whether a public-log entry exists at all,
//   • inclusion  — `aura attest verify <id> --json` (with the public log) runs
//     only on demand, since it re-fetches the public log over the network.
//
// No fabricated trust: a failed signature reads as a failed signature with
// the real error; an unverified public entry says so plainly.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { invalidateCache, peekCache, writeCache } from "../../../lib/resourceCache";

/** Structured shape of `aura attest verify --json` (see
 *  intent_block::verify_block_structured). Every field past the verified
 *  flag is best-effort — we tolerate a thinner payload rather than break. */
export type VerifyResult = {
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
  /** Scope check — what the block DECLARED it would write vs what it ACTUALLY
   *  wrote (stamped at commit-time reconciliation), plus the set difference.
   *  `actual_writes` / `undeclared_writes` are absent until the block is
   *  reconciled, so all three are optional. */
  declared_writes?: string[];
  actual_writes?: string[];
  undeclared_writes?: string[];
};

/** One row from `aura attest list --json`. */
export type AttestListRow = {
  id: string;
  kind: string;
  created_at?: string | number | null;
  signature: boolean;
  rekor: boolean;
  human_id?: string | null;
  intent_type?: string | null;
};

export type SigPhase =
  | { kind: "loading" }
  | { kind: "verified"; result: VerifyResult }
  | { kind: "failed"; message: string };

export type InclusionPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "verified"; uuid?: string; logIndex?: number; url?: string }
  | { kind: "error"; message: string };

const verifyKey = (repoRoot: string, blockId: string) => `attest:verify:${repoRoot}:${blockId}`;
const listKey = (repoRoot: string) => `attest:list:${repoRoot}`;

export function useAttestation(repoRoot: string, blockId: string) {
  // Seeded from the last verdict this session reached for the same block, so
  // re-opening a run repaints instantly instead of shelling `aura attest` from
  // scratch. The re-verify below still runs and its answer WINS — a signature
  // verdict is never masked by a cached one, only pre-painted by it.
  const [sig, setSig] = useState<SigPhase>(() => {
    const cached = blockId ? peekCache<VerifyResult>(verifyKey(repoRoot, blockId)) : undefined;
    return cached ? { kind: "verified", result: cached } : { kind: "loading" };
  });
  const [meta, setMeta] = useState<AttestListRow | null>(() => {
    const rows = peekCache<AttestListRow[]>(listKey(repoRoot));
    return rows?.find((r) => r.id === blockId) ?? null;
  });
  const [incl, setIncl] = useState<InclusionPhase>({ kind: "idle" });

  // Signature verdict — offline-safe (--no-rekor). Errors surface verbatim.
  const verifySignature = useCallback(async () => {
    if (!blockId) {
      setSig({ kind: "failed", message: "This run has no signed block id." });
      return;
    }
    const key = verifyKey(repoRoot, blockId);
    const cached = peekCache<VerifyResult>(key);
    // Keep a previously verified result on screen while re-checking; a bare
    // "loading" here would flicker the verdict on every remount.
    setSig(cached ? { kind: "verified", result: cached } : { kind: "loading" });
    try {
      const res = await api.auraCli(repoRoot, ["attest", "verify", blockId, "--no-rekor", "--json"]);
      const trimmed = res.stdout.trim();
      if (res.status !== 0 || !trimmed) {
        // Anything short of a clean pass drops the cached pass, so the next
        // mount can't flash a green verdict this block no longer earns.
        invalidateCache(key);
        setSig({ kind: "failed", message: (res.stderr || trimmed || `exit ${res.status}`).trim() });
        return;
      }
      const parsed = JSON.parse(trimmed) as VerifyResult;
      if (parsed.signature_verified) {
        writeCache(key, parsed);
        setSig({ kind: "verified", result: parsed });
      } else {
        invalidateCache(key);
        setSig({ kind: "failed", message: "Signature did not verify." });
      }
    } catch (e) {
      invalidateCache(key);
      setSig({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }, [repoRoot, blockId]);

  // Block metadata (kind, created_at, whether a public entry exists) — the
  // facts verify doesn't carry. Best-effort; absence just omits the rows.
  useEffect(() => {
    let alive = true;
    void verifySignature();
    setIncl({ kind: "idle" });
    (async () => {
      // The ledger is one CLI call for the whole repo, so cache it per root:
      // every run's panel reads the same list, and the seeded `meta` above
      // means a remount shows "Sealed …" without waiting on it.
      try {
        const res = await api.auraCli(repoRoot, ["attest", "list", "--json"]);
        const trimmed = res.stdout.trim();
        if (!trimmed) return;
        const rows = JSON.parse(trimmed) as AttestListRow[];
        if (Array.isArray(rows)) writeCache(listKey(repoRoot), rows);
        const found = Array.isArray(rows) ? rows.find((r) => r.id === blockId) ?? null : null;
        if (alive) setMeta(found);
      } catch {
        /* metadata is enrichment only — keep whatever the cache seeded */
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoRoot, blockId, verifySignature]);

  // On-demand public-log inclusion check — re-fetches the public entry, so
  // it's explicit (network) rather than blocking the verdict.
  const checkInclusion = useCallback(async () => {
    if (!blockId) return;
    setIncl({ kind: "checking" });
    try {
      const res = await api.auraCli(repoRoot, ["attest", "verify", blockId, "--json"]);
      const trimmed = res.stdout.trim();
      if (res.status !== 0 || !trimmed) {
        setIncl({ kind: "error", message: (res.stderr || trimmed || `exit ${res.status}`).trim() });
        return;
      }
      const r = (JSON.parse(trimmed) as VerifyResult).rekor;
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

  return { sig, meta, incl, verifySignature, checkInclusion };
}
