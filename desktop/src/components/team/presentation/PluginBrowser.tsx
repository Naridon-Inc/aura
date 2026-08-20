/** Team (chat) presentation — the Plugin Exchange browser (Commons W1).
 *
 *  Lives as a tab in the right context panel: bundles your teammates
 *  published over the live rail, plus a publish picker for your own
 *  signed bundles. Trust is explicit — an untrusted publisher's row
 *  shows the key fingerprint and a "Trust & install" action; nothing
 *  installs (let alone loads) without an ed25519 verification pass in
 *  Rust. */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../../lib/api";
import type { ExchangeRow, PluginRow } from "../../../lib/api";
import { refreshPluginContributes } from "../../../lib/pluginContributesStore";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";

export function PluginBrowser({ repoRoot }: { repoRoot: string }) {
  const [rows, setRows] = useState<ExchangeRow[] | null>(null);
  const [locals, setLocals] = useState<PluginRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmTrust, setConfirmTrust] = useState<ExchangeRow | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      // Poll first so freshly-published chunks assemble before we list.
      await api.pluginExchangePoll(repoRoot).catch(() => null);
      const [listed, local] = await Promise.all([
        api.pluginExchangeList(repoRoot),
        api.pluginList().catch(() => [] as PluginRow[]),
      ]);
      if (!alive.current) return;
      setRows(listed);
      setLocals(local);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setRows([]);
      setError(String(e));
    }
  }, [repoRoot]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, [refresh]);

  const install = async (row: ExchangeRow) => {
    setBusy(row.publish_id);
    setError(null);
    setNotice(null);
    try {
      const res = await api.pluginExchangeInstall(repoRoot, row.publish_id);
      if (res.installed) {
        setNotice(`${row.name} installed`);
        await api.pluginRescan().catch(() => null);
        // Refresh the renderer-side contributes cache too, so a plugin that
        // contributes apps shows up in the Apps launcher immediately instead
        // of only after a reboot / Settings rescan.
        await refreshPluginContributes().catch(() => null);
        await refresh();
      } else if (res.needs_trust) {
        setConfirmTrust(row);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const trustAndInstall = async (row: ExchangeRow) => {
    setBusy(row.publish_id);
    setError(null);
    try {
      await api.pluginExchangeTrust(repoRoot, row.publish_id);
      setConfirmTrust(null);
      const res = await api.pluginExchangeInstall(repoRoot, row.publish_id);
      if (res.installed) {
        setNotice(`${row.name} installed`);
        await api.pluginRescan().catch(() => null);
        await refreshPluginContributes().catch(() => null);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async (row: ExchangeRow) => {
    setBusy(`un:${row.publish_id}`);
    setError(null);
    setNotice(null);
    try {
      await api.pluginExchangeUnpublish(repoRoot, row.publish_id);
      setNotice(`${row.name} unpublished`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const publish = async (dir: string) => {
    setBusy(dir);
    setError(null);
    setNotice(null);
    try {
      const listing = await api.pluginExchangePublish(repoRoot, dir);
      setNotice(`${listing.name} shared with the team`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // Local signed plugin bundles eligible for publishing — one entry per
  // bundle (a bundle can carry plugin+skill+mcp manifests).
  const publishable: PluginRow[] = [];
  const seen = new Set<string>();
  for (const p of locals) {
    const key = p.bundle ?? p.install_dir;
    if (p.signature !== "verified" || seen.has(key)) continue;
    seen.add(key);
    publishable.push(p);
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3 flex flex-col gap-3">
      {error && (
        <div className="text-xs text-red bg-red/10 border border-red/20 rounded px-2 py-1.5 leading-snug break-words">
          {error}
        </div>
      )}
      {notice && (
        <div className="text-xs text-accent-green bg-accent-green/10 border border-accent-green/20 rounded px-2 py-1.5 leading-snug">
          {notice}
        </div>
      )}

      <section>
        <header className="flex items-center justify-between mb-1.5">
          <span className="section-label">
            From your team
          </span>
          <Button
            variant="link"
            size="xs"
            onClick={() => void refresh()}
            className="h-auto px-0 text-xs text-text-4 no-underline hover:text-text-1 hover:no-underline"
            title="Refresh"
          >
            Refresh
          </Button>
        </header>
        {rows === null ? (
          <div className="flex items-center gap-1.5 text-text-4 text-sm py-2">
            <AsciiSpinner />
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-text-4 text-sm leading-snug py-1">
            Nothing shared yet. Publish a plugin below and your teammates see
            it here instantly.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.publish_id}
                className="border border-line-soft rounded-lg px-2.5 py-2 bg-bg-0 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-text-1 text-base font-medium truncate">
                    {row.name}
                  </span>
                  <span className="text-text-5 text-xs tabular-nums flex-shrink-0">
                    v{row.version}
                  </span>
                </div>
                <div className="text-text-4 text-xs mt-0.5 truncate font-mono">
                  {row.bundle_id}
                </div>
                {row.description && (
                  <div className="text-text-4 text-xs mt-1 leading-snug line-clamp-2">
                    {row.description}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-2xs text-text-4 bg-bg-1 border border-line-soft rounded px-1.5 py-0.5">
                    {row.mine ? "you" : row.publisher.display || row.publisher.label}
                  </span>
                  {row.trusted ? (
                    <span className="text-2xs text-accent-green bg-accent-green/10 rounded px-1.5 py-0.5">
                      ✓ {row.publisher.label}
                    </span>
                  ) : (
                    <span
                      className="text-2xs text-text-4 bg-bg-1 rounded px-1.5 py-0.5"
                      title={row.publisher.key_id}
                    >
                      publisher not verified
                    </span>
                  )}
                  {row.capabilities.slice(0, 3).map((c) => (
                    <span
                      key={c}
                      className="text-2xs text-text-5 bg-bg-1 rounded px-1.5 py-0.5 font-mono"
                    >
                      {c}
                    </span>
                  ))}
                </div>

                {confirmTrust?.publish_id === row.publish_id ? (
                  <div className="mt-2 border border-line-soft rounded px-2 py-1.5 bg-bg-1">
                    <div className="text-xs text-text-2 leading-snug">
                      Trust <span className="font-medium">{row.publisher.label}</span>?
                      Future plugins from them will install without asking.
                    </div>
                    <div className="text-2xs text-text-5 font-mono mt-1 break-all">
                      {row.publisher.key_id}
                    </div>
                    <div className="flex gap-1.5 mt-1.5">
                      <button
                        type="button"
                        disabled={busy === row.publish_id}
                        onClick={() => void trustAndInstall(row)}
                        className="px-2 py-0.5 text-xs rounded bg-accent/15 hover:bg-accent/25 text-accent disabled:opacity-50"
                      >
                        Trust &amp; install
                      </button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirmTrust(null)}
                        className="text-xs text-text-4 hover:text-text-1"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 mt-2">
                    {row.installed ? (
                      <span className="text-xs text-text-4">Installed</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === row.publish_id}
                        onClick={() => void install(row)}
                        className="px-2 py-0.5 text-xs rounded bg-accent/15 hover:bg-accent/25 text-accent disabled:opacity-50"
                      >
                        {busy === row.publish_id
                          ? "Installing…"
                          : row.trusted
                            ? "Install"
                            : "Install…"}
                      </button>
                    )}
                    {row.mine && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy === `un:${row.publish_id}`}
                        onClick={() => void unpublish(row)}
                        className="text-xs text-text-4 hover:text-red hover:bg-red/10"
                        title="Withdraw this listing for the whole team"
                      >
                        {busy === `un:${row.publish_id}`
                          ? "Unpublishing…"
                          : "Unpublish"}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <header className="mb-1.5">
          <span className="section-label">
            Share yours
          </span>
        </header>
        {publishable.length === 0 ? (
          <div className="text-text-5 text-sm leading-snug">
            No plugins ready to share yet. Create one with
            <span className="font-mono"> aura plugin new</span>, then sign
            it (<span className="font-mono">keygen</span> +
            <span className="font-mono"> sign</span>).
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {publishable.map((p) => (
              <li
                key={p.bundle ?? p.install_dir}
                className="flex items-center justify-between gap-2 border border-line-soft rounded px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="text-text-2 text-sm truncate font-mono">
                    {p.bundle ?? p.id}
                  </div>
                  <div className="text-text-5 text-2xs">v{p.version}</div>
                </div>
                <button
                  type="button"
                  disabled={busy === p.install_dir}
                  onClick={() => void publish(p.install_dir)}
                  className="px-2 py-0.5 text-xs rounded bg-accent/15 hover:bg-accent/25 text-accent disabled:opacity-50 flex-shrink-0"
                >
                  {busy === p.install_dir ? "Publishing…" : "Publish"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
