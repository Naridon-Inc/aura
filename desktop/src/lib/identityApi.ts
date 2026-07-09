// Typed bindings for the per-repo "this is me" identity surface.
//
// Self-contained on purpose: the IdentityPanel imports only from here, so
// the whole feature is one Rust module (`cmd_identity`) + this file + the
// `components/identity` view. The aggregator commands (`identity_status`,
// `identity_status_all`) are new; the mutation wrappers below
// (`teamClaim`, `identityOverrideSet`, `identityOverrideClear`,
// `teamAliasAdd`) re-bind existing `cmd_team` commands so the panel never
// has to reach into the much larger `lib/api.ts` team surface.
//
// Invoke key convention matches the rest of the app: camelCase argument
// keys (`repoRoot`, `targetHandle`, `aliasEmail`), even though the Rust
// params are snake_case — Tauri does the conversion.

import { invoke } from "@tauri-apps/api/core";

/** A roster member trimmed to what the "pick someone else" chooser needs. */
export type RosterLite = {
  handle: string;
  name: string;
  email: string;
  commits: number;
  github_login: string | null;
};

/** Why a kind of verdict was reached for one repo. */
export type IdentityConfusion =
  | "clear"
  | "unclaimed"
  | "needs_confirm"
  | "not_on_roster";

/** The identity verdict for a single repo. Mirrors `cmd_identity::IdentityStatus`. */
export type IdentityStatus = {
  repo_root: string;
  repo_name: string;
  email: string;
  name: string;
  effective_handle: string;
  in_team: boolean;
  claimed: boolean;
  confusion: IdentityConfusion;
  best_guess: string | null;
  candidates: RosterLite[];
};

/** Classify who the local git user is in one repo. */
export function identityStatus(repoRoot: string): Promise<IdentityStatus> {
  return invoke<IdentityStatus>("identity_status", { repoRoot });
}

/** Classify every open workspace repo at once. Unreadable repos are skipped. */
export function identityStatusAll(
  repoRoots: string[],
): Promise<IdentityStatus[]> {
  return invoke<IdentityStatus[]>("identity_status_all", { repoRoots });
}

// ── Mutations (re-bound from cmd_team) ───────────────────────────────────
//
// These return the team manifest / void; we don't model the manifest
// shape here (the panel only refreshes via identityStatus after each
// mutation), so the manifest-returning calls resolve to `unknown`.

/** Claim the local git user's seat on this repo's team. */
export function teamClaim(repoRoot: string): Promise<unknown> {
  return invoke("team_claim", { repoRoot });
}

/** Pin a (handle, name, email) identity for THIS repo only. */
export function identityOverrideSet(args: {
  repoRoot: string;
  handle: string;
  name: string;
  email: string;
}): Promise<void> {
  const { repoRoot, handle, name, email } = args;
  return invoke<void>("identity_override_set", {
    repoRoot,
    handle,
    name,
    email,
  });
}

/** Remove the per-repo identity pin, falling back to git-email resolution. */
export function identityOverrideClear(repoRoot: string): Promise<void> {
  return invoke<void>("identity_override_clear", { repoRoot });
}

/** Link an email to a roster handle so future resolves match deterministically.
 *
 *  `cmd_team::team_alias_add` takes the TARGET handle to attach the alias
 *  to plus the alias email — it does not infer "me". The panel passes the
 *  user's own effective handle as `targetHandle` and their local git
 *  `email` as `aliasEmail` so a future open of this repo recognises them
 *  without another confirm. */
export function teamAliasAdd(
  repoRoot: string,
  targetHandle: string,
  aliasEmail: string,
): Promise<unknown> {
  return invoke("team_alias_add", { repoRoot, targetHandle, aliasEmail });
}
