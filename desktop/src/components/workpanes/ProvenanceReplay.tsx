// Proof trail — every commit on the current branch, with proof it's genuine.
//
// Scrub through commits on the current branch; each commit is paired
// with whatever signed manifest lives at `.aura/manifest{,s}/<sha>.json`
// or `.aura/blocks/<sha>.json`. Pinned commits get a Verify button that
// shells `aura keys sigstore-verify <path>` and updates the pin.
//
// Layout: the commit rail across the top, the selected commit (subject,
// message, each file's diff) on the left, its trust evidence on the right.
// The parts live in ../trace/proof/.
//
// Backend: `api.gitRecentCommits` + `api.gitShowCommit` for commit
// data, `api.readFile` for manifest probes, `api.auraCli(["keys",
// "sigstore-verify", ...])` for verification. No new Tauri commands.
//
// Everything here is read through `resourceCache` and probed lazily: the
// commit list, the change_id stripe, each commit's diff and each manifest
// survive a tab switch (which unmounts the pane outright), and a manifest is
// only read off disk once its pin is actually on screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type CommitEntry } from "../../lib/api";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { TraceToolbar } from "../ui/trace-page";
import { TraceLine } from "../ui/trace-report";
import { ProofCommit } from "../trace/proof/ProofCommit";
import { ProofEvidence } from "../trace/proof/ProofEvidence";
import { ProofRail } from "../trace/proof/ProofRail";
import {
  COMMIT_DEPTH,
  EMPTY,
  changeIdsKey,
  commitsKey,
  diffKey,
  manifestKey,
  probeManifest,
  type ManifestRecord,
} from "../trace/proof/proofManifest";
import "../trace/proof/proof.css";

type Props = { repoRoot: string; onClose: () => void };

export function ProvenanceReplay({ repoRoot, onClose }: Props) {
  // Seeded from the process-lifetime cache so re-opening the pane paints the
  // last scrubber immediately rather than re-walking git.
  const [commits, setCommits] = useState<CommitEntry[]>(
    () => peekCache<CommitEntry[]>(commitsKey(repoRoot)) ?? [],
  );
  const [manifests, setManifests] = useState<Record<string, ManifestRecord>>({});
  // jj-style change_id stripe — sha → stable change_id derived from
  // intent + tree hash. Commits sharing a change_id are the same
  // logical change re-signed (amend, sign, re-sign).
  const [changeIds, setChangeIds] = useState<Record<string, string>>(
    () => peekCache<Record<string, string>>(changeIdsKey(repoRoot)) ?? {},
  );
  const [selected, setSelected] = useState<string | null>(
    () => peekCache<CommitEntry[]>(commitsKey(repoRoot))?.[0]?.sha ?? null,
  );
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(
    () => peekCache<CommitEntry[]>(commitsKey(repoRoot)) == null,
  );
  const aliveRef = useRef(true);
  // Which shas we've already read (or started reading) a manifest for. Guards
  // the lazy probe against re-reading, and against clobbering a `verify`
  // verdict the user just produced.
  const probedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Read one commit's manifest, at most once per repo per session. Probing all
  // COMMIT_DEPTH commits up front cost up to 3 fs reads each — ~240 IPC round
  // trips on every single mount — for evidence the user mostly never looks at.
  const ensureManifest = useCallback(
    (sha: string) => {
      if (!sha || probedRef.current.has(sha)) return;
      probedRef.current.add(sha);
      const key = manifestKey(repoRoot, sha);
      const cached = peekCache<ManifestRecord>(key);
      if (cached) {
        setManifests((prev) => ({ ...prev, [sha]: cached }));
        return;
      }
      // Claim the slot as "checking" so the panel says it is still looking
      // rather than asserting "no signed evidence" it hasn't earned yet.
      setManifests((prev) => ({ ...prev, [sha]: { ...EMPTY, status: "checking" } }));
      void probeManifest(repoRoot, sha).then((rec) => {
        // Cache only a FOUND manifest: it's immutable, whereas "no evidence"
        // is a fact that can change the moment the commit gets signed, so we
        // re-probe those. Verify verdicts are never cached either — a remount
        // always says "not checked" until the user checks again.
        if (rec.status === "signed") writeCache(key, rec);
        if (!aliveRef.current) return;
        setManifests((prev) => ({ ...prev, [sha]: rec }));
      });
    },
    [repoRoot],
  );

  useEffect(() => {
    let cancelled = false;
    // Stale-while-revalidate: paint the cached commit list (already seeded into
    // state) and refresh underneath. Manifests belong to the repo, not to this
    // mount, so the probe ledger resets only when the root changes.
    probedRef.current = new Set();
    setManifests({});
    const cachedCommits = peekCache<CommitEntry[]>(commitsKey(repoRoot));
    if (cachedCommits) setCommits(cachedCommits);
    setLoadingList(cachedCommits == null);
    setError(null);
    api
      .gitRecentCommits(repoRoot, COMMIT_DEPTH)
      .then((list) => {
        writeCache(commitsKey(repoRoot), list);
        if (cancelled) return;
        setCommits(list);
        if (list.length > 0) {
          // Keep the user on their commit across a refresh; fall back to newest.
          setSelected((prev) =>
            prev && list.some((c) => c.sha === prev) ? prev : list[0].sha,
          );
        }
        // change_id derivation runs on the same commit list — single
        // backend call, group commits by change_id for the stripe.
        api
          .auraChangesList(
            repoRoot,
            list.map((c) => c.sha),
          )
          .then((rows) => {
            const map: Record<string, string> = {};
            for (const r of rows) map[r.commit_sha] = r.change_id;
            writeCache(changeIdsKey(repoRoot), map);
            if (cancelled) return;
            setChangeIds(map);
          })
          .catch(() => {
            /* shell-local derivation — best-effort */
          });
      })
      .catch((e) => {
        if (cancelled) return;
        // A failed refresh keeps the cached scrubber; commits don't rewrite
        // themselves, so what's on screen is still true.
        if (!cachedCommits) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  useEffect(() => {
    if (!selected) {
      setDiff("");
      return;
    }
    // The signature panel is about to show this commit, so its evidence is
    // wanted whether or not the pin ever scrolled into view.
    ensureManifest(selected);
    let cancelled = false;
    const key = diffKey(repoRoot, selected);
    const cached = peekCache<string>(key);
    if (cached != null) setDiff(cached);
    setDiffLoading(cached == null);
    api
      .gitShowCommit(repoRoot, selected)
      .then((body) => {
        writeCache(key, body);
        if (!cancelled) setDiff(body);
      })
      .catch(() => {
        if (!cancelled && cached == null) setDiff("");
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, repoRoot, ensureManifest]);

  const verify = async (sha: string) => {
    const m = manifests[sha];
    if (!m?.path) return;
    setManifests((prev) => ({ ...prev, [sha]: { ...m, status: "verifying" } }));
    try {
      const res = await api.auraCli(repoRoot, [
        "keys",
        "sigstore-verify",
        m.path,
      ]);
      const ok = res.status === 0;
      setManifests((prev) => ({
        ...prev,
        [sha]: {
          ...m,
          status: ok ? "ok" : "fail",
          detail:
            (ok ? res.stdout : res.stderr).trim() ||
            (ok ? "verified" : `exit ${res.status}`),
        },
      }));
    } catch (e) {
      setManifests((prev) => ({
        ...prev,
        [sha]: { ...m, status: "fail", detail: String(e) },
      }));
    }
  };

  const sel = selected ? commits.find((c) => c.sha === selected) ?? null : null;
  const selManifest = selected ? manifests[selected] ?? EMPTY : EMPTY;

  // Manifests arrive as pins scroll into view, so the headline counts what we
  // have actually looked at — claiming "N/80 signed" off a partial probe would
  // under-report evidence we simply haven't read yet.
  const summary = useMemo(() => {
    let signed = 0;
    let verified = 0;
    let failed = 0;
    let checked = 0;
    for (const m of Object.values(manifests)) {
      if (m.status === "checking") continue;
      checked++;
      if (m.status === "signed" || m.status === "ok" || m.status === "verifying")
        signed++;
      if (m.status === "ok") verified++;
      if (m.status === "fail") failed++;
    }
    return { signed, verified, failed, checked, total: commits.length };
  }, [manifests, commits.length]);

  return (
    <div className="ui-proof-page">
      <TraceToolbar
        search={
          <span className="ui-trace-toolbar-meta ui-proof-lede">
            Every change, with proof it&rsquo;s genuine
          </span>
        }
      >
        <span className="ui-trace-toolbar-meta ui-proof-tally">
          {summary.signed}/{summary.checked} signed
          {summary.checked < summary.total &&
            ` · ${summary.total - summary.checked} still to check`}
          {summary.verified > 0 && ` · ${summary.verified} verified`}
          {summary.failed > 0 && (
            <>
              {" · "}
              <span data-tone="bad">{summary.failed} failed</span>
            </>
          )}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close" aria-label="Close">
          <X />
        </Button>
      </TraceToolbar>

      {error && (
        <div className="ui-proof-error">
          <TraceLine tone="danger">Couldn&rsquo;t read the commits.</TraceLine>
          <code>{error}</code>
        </div>
      )}

      <div className="ui-proof-rail">
        <div className="ui-proof-rail-caption">
          Commits, newest first. Pick one to read its change and its evidence.
        </div>
        {loadingList ? (
          <div className="ui-proof-rail-state" role="status">
            <AsciiSpinner />
            <span>Reading the commits…</span>
          </div>
        ) : commits.length === 0 ? (
          <div className="ui-proof-rail-state">
            <TraceLine tone="note">No commits found.</TraceLine>
          </div>
        ) : (
          <div className="ui-proof-rail-scroll">
            <ProofRail
              commits={commits}
              manifests={manifests}
              changeIds={changeIds}
              selected={selected}
              onSelect={setSelected}
              onPinVisible={ensureManifest}
              repoRoot={repoRoot}
            />
          </div>
        )}
      </div>

      <div className="ui-proof-body">
        <ProofCommit key={selected ?? ""} commit={sel} diff={diff} loading={diffLoading} />
        <ProofEvidence
          record={selManifest}
          onVerify={selected ? () => verify(selected) : undefined}
        />
      </div>
    </div>
  );
}
