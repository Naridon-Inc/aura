// Audit Trail — auravcs.com Studio pane #2.
//
// Scrub through commits on the current branch; each commit is paired
// with whatever signed manifest lives at `.aura/manifest{,s}/<sha>.json`
// or `.aura/blocks/<sha>.json`. Pinned commits get a Verify button that
// shells `aura keys sigstore-verify <path>` and recolors the pin.
//
// Layout: scrubber across the top, commit detail (subject + diff) on
// the left, signature panel on the right. Reuses the dialog's
// probeManifest + verify code paths — pane is a thin re-skin so the
// UX feels like a Studio surface (full work area, dismissable tab)
// instead of a modal dialog that steals focus from the editor.
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
import { api, type CommitEntry } from "../../lib/api";
import { peekCache, writeCache } from "../../lib/resourceCache";
import { Button } from "../ui/button";
import { IntentMatchChip } from "../IntentMatchChip";
import { shortDateFromSecs } from "../../lib/calendarDate";

type Props = { repoRoot: string; onClose: () => void };

/** How far back the scrubber reads. Baked into the cache key so changing it
 *  can't silently read a shorter bundle. */
const COMMIT_DEPTH = 80;

// "checking" is the honest gap the lazy probe opens up: we haven't read this
// commit's evidence off disk yet, which is NOT the same claim as "unsigned".
type ManifestStatus =
  | "checking"
  | "signed"
  | "unsigned"
  | "verifying"
  | "ok"
  | "fail";

type ManifestRecord = {
  status: ManifestStatus;
  path: string | null;
  identity: string | null;
  intent_hash: string | null;
  ast_hash: string | null;
  detail: string | null;
};

const EMPTY: ManifestRecord = {
  status: "unsigned",
  path: null,
  identity: null,
  intent_hash: null,
  ast_hash: null,
  detail: null,
};

// ── resourceCache keys ────────────────────────────────────────────────
// All repo-scoped, all process-lifetime. Nothing here rewrites itself once
// written (a commit's diff and its manifest are immutable), so a cache hit is
// as true as a fresh read — only the commit LIST can grow, and that refreshes
// on every mount.

function commitsKey(repoRoot: string): string {
  return `commits:recent:${repoRoot}:${COMMIT_DEPTH}`;
}

function changeIdsKey(repoRoot: string): string {
  return `changeIds:${repoRoot}:${COMMIT_DEPTH}`;
}

function manifestKey(repoRoot: string, sha: string): string {
  return `manifest:${repoRoot}:${sha}`;
}

function diffKey(repoRoot: string, sha: string): string {
  return `commitDiff:${repoRoot}:${sha}`;
}

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
    <div className="h-full w-full flex flex-col bg-bg-content">
      <header className="h-9 flex items-center px-4 border-b border-line-soft flex-shrink-0 gap-3">
        <span className="section-label">
          Proof trail
        </span>
        <span className="text-text-4 text-xs">
          every change, with proof it's genuine
        </span>
        <span className="text-text-4 text-xs tabular-nums ml-3">
          {summary.signed}/{summary.checked} signed
          {summary.checked < summary.total &&
            ` · ${summary.total - summary.checked} still to check`}
          {summary.verified > 0 && ` · ${summary.verified} verified`}
          {summary.failed > 0 && (
            <>
              {" · "}
              <span style={{ color: "var(--color-red)" }}>
                {summary.failed} failed
              </span>
            </>
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close"
          className="ml-auto text-text-4 hover:text-text-1"
        >
          ×
        </Button>
      </header>

      {error && (
        <div className="text-red-400 text-xs font-mono px-4 py-2 border-b border-line-soft">
          {error}
        </div>
      )}

      <div className="flex-shrink-0 border-b border-line-soft px-3 py-2 overflow-x-auto">
        <div className="flex items-center gap-2 px-2 pb-1">
          <span className="section-label">
            Commit timeline
          </span>
          <span className="text-xs text-text-5">
            select a commit to review its diff and trust evidence
          </span>
        </div>
        {loadingList ? (
          <div className="text-text-4 text-sm px-2 py-2">
            loading commits…
          </div>
        ) : commits.length === 0 ? (
          <div className="text-text-4 text-sm px-2 py-2">
            No commits found.
          </div>
        ) : (
          <Scrubber
            commits={commits}
            manifests={manifests}
            changeIds={changeIds}
            selected={selected}
            onSelect={setSelected}
            onPinVisible={ensureManifest}
            repoRoot={repoRoot}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        <CommitDetail commit={sel} diff={diff} loading={diffLoading} />
        <SignaturePanel
          record={selManifest}
          onVerify={selected ? () => verify(selected) : undefined}
        />
      </div>
    </div>
  );
}

function Scrubber({
  commits,
  manifests,
  changeIds,
  selected,
  onSelect,
  onPinVisible,
  repoRoot,
}: {
  commits: CommitEntry[];
  manifests: Record<string, ManifestRecord>;
  changeIds: Record<string, string>;
  selected: string | null;
  onSelect: (sha: string) => void;
  /** Called the first time a pin scrolls into the rail — the cue to read
   *  that commit's manifest off disk instead of probing all of them up front. */
  onPinVisible: (sha: string) => void;
  repoRoot: string;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);
  // Held in a ref so re-renders (which happen on every arriving manifest)
  // don't tear down and rebuild the observer.
  const notifyRef = useRef(onPinVisible);
  notifyRef.current = onPinVisible;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const sha = (e.target as HTMLElement).dataset.sha;
          if (sha) notifyRef.current(sha);
        }
      },
      {
        // The rail is the horizontally scrolling parent. A generous margin
        // warms the pins just off either edge so scrubbing never waits.
        root: list.parentElement,
        rootMargin: "0px 400px",
      },
    );
    for (const li of Array.from(list.children)) io.observe(li);
    return () => io.disconnect();
  }, [commits]);

  // Stable color per change_id so the stripe under each pin reads as
  // "this group of commits is one logical change." Hash → 12 hue
  // buckets so adjacent groups stay distinct.
  const colorFor = (cid: string | undefined): string => {
    if (!cid) return "transparent";
    let h = 0;
    for (let i = 0; i < cid.length; i++) {
      h = (h * 31 + cid.charCodeAt(i)) >>> 0;
    }
    const hue = h % 360;
    return `hsl(${hue} 60% 55%)`;
  };
  return (
    <ol ref={listRef} className="flex items-center gap-1 min-w-max">
      {commits.map((c) => {
        const m = manifests[c.sha] ?? EMPTY;
        const tone = pinTone(m.status);
        const active = selected === c.sha;
        const cid = changeIds[c.sha];
        return (
          <li key={c.sha} data-sha={c.sha} className="shrink-0">
            <button
              type="button"
              onClick={() => onSelect(c.sha)}
              title={`${c.sha.slice(0, 8)} · ${c.subject}${cid ? ` · change ${cid}` : ""}`}
              className={`flex flex-col items-center gap-1 px-2 py-1.5 rounded transition-colors ${
                active ? "bg-bg-2" : "hover:bg-bg-2"
              }`}
              style={{ width: 64 }}
            >
              <span
                className="rounded-full"
                style={{
                  width: 12,
                  height: 12,
                  background: tone.bg,
                  border: `2px solid ${tone.fg}`,
                }}
              />
              <span className="text-2xs font-mono text-text-3 flex items-center gap-1">
                <IntentMatchChip repoRoot={repoRoot} sha={c.sha} />
                {c.sha.slice(0, 7)}
              </span>
              <span className="text-2xs text-text-4 truncate w-full text-center">
                {shortDateFromSecs(c.timestamp, { empty: "—" })}
              </span>
              <span
                className="block w-full h-[3px] rounded-full"
                style={{ background: colorFor(cid) }}
                title={cid ? `change ${cid}` : "no change_id"}
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function CommitDetail({
  commit,
  diff,
  loading,
}: {
  commit: CommitEntry | null;
  diff: string;
  loading: boolean;
}) {
  if (!commit) {
    return (
      <div className="flex-1 min-w-0 px-4 py-4 text-text-4 text-sm">
        Pick a commit to review.
      </div>
    );
  }
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex-shrink-0 px-4 py-3 border-b border-line-soft">
        <div className="section-label mb-1">
          Selected commit
        </div>
        <div className="text-base text-text-1 font-medium leading-snug">
          {commit.subject}
        </div>
        <div className="text-xs text-text-4 font-mono mt-1 truncate">
          {commit.sha} · {commit.author}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-2">
        {loading ? (
          <div className="text-text-4 text-sm">loading diff…</div>
        ) : (
          <pre className="text-xs font-mono text-text-2 whitespace-pre">
            {colorizeDiff(diff)}
          </pre>
        )}
      </div>
    </div>
  );
}

function SignaturePanel({
  record,
  onVerify,
}: {
  record: ManifestRecord;
  onVerify?: () => void;
}) {
  const tone = pinTone(record.status);
  const hint = useMemo(() => statusHint(record.status), [record.status]);
  return (
    <aside
      className="w-[320px] border-l border-line-soft flex-shrink-0 flex flex-col"
      style={{ background: "var(--color-bg-1)" }}
    >
      <div className="section-label h-7 flex items-center px-3 border-b border-line-soft flex-shrink-0">
        Trust evidence
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-2">
        <div
          className="flex items-center gap-2 text-sm font-medium"
          style={{ color: tone.fg }}
        >
          <span
            className="rounded-full"
            style={{
              width: 10,
              height: 10,
              background: tone.bg,
              border: `2px solid ${tone.fg}`,
            }}
          />
          <span>{hint}</span>
        </div>
        {record.path ? (
          <>
            <KV
              label="Evidence file"
              value={record.path.split("/").pop() ?? "?"}
            />
            <KV label="Identity" value={record.identity ?? "—"} />
            <KV label="Task hash" value={record.intent_hash ?? "—"} mono />
            <KV label="Code hash" value={record.ast_hash ?? "—"} mono />
            {record.detail && (
              <div className="text-xs text-text-3 font-mono whitespace-pre-wrap break-words">
                {record.detail}
              </div>
            )}
            <Button
              variant="default"
              size="xs"
              disabled={record.status === "verifying" || !onVerify}
              onClick={onVerify}
              className="mt-1"
            >
              {record.status === "verifying"
                ? "Verifying…"
                : "Verify evidence"}
            </Button>
          </>
        ) : record.status === "checking" ? (
          <div className="text-xs text-text-3">
            Looking for this commit&rsquo;s evidence…
          </div>
        ) : (
          <div className="text-xs text-text-3">
            No signed evidence found for this commit. You can still review the
            diff, but Aura cannot verify who produced this change yet.
          </div>
        )}
      </div>
    </aside>
  );
}

function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="section-label">
        {label}
      </span>
      <span
        className={`text-xs truncate ${mono ? "font-mono text-text-2" : "text-text-1"}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function pinTone(status: ManifestStatus): { fg: string; bg: string } {
  switch (status) {
    case "ok":
    case "signed":
      return {
        fg: "var(--color-accent-green)",
        bg: "color-mix(in srgb, var(--color-accent-green) 20%, transparent)",
      };
    case "verifying":
      return {
        fg: "var(--color-amber)",
        bg: "color-mix(in srgb, var(--color-amber) 20%, transparent)",
      };
    case "fail":
      return {
        fg: "var(--color-red)",
        bg: "color-mix(in srgb, var(--color-red) 20%, transparent)",
      };
    // A pin we haven't read yet looks the same as one with nothing to show —
    // neutral. The copy in the panel is what draws the distinction.
    case "checking":
    case "unsigned":
    default:
      return { fg: "var(--color-text-4)", bg: "var(--color-bg-1)" };
  }
}

function statusHint(s: ManifestStatus): string {
  switch (s) {
    case "ok":
      return "Verified evidence";
    case "signed":
      return "Signed evidence · not checked";
    case "verifying":
      return "Checking evidence…";
    case "fail":
      return "Evidence check failed";
    case "checking":
      return "Looking for evidence…";
    case "unsigned":
    default:
      return "No signed evidence";
  }
}

function colorizeDiff(diff: string) {
  return diff.split(/\r?\n/).map((line, i) => {
    let cls = "text-text-3";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "text-text-4";
    else if (line.startsWith("+")) cls = "text-accent-green";
    else if (line.startsWith("-")) cls = "text-red";
    else if (line.startsWith("@@")) cls = "text-violet";
    return (
      <span key={i} className={cls}>
        {line}
        {"\n"}
      </span>
    );
  });
}

// Probe `.aura/manifest/<sha>.json` first, then `manifests/`, then
// `.aura/blocks/<sha>.json`. All three layouts are tolerated since
// the signing infra is still settling. If we find a JSON file, parse
// just enough to surface identity + canonical hashes; the full
// verification step happens via the CLI when the user clicks Verify.
async function probeManifest(
  repoRoot: string,
  sha: string,
): Promise<ManifestRecord> {
  for (const candidate of [
    `${repoRoot}/.aura/manifest/${sha}.json`,
    `${repoRoot}/.aura/manifests/${sha}.json`,
    `${repoRoot}/.aura/blocks/${sha}.json`,
  ]) {
    try {
      const body = await api.readFile(candidate);
      if (body.status !== "ok" || !body.text) continue;
      const parsed = JSON.parse(body.text) as Record<string, unknown>;
      const identity = pickStr(parsed, [
        "signed_by",
        "identity",
        "signer",
        "author_identity",
      ]);
      const intentHash = pickStr(parsed, [
        "intent_hash",
        "intent_sha",
        "stated_hash",
      ]);
      const astHash = pickStr(parsed, [
        "ast_hash",
        "delta_hash",
        "actual_hash",
      ]);
      return {
        status: "signed",
        path: candidate,
        identity,
        intent_hash: intentHash,
        ast_hash: astHash,
        detail: null,
      };
    } catch {
      /* try next candidate */
    }
  }
  return EMPTY;
}

function pickStr(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}
