import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Grid2X2, History, Home, Plus, Search } from "lucide-react";
import { AppNavigation, AppNavigationPlan, type AppNavigationItem } from "../ui/app-navigation";
import { windowControlsInset } from "../topbar/windowControls";
import { beginWindowDrag } from "../../lib/windowDrag";
import { setNoticeSlot } from "./noticeSlot";
import { WhatsNewCard } from "../WhatsNewCard";
import { ShellNoticeStack } from "../ui/shell-notice";
import type { ReleaseCta, ReleaseNote } from "../../lib/releaseNotes";
import { AccountSwitcher } from "./AccountSwitcher";
import { HelpMenu } from "./HelpMenu";
import { useAccountStanding } from "./useAccountStanding";

/** Where the window is standing, as far as the primary rows are concerned. */
export type AppDestination = "dashboard" | "home" | "trace" | null;

export interface AppSidebarProps {
  repoRoot: string;
  fullscreen: boolean;
  active: AppDestination;
  onHide: () => void;
  onBack?: () => void;
  onForward?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  onDashboard: () => void;
  onHome: () => void;
  onCreate: () => void;
  onSearch: () => void;
  onTrace: () => void;
  /** Unresolved impact alerts Trace holds; shown beside its row. */
  traceCount?: number;
  whatsNew?: ReleaseNote;
  onDismissWhatsNew?: () => void;
  onWhatsNewCta?: (kind: ReleaseCta) => void;
  /** Account-level status after the plan badge — usage, the CLI's version
   *  when it drifts. Each piece renders nothing while there is nothing to say. */
  footerStatus?: ReactNode;
  children: ReactNode;
}

function dragWindow(event: MouseEvent) {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button, input, a, [role=button]")) return;
  if (event.detail === 2) {
    getCurrentWindow()
      .toggleMaximize()
      .catch(() => {});
    return;
  }
  beginWindowDrag();
}

/** The app's left column: header, account, primary destinations, workspaces, footer. */
export function AppSidebar({
  repoRoot,
  fullscreen,
  active,
  onHide,
  onBack,
  onForward,
  canBack,
  canForward,
  onDashboard,
  onHome,
  onCreate,
  onSearch,
  onTrace,
  traceCount,
  whatsNew,
  onDismissWhatsNew,
  onWhatsNewCta,
  footerStatus,
  children,
}: AppSidebarProps) {
  const account = useAccountStanding(repoRoot);
  const items: AppNavigationItem[] = [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <Grid2X2 size={14} />,
      selected: active === "dashboard",
      onSelect: onDashboard,
    },
    {
      id: "home",
      label: "Home",
      icon: <Home size={14} />,
      selected: active === "home",
      onSelect: onHome,
    },
    {
      id: "create",
      label: "Create",
      icon: <Plus size={14} />,
      shortcut: "⇧ ⌘ N",
      onSelect: onCreate,
    },
    {
      id: "search",
      label: "Search",
      icon: <Search size={14} />,
      shortcut: "⌘ K",
      onSelect: onSearch,
    },
    {
      id: "trace",
      label: "Trace",
      icon: <History size={14} />,
      selected: active === "trace",
      trailing: traceCount ? <span className="ui-nav-count">{traceCount}</span> : undefined,
      onSelect: onTrace,
    },
  ];
  return (
    <AppNavigation
      style={{ width: "100%" }}
      headerProps={{
        "data-tauri-drag-region": fullscreen ? undefined : true,
        onMouseDown: fullscreen ? undefined : dragWindow,
        style: { paddingLeft: windowControlsInset(true, fullscreen) },
      } as HTMLAttributes<HTMLDivElement>}
      onHide={onHide}
      onBack={onBack}
      onForward={onForward}
      canBack={canBack}
      canForward={canForward}
      account={<AccountSwitcher account={account} />}
      items={items}
      groupTitle={null}
      notice={
        <>
          {/* App-level notices draw here while the sidebar is on screen. */}
          <div ref={setNoticeSlot} />
          {whatsNew && (
            <ShellNoticeStack>
              <WhatsNewCard
                note={whatsNew}
                onDismiss={() => onDismissWhatsNew?.()}
                onCta={onWhatsNewCta}
              />
            </ShellNoticeStack>
          )}
        </>
      }
      footerStart={
        <>
          {account.plan ? (
            <button
              type="button"
              className="ui-nav-plan"
              title={account.title}
              aria-label={`${account.plan} plan — plans and billing`}
              onClick={() => window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "billing" } }))}
            >
              <AppNavigationPlan>{account.plan}</AppNavigationPlan>
            </button>
          ) : !account.connected ? (
            <button type="button" className="ui-nav-plan" onClick={account.openSignIn}>
              <AppNavigationPlan>Sign in</AppNavigationPlan>
            </button>
          ) : null}
          {footerStatus}
        </>
      }
      help={<HelpMenu />}
      onSettings={() => window.dispatchEvent(new CustomEvent("aura:open-settings"))}
    >
      {children}
    </AppNavigation>
  );
}
