// Which plan the cloud place is on, and what that plan opens.
//
// Read from the server's billing status (`effective_plan`, trial-aware — the
// same rung `require_plan` checks). A plan we weren't told is `null`, never
// "Free": the gate for an unread plan says so rather than locking someone out
// of a plan they may well be paying for.

import type { CloudPlan } from "../components/ui/cloud-organization";

export type { CloudPlan };

/** What a page needs: any paid plan, Teams and up, or Enterprise. */
export type CloudFeature = "cloud" | "team" | "enterprise";

const BY_WORD: Record<string, CloudPlan> = {
  free: "Free",
  pro: "Pro",
  team: "Teams",
  teams: "Teams",
  enterprise: "Enterprise",
};

/** The server's plan word as the place's plan, or null when it isn't one. */
export function cloudPlanOf(word: string | null | undefined): CloudPlan | null {
  const key = (word ?? "").trim().toLowerCase();
  return BY_WORD[key] ?? null;
}

/** The same ladder the plan gate and the server's `require_plan` use. */
export function planOpens(plan: CloudPlan, feature: CloudFeature): boolean {
  if (feature === "enterprise") return plan === "Enterprise";
  if (feature === "team") return plan === "Teams" || plan === "Enterprise";
  return plan !== "Free";
}

/** The footer badge's word: FREE, PRO, TEAM, ENTERPRISE. */
export function planBadge(plan: CloudPlan): string {
  return plan === "Teams" ? "TEAM" : plan.toUpperCase();
}

/** The web console's address, on the public cloud only — a self-hosted
 *  server's console lives wherever its operator put it, and we aren't told. */
function consoleOrigin(cloudUrl: string | null | undefined): string | null {
  const origin = (cloudUrl ?? "").trim().replace(/\/+$/, "");
  if (origin === "https://auravcs.com" || origin === "https://app.auravcs.com" || origin === "https://api.auravcs.com")
    return "https://app.auravcs.com";
  return null;
}

/** Where upgrading happens: the console's Settings → Billing, the same plan
 *  ladder as the app's with a button per tier, on the public cloud only. A
 *  page that needs Teams still names it in `?plan=`; older consoles read it to
 *  choose which tier their single buy button sold. */
export function upgradeUrl(
  cloudUrl: string | null | undefined,
  feature?: CloudFeature,
): string | null {
  const origin = consoleOrigin(cloudUrl);
  if (!origin) return null;
  const billing = `${origin}/settings/billing`;
  return feature === "team" ? `${billing}?plan=team` : billing;
}

/** Where a member connects their own GitHub: the console's Settings → Git,
 *  on the public cloud only. Cloud setup's "Connect GitHub on the web" opens
 *  it, so the repositories a cloud workspace can start from are the ones that
 *  member may open. */
export function githubConnectUrl(cloudUrl: string | null | undefined): string | null {
  const origin = consoleOrigin(cloudUrl);
  return origin ? `${origin}/settings/git` : null;
}

/** A cloud workspace's own page on the console — the link a teammate opens.
 *  Links from older builds name /sessions/<id>; the console sends those on to
 *  the workspace when the id is one. */
export function workspaceLink(cloudUrl: string | null | undefined, id: string): string | null {
  const origin = consoleOrigin(cloudUrl);
  return origin ? `${origin}/workspaces/${encodeURIComponent(id)}` : null;
}
