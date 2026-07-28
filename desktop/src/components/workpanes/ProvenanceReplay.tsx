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

import { useEffect, useMemo, useState } from "react";
import { api, type CommitEntry } from "../../lib/api";
import { Button } from "../ui/button";
import { IntentMatchChip } from "../IntentMatchChip";

type Props = { repoRoot: string; onClose: () => void };

type ManifestStatus = "signed" | "unsigned" | "verifying" | "ok" | "fail";

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

export function ProvenanceReplay({ repoRoot, onClose }: Props) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [manifests, setManifests] = useState<Record<string, ManifestRecord>>({});
  // jj-style change_id stripe — sha → stable change_id derived from
  // intent + tree hash. Commits sharing a change_id are the same
  // logical change re-signed (amend, sign, re-sign).
  const [changeIds, setChangeIds] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setError(null);
    api
      .gitRecentCommits(repoRoot, 80)
      .then(async (list) => {
        if (cancelled) return;
        setCommits(list);
        if (list.length > 0 && selected === null) setSelected(list[0].sha);
        // Probe in parallel — manifest reads are cheap fs hits and we
        // don't want a 80-deep serial chain blocking the scrubber.
        const entries = await Promise.all(
          list.map(async (c) => [c.sha, await probeManifest(repoRoot, c.sha)] as const),
        );
        if (cancelled) return;
        const next: Record<string, ManifestRecord> = {};
        for (const [sha, rec] of entries) next[sha] = rec;
        setManifests(next);
        // change_id derivation runs on the same commit list — single
        // backend call, group commits by change_id for the stripe.
        api
          .auraChangesList(
            repoRoot,
            list.map((c) => c.sha),
          )
          .then((rows) => {
            if (cancelled) return;
            const map: Record<string, string> = {};
            for (const r of rows) map[r.commit_sha] = r.change_id;
            setChangeIds(map);
          })
          .catch(() => {
            /* shell-local derivation — best-effort */
          });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  useEffect(() => {
    if (!selected) {
      setDiff("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api
      .gitShowCommit(repoRoot, selected)
      .then((body) => {
        if (!cancelled) setDiff(body);
      })
      .catch(() => {
        if (!cancelled) setDiff("");
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, repoRoot]);

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

  const summary = useMemo(() => {
    let signed = 0;
    let verified = 0;
    let failed = 0;
    for (const m of Object.values(manifests)) {
      if (m.status === "signed" || m.status === "ok" || m.status === "verifying")
        signed++;
      if (m.status === "ok") verified++;
      if (m.status === "fail") failed++;
    }
    return { signed, verified, failed, total: commits.length };
  }, [manifests, commits.length]);

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <header className="h-9 flex items-center px-4 border-b border-line-soft flex-shrink-0 gap-3">
        <span className="text-text-2 text-[12px] font-medium uppercase tracking-wider">
          Proof trail
        </span>
        <span className="text-text-4 text-[11px]">
          every change, with proof it's genuine
        </span>
        <span className="text-text-4 text-[10.5px] tabular-nums ml-3">
          {summary.signed}/{summary.total} signed
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
        <div className="text-red-400 text-[11px] font-mono px-4 py-2 border-b border-line-soft">
          {error}
        </div>
      )}

      <div className="flex-shrink-0 border-b border-line-soft px-3 py-2 overflow-x-auto">
        <div className="flex items-center gap-2 px-2 pb-1">
          <span className="text-[10.5px] uppercase tracking-wider text-text-4">
            Commit timeline
          </span>
          <span className="text-[10.5px] text-text-5">
            select a commit to review its diff and trust evidence
          </span>
        </div>
        {loadingList ? (
          <div className="text-text-4 text-[11.5px] px-2 py-2">
            loading commits…
          </div>
        ) : commits.length === 0 ? (
          <div className="text-text-4 text-[11.5px] px-2 py-2">
            No commits found.
          </div>
        ) : (
          <Scrubber
            commits={commits}
            manifests={manifests}
            changeIds={changeIds}
            selected={selected}
            onSelect={setSelected}
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
  repoRoot,
}: {
  commits: CommitEntry[];
  manifests: Record<string, ManifestRecord>;
  changeIds: Record<string, string>;
  selected: string | null;
  onSelect: (sha: string) => void;
  repoRoot: string;
}) {
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
    <ol className="flex items-center gap-1 min-w-max">
      {commits.map((c) => {
        const m = manifests[c.sha] ?? EMPTY;
        const tone = pinTone(m.status);
        const active = selected === c.sha;
        const cid = changeIds[c.sha];
        return (
          <li key={c.sha} className="shrink-0">
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
              <span className="text-[10px] font-mono text-text-3 flex items-center gap-1">
                <IntentMatchChip repoRoot={repoRoot} sha={c.sha} />
                {c.sha.slice(0, 7)}
              </span>
              <span className="text-[9.5px] text-text-4 truncate w-full text-center">
                {hhmm(c.timestamp)}
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
      <div className="flex-1 min-w-0 px-4 py-4 text-text-4 text-[12px]">
        Pick a commit to review.
      </div>
    );
  }
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex-shrink-0 px-4 py-3 border-b border-line-soft">
        <div className="text-[10.5px] uppercase tracking-wider text-text-4 mb-1">
          Selected commit
        </div>
        <div className="text-[12.5px] text-text-1 font-medium leading-snug">
          {commit.subject}
        </div>
        <div className="text-[10.5px] text-text-4 font-mono mt-1 truncate">
          {commit.sha} · {commit.author}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-2">
        {loading ? (
          <div className="text-text-4 text-[11.5px]">loading diff…</div>
        ) : (
          <pre className="text-[10.5px] font-mono text-text-2 whitespace-pre">
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
      <div className="h-7 flex items-center px-3 text-[10.5px] uppercase tracking-wider text-text-4 border-b border-line-soft flex-shrink-0">
        Trust evidence
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-2">
        <div
          className="flex items-center gap-2 text-[11.5px] font-medium"
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
              <div className="text-[10.5px] text-text-3 font-mono whitespace-pre-wrap break-words">
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
        ) : (
          <div className="text-[11px] text-text-3">
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
      <span className="text-[10px] uppercase tracking-wide text-text-4">
        {label}
      </span>
      <span
        className={`text-[11px] truncate ${mono ? "font-mono text-text-2" : "text-text-1"}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// Verified / in-flight / broken, in the pack's own slots. `--color-accent-blue`
// was defined by no theme, so "verifying" drew an invisible foreground on a
// hard-coded blue chip; it is the in-flight state, which is the amber slot. The
// backgrounds were literal rgba() of hues the palette does not contain — mixed
// off their own foreground instead so a chip can never drift from its ink.
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

function hhmm(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
