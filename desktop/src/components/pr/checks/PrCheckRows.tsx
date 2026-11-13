// One pull request check, and the preview deploy, as the shared check-run
// row: a status mark, the name with one quiet line under it, and the one
// thing the reader can do from here.

import { Triangle } from "lucide-react";
import type { PrCheck, VercelDeployment } from "../../../lib/api";
import { openExternal } from "../../../lib/openExternal";
import { DetailsCheckRow, type DetailsCheckStatus } from "../../ui/details-checks";

export type CheckBucket = "failure" | "pending" | "success";

export const BUCKET_ORDER: CheckBucket[] = ["failure", "pending", "success"];

export const BUCKET_LABEL: Record<CheckBucket, string> = {
  failure: "Failing",
  pending: "In progress",
  success: "Passing",
};

const BUCKET_STATUS: Record<CheckBucket, DetailsCheckStatus> = {
  failure: "failed",
  pending: "running",
  success: "passed",
};

export function bucketOf(c: PrCheck): CheckBucket {
  if (c.bucket === "failure") return "failure";
  if (c.bucket === "success") return "success";
  return "pending";
}

export function PrCheckRow({ check }: { check: PrCheck }) {
  const bucket = bucketOf(check);
  // "STARTUP_FAILURE" on its own is a red row with no story. When the
  // backend found GitHub's reason it leads the detail line — it is the one
  // line the reviewer needs.
  const startupReason = check.failure_reason?.trim() ?? "";
  const where = check.workflow && check.workflow !== check.name ? check.workflow : "";
  const detail = startupReason
    ? `Didn't start. ${startupReason}`
    : [where, check.description].filter(Boolean).join(" · ");
  return (
    <DetailsCheckRow
      status={BUCKET_STATUS[bucket]}
      title={check.name}
      detail={detail || undefined}
      hint={`GitHub status: ${check.raw}`}
      action={check.url ? { label: "Logs", onClick: () => void openExternal(check.url) } : undefined}
    />
  );
}

// Plain-language reading of the deploy's state: is it live, still going, or
// broken — not the raw enum.
const DEPLOY_STATE: Record<string, { label: string; status: DetailsCheckStatus }> = {
  READY: { label: "Deployed", status: "passed" },
  BUILDING: { label: "Building", status: "running" },
  INITIALIZING: { label: "Starting", status: "running" },
  QUEUED: { label: "Queued", status: "running" },
  ERROR: { label: "Deploy failed", status: "failed" },
  CANCELED: { label: "Canceled", status: "pending" },
};

export function PrDeployRow({ deploy }: { deploy: VercelDeployment }) {
  const meta = DEPLOY_STATE[deploy.state] ?? { label: "Deploy", status: "pending" as const };
  const env = deploy.target === "production" ? "Production" : "Preview";
  const previewUrl = deploy.url ? `https://${deploy.url}` : null;
  const action = previewUrl
    ? { label: "Open", onClick: () => void openExternal(previewUrl) }
    : deploy.inspector_url
      ? { label: "Build", onClick: () => void openExternal(deploy.inspector_url!) }
      : undefined;
  return (
    <DetailsCheckRow
      status={meta.status}
      icon={<Triangle size={14} />}
      title={`Vercel · ${env}`}
      detail={[meta.label, deploy.url].filter(Boolean).join(" · ")}
      hint={previewUrl ? "Open the deployed preview" : "View the build on Vercel"}
      action={action}
    />
  );
}
