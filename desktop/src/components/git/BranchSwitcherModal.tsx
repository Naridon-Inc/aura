// The branch switcher: a search over this repository's branches in the shared
// command dialog. Each row carries what you decide on — who last moved the
// branch and when, its one-line subject, how far it is from its shared copy,
// and who else is on it right now. Typing a name no branch has offers to
// create it from the branch you're on.
//
// Picking a branch while an agent is working in this checkout asks first
// ("Switch branch?"); the switcher steps aside for that question, and comes
// back only if the switch then fails, to say why. Creating a branch isn't
// asked about — it starts from where the agent already is.
//
// It can open over the full-screen Git view, whose Escape handler sits on the
// window. The dialog stops Escape before it gets there, so Esc closes the
// switcher and leaves the view under it open.

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Check, Cloud, GitBranch, Plus } from "lucide-react";

import { api, type GitBranchRich, type RadarEvent } from "../../lib/api";
import * as work from "../../lib/place/workApi";
import { monogram } from "../../lib/monogram";
import { relativeAgeFromSecs } from "../../lib/relativeTime";
import { branchSyncDetail } from "../rightrail/reviewState";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Badge } from "../ui/badge";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { BranchSwitchConfirm, useBranchSwitchGuard } from "./BranchSwitchConfirm";
import { useBranches } from "./branches";
import "../ui/branch-switcher.css";

type Props = {
  repoRoot: string;
  onClose: () => void;
};

// How recent a radar event must be to count as "someone's on this branch".
// The radar feed is ambient; an event older than this is stale presence.
const PRESENCE_WINDOW_MS = 30 * 60 * 1000;

/** The rich branch list, read once on open. The shared `useBranches` engine
 *  still owns checkout and create (dirty-guard + human error); this only
 *  feeds the rows. */
function useRichBranches(repoRoot: string) {
  const [rows, setRows] = useState<GitBranchRich[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    work
      .gitBranchesRich(repoRoot)
      .then((next) => alive && setRows(next))
      .catch(() => alive && setRows([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  return { rows, loading };
}

/** Branch name → the distinct people recently active on it, from the Team
 *  Radar. Best-effort: no radar (not signed in, no cloud) means no faces. */
function useBranchPresence(repoRoot: string) {
  const [events, setEvents] = useState<RadarEvent[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .auraRadar(repoRoot)
      .then((view) => alive && setEvents(view.events ?? []))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [repoRoot]);
  return useMemo(() => {
    const now = Date.now();
    const map = new Map<string, string[]>();
    for (const ev of events) {
      if (!ev.branch || now - ev.ts * 1000 > PRESENCE_WINDOW_MS) continue;
      const list = map.get(ev.branch) ?? [];
      if (!list.includes(ev.actor)) list.push(ev.actor);
      map.set(ev.branch, list);
    }
    return map;
  }, [events]);
}

const rowKey = (b: GitBranchRich) => (b.isRemote ? "r:" : "l:") + b.name;

export function BranchSwitcherModal({ repoRoot, onClose }: Props) {
  const br = useBranches(repoRoot, { poll: false });
  const rich = useRichBranches(repoRoot);
  const presence = useBranchPresence(repoRoot);
  const [query, setQuery] = useState("");
  const guard = useBranchSwitchGuard(repoRoot);
  // Out of the way while the question is up, and while the switch it allowed
  // runs; a failed switch brings the list back with git's reason.
  const [stepAside, setStepAside] = useState(false);

  const name = query.trim();
  // The current branch leads; newest-commit order (the backend's) holds
  // within each group.
  const { local, remote } = useMemo(() => {
    const q = name.toLowerCase();
    const hits = q ? rich.rows.filter((b) => b.name.toLowerCase().includes(q)) : rich.rows;
    const local = hits
      .filter((b) => !b.isRemote)
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    return { local, remote: hits.filter((b) => b.isRemote) };
  }, [rich.rows, name]);
  const canCreate = name.length > 0 && !rich.loading && !rich.rows.some((b) => b.name === name);

  // checkout/createBranch broadcast `aura:git-changed` themselves (in the
  // shared useBranches engine), so every git pane re-reads after the switch.
  async function checkout(name: string) {
    if (await br.checkout(name)) onClose();
    else setStepAside(false);
  }
  function pick(b: GitBranchRich) {
    if (b.isCurrent) return onClose();
    const outcome = guard.requestSwitch({
      branchName: b.name,
      switchBranch: () => void checkout(b.name),
    });
    if (outcome === "confirming") setStepAside(true);
  }
  async function create() {
    if (await br.createBranch(name)) onClose();
  }

  function row(b: GitBranchRich) {
    return (
      <BranchRow
        key={rowKey(b)}
        b={b}
        busy={br.busy === b.name}
        presence={presence.get(b.name) ?? []}
        onPick={() => pick(b)}
      />
    );
  }

  return (
    <>
      <BranchSwitchConfirm
        {...guard.dialogProps}
        onCancel={() => {
          guard.dialogProps.onCancel();
          onClose();
        }}
      />
      <CommandDialog
        open={!stepAside}
        onOpenChange={(next) => !next && onClose()}
        title="Switch branch"
        description="Search this repository's branches and press Enter to switch, or type a new name to create one."
        commandProps={{
          shouldFilter: false,
          loop: true,
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Escape") e.stopPropagation();
          },
        }}
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Switch branch, or type a new name…"
          aria-label="Switch branch"
          trailing={rich.loading && <AsciiSpinner />}
        />
        {br.error && (
          <Alert variant="destructive" className="ui-branch-switch-error">
            <AlertDescription>{br.error}</AlertDescription>
          </Alert>
        )}
        <CommandList>
          <CommandEmpty>
            {rich.loading ? "Reading this repository's branches…" : "No branches match."}
          </CommandEmpty>
          {canCreate && (
            <CommandGroup heading="New branch">
              <CommandItem
                value={`create:${name}`}
                disabled={!!br.busy}
                onSelect={() => void create()}
              >
                <Plus />
                <span className="ui-branch-switch-new">
                  Create <code>{name}</code> from {br.current ?? "here"}
                </span>
              </CommandItem>
            </CommandGroup>
          )}
          {local.length > 0 && <CommandGroup heading="Local">{local.map(row)}</CommandGroup>}
          {remote.length > 0 && <CommandGroup heading="Remote">{remote.map(row)}</CommandGroup>}
        </CommandList>
      </CommandDialog>
    </>
  );
}

function BranchRow({
  b,
  busy,
  presence,
  onPick,
}: {
  b: GitBranchRich;
  busy: boolean;
  presence: string[];
  onPick: () => void;
}) {
  const detail = [b.author, b.committedAt ? relativeAgeFromSecs(b.committedAt) : null, b.subject]
    .filter(Boolean)
    .join(" · ");
  const Icon = b.isCurrent ? Check : b.isRemote ? Cloud : GitBranch;
  return (
    <CommandItem
      value={rowKey(b)}
      disabled={busy}
      onSelect={onPick}
      className="ui-branch-switch-row"
      title={b.upstream ? `Shared copy: ${b.upstream}` : undefined}
    >
      <Icon className="ui-branch-switch-icon" data-current={b.isCurrent ? "" : undefined} />
      <span className="ui-branch-switch-main">
        <span className="ui-branch-switch-line">
          <span className="ui-branch-switch-name">{b.name}</span>
          {b.isCurrent && <Badge variant="secondary">Current</Badge>}
          {/* A remote ref is the shared copy itself; only a local branch
              can be ahead of, behind, or missing one. */}
          {!b.isRemote && (
            <SyncMark ahead={b.ahead} behind={b.behind} hasUpstream={!!b.upstream} />
          )}
        </span>
        {detail && <span className="ui-branch-switch-detail">{detail}</span>}
      </span>
      {presence.length > 0 && <Presence actors={presence} />}
      {busy && <AsciiSpinner />}
    </CommandItem>
  );
}

// The mark stays terse — two arrows and two numbers — so the hover is where
// the state is explained. `branchSyncDetail` is the one copy of that
// explanation, shared with the review rail, and it leads with what the
// numbers mean before the git fact.
function SyncMark({
  ahead,
  behind,
  hasUpstream,
}: {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}) {
  const detail = branchSyncDetail(ahead, behind, hasUpstream);
  const text = !hasUpstream
    ? "only here"
    : ahead === 0 && behind === 0
      ? "in step"
      : [ahead > 0 && `↑${ahead}`, behind > 0 && `↓${behind}`].filter(Boolean).join(" ");
  return (
    <span className="ui-branch-switch-sync" title={detail}>
      {text}
    </span>
  );
}

// Who's live on this branch, from the Team Radar. Caps at three faces with a
// "+N" tail. Monograms, so it works with no avatar service — the point is
// presence, not a photo.
function Presence({ actors }: { actors: string[] }) {
  const shown = actors.slice(0, 3);
  const extra = actors.length - shown.length;
  return (
    <span className="ui-branch-switch-who" title={`On this branch: ${actors.join(", ")}`}>
      {shown.map((a) => (
        <Avatar key={a}>
          {/* The shared monogram strips the "@host" off a radar actor. */}
          <AvatarFallback>{monogram(a, { empty: "·" })}</AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 && <span className="ui-branch-switch-more">+{extra}</span>}
    </span>
  );
}
