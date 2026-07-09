/** Team (chat) presentation — the Commons Lounge tab (Commons W2).
 *
 *  The social pulse of the workspace, derived from data that already
 *  flows: presence comes from the roster merged with each person's
 *  latest radar awareness event (active / recent / away tiers with live
 *  status lines), and the ship log is the radar's `committed` events
 *  burst-grouped per author. The only NEW state is emoji reactions on
 *  ship-log entries, riding the hidden `__aura_ship_log` rail channel
 *  (durable — full-history fetch, seq-ordered toggle replay), so a late
 *  joiner sees the same chips as everyone else.
 *
 *  Presentational + self-polling: radar via the shared `useTeamRadar`
 *  hook (6s), reactions on a calmer 15s cadence. Every read degrades to
 *  an empty section — a room-less repo simply shows a quiet lounge. */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type LoungeReactionRow,
  type RadarEvent,
  type TeamMember,
} from "../../../lib/api";
import { PICKER_EMOJIS } from "../../../lib/reactionsStore";
import { useDocumentVisibility } from "../../../lib/useDocumentVisibility";
import {
  actorShort,
  agoFromTs,
  kindGlyph,
} from "../../rightrail/radar/radarFormat";
import { useTeamRadar } from "../../rightrail/radar/useTeamRadar";
import { Avatar, type Presence } from "./Avatar";

const REACTIONS_POLL_MS = 15_000;

/** Active = touched the radar in the last 5 minutes. */
const ACTIVE_MS = 5 * 60 * 1000;
/** Recent = within the hour. Older falls back to git last_seen. */
const RECENT_MS = 60 * 60 * 1000;

/** Two committed events by the same actor within this gap merge into
 *  one ship-log entry (an agent landing a wave commits in bursts). */
const BURST_GAP_MS = 90_000;

const SHIP_LOG_CAP = 50;

// ── presence derivation ──────────────────────────────────────────────

type Tier = "active" | "recent" | "away";

type PresenceRow = {
  key: string;
  name: string;
  /** Roster handle when this row maps to a team member — enables DM. */
  handle: string | null;
  isAgent: boolean;
  tier: Tier;
  /** Live status line ("intends: …", "editing foo()", …) or null. */
  status: string | null;
  statusEmoji: string | null;
  /** Unix ms of the freshest signal (radar ts, or last_seen*1000). */
  lastTs: number;
};

/** Which event best describes what someone is doing right now. Lower
 *  wins; recency breaks ties. */
function kindRank(kind: string): number {
  switch (kind) {
    case "intent":
      return 0;
    case "editing":
      return 1;
    case "committed":
      return 2;
    case "paused":
      return 3;
    case "started":
      return 4;
    default:
      return 5;
  }
}

function statusLine(e: RadarEvent): string | null {
  const what = e.symbol || e.file;
  switch (e.kind) {
    case "intent":
      return e.intent ? `intends: ${e.intent}` : "planning";
    case "editing":
      return what ? `editing ${what}` : "editing";
    case "committed":
      return what ? `shipped ${what}` : "shipped a commit";
    case "paused":
      return "paused";
    case "started":
      return e.branch ? `active on ${e.branch}` : "active";
    default:
      return null;
  }
}

/** Case-insensitive identity keys a roster member answers to, so radar
 *  actors ("owner", "claude@cursor") find their roster row. */
function memberKeys(m: TeamMember): string[] {
  const keys = [m.handle, m.name, m.email, m.email.split("@")[0]];
  return keys.filter(Boolean).map((k) => k.toLowerCase());
}

function derivePresence(
  members: TeamMember[],
  events: RadarEvent[],
  now: number,
): PresenceRow[] {
  // Freshest event per actor, with the best descriptor inside the
  // recent window (intent beats editing beats committed…).
  const latest = new Map<string, RadarEvent>();
  const best = new Map<string, RadarEvent>();
  for (const e of events) {
    const a = e.actor.toLowerCase();
    const prev = latest.get(a);
    if (!prev || e.ts > prev.ts) latest.set(a, e);
    if (now - e.ts <= RECENT_MS) {
      const b = best.get(a);
      if (
        !b ||
        kindRank(e.kind) < kindRank(b.kind) ||
        (kindRank(e.kind) === kindRank(b.kind) && e.ts > b.ts)
      ) {
        best.set(a, e);
      }
    }
  }

  const rows: PresenceRow[] = [];
  const claimed = new Set<string>();

  for (const m of members) {
    const keys = memberKeys(m);
    const hitKey = keys.find((k) => latest.has(k));
    const hit = hitKey ? latest.get(hitKey)! : null;
    if (hitKey) claimed.add(hitKey);
    const ts = hit ? hit.ts : m.last_seen * 1000;
    const tier: Tier =
      hit && now - hit.ts < ACTIVE_MS
        ? "active"
        : hit && now - hit.ts < RECENT_MS
          ? "recent"
          : "away";
    const desc = hitKey ? best.get(hitKey) : null;
    rows.push({
      key: `member:${m.email}`,
      name: m.name || m.handle,
      handle: m.handle,
      isAgent: false,
      tier,
      status:
        tier === "away" ? m.activity_text ?? null : desc ? statusLine(desc) : null,
      statusEmoji: m.status_emoji ?? null,
      lastTs: ts,
    });
  }

  // Radar actors with no roster row — agents, mostly. They get the same
  // row treatment plus a badge.
  for (const [key, e] of latest) {
    if (claimed.has(key)) continue;
    if (now - e.ts >= RECENT_MS) continue; // stale strangers stay hidden
    const desc = best.get(key);
    rows.push({
      key: `actor:${key}`,
      name: actorShort(e.actor),
      handle: null,
      isAgent: e.is_agent,
      tier: now - e.ts < ACTIVE_MS ? "active" : "recent",
      status: desc ? statusLine(desc) : null,
      statusEmoji: null,
      lastTs: e.ts,
    });
  }

  const tierRank: Record<Tier, number> = { active: 0, recent: 1, away: 2 };
  rows.sort(
    (a, b) => tierRank[a.tier] - tierRank[b.tier] || b.lastTs - a.lastTs,
  );
  return rows;
}

// ── ship log derivation ──────────────────────────────────────────────

type ShipEntry = {
  /** Reaction anchor — the OLDEST event id in the burst, sanitized to
   *  the rail's id grammar. Stable as newer commits join the burst. */
  id: string;
  actor: string;
  isAgent: boolean;
  branch: string;
  /** Unique symbols/files across the burst, oldest→newest. */
  items: string[];
  /** Newest commit ts in the burst. */
  ts: number;
  count: number;
};

/** Radar ids are uuid-ish but the rail grammar is strict; the same
 *  deterministic squeeze on every device keeps reactions aligned. */
function safeEventId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function deriveShipLog(events: RadarEvent[]): ShipEntry[] {
  const committed = events
    .filter((e) => e.kind === "committed")
    .sort((a, b) => a.ts - b.ts);

  const entries: ShipEntry[] = [];
  for (const e of committed) {
    const last = entries[entries.length - 1];
    const item = e.symbol || e.file;
    if (
      last &&
      last.actor === e.actor &&
      e.ts - last.ts <= BURST_GAP_MS &&
      last.branch === e.branch
    ) {
      last.ts = e.ts;
      last.count += 1;
      if (item && !last.items.includes(item)) last.items.push(item);
      continue;
    }
    entries.push({
      id: safeEventId(e.id),
      actor: e.actor,
      isAgent: e.is_agent,
      branch: e.branch,
      items: item ? [item] : [],
      ts: e.ts,
      count: 1,
    });
  }
  return entries.reverse().slice(0, SHIP_LOG_CAP);
}

// ── reactions aggregate ──────────────────────────────────────────────

type ChipAgg = {
  emoji: string;
  count: number;
  mine: boolean;
  /** Display names for the tooltip, insertion order. */
  who: string[];
};

/** Replay react/unreact toggles (rows arrive seq-ordered from Rust;
 *  optimistic local rows are appended last) into per-entry chip rows. */
function aggregateReactions(
  rows: LoungeReactionRow[],
  selfDevice: string | null,
): Map<string, ChipAgg[]> {
  // event_id -> emoji -> device_id -> display
  const state = new Map<string, Map<string, Map<string, string>>>();
  for (const r of rows) {
    let byEmoji = state.get(r.event_id);
    if (!byEmoji) {
      byEmoji = new Map();
      state.set(r.event_id, byEmoji);
    }
    let devices = byEmoji.get(r.emoji);
    if (!devices) {
      devices = new Map();
      byEmoji.set(r.emoji, devices);
    }
    if (r.op === "react") devices.set(r.device_id, r.display);
    else devices.delete(r.device_id);
  }

  const out = new Map<string, ChipAgg[]>();
  for (const [eventId, byEmoji] of state) {
    const chips: ChipAgg[] = [];
    for (const [emoji, devices] of byEmoji) {
      if (devices.size === 0) continue;
      chips.push({
        emoji,
        count: devices.size,
        mine: selfDevice != null && devices.has(selfDevice),
        who: [...devices.values()],
      });
    }
    if (chips.length > 0) out.set(eventId, chips);
  }
  return out;
}

// ── the panel ────────────────────────────────────────────────────────

export function LoungePanel({
  repoRoot,
  members,
  onDM,
}: {
  repoRoot: string;
  members: TeamMember[];
  /** Open a DM with a roster member (presence-row click). */
  onDM?: (handle: string) => void;
}) {
  const radar = useTeamRadar(repoRoot, true);
  const visible = useDocumentVisibility();

  const [rows, setRows] = useState<LoungeReactionRow[]>([]);
  const [selfDevice, setSelfDevice] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [reactError, setReactError] = useState<string | null>(null);

  const pollReactions = useCallback(async () => {
    if (!repoRoot) return;
    try {
      const res = await api.loungeReactions(repoRoot);
      setRows(res.rows);
      setSelfDevice(res.self_device);
    } catch {
      // Room-less / offline — reactions just stay local-optimistic.
    }
  }, [repoRoot]);

  useEffect(() => {
    void pollReactions();
    if (!visible) return;
    const id = window.setInterval(() => void pollReactions(), REACTIONS_POLL_MS);
    return () => window.clearInterval(id);
  }, [pollReactions, visible]);

  const presence = useMemo(
    () => derivePresence(members, radar.events, Date.now()),
    [members, radar.events],
  );
  const shipLog = useMemo(() => deriveShipLog(radar.events), [radar.events]);
  const chipsByEntry = useMemo(
    () => aggregateReactions(rows, selfDevice),
    [rows, selfDevice],
  );

  const toggleReaction = useCallback(
    async (entryId: string, emoji: string, currentlyMine: boolean) => {
      setPickerFor(null);
      try {
        const row = await api.loungeReact(repoRoot, entryId, emoji, !currentlyMine);
        setRows((prev) => [...prev, row]);
        if (selfDevice == null) setSelfDevice(row.device_id);
        setReactError(null);
      } catch (e) {
        setReactError(String(e));
      }
    },
    [repoRoot, selfDevice],
  );

  const activeCount = presence.filter((p) => p.tier === "active").length;

  return (
    <div className="flex-1 h-full overflow-y-auto px-3 py-3 flex flex-col gap-3">
      {/* ── presence ── */}
      <section>
        <div className="text-text-5 text-[10.5px] uppercase tracking-wide mb-1.5">
          Here now{activeCount > 0 ? ` · ${activeCount}` : ""}
        </div>
        {presence.length === 0 ? (
          <div className="text-text-5 text-[11.5px] leading-snug">
            No teammates yet — presence appears as people and agents work
            in this repo.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {presence.map((p) => (
              <PresenceRowView
                key={p.key}
                row={p}
                onDM={p.handle && onDM ? () => onDM(p.handle!) : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── ship log ── */}
      <section>
        <div className="text-text-5 text-[10.5px] uppercase tracking-wide mb-1.5">
          Ship log
        </div>
        {shipLog.length === 0 ? (
          <div className="text-text-5 text-[11.5px] leading-snug">
            Quiet so far — commits land here as the team ships.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {shipLog.map((entry) => (
              <ShipEntryView
                key={entry.id}
                entry={entry}
                chips={chipsByEntry.get(entry.id) ?? []}
                pickerOpen={pickerFor === entry.id}
                onTogglePicker={() =>
                  setPickerFor((cur) => (cur === entry.id ? null : entry.id))
                }
                onReact={(emoji, mine) => void toggleReaction(entry.id, emoji, mine)}
              />
            ))}
          </div>
        )}
        {reactError && (
          <div className="mt-2 text-[11px] text-[#e5484d] leading-snug">
            {reactError}
          </div>
        )}
      </section>

      {/* click-away for the emoji picker */}
      {pickerFor && (
        <button
          type="button"
          aria-label="Close emoji picker"
          className="fixed inset-0 z-10 cursor-default"
          onClick={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

// ── rows ─────────────────────────────────────────────────────────────

const TIER_PRESENCE: Record<Tier, Presence> = {
  active: "online",
  recent: "idle",
  away: "offline",
};

function PresenceRowView({
  row,
  onDM,
}: {
  row: PresenceRow;
  onDM?: () => void;
}) {
  const Tag = onDM ? "button" : "div";
  return (
    <Tag
      {...(onDM
        ? { type: "button" as const, onClick: onDM, title: `Message ${row.name}` }
        : {})}
      className={`flex items-center gap-2 px-1 py-1 rounded hover:bg-bg-2 min-w-0 text-left w-full ${
        onDM ? "cursor-pointer" : ""
      }`}
    >
      <Avatar name={row.name} size={24} presence={TIER_PRESENCE[row.tier]} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`text-[12px] truncate ${
              row.tier === "away" ? "text-text-4" : "text-text-1"
            }`}
          >
            {row.name}
          </span>
          {row.statusEmoji && (
            <span className="text-[11px] flex-shrink-0">{row.statusEmoji}</span>
          )}
          {row.isAgent && (
            <span className="flex-shrink-0 px-1 rounded text-[9px] font-semibold uppercase tracking-wide bg-bg-3 text-text-4 border border-line-soft leading-[14px]">
              agent
            </span>
          )}
        </div>
        {row.status && (
          <div className="text-text-4 text-[11px] truncate leading-snug">
            {row.status}
          </div>
        )}
      </div>
      <span className="text-text-5 text-[10.5px] tabular-nums flex-shrink-0">
        {agoFromTs(row.lastTs)}
      </span>
    </Tag>
  );
}

const SHOWN_ITEMS = 4;

function ShipEntryView({
  entry,
  chips,
  pickerOpen,
  onTogglePicker,
  onReact,
}: {
  entry: ShipEntry;
  chips: ChipAgg[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onReact: (emoji: string, currentlyMine: boolean) => void;
}) {
  const shown = entry.items.slice(0, SHOWN_ITEMS);
  const more = entry.items.length - shown.length;
  return (
    <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] px-2 py-1.5">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-text-4 text-[11px] flex-shrink-0">
          {kindGlyph("committed")}
        </span>
        <span className="text-text-1 text-[12px] font-medium truncate">
          {actorShort(entry.actor)}
        </span>
        {entry.isAgent && (
          <span className="flex-shrink-0 px-1 rounded text-[9px] font-semibold uppercase tracking-wide bg-bg-3 text-text-4 border border-line-soft leading-[14px]">
            agent
          </span>
        )}
        <span className="text-text-4 text-[11px] truncate">
          shipped{entry.count > 1 ? ` ${entry.count} changes` : ""}
        </span>
        <span className="flex-1" />
        <span className="text-text-5 text-[10.5px] tabular-nums flex-shrink-0">
          {agoFromTs(entry.ts)}
        </span>
      </div>
      {(shown.length > 0 || entry.branch) && (
        <div className="mt-1 flex items-center gap-1 flex-wrap">
          {shown.map((it) => (
            <span
              key={it}
              className="px-1.5 py-px rounded bg-bg-3 text-text-2 text-[10.5px] font-mono truncate max-w-[160px]"
              title={it}
            >
              {it}
            </span>
          ))}
          {more > 0 && (
            <span className="text-text-5 text-[10.5px]">+{more} more</span>
          )}
          {entry.branch && (
            <span
              className="ml-auto text-text-5 text-[10.5px] truncate max-w-[120px]"
              title={entry.branch}
            >
              {entry.branch}
            </span>
          )}
        </div>
      )}
      <div className="relative mt-1.5 flex items-center gap-1 flex-wrap">
        {chips.map((c) => (
          <button
            key={c.emoji}
            type="button"
            onClick={() => onReact(c.emoji, c.mine)}
            title={c.who.join(", ")}
            className={`px-1.5 py-px rounded-full text-[11px] leading-[18px] border transition-colors ${
              c.mine
                ? "bg-accent/15 border-accent/40 text-text-1"
                : "bg-bg-3 border-line-soft text-text-2 hover:border-line-strong"
            }`}
          >
            {c.emoji}{" "}
            <span className="tabular-nums text-[10px] text-text-4">
              {c.count}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={onTogglePicker}
          title="Add reaction"
          aria-label="Add reaction"
          className="w-[22px] h-[20px] rounded-full border border-line-soft bg-bg-3 text-text-4 hover:text-text-1 hover:border-line-strong text-[11px] leading-none flex items-center justify-center"
        >
          +
        </button>
        {pickerOpen && (
          <div className="absolute z-20 bottom-[24px] left-0 grid grid-cols-6 gap-0.5 p-1.5 rounded border border-line-soft bg-bg-1 shadow-lg">
            {PICKER_EMOJIS.map((emoji) => {
              const mine = chips.some((c) => c.emoji === emoji && c.mine);
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onReact(emoji, mine)}
                  className={`w-7 h-7 rounded flex items-center justify-center text-[15px] hover:bg-bg-2 ${
                    mine ? "bg-accent/15" : ""
                  }`}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
