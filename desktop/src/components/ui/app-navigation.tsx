import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowLeft, ArrowRight, ChevronDown, PanelLeft, Settings } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarItem,
} from "./sidebar";
import "./app-navigation.css";

export interface AppNavigationItem {
  id: string;
  label: string;
  icon: ReactNode;
  selected?: boolean;
  /** Shown on hover, e.g. "⌘ K". Only for shortcuts that are really bound. */
  shortcut?: string;
  /** Always-visible trailing text, such as a count. */
  trailing?: ReactNode;
  onSelect: () => void;
}

export interface AppNavigationProps {
  /** Spread onto the header row — window drag regions, inset for window controls. */
  headerProps?: HTMLAttributes<HTMLDivElement>;
  onHide?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  /** The account switcher row, usually an `AppNavigationAccount` inside a menu. */
  account?: ReactNode;
  items: AppNavigationItem[];
  /** `null` hands the whole content area to `children`, for a list that
   *  draws its own group header. */
  groupTitle?: string | null;
  groupAction?: ReactNode;
  /** The workspace list under the group title. */
  children?: ReactNode;
  /** Above the footer, outside the scrolling list: release notes and similar. */
  notice?: ReactNode;
  /** Left end of the footer: plan badge, account state. */
  footerStart?: ReactNode;
  /** Help menu button for the footer. */
  help?: ReactNode;
  onSettings?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function AppNavigation({
  headerProps,
  onHide,
  onBack,
  onForward,
  canBack,
  canForward,
  account,
  items,
  groupTitle = "My workspaces",
  groupAction,
  children,
  notice,
  footerStart,
  help,
  onSettings,
  className,
  style,
}: AppNavigationProps) {
  return (
    <Sidebar
      className={cn("ui-app-navigation", className)}
      aria-label="Workspace sidebar"
      style={style}
    >
      <SidebarHeader {...headerProps}>
        {onHide && (
          <Button variant="ghost" size="iconSm" aria-label="Hide sidebar" onClick={onHide}>
            <PanelLeft />
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="iconXs"
          aria-label="Go back"
          disabled={!canBack}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="iconXs"
          aria-label="Go forward"
          disabled={!canForward}
          onClick={onForward}
        >
          <ArrowRight />
        </Button>
      </SidebarHeader>
      {account}
      <nav className="ui-nav-primary" aria-label="Main navigation">
        {items.map((item) => (
          <SidebarItem
            key={item.id}
            label={item.label}
            icon={item.icon}
            selected={item.selected}
            onClick={item.onSelect}
            trailing={
              item.shortcut ? (
                <span className="ui-nav-shortcut">{item.shortcut}</span>
              ) : (
                item.trailing
              )
            }
          />
        ))}
      </nav>
      <SidebarContent>
        {groupTitle === null ? (
          children
        ) : (
          <SidebarGroup title={groupTitle} action={groupAction}>
            {children}
          </SidebarGroup>
        )}
      </SidebarContent>
      {notice}
      <SidebarFooter className="ui-nav-footer">
        {footerStart}
        <span style={{ flex: 1 }} />
        {help}
        {onSettings && (
          <Button variant="ghost" size="iconSm" aria-label="Settings" onClick={onSettings}>
            <Settings />
          </Button>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

export interface AppNavigationAccountProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  letter: string;
  label: string;
}

/** The account row under the header: letter avatar, name, chevron. */
export const AppNavigationAccount = forwardRef<HTMLButtonElement, AppNavigationAccountProps>(
  function AppNavigationAccount({ letter, label, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn("ui-nav-account", className)}
        aria-label="Account menu"
        {...props}
      >
        <span className="ui-nav-avatar" aria-hidden>
          {letter}
        </span>
        <strong>{label}</strong>
        <ChevronDown size={14} />
      </button>
    );
  },
);

export function AppNavigationPlan({ children }: { children: ReactNode }) {
  return <span className="ui-nav-plan-badge">{children}</span>;
}
