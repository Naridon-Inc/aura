// BranchSwitcherModal — a Cmd-K-style branch switcher that opens OVER the Git
// view's full-screen overlay. Where the old popover gave you a name and a
// subject, this gives you the context you actually decide on: who last moved
// the branch and when, its one-line subject, how far it is ahead/behind its
// upstream, whether it's local or remote, and — live from the Team Radar — who
// else is on it right now. Fuzzy-filter at the top, arrow keys to move, Enter
// to switch (with the shared dirty-guard + human error), and a one-keystroke
// "create a branch from here".
//
// It renders through a portal at a higher stacking context (z-[60]) than the
// FullscreenOverlay (z-50) beneath it, and its Esc handler stops propagation —
// so pressing Esc closes THIS modal without also closing the Git view under it.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Cloud, GitBranch, Plus, Search } from "lucide-react";

import { api, type GitBranchRich, type RadarEvent } from "../../lib/api";
import { Button } from "../ui/button";
import { useBranches } from "./branches";

type Props = {
  repoRoot: string;
  onClose: () => void;
};

// How recent a radar event must be to count as "someone's on this branch".
// The radar feed is ambient; an event older than this is stale presence.
const PRESENCE_WINDOW_MS = 30 * 60 * 1000;

export function BranchSwitcherModal({ repoRoot, onClose }: Props) {
  const br = useBranches(repoRoot, { poll: false });
  const [rich, setRich] = useState<GitBranchRich[]>([]);
  const [loading, setLoading] = useState(true);
  const [presence, setPresence] = useState<RadarEvent[]>([]);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load the rich branch list once on open. The shared useBranches engine still
  // owns checkout/create (dirty-guard + humanizeGitError); this just feeds the
  // richer rows the modal paints.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .gitBranchesRich(repoRoot)
      .then((rows) => {
        if (alive) setRich(rows);
      })
      .catch(() => {
        if (alive) setRich([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Pull the Team Radar once so each row can show who else is on that branch.
  // Best-effort — no radar (not signed in / no cloud) just means no pips.
  useEffect(() => {
    let alive = true;
    api
      .auraRadar(repoRoot)
      .then((view) => {
        if (alive) setPresence(view.events ?? []);
      })
      .catch(() => {
        if (alive) setPresence([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Focus the filter as soon as the modal mounts.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Map branch name → the distinct, recent actors editing on it (excluding me).
  const presenceByBranch = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, string[]>();
    for (const ev of presence) {
      if (!ev.branch) continue;
      if (now - ev.ts * 1000 > PRESENCE_WINDOW_MS) continue;
      const list = map.get(ev.branch) ?? [];
      if (!list.includes(ev.actor)) list.push(ev.actor);
      map.set(ev.branch, list);
    }
    return map;
  }, [presence]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = q ? rich.filter((b) => b.name.toLowerCase().includes(q)) : rich;
    // Current branch first, then locals, then remotes — newest-commit order is
    // preserved within each group (the backend already sorted by committerdate).
    return [...rows].sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
      return 0;
    });
  }, [rich, q]);

  // Keep the highlighted row in range as the filter narrows.
  useEffect(() => {
    setIdx((i) => Math.min(Math.max(0, i), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  // checkout/createBranch broadcast `aura:git-changed` themselves (in the
  // shared useBranches engine), so every git pane re-reads after the switch.
  async function pick(name: string) {
    if (await br.checkout(name)) onClose();
  }

  async function create() {
    if (await br.createBranch(newName)) onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // Stop the FullscreenOverlay underneath from also catching this and
      // closing the whole Git view — Esc closes ONLY the modal.
      e.preventDefault();
      e.stopPropagation();
      if (creating) {
        setCreating(false);
        return;
      }
      onClose();
      return;
    }
    if (creating) return; // arrow/enter belong to the create input while open
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = filtered[idx];
      if (row && !row.isCurrent) void pick(row.name);
    }
  }

  return createPortal(
    // Backdrop captures Esc at the highest layer and a mousedown-to-dismiss.
    // The wrapping div listens in capture phase so Esc never reaches the
    // overlay below.
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(5,5,5,0.5)", backdropFilter: "blur(3px)" }}
      onMouseDown={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-xl shadow-2xl"
        style={{
          background: "var(--color-bg-1)",
          border: "1px solid var(--color-line)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Filter */}
        <div className="flex items-center gap-2.5 border-b border-line-soft px-3.5 py-2.5">
          <Search size={14} className="shrink-0 text-text-4" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIdx(0);
            }}
            placeholder="Switch branch…"
            className="flex-1 bg-transparent text-[13px] text-text-1 placeholder:text-text-4 focus:outline-none"
          />
          <span className="text-[10px] tracking-wider text-text-5">esc</span>
        </div>

        {/* Create-from-here */}
        {creating ? (
          <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
            <Plus size={14} className="shrink-0 text-accent" />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              placeholder="new-branch-name"
              className="flex-1 bg-transparent font-mono text-[12.5px] text-text-1 placeholder:text-text-4 focus:outline-none"
            />
            <Button
              type="button"
              size="xs"
              variant="subtle"
              onClick={() => void create()}
              disabled={!newName.trim() || !!br.busy}
            >
              Create from {br.current ?? "here"}
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setNewName("");
            }}
            className="flex w-full items-center gap-2 border-b border-line-soft px-3.5 py-2.5 text-left text-[12.5px] text-text-2 transition-colors hover:bg-bg-2"
          >
            <Plus size={14} className="shrink-0 text-accent" />
            Create branch from here…
          </button>
        )}

        {br.error && (
          <div
            className="border-b border-line-soft px-3.5 py-2 text-[11.5px]"
            style={{ color: "var(--color-red)", background: "rgba(239,68,68,0.08)" }}
          >
            {br.error}
          </div>
        )}

        {/* Rich rows */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {loading ? (
            <div className="px-3.5 py-3 text-[12px] text-text-4">Loading branches…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-text-4">No branches match.</div>
          ) : (
            filtered.map((b, i) => (
              <BranchRowRich
                key={(b.isRemote ? "r:" : "l:") + b.name}
                index={i}
                b={b}
                active={i === idx}
                busy={br.busy === b.name}
                presence={presenceByBranch.get(b.name) ?? []}
                onHover={() => setIdx(i)}
                onPick={() => void pick(b.name)}
              />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function BranchRowRich({
  index,
  b,
  active,
  busy,
  presence,
  onHover,
  onPick,
}: {
  index: number;
  b: GitBranchRich;
  active: boolean;
  busy: boolean;
  presence: string[];
  onHover: () => void;
  onPick: () => void;
}) {
  const secondary = [
    b.author,
    b.committedAt ? relativeTime(b.committedAt) : null,
    b.subject,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      data-row={index}
      disabled={busy || b.isCurrent}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!b.isCurrent) onPick();
      }}
      title={b.upstream ? `tracks ${b.upstream}` : undefined}
      className={
        "flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors disabled:cursor-default " +
        (active && !b.isCurrent ? "bg-bg-card" : b.isCurrent ? "" : "hover:bg-bg-2")
      }
    >
      <span className="mt-0.5 flex w-4 shrink-0 justify-center">
        {b.isCurrent ? (
          <Check size={14} className="text-accent" />
        ) : b.isRemote ? (
          <Cloud size={13} className="text-text-4" />
        ) : (
          <GitBranch size={13} className="text-text-4" />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span
            className={
              "truncate font-mono text-[12.5px] " +
              (b.isCurrent ? "font-medium text-text-1" : "text-text-1")
            }
          >
            {b.name}
          </span>
          {b.isCurrent && (
            <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-accent">
              current
            </span>
          )}
          <AheadBehindChip ahead={b.ahead} behind={b.behind} hasUpstream={!!b.upstream} />
          <span className="shrink-0 rounded border border-line-soft bg-bg-2 px-1 py-px text-[9px] uppercase tracking-wider text-text-4">
            {b.isRemote ? "remote" : "local"}
          </span>
        </span>
        {secondary && (
          <span className="truncate text-[10.5px] text-text-4">{secondary}</span>
        )}
      </span>

      {presence.length > 0 && <PresencePips actors={presence} />}
      {busy && <span className="shrink-0 self-center text-[10px] text-text-4">…</span>}
    </button>
  );
}

function AheadBehindChip({
  ahead,
  behind,
  hasUpstream,
}: {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}) {
  if (!hasUpstream) {
    return (
      <span
        className="shrink-0 text-[9.5px] text-text-5"
        title="This branch has no upstream — it only lives on your machine."
      >
        unpublished
      </span>
    );
  }
  if (ahead === 0 && behind === 0) {
    return (
      <span className="shrink-0 text-[9.5px] text-text-5" title="In step with upstream.">
        in step
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[9.5px] tabular-nums text-text-3"
      title={`${ahead} ahead · ${behind} behind upstream`}
    >
      {ahead > 0 && <span>↑{ahead}</span>}
      {behind > 0 && <span>↓{behind}</span>}
    </span>
  );
}

// Small avatar pips for who's live on this branch (from the Team Radar). Caps
// at three; a "+N" tail covers the rest. Initial-based so it works with no
// avatar service — the point is presence, not a photo.
function PresencePips({ actors }: { actors: string[] }) {
  const shown = actors.slice(0, 3);
  const extra = actors.length - shown.length;
  return (
    <span
      className="flex shrink-0 items-center self-center"
      title={`On this branch: ${actors.join(", ")}`}
    >
      {shown.map((a, i) => (
        <span
          key={a}
          className="flex items-center justify-center rounded-full border text-[8.5px] font-medium uppercase"
          style={{
            width: 18,
            height: 18,
            marginLeft: i === 0 ? 0 : -5,
            background: "var(--color-bg-3)",
            borderColor: "var(--color-line)",
            color: "var(--color-text-2)",
            zIndex: shown.length - i,
          }}
        >
          {initials(a)}
        </span>
      ))}
      {extra > 0 && (
        <span className="ml-1 text-[9.5px] text-text-4">+{extra}</span>
      )}
    </span>
  );
}

function initials(actor: string): string {
  // Strip an "@host" suffix (radar actors look like "owner@cursor"), then take
  // up to two leading letters.
  const name = actor.split("@")[0].replace(/[^A-Za-z0-9]/g, " ").trim();
  if (!name) return "·";
  const parts = name.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function relativeTime(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}
