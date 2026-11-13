// Aura settings: one full-window page with the page list on the left and
// the chosen page on the right. Reachable from the sidebar gear and ⌘,.
//
// Every page saves as you change it, so there is no Save button; Back (or
// Esc) returns to where you were. Settings the shell can't safely change
// over IPC (strict-mode passcode, cloud key rotation, signing-key import)
// stay in `aura config` / `aura keys`, and the pages point there.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, FileCode2, FolderGit2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, type SettingsView } from "../../lib/api";
import { beginWindowDrag } from "../../lib/windowDrag";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Select } from "../ui/select";
import { SettingsError } from "../ui/settings-blocks";
import { SettingsLayout } from "../ui/settings-layout";
import {
  foldOfLink,
  isRepoPage,
  navigationGroups,
  pageActsOnRepo,
  pageLabel,
  repoName,
  repoPageOf,
  resolvePageLink,
  visiblePages,
  type FoldedPageId,
  type SettingsLink,
  type SettingsPage,
} from "../settings/nav";
import { SettingsPageView } from "../settings/SettingsPageView";
import { ProjectAvatar } from "../ProjectAvatar";
import { AccountSwitcher } from "../nav/AccountSwitcher";
import { useAccountStanding } from "../nav/useAccountStanding";

type SettingsDialogProps = {
  open: boolean;
  repoRoot: string;
  /** Every open/recent workspace root, so the account and repository pages
   *  cover each project at once. Falls back to just `repoRoot`. */
  openRoots?: string[];
  onClose: () => void;
};

// The page list's header and the toolbar are the window's title bar here,
// so they drag the window like the app's own top bar does. Controls inside
// them keep their clicks.
function dragFromChrome(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!target.closest(".ui-sidebar-header, .ui-settings-toolbar")) return;
  if (target.closest("button, input, a, [role=button], [role=combobox]")) return;
  if (e.detail === 2) {
    getCurrentWindow().toggleMaximize().catch(() => {});
    return;
  }
  beginWindowDrag();
}

export function SettingsDialog({ open, repoRoot, openRoots, onClose }: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>("general");
  const [query, setQuery] = useState("");
  const [repoPick, setRepoPick] = useState<string | null>(null);
  // The part of the page a link asked for, brought into view once it draws.
  const [foldAsked, setFoldAsked] = useState<FoldedPageId | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every distinct project open in the app, the current one first.
  const roots = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [repoRoot, ...(openRoots ?? [])]) {
      if (r && !seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
    return out;
  }, [repoRoot, openRoots]);

  // The project a repository-scoped page acts on: the one last opened from
  // the Repositories list or the toolbar picker, else the current one.
  const activeRepo = repoPick && roots.includes(repoPick) ? repoPick : repoRoot;

  // Go to a page, or to a part folded into one: its page opens with that
  // part's Advanced open and the part scrolled into view.
  const go = useCallback(
    (link: SettingsLink, repo: string = activeRepo) => {
      const next = resolvePageLink(link, repo);
      if (!next) return;
      const root = repoPageOf(next)?.root;
      if (root) setRepoPick(root);
      setPage(next);
      setFoldAsked(foldOfLink(link));
    },
    [activeRepo],
  );

  // Callers can open a particular page: `aura:open-settings` may carry
  // `{ pane }`. App's own listener flips `open`; this one steers the page.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail as { pane?: string } | undefined;
      if (!detail?.pane) return;
      go(detail.pane as SettingsLink, repoRoot);
    }
    window.addEventListener("aura:open-settings", onOpen as EventListener);
    return () => window.removeEventListener("aura:open-settings", onOpen as EventListener);
  }, [go, repoRoot]);

  const reload = useCallback(async () => {
    try {
      setView(await api.settingsLoad());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  // Reveal the settings file backing your preferences or a project's, in
  // Finder. Falls back to the `.aura` folder if the file isn't written yet.
  const revealSettingsToml = useCallback(
    async (which: "user" | "repo") => {
      try {
        const base = which === "repo" && activeRepo ? activeRepo : await api.homeDir();
        const auraDir = `${base}/.aura`;
        try {
          await api.fsRevealInFinder(`${auraDir}/settings.toml`);
        } catch {
          await api.fsRevealInFinder(auraDir);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [activeRepo],
  );

  const groups = useMemo(() => navigationGroups(roots, query), [roots, query]);

  // A folded part sits under whatever the page loads above it, so it is
  // looked for again as the page fills in rather than once.
  useEffect(() => {
    if (!open || !foldAsked) return;
    const reveal = () =>
      document
        .querySelector(`[data-fold="${foldAsked}"]`)
        ?.scrollIntoView({ block: "start" });
    const timers = [0, 200, 700].map((ms) => window.setTimeout(reveal, ms));
    const done = window.setTimeout(() => setFoldAsked(null), 800);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearTimeout(done);
    };
  }, [open, foldAsked, page]);

  // A search that hides the open page moves to the first page it found, so
  // the right side never shows a page the list no longer offers.
  useEffect(() => {
    const visible = visiblePages(groups);
    if (visible.length > 0 && !visible.includes(page)) go(visible[0] as SettingsPage);
  }, [groups, page, go]);

  // Esc returns to the previous surface, unless a menu or select inside the
  // page already used it to close itself.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const repoScoped = pageActsOnRepo(page) && !isRepoPage(page);
  const repoPageRoot = repoPageOf(page)?.root;
  const toolbar = (
    <>
      {repoPageRoot && (
        <span className="ui-settings-toolbar-repo">
          <ProjectAvatar root={repoPageRoot} name={repoName(repoPageRoot)} />
          {repoName(repoPageRoot)}
        </span>
      )}
      {repoScoped && roots.length > 1 && (
        <Select
          aria-label="Repository"
          value={activeRepo}
          onChange={setRepoPick}
          align="end"
          options={roots.map((root) => ({ value: root, label: repoName(root) }))}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <FileCode2 />
            Open settings.toml
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void revealSettingsToml("user")}>
            <FileCode2 />
            Your settings.toml
          </DropdownMenuItem>
          {activeRepo && (
            <DropdownMenuItem onSelect={() => void revealSettingsToml("repo")}>
              <FolderGit2 />
              {repoName(activeRepo)} settings.toml
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    // A full-window surface that covers the app and takes Escape is a modal,
    // so it says so; the page list names where you are.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-40"
      onMouseDown={dragFromChrome}
    >
      <SettingsLayout
        title={pageLabel(page)}
        groups={groups}
        selected={page}
        onSelect={(id) => go(id as SettingsPage)}
        onBack={onClose}
        query={query}
        onQueryChange={setQuery}
        account={<SettingsAccount repoRoot={repoRoot} />}
        toolbar={toolbar}
      >
        {error && <SettingsError>{error}</SettingsError>}
        {/* Which page is on screen, in the DOM, for anything driving the
            app from outside. */}
        <div data-pane={page} style={{ display: "contents" }}>
          <SettingsPageView
            page={page}
            view={view}
            repoRoot={activeRepo}
            currentRepo={repoRoot}
            roots={roots}
            query={query}
            foldAsked={foldAsked}
            reload={reload}
            onClose={onClose}
            go={go}
          />
        </div>
      </SettingsLayout>
    </div>
  );
}

/** The same account row and menu the sidebar has, so who you are and
 *  which organization you act as stay in view while you change settings.
 *  Its own component so the account is only read while settings is open. */
function SettingsAccount({ repoRoot }: { repoRoot: string }) {
  return <AccountSwitcher account={useAccountStanding(repoRoot)} />;
}
