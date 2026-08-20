// "This is me" — the per-repo identity surface.
//
// When someone installs Aura and opens a repo, the app guesses who they
// are from `git config user.email`. That guess is ambiguous when the
// email isn't on the team, is unclaimed, or the user uses a different git
// email per repo. This panel lets them confirm who they are in each
// project — never a silent merge, always one click.
//
// The orchestrator passes every open workspace repo root; we classify
// them all on mount via `identityStatusAll` and render one calm row per
// repo (IdentityRepoRow), each carrying its own confirm / pick / add
// actions. Plain language only — no "roster"/"override"/"AST" jargon.

import * as React from "react";

import { Skeleton } from "../ui/skeleton";
import { IdentityRepoRow } from "./IdentityRepoRow";
import { identityStatusAll, type IdentityStatus } from "../../lib/identityApi";
import { peekCache, writeCache } from "../../lib/resourceCache";

type IdentityPanelProps = {
  /** Open workspace repo roots. The orchestrator passes the live list;
   *  a single current repo is just a one-element array. */
  repoRoots: string[];
};

export function IdentityPanel({ repoRoots }: IdentityPanelProps) {
  // Stable key so the effect doesn't re-fire on a new-but-equal array
  // identity from the parent each render.
  const key = repoRoots.join(" ");
  // Cached per repo-set (SWR) so reopening Settings -> Identity paints the
  // last classification immediately instead of flashing skeletons.
  const cacheKey = `identity-status:${key}`;

  const [rows, setRows] = React.useState<IdentityStatus[] | null>(
    () => peekCache<IdentityStatus[]>(cacheKey) ?? null,
  );
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    if (repoRoots.length === 0) {
      setRows([]);
      writeCache<IdentityStatus[]>(cacheKey, []);
      return;
    }
    try {
      const next = await identityStatusAll(repoRoots);
      setRows(next);
      writeCache<IdentityStatus[]>(cacheKey, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
    // key drives the effect; repoRoots is read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  React.useEffect(() => {
    // Paint the last classification immediately (no skeleton flash on
    // reopen), then reclassify in the background.
    setRows(peekCache<IdentityStatus[]>(cacheKey) ?? null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    // No heading of its own. This panel has exactly one caller — the
    // Identity settings pane — which already prints "Identity" from the rail
    // row you clicked, so the old <h3>This is me</h3> was the same
    // destination named twice, forty pixels apart. Its one sentence moved up
    // to the pane's intro, where the rest of the app puts that sentence.
    <section>
      {rows === null ? (
        <div className="divide-y divide-line-soft">
          {Array.from({ length: Math.max(1, Math.min(repoRoots.length, 3)) }).map(
            (_, i) => (
              <div key={i} className="py-7">
                <Skeleton className="h-[42px] w-full" />
              </div>
            ),
          )}
        </div>
      ) : error ? (
        <p className="py-7 text-[13px] text-text-3" role="alert">
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p className="py-7 text-[13px] text-text-3">
          No git projects open. Open one to confirm your identity.
        </p>
      ) : (
        <div className="divide-y divide-line-soft">
          {rows.map((status) => (
            <IdentityRepoRow
              key={status.repo_root}
              status={status}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </section>
  );
}
