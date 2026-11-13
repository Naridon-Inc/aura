// The cloud's sidebar: the organization in the account row, Dashboard, Home,
// Create, Routines and Search, your workspaces and your team, and the plan in
// the footer. It stands where the local sidebar stands while the cloud place
// is open, on the same navigation chrome.

import { useState, type HTMLAttributes, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Cloud,
  Grid2X2,
  Home,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  Search,
} from "lucide-react";

import {
  openCloud,
  openCloudWorkspace,
  leaveCloud,
  setCloudCreating,
  setCloudPage,
  useCloudPlace,
  workOf,
} from "../../lib/cloudPlace";
import { planBadge } from "../../lib/cloudPlan";
import { messageOf, orgLabel, switchOrg, useCloudOrgs } from "../../lib/cloudOrgs";
import { useCloudPlan } from "../../lib/useCloudPlan";
import { beginWindowDrag } from "../../lib/windowDrag";
import { windowControlsInset } from "../topbar/windowControls";
import { AppNavigation, AppNavigationPlan, type AppNavigationItem } from "../ui/app-navigation";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { FirstWorkspace } from "../nav/roster/SidebarFirstWorkspace";
import { Button } from "../ui/button";
import { CloudOrganizationGlyph, CloudWorkspaceGlyph, type CloudMember } from "../ui/cloud-workspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { SidebarGroup, SidebarItem } from "../ui/sidebar";
import { WorkspaceHoverPreview } from "../ui/workspace-preview-card";
import { usePokes } from "../../lib/cloudTeamPrefs";
import { useCloudPlaceData } from "./cloudPlaceStore";
import { pokeMember } from "./cloudPokes";
import { PUBLIC_ROW_PREFIX } from "./cloudRows";
import { useCloudFollowing } from "./cloudTeamStore";
import { myWorkspaces, useCloudNow, useCloudRows } from "./useCloudRows";
import { CreateOrgDialog } from "../settings/org/CreateOrgDialog";
import "../ui/cloud-patterns.css";

const openSettings = (pane: string) =>
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane } }));

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

/** A teammate's row menu: their workspaces on Home, a poke. */
function TeammateMenu({ member, isMe, pokes }: { member: CloudMember; isMe: boolean; pokes: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="iconXs" variant="ghost" aria-label={`${member.name} actions`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => openCloud("home", [member.id])}>
          {isMe ? "Your workspaces" : "Their workspaces"}
        </DropdownMenuItem>
        {pokes && !isMe && (
          <DropdownMenuItem onSelect={() => void pokeMember(member.id, member.name)}>Poke</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({ member, className }: { member: CloudMember; className?: string }) {
  return (
    <span
      className={`ui-cloud-avatar ui-cloud-avatar-static${className ? ` ${className}` : ""}`}
      style={{ background: member.color }}
      data-active={member.active}
      role="img"
      aria-label={member.name}
    >
      {member.photo ? <img src={member.photo} alt="" draggable={false} /> : member.initials}
    </span>
  );
}

/** Opens Settings → Billing, where the plan is read and an upgrade is bought. */
export function useOpenPlans(): { open: () => void } {
  return { open: () => openSettings("billing") };
}

function CloudAccount({ orgName, local = true }: { orgName: string; local?: boolean }) {
  const [open, setOpen] = useState(false);
  const { orgs, loading, loaded, error } = useCloudOrgs(open);
  const [failed, setFailed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const plans = useOpenPlans();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ui-nav-account" aria-label="Account menu">
          <CloudOrganizationGlyph size={18} />
          <strong>{orgName || "Cloud"}</strong>
          <ChevronDown size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[232px]">
        {local && (
          <DropdownMenuItem onSelect={leaveCloud}>
            <Monitor />
            My workspace <span className="ml-auto opacity-70">Local</span>
          </DropdownMenuItem>
        )}
        {loading && !loaded ? (
          <DropdownMenuItem disabled>
            <AsciiSpinner size={11} />
            Loading your orgs…
          </DropdownMenuItem>
        ) : error || failed ? (
          <DropdownMenuItem disabled>
            <Cloud />
            <span className="truncate">{error ?? failed}</span>
          </DropdownMenuItem>
        ) : (
          orgs.map((org) => (
            <DropdownMenuItem
              key={org.slug}
              onSelect={() => {
                if (org.current) return;
                setFailed(null);
                switchOrg(org.slug).catch((e: unknown) => setFailed(messageOf(e)));
              }}
            >
              <Cloud />
              <span className="truncate">{orgLabel(org)}</span>
              {org.current && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings("computer")}>Cloud computer</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("team")}>Members</DropdownMenuItem>
        <DropdownMenuItem onSelect={plans.open}>Billing</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setCreating(true)}>Create organization…</DropdownMenuItem>
      </DropdownMenuContent>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </DropdownMenu>
  );
}

export interface CloudSidebarProps {
  fullscreen: boolean;
  onHide: () => void;
  onBack?: () => void;
  onForward?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  /** The organization overseen rather than worked in, as the web console
   *  draws it: Home, then the host's own pages, then the Team. No workspace
   *  lists, nothing that starts work, and no way back to this computer.
   *  `away` is true while one of the host's pages is open, so Home and the
   *  Team rows don't read as selected over it. The app passes none. */
  oversee?: { items: AppNavigationItem[]; away: boolean };
}

export function CloudSidebar({
  fullscreen,
  onHide,
  onBack,
  onForward,
  canBack,
  canForward,
  oversee,
}: CloudSidebarProps) {
  const place = useCloudPlace();
  const data = useCloudPlaceData();
  // The ages beside each workspace are a reading of the clock, so the clock
  // has to keep moving — read once at mount, a row stayed "just now" forever.
  const nowMs = useCloudNow(data);
  const rows = useCloudRows(data, nowMs);
  const plan = useCloudPlan();
  const plans = useOpenPlans();
  const following = useCloudFollowing();
  const pokes = usePokes();
  // Home's avatars are the people here now; nobody is drawn as here who isn't.
  const online = rows.members.filter((m) => rows.activeIds.has(m.id) && m.id !== rows.me);

  const here = !oversee?.away;
  const home: AppNavigationItem = {
    id: "home",
    label: "Home",
    icon: <Home size={14} />,
    selected: here && place.page === "home" && !workOf(place),
    trailing: online.length ? (
      <span className="ui-cloud-home-avatars" aria-label={`${online.length} online`}>
        {online.slice(0, 3).map((m) => (
          <Avatar key={m.id} member={m} />
        ))}
      </span>
    ) : undefined,
    // All of Home: a Team row's narrowing ends here.
    onSelect: () => openCloud("home"),
  };
  const items: AppNavigationItem[] = oversee ? [home, ...oversee.items] : [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <Grid2X2 size={14} />,
      selected: place.page === "dashboard",
      onSelect: () => setCloudPage("dashboard"),
    },
    home,
    {
      id: "create",
      label: "Create",
      icon: <Plus size={14} />,
      onSelect: () => setCloudCreating(true),
    },
    {
      id: "routines",
      label: "Routines",
      icon: <Play size={14} />,
      selected: place.page === "routines",
      onSelect: () => setCloudPage("routines"),
    },
    {
      id: "search",
      label: "Search",
      icon: <Search size={14} />,
      onSelect: () => {
        setCloudPage("home");
        window.setTimeout(() => {
          document.querySelector<HTMLInputElement>(".ui-cloud-home input[type=search], .ui-cloud-home input")?.focus();
        }, 0);
      },
    },
  ];

  const mine = myWorkspaces(rows);
  // Followed workspaces you didn't open: yours are already listed above.
  const followed = new Set(following.map((id) => `${PUBLIC_ROW_PREFIX}${id}`));
  const watched = rows.workspaces.filter(
    (w) => followed.has(w.id) && !w.archived && !mine.some((x) => x.id === w.id),
  );
  const glyphState = (w: (typeof mine)[number]) =>
    w.workflow.state === "working"
      ? "working"
      : w.stage === "done"
        ? "done"
        : w.stage === "canceled"
          ? "error"
          : "idle";

  return (
    <AppNavigation
      className="ui-cloud-navigation"
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
      account={<CloudAccount orgName={data.orgName} local={!oversee} />}
      items={items}
      groupTitle={null}
      footerStart={
        plan.state === "ready" ? (
          <button
            type="button"
            className="ui-cloud-plan-badge"
            data-free={plan.plan === "Free"}
            aria-label={`${plan.plan} plan`}
            title={
              plan.trialDays !== null
                ? `Trial · ${plan.trialDays} day${plan.trialDays === 1 ? "" : "s"} left`
                : "Plans and billing"
            }
            onClick={plans.open}
          >
            {planBadge(plan.plan)}
          </button>
        ) : plan.state === "signed_out" ? (
          <button
            type="button"
            className="ui-nav-plan"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:open-signin"))}
          >
            <AppNavigationPlan>Sign in</AppNavigationPlan>
          </button>
        ) : null
      }
      help={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="iconSm" aria-label="Help">
              <CircleHelp />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuItem onSelect={() => setCloudPage("onboarding")}>Getting started</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openSettings("computer")}>Cloud computer</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      onSettings={() => openSettings("computer")}
    >
      {!oversee && (
        <SidebarGroup title="My workspaces">
          {data.workspaces.state === "ready" && mine.length === 0 && (
            <FirstWorkspace onCreate={() => setCloudCreating(true)} />
          )}
          {mine.map((w) => (
            <WorkspaceHoverPreview key={w.id} workspace={w}>
              <div>
                <SidebarItem
                  label={w.title}
                  revealKey={`cloud-workspace:${w.id}`}
                  icon={<CloudWorkspaceGlyph state={glyphState(w)} />}
                  trailing={<span className="ui-cloud-sidebar-time">{w.timeLabel}</span>}
                  selected={place.page === "workspace" && place.workspaceId === w.id}
                  onClick={() => openCloudWorkspace(w.id)}
                />
              </div>
            </WorkspaceHoverPreview>
          ))}
        </SidebarGroup>
      )}
      {!oversee && watched.length > 0 && (
        <SidebarGroup title="Following">
          {watched.map((w) => (
            <WorkspaceHoverPreview key={w.id} workspace={w}>
              <div>
                <SidebarItem
                  label={w.title}
                  revealKey={`cloud-workspace:${w.id}`}
                  icon={<CloudWorkspaceGlyph state={glyphState(w)} />}
                  trailing={<span className="ui-cloud-sidebar-time">{w.timeLabel}</span>}
                  selected={place.page === "workspace" && place.workspaceId === w.id}
                  onClick={() => openCloudWorkspace(w.id)}
                />
              </div>
            </WorkspaceHoverPreview>
          ))}
        </SidebarGroup>
      )}
      {rows.members.length > 0 && (
        <SidebarGroup title="Team">
          {rows.members.map((m) => (
            <SidebarItem
              key={m.id}
              label={m.name}
              icon={<Avatar member={m} className="ui-cloud-team-avatar" />}
              selected={here && workOf(place) === m.id}
              onClick={() => openCloud("home", [m.id])}
              actions={<TeammateMenu member={m} isMe={m.id === rows.me} pokes={pokes} />}
            />
          ))}
        </SidebarGroup>
      )}
    </AppNavigation>
  );
}
