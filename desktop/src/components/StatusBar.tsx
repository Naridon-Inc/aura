// Bottom chrome strip — redesigned (ADE footer). 28px tall. Items are
// real inset chips (~20px, rounded-6, own hover background) centered in
// the bar, separated by gaps + the occasional hairline divider — not
// butted-together flat rows. IA is split into two priority zones:
//
//   LEFT  — workspace identity + activity. Leads with a first-class
//           BranchSwitcher (current branch, dirty dot, full
//           list/checkout/create popover — the thing VS Code's branch
//           item does), then changes, path, then today's activity
//           (usage, intents) and event badges (audit, conflicts,
//           aurawatch). flex-1 + overflow-hidden so it clips its own
//           lowest-priority items instead of scrolling the whole bar.
//   RIGHT — system cluster (CLI version, the relocated TopBar utility
//           cluster via `trailing`, model picker). flex-none, pinned to
//           the edge; every upward popover lives here so the LEFT run's
//           overflow-hidden can't clip it.
//
// Branch no longer lives in StatusPills — it's promoted to the footer's
// leftmost slot as the BranchSwitcher. StatusPills keeps strict/hub/agents.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  callScreenshareWorkpaneId,
  getDeafenedPreference,
  getMicEnabledPreference,
  leaveCall,
  setDeafenedPreference,
  setMicEnabledPreference,
  useCallMicLevel,
  useCallSnapshot,
} from "../lib/callStore";
import {
  GitBranch,
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
} from "lucide-react";
import { api } from "../lib/api";
import { BranchSwitcherModal } from "./git/BranchSwitcherModal";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { ClaudeUsageRing } from "./manager/chat/ClaudeUsageRing";
import { AuraMark } from "./AuraMark";
import {
  humanizeWorkspaceName,
  isMachineLeaf,
  isWorktreeRoot,
} from "../lib/workspaceLabel";

type StatusBarProps = {
  /** Repo root for the BranchSwitcher's git ops (list/checkout/create) and
   *  the leftmost branch chip. Empty string disables the switcher's git
   *  calls. */
  repoRoot: string;
  changedFiles: number;
  auditUnacked?: number;
  conflictsOpen?: number;
  /** Footer changes chip click — routes to the Review changes surface and
   *  focuses the working set. */
  onClickDiff?: () => void;
  onClickAudit?: () => void;
  onClickConflicts?: () => void;
  /** W1.4 — plugin status pills. Manifest declares `render` as a
   *  well-known kind. v1 only handles `"worker:status"` (renders the
   *  plugin id + label as a neutral pill). Anything else is silently
   *  skipped so unknown render kinds don't crash the chrome. */
  pluginPills?: { pluginId: string; id: string; render: string }[];
  /** Click handler for a plugin pill — host wires it into the bridge. */
  onClickPluginPill?: (pluginId: string, pillId: string) => void;
  /** V0.2.8 — when the left sidebar is open, the VoiceDockPanel at
   *  the sidebar's bottom is the canonical huddle surface. The
   *  StatusBar pill becomes a fallback only when the sidebar is
   *  collapsed. Defaults to `true` so callers that don't wire this
   *  still see the pill (graceful pre-dock behavior). */
  sidebarOpen?: boolean;
  /** Task #229 — installed `aura` CLI version check. When set, renders
   *  a chip showing ok/outdated/missing/unknown so users notice when
   *  the bundled MCP contract drifts from the binary on PATH. `null`
   *  while the first check is in flight; the chip stays hidden. */
  cliVersion?: {
    installed: string | null;
    expected: string;
    path: string | null;
    status: "ok" | "outdated" | "missing" | "unknown";
    raw: string | null;
  } | null;
  /** Refresh handler — wired to a button inside the popover so users
   *  don't have to restart the shell after upgrading the CLI. */
  onRefreshCliVersion?: () => void;
  /** One-click update — installs the CLI bundled with this release in
   *  place. Resolves when done (chip state already refreshed by the
   *  caller); rejects on failure so the popover can show an error. */
  onUpdateCli?: () => Promise<void>;
  /** ADE chrome — utility cluster relocated from the slim TopBar: status
   *  pills (branch/strict/hub/agents), resource, impact inbox, view
   *  toggles, more-tools. Rendered just before the model picker. Omitted
   *  in the legacy shell, which keeps those items in the TopBar. */
  trailing?: ReactNode;
};

export function StatusBar({
  repoRoot,
  changedFiles,
  auditUnacked,
  conflictsOpen,
  onClickDiff,
  onClickAudit,
  onClickConflicts,
  pluginPills = [],
  onClickPluginPill,
  sidebarOpen = true,
  cliVersion,
  onRefreshCliVersion,
  onUpdateCli,
  trailing,
}: StatusBarProps) {
  return (
    // Two zones with a hard priority split so the footer never scrolls,
    // wraps, or spills:
    //   • LEFT run  — workspace identity + activity. flex-1 + min-w-0 +
    //     overflow-hidden: it absorbs the slack and clips its own
    //     lowest-priority (rightmost) items when space runs out, instead
    //     of pushing a horizontal scrollbar onto the whole bar.
    //   • RIGHT cluster — system indicators (CLI, status pills, resource,
    //     inbox, model). flex-none so it's always fully visible and
    //     pinned to the edge. Every popover-bearing control lives here so
    //     the LEFT run's overflow-hidden can't clip an open popover.
    // Root is items-stretch so the full-height CallStatusPill strip can
    // fill the bar; the two inner zones are items-center so their inset
    // chips sit centered in the taller strip. overflow-visible lets the
    // upward popovers (branch, cli, model) escape the bar.
    <div className="flex items-stretch flex-nowrap w-full h-full text-[11px] border-t border-line-soft bg-bg-0 select-none">
      {/* Persistent huddle status pill — V.Y.4. Renders nothing when
          no call is active OR when the sidebar is open (the
          VoiceDockPanel dock is the primary surface in that case).
          When the sidebar is collapsed, this is the fallback so the
          user can still see + control the call. */}
      <CallStatusPill suppressed={sidebarOpen} />

      <div className="flex items-center flex-nowrap min-w-0 flex-1 overflow-hidden gap-0.5 pl-1.5 pr-1">
        {/* Workspace identity — branch (with live list/checkout/create),
            then changes, then the path. The branch leads because it's the
            single most consequential bit of workspace state. */}
        <BranchSwitcher repoRoot={repoRoot} dirty={changedFiles > 0} />
        {/* Changes — plain "N changes", no line-churn numbers. Click opens
            the Review changes surface. Dim (no click) when nothing's changed. */}
        <Item
          icon={<FileIcon />}
          title={
            changedFiles > 0
              ? `${changedFiles} change${changedFiles === 1 ? "" : "s"} — click to review`
              : "No changes yet"
          }
          onClick={changedFiles > 0 ? onClickDiff : undefined}
          dim={changedFiles === 0}
        >
          <span className="tabular-nums">{changedFiles}</span>
          <span className="text-text-4">change{changedFiles === 1 ? "" : "s"}</span>
        </Item>

        {auditUnacked !== undefined && auditUnacked > 0 && (
          <Item
            dot="red"
            onClick={onClickAudit}
            title="Risky actions Aura paused for you to check. Click to review."
            tone="red"
          >
            <span className="tabular-nums">{auditUnacked}</span>
            <span>to review</span>
          </Item>
        )}
        {conflictsOpen !== undefined && conflictsOpen > 0 && (
          <Item
            dot="amber"
            onClick={onClickConflicts}
            title="Merge conflicts — click to resolve"
            tone="amber"
          >
            <span className="tabular-nums">{conflictsOpen}</span>
            <span>conflict{conflictsOpen === 1 ? "" : "s"}</span>
          </Item>
        )}

        {pluginPills
          .filter((p) => p.render === "worker:status")
          .map((p) => (
            <Item
              key={`${p.pluginId}:${p.id}`}
              title={`${p.pluginId} · ${p.id}`}
              onClick={
                onClickPluginPill
                  ? () => onClickPluginPill(p.pluginId, p.id)
                  : undefined
              }
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: "var(--color-accent-purple, var(--color-accent-blue))" }}
                aria-hidden
              />
              <span className="text-text-3">{p.id}</span>
            </Item>
          ))}
      </div>

      {/* RIGHT cluster — flex-none, always visible, popovers open upward. */}
      <div className="flex items-center flex-none gap-0.5 pr-1.5 pl-1">
        {/* Claude subscription usage ring — the user's live rolling 5-hour +
            weekly limits (relocated here from under the chat composer). Hidden
            until there's a fresh real reading, so it never adds an empty chip;
            hover reveals the provider/model, 5h %, weekly %, session cost and
            freshness. */}
        <ClaudeUsageRing variant="footer" />
        {/* CLI version chip only when there's actual drift — an update or a
            missing binary. In sync (status "ok", or an undeterminable
            "unknown") it renders nothing, so the calm footer never carries a
            green "all good" chip as noise. Auto-update via CliUpdateToast is
            unaffected. */}
        {cliVersion &&
          (cliVersion.status === "outdated" || cliVersion.status === "missing") && (
            <CliVersionChip
              info={cliVersion}
              onRefresh={onRefreshCliVersion}
              onUpdate={onUpdateCli}
            />
          )}
        {trailing && (
          <span className="flex items-center gap-1 pl-1.5 ml-0.5 border-l border-line-soft">
            {trailing}
          </span>
        )}
      </div>
    </div>
  );
}

// Task #229 — footer chip for the `aura` CLI version drift check.
//
// Renders as a flat Item with a colored dot:
//   • green  → installed.major.minor == expected (status "ok")
//   • amber  → installed but on a different minor (status "outdated")
//   • red    → no binary on PATH ("missing"), or `--version` unparseable ("unknown")
//
// Click toggles a popover anchored above the chip with the actual
// version strings, the resolved path, the raw `--version` line, and a
// copy-install-command affordance. A small refresh button lets users
// re-check after upgrading without restarting the shell.
function CliVersionChip({
  info,
  onRefresh,
  onUpdate,
}: {
  info: {
    installed: string | null;
    expected: string;
    path: string | null;
    status: "ok" | "outdated" | "missing" | "unknown";
    raw: string | null;
  };
  onRefresh?: () => void;
  onUpdate?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  async function runUpdate() {
    if (!onUpdate || updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      await onUpdate();
      // Success refreshes `info` via the parent; the popover re-renders
      // to the "ok" state (no install block). Close it after a beat.
      setOpen(false);
    } catch (e) {
      setUpdateError(String(e));
    } finally {
      setUpdating(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (wrapRef.current && t && !wrapRef.current.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dotTone: "green" | "amber" | "red" =
    info.status === "ok"
      ? "green"
      : info.status === "outdated"
        ? "amber"
        : "red";
  const labelText =
    info.status === "ok"
      ? `aura ${info.installed ?? ""}`
      : info.status === "outdated"
        ? `aura ${info.installed ?? "?"} → ${info.expected}`
        : info.status === "missing"
          ? "aura missing"
          : "aura ?";
  const titleText =
    info.status === "ok"
      ? `Aura CLI ${info.installed} matches expected ${info.expected}`
      : info.status === "outdated"
        ? `Aura CLI ${info.installed} is out of sync — shell expects ${info.expected}. Click for install command.`
        : info.status === "missing"
          ? "Aura CLI not found on PATH. Click for install command."
          : "Aura CLI version could not be determined. Click for details.";

  // Install command shown in the popover. Cargo path is the canonical
  // route today; the bundled installer also exists but isn't a one-line
  // copy-paste, so we surface cargo here and link the docs URL.
  const installCmd = `cargo install --git https://github.com/Naridon-Inc/aura aura-cli`;

  function copyInstall() {
    navigator.clipboard
      ?.writeText(installCmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <Item
        dot={dotTone === "green" ? undefined : dotTone}
        title={titleText}
        onClick={() => setOpen((v) => !v)}
        tone={dotTone === "green" ? undefined : dotTone === "amber" ? "amber" : "red"}
      >
        {dotTone === "green" && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--color-accent-green, #10b981)" }}
            aria-hidden
          />
        )}
        <span>{labelText}</span>
      </Item>
      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 rounded-md shadow-lg z-50 p-3 text-[11.5px]"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
            minWidth: 320,
            color: "var(--color-text-2)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-text-1">Aura CLI</span>
            {onRefresh && (
              <button
                type="button"
                onClick={() => {
                  onRefresh();
                }}
                className="text-[10.5px] px-1.5 py-0.5 rounded hover:bg-bg-2 text-text-3"
                title="Re-run the version check"
              >
                Refresh
              </button>
            )}
          </div>
          <dl className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-2">
            <dt className="text-text-4">Status</dt>
            <dd
              style={{
                color:
                  dotTone === "green"
                    ? "var(--color-accent-green, #10b981)"
                    : dotTone === "amber"
                      ? "var(--color-amber, #d97706)"
                      : "var(--color-red, #ef4444)",
              }}
            >
              {info.status}
            </dd>
            <dt className="text-text-4">Installed</dt>
            <dd className="font-mono tabular-nums">
              {info.installed ?? "—"}
            </dd>
            <dt className="text-text-4">Expected</dt>
            <dd className="font-mono tabular-nums">{info.expected}</dd>
            {info.path && (
              <>
                <dt className="text-text-4">Path</dt>
                <dd className="font-mono text-[10.5px] truncate" title={info.path}>
                  {info.path}
                </dd>
              </>
            )}
            {info.raw && info.raw !== `aura ${info.installed}` && (
              <>
                <dt className="text-text-4">Raw</dt>
                <dd className="font-mono text-[10.5px] text-text-3 truncate" title={info.raw}>
                  {info.raw}
                </dd>
              </>
            )}
          </dl>
          {info.status !== "ok" && info.status !== "unknown" && (
            <div className="mt-3 pt-2 border-t border-line-soft">
              {/* One-click update — installs the binary bundled with this
                  release in place. No terminal, no cargo compile. */}
              {onUpdate && (
                <button
                  type="button"
                  onClick={() => void runUpdate()}
                  disabled={updating}
                  className="w-full text-[11.5px] px-2 py-1.5 rounded mb-2 transition-colors disabled:opacity-60"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-bg-0)",
                    fontWeight: 500,
                    cursor: updating ? "default" : "pointer",
                  }}
                  title="Install the CLI bundled with this app version"
                >
                  {updating
                    ? "Updating…"
                    : info.status === "missing"
                      ? `Install Aura CLI ${info.expected}`
                      : `Update to ${info.expected}`}
                </button>
              )}
              {updateError && (
                <div
                  className="text-[10.5px] mb-2"
                  style={{ color: "var(--color-red, #ef4444)" }}
                >
                  {updateError}
                </div>
              )}
              <div className="text-text-4 mb-1">or install manually:</div>
              <div className="flex items-center gap-1.5">
                <code
                  className="flex-1 font-mono text-[10.5px] px-1.5 py-1 rounded bg-bg-2 truncate"
                  title={installCmd}
                >
                  {installCmd}
                </code>
                <button
                  type="button"
                  onClick={copyInstall}
                  className="text-[10.5px] px-2 py-1 rounded hover:bg-bg-2 text-text-3"
                  title="Copy install command"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One inset chip — a ~20px rounded cell centered in the 28px bar. Hover
// background only when interactive (`onClick` set). Alert tones (red /
// amber) carry a faint tinted background so they read as a state, not
// just colored text. Chips are separated by gaps in their container, so
// there are no per-item dividers here.
function Item({
  icon,
  label,
  children,
  onClick,
  title,
  dim,
  tone,
  iconTone,
  dot,
}: {
  icon?: React.ReactNode;
  label?: string;
  children?: React.ReactNode;
  onClick?: () => void;
  title?: string;
  dim?: boolean;
  tone?: "red" | "amber";
  iconTone?: "green";
  dot?: "red" | "amber";
}) {
  const interactive = !!onClick;
  const fg =
    tone === "red"
      ? "var(--color-red)"
      : tone === "amber"
        ? "var(--color-amber, #d97706)"
        : dim
          ? "var(--color-text-4)"
          : "var(--color-text-2)";
  const toneBg =
    tone === "red"
      ? "bg-red-500/10"
      : tone === "amber"
        ? "bg-amber-500/10"
        : "";
  const className = `inline-flex items-center gap-1.5 h-[20px] px-2 rounded-[6px] whitespace-nowrap flex-none transition-colors ${toneBg} ${
    interactive ? "hover:bg-bg-2 cursor-pointer" : ""
  }`;
  const content = (
    <>
      {dot && <Dot tone={dot} />}
      {icon && (
        <span
          className="flex items-center"
          style={{ color: iconTone === "green" ? "var(--color-accent-green)" : "var(--color-text-3)" }}
        >
          {icon}
        </span>
      )}
      {label !== undefined && <span className="truncate max-w-[180px]">{label}</span>}
      {children}
    </>
  );
  const node = interactive ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className={className}
      style={{ color: fg }}
    >
      {content}
    </button>
  ) : (
    <span aria-label={title} className={className} style={{ color: fg }}>
      {content}
    </span>
  );
  // Footer chips carried only a native `title=` (no styling, no delay
  // control). Route it through the shared Radix tooltip so every chip
  // reads consistently with the topbar chrome. No `title` → no tooltip.
  if (!title) return node;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{node}</TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  );
}

// First-class branch control — the footer's leftmost, most prominent
// chip. Replaces the old read-only branch Pill that lived in the TopBar
// StatusPills. Does what VS Code's branch item does:
//
//   • shows the current branch + a dirty dot when the tree has changes
//   • click → upward popover: filter input, "create new branch", the
//     local branches (current marked, each with its last-commit subject),
//     and remote branches grouped below
//   • clicking a branch checks it out (remote names DWIM to a local
//     tracking branch via the Rust `git_checkout`); errors (e.g. dirty
//     tree) surface inline, humanized
//   • create types a name → `git checkout -b`
//
// Current branch is polled every 5s (cheap `git_branch`); the full list
// is fetched lazily each time the popover opens so it's always fresh.
function BranchSwitcher({ repoRoot, dirty }: { repoRoot: string; dirty: boolean }) {
  const [branch, setBranch] = useState<string | null>(null);
  // The caret opens the rich Cmd-K branch switcher (the same modal the Git view
  // header uses). The chip itself still polls the current branch so the footer
  // label + dirty pill stay honest when the branch changes elsewhere.
  const [modalOpen, setModalOpen] = useState(false);

  // Poll the current branch — cheap, and keeps the chip honest when the
  // branch changes outside the switcher (terminal checkout, agent, etc.). A
  // post-checkout signal also refreshes it immediately.
  useEffect(() => {
    if (!repoRoot) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const b = (await api.gitBranch(repoRoot)).trim();
        if (!cancelled) setBranch(b || null);
      } catch {
        if (!cancelled) setBranch(null);
      }
    };
    void poll();
    const id = window.setInterval(poll, 5000);
    window.addEventListener("aura:git-changed", poll);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("aura:git-changed", poll);
    };
  }, [repoRoot]);

  // An Aura "copy" is a parallel workspace an agent works in — a machine git
  // worktree with a hash branch like `worktree-agent-a6f18ff…`. Surfacing that
  // raw branch reads as gibberish to the non-engineer audience, so when we're in
  // one we show the Aura blossom + the friendly "<project> · copy" name instead.
  const isCopy =
    isWorktreeRoot(repoRoot) || (!!branch && isMachineLeaf(branch));
  const copyLabel = isCopy ? humanizeWorkspaceName(repoRoot) : null;
  const branchTitle = isCopy
    ? `${copyLabel} — an Aura copy: a parallel workspace an agent works in${
        branch ? ` (branch ${branch})` : ""
      }${dirty ? " · uncommitted changes" : ""} — open source control`
    : branch
      ? `On branch ${branch}${dirty ? " · uncommitted changes" : ""} — open source control`
      : repoRoot
        ? "Not on a branch right now — open source control"
        : "This folder isn't tracked yet — open source control";

  return (
    <div className="relative flex items-center flex-none">
      <div
        className="inline-flex items-center h-[20px] rounded-[6px] overflow-hidden flex-none"
        style={{ maxWidth: 240 }}
      >
        {/* Branch name → the full Source Control surface (Changes + History). */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("aura:open-source-control"))
              }
              aria-label={branchTitle}
              className="inline-flex items-center gap-1.5 h-full pl-2 pr-1 whitespace-nowrap transition-colors hover:bg-bg-2"
              style={{ color: "var(--color-text-1)" }}
            >
              {isCopy ? (
                // An agent's parallel copy wears a soft accent-tinted "block
                // box" with the Aura mark + its place-name — a calm, branded
                // pill so a non-engineer reads "this is an Aura copy" at a
                // glance instead of a raw branch hash.
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-px rounded-[5px] font-medium truncate"
                  style={{
                    background:
                      "color-mix(in srgb, var(--color-accent) 13%, transparent)",
                    color: "var(--color-accent)",
                  }}
                >
                  <AuraMark size={11} className="shrink-0" title="Aura copy" />
                  <span className="truncate">{copyLabel}</span>
                </span>
              ) : (
                <>
                  <GitBranch size={12} className="text-text-3 shrink-0" />
                  <span className="truncate font-medium">{branch ?? "—"}</span>
                </>
              )}
              {dirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: "var(--color-accent)" }}
                  aria-hidden
                />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{branchTitle}</TooltipContent>
        </Tooltip>
        {/* Caret → the rich Cmd-K branch switcher. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              aria-label="Switch branch"
              className="inline-flex items-center h-full px-1 text-text-3 transition-colors hover:bg-bg-2 hover:text-text-1"
            >
              <Caret />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Switch branch</TooltipContent>
        </Tooltip>
      </div>
      {modalOpen && repoRoot && (
        <BranchSwitcherModal
          repoRoot={repoRoot}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function Dot({ tone }: { tone: "red" | "amber" }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{
        background: tone === "red" ? "var(--color-red)" : "var(--color-amber, #d97706)",
      }}
    />
  );
}

function Caret() {
  return (
    <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 1.5A1.5 1.5 0 014.5 0h5L13 3.5V14a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 14V1.5z"
        stroke="currentColor"
        fill="none"
      />
    </svg>
  );
}

// Persistent in-call strip — v0.2.24 (HH.6).
//
// Replaces the old 11px-icon-only "status pill". When the user is in
// (or joining) a huddle this renders a full inline strip with labelled
// controls — visible from anywhere in the app shell, regardless of
// sidebar tab or collapse state, because StatusBar is mounted at the
// app shell level:
//
//     🎙 #design   🎤 Mic [VU]   🔇 Deafen   🖥 Screen   ⏏ Leave
//
//   • channel chip — click focuses the chat channel + un-minimizes
//     CallPanel
//   • Mic — toggles `setMicEnabledPreference` (persists across calls,
//     writes through to LiveKit when live). VU bar renders right of the
//     icon while mic is enabled, fed by the separate `useCallMicLevel`
//     atom (10Hz, doesn't re-render the rest of the snapshot consumers).
//   • Deafen — toggles `setDeafenedPreference` (mutes RoomAudioRenderer
//     <audio> elements; the dock has a 1s re-apply loop for newcomers)
//   • Screen — tri-state matching VoiceDockPanel (HH.5):
//        - localSharing  → red dot, stops my share
//        - remoteSharing → opens the screenshare workpane tab
//        - idle          → starts my share
//   • Leave — calls `leaveCall()` (dispatches `aura:leave-huddle` →
//     HuddleUI hardLeave → callStore.clearCall via epoch guard)
//
// Subtle background tint signals call state at a glance:
//     emerald/10 while connected, amber/10 while connecting.
//
// The whole strip carries `data-incall-control="true"` so the
// Esc-to-leave keydown handler (HH.9) can scope itself to in-call
// surfaces and not steal Esc from the chat composer or Monaco.
//
// State comes from the callStore singleton (no Context). Toggles
// dispatch into the live LocalParticipant via the store's imperative
// helpers — the UI doesn't import LiveKit at all.
function CallStatusPill({ suppressed = false }: { suppressed?: boolean }) {
  const snap = useCallSnapshot();
  // Track preference state via local mirror so the strip re-renders
  // immediately on toggle (the localStorage write isn't observable).
  const [micPref, setMicPref] = useState<boolean>(() =>
    getMicEnabledPreference(),
  );
  const [deafenPref, setDeafenPref] = useState<boolean>(() =>
    getDeafenedPreference(),
  );
  useEffect(() => {
    // Re-sync prefs whenever the call state changes (e.g. join applies
    // them and may have flipped LiveKit underneath).
    setMicPref(getMicEnabledPreference());
    setDeafenPref(getDeafenedPreference());
  }, [snap.active, snap.connecting]);

  if (!snap.active && !snap.connecting) return null;
  // The pill suppression flag is kept for callers that still wire it
  // (legacy compact StatusBar consumers). With the new strip the dock
  // is no longer the sole surface — both are first-class. Suppression
  // now only hides while a caller explicitly opts out.
  if (suppressed) return null;

  const channelLabel = snap.channel
    ? `#${snap.channelName ?? snap.channel}`
    : "Huddle";
  const localSharing = snap.screenshareEnabled;
  const remoteSharing = snap.screenshareTracks.some((t) => !t.isLocal);
  const remoteShareCount = snap.screenshareTracks.filter(
    (t) => !t.isLocal,
  ).length;

  function focusChannel() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:focus-channel", {
        detail: { repoRoot: snap.repoRoot, channel: snap.channel },
      }),
    );
  }

  function openShareTab() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:open-screenshare", {
        detail: {
          workpaneId: callScreenshareWorkpaneId(snap.repoRoot, snap.channel),
          repoRoot: snap.repoRoot,
          channel: snap.channel,
        },
      }),
    );
  }

  function toggleScreenshare() {
    if (!snap.repoRoot || !snap.channel) return;
    window.dispatchEvent(
      new CustomEvent("aura:toggle-screenshare", {
        detail: { repoRoot: snap.repoRoot, channel: snap.channel },
      }),
    );
  }

  function onScreenClick() {
    if (localSharing) toggleScreenshare();
    else if (remoteSharing) openShareTab();
    else toggleScreenshare();
  }

  function onMicClick() {
    const next = !micPref;
    setMicPref(next);
    void setMicEnabledPreference(next);
  }

  function onDeafenClick() {
    const next = !deafenPref;
    setDeafenPref(next);
    setDeafenedPreference(next);
  }

  // Connecting state — same strip shape, amber tint, controls disabled
  // because LiveKit isn't live yet. Channel chip + Leave still work
  // (Leave cancels the pending join via the CallPanel fallback).
  const isConnecting = snap.connecting && !snap.active;
  const stripBg = isConnecting
    ? "rgba(217, 119, 6, 0.10)"
    : "rgba(16, 185, 129, 0.10)";

  return (
    <span
      data-incall-control="true"
      className="inline-flex items-stretch border-r border-line-soft"
      style={{ background: stripBg }}
    >
      <button
        type="button"
        onClick={focusChannel}
        title={
          isConnecting
            ? `Joining ${channelLabel}…`
            : `In huddle — click to focus ${channelLabel}`
        }
        className="inline-flex items-center gap-1.5 px-2 hover:bg-bg-2 transition-colors"
        style={{ color: "var(--color-text-1)" }}
      >
        <span
          className={`inline-block w-2 h-2 rounded-full ${isConnecting ? "animate-pulse" : ""}`}
          style={{
            background: isConnecting
              ? "var(--color-amber, #d97706)"
              : "var(--color-accent-green, #10b981)",
          }}
          aria-hidden
        />
        <span className="truncate max-w-[160px] font-medium text-[11px]">
          {channelLabel}
        </span>
      </button>

      <button
        type="button"
        onClick={onMicClick}
        disabled={isConnecting}
        title={micPref ? "Mute mic" : "Unmute mic"}
        aria-label={micPref ? "Mute mic" : "Unmute mic"}
        className="inline-flex items-center gap-1.5 px-2 hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
        style={{
          color: micPref
            ? "var(--color-text-2)"
            : "var(--color-red, #ef4444)",
        }}
      >
        {micPref ? <Mic size={12} /> : <MicOff size={12} />}
        <span className="hidden lg:inline text-[11px]">{micPref ? "Mic" : "Muted"}</span>
        {micPref && !isConnecting && <MicVuBar />}
      </button>

      <button
        type="button"
        onClick={onDeafenClick}
        disabled={isConnecting}
        title={deafenPref ? "Un-deafen" : "Deafen (mute everyone)"}
        aria-label={deafenPref ? "Un-deafen" : "Deafen"}
        className="inline-flex items-center gap-1.5 px-2 hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
        style={{
          color: deafenPref
            ? "var(--color-red, #ef4444)"
            : "var(--color-text-2)",
        }}
      >
        {deafenPref ? <HeadphoneOff size={12} /> : <Headphones size={12} />}
        <span className="hidden lg:inline text-[11px]">{deafenPref ? "Deafened" : "Audio"}</span>
      </button>

      <button
        type="button"
        onClick={onScreenClick}
        disabled={isConnecting}
        title={
          localSharing
            ? "Stop sharing your screen"
            : remoteSharing
              ? `Open screenshare${remoteShareCount > 1 ? ` (${remoteShareCount} sharing)` : ""}`
              : "Share your screen"
        }
        aria-label={
          localSharing
            ? "Stop screen share"
            : remoteSharing
              ? "View screen share"
              : "Start screen share"
        }
        className="relative inline-flex items-center gap-1.5 px-2 hover:bg-bg-2 transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
        style={{
          color: localSharing
            ? "var(--color-red, #ef4444)"
            : remoteSharing
              ? "var(--color-accent-blue, #3b82f6)"
              : "var(--color-text-2)",
        }}
      >
        {localSharing ? <MonitorOff size={12} /> : <Monitor size={12} />}
        <span className="hidden lg:inline text-[11px]">
          {localSharing
            ? "Stop"
            : remoteSharing
              ? `View${remoteShareCount > 1 ? ` (${remoteShareCount})` : ""}`
              : "Screen"}
        </span>
        {!localSharing && remoteSharing && remoteShareCount > 1 && (
          <span className="lg:hidden text-[10px] font-medium">
            {remoteShareCount}
          </span>
        )}
        {localSharing && (
          <span
            className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--color-red, #ef4444)" }}
            aria-hidden
          />
        )}
      </button>

      <button
        type="button"
        onClick={() => leaveCall()}
        title="Leave huddle (Esc)"
        aria-label="Leave huddle"
        className="inline-flex items-center gap-1.5 px-2 hover:bg-red-500/15 transition-colors"
        style={{ color: "var(--color-red, #ef4444)" }}
      >
        <PhoneOff size={12} />
        <span className="text-[11px] font-medium">Leave</span>
      </button>
    </span>
  );
}

// Mic VU meter — 12×4 bar fed by the callStore micLevel atom. Lives
// in its own component so re-renders at 10Hz don't bubble into the
// rest of the StatusBar (the parent <CallStatusPill> doesn't subscribe
// to micLevel). Green at low/mid level, amber when peaking (>0.8).
function MicVuBar() {
  const level = useCallMicLevel();
  // Smooth the bar — raw audioLevel is jittery at low input. A simple
  // perceptual curve (sqrt) makes the meter responsive to quiet speech
  // without pinning at the top during normal volume.
  const visual = Math.sqrt(Math.max(0, Math.min(1, level)));
  const widthPx = Math.round(visual * 12);
  const peaking = level > 0.8;
  return (
    <span
      className="relative inline-block bg-bg-2 rounded-sm overflow-hidden"
      style={{ width: 12, height: 4 }}
      aria-hidden
    >
      <span
        className="absolute left-0 top-0 bottom-0 transition-[width] duration-75"
        style={{
          width: widthPx,
          background: peaking
            ? "var(--color-amber, #d97706)"
            : "var(--color-accent-green, #10b981)",
        }}
      />
    </span>
  );
}
