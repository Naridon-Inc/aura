// The cloud place's work area: Home, Dashboard, Routines, setup and one
// workspace, each the library's own screen over the organization's real data.
// A teammate has no page of their own: their Team row narrows Home to them.
//
// Every page but setup sits behind the plan gate, read from billing status.
// Where the plan couldn't be read the gate stays shut and says why instead of
// guessing a plan.

import { useEffect, type ReactNode } from "react";
import { ArrowLeft, SearchX } from "lucide-react";

import { openCloudThread } from "../../lib/editorStore";
import { planOpens, workspaceLink, type CloudFeature } from "../../lib/cloudPlan";
import {
  openCloudWorkspace,
  setCloudCreating,
  setCloudNotice,
  setCloudOwners,
  setCloudPage,
  useCloudPlace,
} from "../../lib/cloudPlace";
import { cloudApi, cloudProblem } from "../../lib/cloudWorkspacesApi";
import { useCloudPlan } from "../../lib/useCloudPlan";
import { Button } from "../ui/button";
import { CloudHome } from "../ui/cloud-home";
import { CloudFeatureGate, type CloudGateCopy } from "../ui/cloud-organization";
import { EmptyState, LoadingState } from "../ui/state";
import { WorkspaceDashboard } from "../ui/workspace-dashboard";
import { CLOUD_ROW_PREFIX } from "../workspaces/workspacesOverview";
import { CloudApiWorkspace } from "./CloudApiWorkspace";
import { CloudCreateDialog } from "./CloudCreateDialog";
import { cloudRepoPicture } from "./CloudRepoAvatar";
import { CloudRoutinesPage } from "./CloudRoutinesPage";
import { CloudAgentsHost } from "./CloudAgentsHost";
import { CloudSetupPage } from "./CloudSetupPage";
import { useOpenPlans } from "./CloudSidebar";
import { reloadCloudPlace, useCloudPlaceData, valueOf } from "./cloudPlaceStore";
import { PUBLIC_ROW_PREFIX, repoLabel, rowNumber } from "./cloudRows";
import { setViewingWorkspace } from "./cloudTeamStore";
import { useCloudNow, useCloudRows } from "./useCloudRows";
import "../ui/cloud-patterns.css";
import "../ui/cloud-place.css";

export function CloudPlacePage({
  repoRoot,
  toolbarTrailing,
  oversee = false,
}: {
  repoRoot: string;
  /** Switches the app puts at the end of Home's toolbar (Aura's panel). */
  toolbarTrailing?: ReactNode;
  /** The organization overseen from a browser (the web console): a chat
   *  starts, and is sent in, only where the org's Aura computer answers it by
   *  itself; any other is read here and driven from the app. */
  oversee?: boolean;
}) {
  const place = useCloudPlace();
  const data = useCloudPlaceData();
  const plan = useCloudPlan();
  const plans = useOpenPlans();
  // The sidebar's clock, so Home and the sidebar print the same age for the
  // same workspace.
  const nowMs = useCloudNow(data);
  const rows = useCloudRows(data, nowMs);
  const cloudOpen = plan.state === "ready" && planOpens(plan.plan, "cloud");

  // Teammates see which workspace you have open; leaving it, or the cloud,
  // says so at once.
  const viewingId =
    place.open && place.page === "workspace" && place.workspaceId?.startsWith(PUBLIC_ROW_PREFIX)
      ? place.workspaceId.slice(PUBLIC_ROW_PREFIX.length)
      : null;
  useEffect(() => setViewingWorkspace(viewingId), [viewingId]);
  useEffect(() => () => setViewingWorkspace(null), []);

  const openPlans = plans.open;

  // Create on a plan without the cloud lands on the gate that says so.
  useEffect(() => {
    if (place.creating && plan.state !== "loading" && !cloudOpen) {
      setCloudCreating(false);
      setCloudPage("home");
    }
  }, [place.creating, plan.state, cloudOpen]);

  const gate = (children: ReactNode, feature: CloudFeature = "cloud") => {
    if (plan.state === "loading") return <LoadingState label="Reading your organization’s plan…" />;
    let copy: CloudGateCopy | undefined;
    let onPlans = openPlans;
    if (plan.state === "signed_out") {
      copy = {
        title: "Sign in to Aura’s cloud",
        body: "Your organization’s workspaces, routines and machines are kept there.",
        action: "Sign in",
      };
      onPlans = () => window.dispatchEvent(new CustomEvent("aura:open-signin"));
    } else if (plan.state === "unread") {
      copy = { title: "Couldn’t read your organization’s plan", body: plan.why, action: "Try again" };
      onPlans = plan.refresh;
    }
    return (
      <CloudFeatureGate plan={plan.plan} feature={feature} onPlans={onPlans} copy={copy}>
        {children}
      </CloudFeatureGate>
    );
  };

  const open = (id: string) => {
    openCloudWorkspace(id);
    if (id.startsWith(CLOUD_ROW_PREFIX)) openCloudThread(id.slice(CLOUD_ROW_PREFIX.length), repoRoot);
  };

  const workspacesProblem = data.workspaces.state === "failed" ? data.workspaces.problem : null;
  const problemLine = workspacesProblem && (
    <div className="ui-cloud-session-banner" role="status">
      <span>{workspacesProblem.message}</span>
    </div>
  );

  if (place.page === "onboarding")
    return (
      <div className="ui-cloud-onboarding-frame ui-cloud-place-fullscreen">
        <header>
          <Button variant="ghost" size="sm" onClick={() => setCloudPage("home")}>
            <ArrowLeft />
            Back
          </Button>
          <span>{data.orgName || "Your organization"} · Cloud setup</span>
        </header>
        <CloudSetupPage
          repoRoot={repoRoot}
          data={data}
          rows={rows}
        />
        <CloudAgentsHost />
      </div>
    );

  let page: ReactNode;
  if (place.page === "routines") {
    page = gate(<CloudRoutinesPage data={data} rows={rows} nowMs={nowMs} onPlans={openPlans} />);
  } else if (place.page === "dashboard") {
    page = gate(
      <>
        {problemLine}
        <WorkspaceDashboard
          workspaces={rows.workspaces}
          onOpen={open}
          onMove={() =>
            setCloudNotice("A cloud workspace’s stage follows its work; it can’t be moved by hand yet.")
          }
          onAction={(id) => open(id)}
          onCreate={() => setCloudCreating(true)}
          onArchive={(id) => {
            if (!id.startsWith(PUBLIC_ROW_PREFIX)) {
              setCloudNotice("This conversation is archived from its own workspace.");
              return;
            }
            cloudApi
              .setWorkspaceState(id.slice(PUBLIC_ROW_PREFIX.length), "archive")
              .then(() => {
                setCloudNotice("Workspace archived.");
                void reloadCloudPlace();
              })
              .catch((e) => setCloudNotice(cloudProblem(e).message));
          }}
        />
      </>,
    );
  } else if (place.page === "workspace" && place.workspaceId?.startsWith(PUBLIC_ROW_PREFIX)) {
    const raw = place.workspaceId.slice(PUBLIC_ROW_PREFIX.length);
    const row = valueOf(data.workspaces, []).find((w) => w.id === raw);
    const title = rows.workspaces.find((w) => w.id === place.workspaceId)?.title ?? row?.objective ?? "";
    page = gate(
      row ? (
        <CloudApiWorkspace
          key={row.id}
          row={row}
          title={title || "Untitled workspace"}
          repository={repoLabel(valueOf(data.repos, []).find((r) => r.id === row.repo_id)?.full_name)}
          repositoryFullName={valueOf(data.repos, []).find((r) => r.id === row.repo_id)?.full_name ?? null}
          members={rows.members}
          me={rows.me}
          owner={rows.ownerByWorkspace[place.workspaceId]}
          logins={Object.fromEntries(
            valueOf(data.members, [])
              .filter((m) => m.github_login)
              .map((m) => [m.user_id, m.github_login]),
          )}
          link={workspaceLink(plan.cloudUrl, row.id)}
          panel={plan.state === "ready" && plan.plan !== "Free"}
          orgName={data.orgName}
          watching={oversee}
        />
      ) : data.workspaces.state === "loading" ? (
        <LoadingState label="Opening the workspace…" />
      ) : (
        <EmptyState
          icon={SearchX}
          title="You can’t open this workspace"
          body="It may be private and not shared with you, or it isn’t in this organization any more. Ask whoever opened it to share it with you."
          action={{ label: "Back to Home", onClick: () => setCloudPage("home") }}
        />
      ),
    );
  } else {
    page = gate(
      data.workspaces.state === "loading" && rows.workspaces.length === 0 ? (
        <LoadingState label="Reading your organization’s workspaces…" />
      ) : (
        <>
          {problemLine}
          <CloudHome
            workspaces={rows.workspaces}
            members={rows.members}
            ownerByWorkspace={rows.ownerByWorkspace}
            pinnedIds={[]}
            routineIds={rows.routineIds}
            selectedOwners={place.owners}
            onOwnersChange={setCloudOwners}
            onOpen={open}
            onCreate={() => setCloudCreating(true)}
            onProfile={(m) => setCloudOwners([m.id])}
            numberOf={(w) => rowNumber(w.id)}
            costOf={() => null}
            strictOwners
            trailing={toolbarTrailing}
            repositoryIcon={(id) => {
              const full = valueOf(data.repos, []).find((r) => r.id === id)?.full_name;
              return cloudRepoPicture(full, 14);
            }}
          />
        </>
      ),
    );
  }

  return (
    <div className="ui-cloud-place">
      {page}
      {place.notice && (
        <div className="ui-cloud-notice" role="status">
          {place.notice}
          <button aria-label="Dismiss notice" onClick={() => setCloudNotice("")}>
            ×
          </button>
        </div>
      )}
      {cloudOpen && <CloudCreateDialog data={data} web={oversee} />}
      <CloudAgentsHost />
    </div>
  );
}
