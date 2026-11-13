// A cloud read that didn't answer, said with its own next step.

import { CloudOff, Download, LogIn } from "lucide-react";

import type { CloudProblem } from "../../lib/cloudWorkspacesApi";
import { EmptyState, ErrorState } from "../ui/state";

export function CloudProblemState({
  problem,
  onRetry,
  onPlans,
}: {
  problem: CloudProblem;
  onRetry: () => void;
  onPlans: () => void;
}) {
  if (problem.kind === "signed_out")
    return (
      <EmptyState
        icon={LogIn}
        title="Sign in to Aura’s cloud"
        body={problem.message}
        action={{
          label: "Sign in",
          onClick: () => window.dispatchEvent(new CustomEvent("aura:open-signin")),
        }}
      />
    );
  if (problem.kind === "needs_update")
    return <EmptyState icon={Download} title="Update Aura to see this" body={problem.message} />;
  if (problem.kind === "upgrade")
    return (
      <EmptyState
        icon={CloudOff}
        title="Not on your organization’s plan"
        body={problem.message}
        action={{ label: "View plans", onClick: onPlans }}
      />
    );
  return <ErrorState message={problem.message} onRetry={onRetry} />;
}
