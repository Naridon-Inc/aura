// Per-commit intent-vs-actual cache + hook. Aura's pre-commit hook
// scores how well each commit's stated intent matches the AST nodes
// it actually changed. Surfacing that score next to every commit row
// — History sidebar, Manager DAG, GitSidebar log, anywhere a sha shows
// up — is one of the few moves Warp/Cursor can't copy (no AST → no
// alignment math).
//
// Backing CLI: `aura intent-vs-actual show <sha> --json` returns the
// full report. A dot needs three things out of it — `banner`,
// `alignment_score`, and enough of `stated` to tell whether the reason
// was written independently of the change (lib/intentBasis) — so the
// cache keeps that slim record per sha rather than the whole report.
//
// Cache is module-scoped + session-lived. Commits are immutable so a
// score for `<sha>` is true forever — no TTL, no invalidation. Inflight
// requests dedupe so 30 chips for the same sha resolve in one CLI call.

import { useEffect, useState } from "react";
import { api } from "./api";
import { intentBasis, type IntentBasis } from "./intentBasis";

export type IntentBanner = "aligned" | "drift" | "diverged" | "unknown";

export type IntentMatch = {
  sha: string;
  banner: IntentBanner;
  /** 0..1 — fraction of changed identifiers that appear in stated intent. */
  score: number;
  /** What the score was computed against. A dot can only claim a match when
   *  this says the reason was written independently of the change — see
   *  lib/intentBasis. Cached with the rest because it is derived from the
   *  same one CLI call. */
  basis: IntentBasis;
  /** True until the underlying `aura intent-vs-actual show` resolves. */
  loading: boolean;
};

const cache = new Map<string, IntentMatch>();
const inflight = new Map<string, Promise<IntentMatch>>();
type Listener = (m: IntentMatch) => void;
const listeners = new Map<string, Set<Listener>>();

function announce(sha: string, m: IntentMatch) {
  cache.set(sha, m);
  const set = listeners.get(sha);
  if (!set) return;
  for (const fn of set) fn(m);
}

async function fetchOne(repoRoot: string, sha: string): Promise<IntentMatch> {
  if (inflight.has(sha)) return inflight.get(sha)!;
  const p = (async (): Promise<IntentMatch> => {
    try {
      const r = await api.auraCli(repoRoot, [
        "intent-vs-actual",
        "show",
        sha,
        "--json",
      ]);
      if (r.status !== 0) {
        const m: IntentMatch = {
          sha,
          banner: "unknown",
          score: 0,
          basis: "none",
          loading: false,
        };
        announce(sha, m);
        return m;
      }
      const parsed = JSON.parse(r.stdout) as {
        banner?: string;
        alignment_score?: number;
        commit_message?: string;
        stated?: { intent?: string; source?: string | null }[];
      };
      const banner: IntentBanner = (parsed.banner === "aligned" ||
      parsed.banner === "drift" ||
      parsed.banner === "diverged"
        ? parsed.banner
        : "unknown") as IntentBanner;
      const m: IntentMatch = {
        sha,
        banner,
        score: typeof parsed.alignment_score === "number" ? parsed.alignment_score : 0,
        basis: intentBasis(
          (parsed.stated ?? []).map((s) => ({
            intent: s.intent ?? "",
            source: s.source,
          })),
          parsed.commit_message,
        ),
        loading: false,
      };
      announce(sha, m);
      return m;
    } catch {
      const m: IntentMatch = {
        sha,
        banner: "unknown",
        score: 0,
        basis: "none",
        loading: false,
      };
      announce(sha, m);
      return m;
    } finally {
      inflight.delete(sha);
    }
  })();
  inflight.set(sha, p);
  return p;
}

export function useIntentMatch(
  repoRoot: string | null | undefined,
  sha: string | null | undefined,
): IntentMatch {
  const [state, setState] = useState<IntentMatch>(() => {
    if (!sha) return { sha: "", banner: "unknown", score: 0, basis: "none", loading: false };
    const hit = cache.get(sha);
    if (hit) return hit;
    return { sha, banner: "unknown", score: 0, basis: "none", loading: true };
  });

  useEffect(() => {
    if (!repoRoot || !sha) return;
    const hit = cache.get(sha);
    if (hit) {
      setState(hit);
      return;
    }
    setState({ sha, banner: "unknown", score: 0, basis: "none", loading: true });

    let set = listeners.get(sha);
    if (!set) {
      set = new Set();
      listeners.set(sha, set);
    }
    const fn: Listener = (m) => setState(m);
    set.add(fn);
    void fetchOne(repoRoot, sha);

    return () => {
      const s = listeners.get(sha);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) listeners.delete(sha);
    };
  }, [repoRoot, sha]);

  return state;
}

/** Force-refresh a sha (after `aura log-intent` or amend). */
export function invalidateIntentMatch(sha: string) {
  cache.delete(sha);
}

/** Imperative single-sha fetch (cached + inflight-deduped, same as the hook
 *  uses). For callers that need to score several commits at once — e.g. a
 *  feature's Drift across all its commits — where a per-sha hook can't run in a
 *  loop. Resolves to the slim {banner, score, basis} record; never throws. */
export function fetchIntentMatch(repoRoot: string, sha: string): Promise<IntentMatch> {
  const hit = cache.get(sha);
  if (hit) return Promise.resolve(hit);
  return fetchOne(repoRoot, sha);
}
