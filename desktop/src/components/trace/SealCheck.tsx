// The seal on a team change, as a mark that can be checked in place.
//
// Three honest states:
//   · signed (unchecked) — the shared log says a signed block exists; the mark
//     claims nothing more. Pressing it runs `aura attest verify --no-rekor`
//     right here, offline-safe.
//   · Genuine record — the signature verified. When it verified against the
//     team key registry the mark names the teammate: their key, your machine
//     — the cross-machine proof, not a local echo.
//   · Couldn't verify — the real error, never softened; pressing retries.
// Lazy by design: nothing verifies until asked, so a 200-row feed never shells
// 200 CLI calls. Without a repoRoot (a host with no project) it stays a static
// mark with no action behind it.

import { useCallback, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { invalidateCache, peekCache, writeCache } from "../../lib/resourceCache";
import { TraceMark } from "../ui/trace-list";

/** Minimal shape of `aura attest verify --json` this mark reads — the verdict
 *  plus who/how it verified. SessionAttestation parses the full payload; both
 *  surfaces share one cache entry per block, so a check made on either
 *  pre-paints the other. */
type SealVerifyResult = {
  signature_verified?: boolean;
  /** "local" | "team-registry" | "rotation-chain" — how the key was trusted. */
  verified_via?: string;
  /** Present when the block verified against a TEAMMATE's registered key —
   *  the cross-machine case, with the human identity the registry carries. */
  verified_via_team?: {
    display_name?: string | null;
    github_login?: string | null;
    human_id?: string | null;
  };
};

type SealState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "verified"; via: string; teamName: string | null }
  | { kind: "failed"; message: string };

function sealVerdict(parsed: SealVerifyResult): SealState {
  const team = parsed.verified_via_team;
  return {
    kind: "verified",
    via: parsed.verified_via || "local",
    teamName: team?.display_name || team?.github_login || team?.human_id || null,
  };
}

/** The plain sentence behind a verified mark — says HOW the seal was trusted,
 *  because "verified with my own key" and "verified against a teammate's
 *  registered key on my machine" are different claims. */
function sealVerifiedTitle(check: Extract<SealState, { kind: "verified" }>): string {
  if (check.via === "team-registry") {
    return check.teamName
      ? `Genuine record — sealed by ${check.teamName} and verified on your machine against your team's key registry.`
      : "Genuine record — verified on your machine against your team's key registry.";
  }
  if (check.via === "rotation-chain") {
    return "Genuine record — verified through your key-rotation history.";
  }
  return "Genuine record — the seal verifies with your own key on this machine.";
}

export function SealCheck({
  repoRoot,
  blockId,
  spelled,
}: {
  repoRoot?: string;
  blockId: string;
  /** Spell "Signed" on the mark. On a feed where every change is signed the
   *  header says so once, and each row keeps only the glyph — still an action
   *  (check this seal), never the same word repeated down the list. */
  spelled: boolean;
}) {
  const cacheKey = `attest:verify:${repoRoot ?? ""}:${blockId}`;
  const [check, setCheck] = useState<SealState>(() => {
    if (!repoRoot) return { kind: "idle" };
    const cached = peekCache<SealVerifyResult>(cacheKey);
    return cached?.signature_verified ? sealVerdict(cached) : { kind: "idle" };
  });

  const runCheck = useCallback(
    async (e: { stopPropagation(): void; preventDefault(): void }) => {
      // The whole row is a button that opens the session — the seal check
      // must not also open it.
      e.stopPropagation();
      e.preventDefault();
      if (!repoRoot || check.kind === "checking" || check.kind === "verified") return;
      setCheck({ kind: "checking" });
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
          invalidateCache(cacheKey);
          setCheck({
            kind: "failed",
            message: (res.stderr || trimmed || `exit ${res.status}`).trim(),
          });
          return;
        }
        const parsed = JSON.parse(trimmed) as SealVerifyResult;
        if (parsed.signature_verified) {
          writeCache(cacheKey, parsed);
          setCheck(sealVerdict(parsed));
        } else {
          invalidateCache(cacheKey);
          setCheck({ kind: "failed", message: "The signature did not verify." });
        }
      } catch (err) {
        invalidateCache(cacheKey);
        setCheck({
          kind: "failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [repoRoot, blockId, cacheKey, check.kind],
  );

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") void runCheck(e);
  };

  if (!repoRoot) {
    if (!spelled) return null;
    return (
      <TraceMark
        tone="good"
        title="Aura sealed exactly what the AI changed and why. This record can't be altered."
      >
        <ShieldCheck /> Signed
      </TraceMark>
    );
  }

  if (check.kind === "checking") return <TraceMark>Checking the seal…</TraceMark>;

  if (check.kind === "verified") {
    return (
      <TraceMark tone="good" title={sealVerifiedTitle(check)}>
        <ShieldCheck />{" "}
        {check.via === "team-registry" && check.teamName
          ? `Genuine — ${check.teamName}`
          : "Genuine record"}
      </TraceMark>
    );
  }

  const action = {
    role: "button",
    tabIndex: 0,
    onClick: (e: { stopPropagation(): void; preventDefault(): void }) => void runCheck(e),
    onKeyDown: onKey,
  } as const;

  if (check.kind === "failed") {
    return (
      <span
        {...action}
        className="ui-trace-mark ui-trace-mark-action"
        data-tone="danger"
        title={`Aura couldn't confirm this record is intact: ${check.message || "the check failed"}. Press to try again.`}
      >
        Couldn't verify the seal
      </span>
    );
  }

  return (
    <span
      {...action}
      className="ui-trace-mark ui-trace-mark-action"
      data-tone={spelled ? "good" : undefined}
      title={
        spelled
          ? "Aura sealed exactly what the AI changed and why. Press to check the seal on this machine."
          : "Signed by Aura. Press to check the seal on this machine."
      }
      aria-label={spelled ? undefined : "Check this change's seal"}
    >
      <ShieldCheck />
      {spelled ? " Signed" : null}
    </span>
  );
}
