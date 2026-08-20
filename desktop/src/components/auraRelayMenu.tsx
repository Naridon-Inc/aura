// AuraRelayMenu — reusable "Share to channel" picker.
//
// Any surface in the app that owns an Aura artifact (a commit row in the
// activity feed, an intent log entry, a snapshot row, a function in the
// outline, a PR review verdict) can attach this menu to surface a
// quick relay action. For v0.2.11 we don't wire every entry point —
// just expose the menu component and let callers spawn it.
//
// Usage:
//
//   <AuraRelayMenu
//     repoRoot={repoRoot}
//     kind="commit"
//     payload={{ sha, subject, author, ts, branch }}
//     anchor={anchorEl}
//     onClose={() => setMenuOpen(false)}
//   />
//
// The menu lists discovered chat channels from `.aura/team/channels/`
// and fires `relay(target, kind, payload)` when one is picked.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  relay,
  type RelayKind,
  type RelayPayloadByKind,
} from "../lib/auraRelay";
import { useDismiss } from "../lib/useDismiss";
import { fetchTeam } from "../lib/teamCache";

// ─── Channel discovery ───────────────────────────────────────────────
//
// We reuse the same backend the CommsPanel uses to list channels — but
// `chatListChannels` returns channel slugs only, not full conversations.
// If a project has no discovered channels yet we offer "general" as a
// sensible default so the affordance is never dead.

const DEFAULT_CHANNELS = ["general", "agents"];

type DiscoveredChannel = {
  slug: string;
  /** Human-readable name (= slug today). */
  label: string;
};

async function discoverChannels(repoRoot: string): Promise<DiscoveredChannel[]> {
  try {
    const manifest = await fetchTeam(repoRoot);
    const slugs = manifest.channels ?? [];
    const set = new Set<string>([...DEFAULT_CHANNELS, ...slugs]);
    return [...set].sort().map((s) => ({ slug: s, label: s }));
  } catch {
    return DEFAULT_CHANNELS.map((s) => ({ slug: s, label: s }));
  }
}

// ─── Inline popover menu ─────────────────────────────────────────────

export type AuraRelayMenuProps<K extends RelayKind> = {
  repoRoot: string;
  kind: K;
  payload: RelayPayloadByKind[K];
  /** Optional preselected channel — when set, picking "Send" skips the
   *  channel picker and fires straight away. */
  defaultChannel?: string;
  /** Anchor element the popover should align under. Optional — when
   *  omitted the menu renders inline (good for context menus). */
  anchor?: HTMLElement | null;
  onClose: () => void;
  onSent?: (channel: string) => void;
};

export function AuraRelayMenu<K extends RelayKind>({
  repoRoot,
  kind,
  payload,
  defaultChannel,
  anchor,
  onClose,
  onSent,
}: AuraRelayMenuProps<K>) {
  const [channels, setChannels] = useState<DiscoveredChannel[]>([]);
  const [picked, setPicked] = useState<string | null>(defaultChannel ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void discoverChannels(repoRoot).then((cs) => {
      if (cancelled) return;
      setChannels(cs);
      if (!defaultChannel && cs.length > 0) setPicked(cs[0].slug);
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, defaultChannel]);

  // Position under anchor (if provided) using fixed coords so we don't
  // get clipped by overflow:hidden ancestors.
  useEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [anchor]);

  // Close on outside click + escape.
  useDismiss(true, onClose, ref);

  const previewLabel = useMemo(() => kindPreviewLabel(kind, payload), [kind, payload]);

  const fire = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await relay({ repoRoot, channel: picked }, kind, payload);
      onSent?.(picked);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const style: React.CSSProperties = pos
    ? { position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }
    : { position: "relative" };

  return (
    <div
      ref={ref}
      style={style}
      className="bg-bg-1 border border-line-soft rounded-md shadow-lg w-[260px] overflow-hidden"
    >
      <div className="px-2.5 py-1.5 border-b border-line-soft">
        <div className="section-label">
          Share to channel
        </div>
        <div className="text-text-2 text-sm truncate mt-0.5" title={previewLabel}>
          {previewLabel}
        </div>
      </div>
      <div className="max-h-[200px] overflow-y-auto py-1">
        {channels.length === 0 ? (
          <div className="px-2.5 py-1.5 text-text-4 text-xs">Loading channels…</div>
        ) : (
          channels.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => setPicked(c.slug)}
              className={`w-full text-left px-2.5 py-1 text-sm flex items-center gap-2 ${
                picked === c.slug
                  ? "bg-bg-2 text-text-1"
                  : "text-text-2 hover:bg-state-hover hover:text-text-1"
              }`}
            >
              <span className="text-text-4">#</span>
              <span className="truncate">{c.label}</span>
              {picked === c.slug ? (
                <span className="ml-auto text-accent text-2xs">selected</span>
              ) : null}
            </button>
          ))
        )}
      </div>
      {error ? (
        <div className="px-2.5 py-1 text-red-400 text-xs border-t border-line-soft">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-line-soft">
        <button
          type="button"
          onClick={onClose}
          className="text-text-3 hover:text-text-1 text-xs px-2 py-0.5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={fire}
          disabled={!picked || busy}
          className="ml-auto text-xs px-2.5 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "var(--color-accent)", color: "var(--color-bg-deep)" }}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function kindPreviewLabel<K extends RelayKind>(
  kind: K,
  payload: RelayPayloadByKind[K],
): string {
  switch (kind) {
    case "intent":
      return `Intent · ${(payload as RelayPayloadByKind["intent"]).subject || "(no subject)"}`;
    case "snapshot":
      return `Snapshot · ${(payload as RelayPayloadByKind["snapshot"]).path}`;
    case "commit": {
      const p = payload as RelayPayloadByKind["commit"];
      return `Commit ${p.sha.slice(0, 7)} · ${p.subject}`;
    }
    case "prove":
      return `Prove · ${(payload as RelayPayloadByKind["prove"]).goal}`;
    case "pr_review":
      return `PR review · vs ${(payload as RelayPayloadByKind["pr_review"]).base}`;
    case "function_ref": {
      const p = payload as RelayPayloadByKind["function_ref"];
      return `Function · ${p.name} @ ${p.path}`;
    }
    default:
      return "Aura artifact";
  }
}
