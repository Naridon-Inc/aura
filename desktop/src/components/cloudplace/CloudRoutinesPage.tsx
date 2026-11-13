// Routines, kept on the server: the library editor in its backend mode.
//
// Create, run and delete are the server's. A saved routine is read-only here
// because the server has no update for one, and the editor says so.

import { useEffect, useMemo, useState } from "react";

import { cloudApi, cloudProblem } from "../../lib/cloudWorkspacesApi";
import { openCloudWorkspace, setCloudNotice } from "../../lib/cloudPlace";
import { CloudRoutines, type CloudRoutine, type RoutineBackend } from "../ui/cloud-routines";
import { LoadingState } from "../ui/state";
import { SetUpCloudAgentButton } from "./CloudAgentsHost";
import { CloudProblemState } from "./CloudProblemState";
import { reloadCloudPlace, valueOf, type CloudPlaceData } from "./cloudPlaceStore";
import { useCloudModels } from "./cloudModels";
import { initialsOf, PUBLIC_ROW_PREFIX } from "./cloudRows";
import {
  ROUTINE_READ_ONLY,
  ROUTINE_SCHEDULES,
  ROUTINE_TRIGGER_TYPES,
  ROUTINE_TZ,
  routineFromRow,
  routineToNew,
} from "./routineMapping";
import type { CloudRows } from "./useCloudRows";

function failure(e: unknown): Error {
  return new Error(cloudProblem(e).message);
}

export function CloudRoutinesPage({
  data,
  rows,
  nowMs,
  onPlans,
}: {
  data: CloudPlaceData;
  rows: CloudRows;
  nowMs: number;
  onPlans: () => void;
}) {
  const { models } = useCloudModels();
  const stored = useMemo(
    () => valueOf(data.routines, []).map((r) => routineFromRow(r, nowMs)),
    [data.routines, nowMs],
  );
  const [list, setList] = useState<CloudRoutine[]>(stored);
  useEffect(() => setList(stored), [stored]);
  // The server hands a webhook's address back once, when it is made.
  const [webhooks, setWebhooks] = useState<Record<string, string>>({});

  const me = rows.members.find((m) => m.id === rows.me);
  const author = me
    ? { name: me.name, initials: me.initials, photo: me.photo }
    : { name: data.login ?? "You", initials: initialsOf(data.login ?? "You") };

  const backend: RoutineBackend = {
    repositories: valueOf(data.repos, []).map((r) => ({ value: r.full_name, label: r.full_name })),
    author,
    timezone: ROUTINE_TZ,
    triggerTypes: ROUTINE_TRIGGER_TYPES,
    schedules: ROUTINE_SCHEDULES,
    readOnlyReason: ROUTINE_READ_ONLY,
    create: async (draft) => {
      try {
        const made = await cloudApi.createRoutine(routineToNew(draft));
        if (made.webhook_url) setWebhooks((w) => ({ ...w, [made.routine.id]: made.webhook_url! }));
        void reloadCloudPlace();
        return {
          routine: routineFromRow(made.routine, Date.now()),
          message: made.webhook_secret
            ? `Saved. Copy the webhook secret now — it isn’t shown again: ${made.webhook_secret}`
            : "Saved.",
        };
      } catch (e) {
        throw failure(e);
      }
    },
    remove: async (id) => {
      try {
        await cloudApi.deleteRoutine(id);
        void reloadCloudPlace();
      } catch (e) {
        throw failure(e);
      }
    },
    webhookUrl: (trigger) => {
      const owner = list.find((r) => r.triggers.some((t) => t.id === trigger.id));
      return owner ? (webhooks[owner.id] ?? null) : null;
    },
  };

  if (data.routines.state === "loading") return <LoadingState label="Reading your routines…" />;
  if (data.routines.state === "failed")
    return (
      <CloudProblemState
        problem={data.routines.problem}
        onRetry={() => void reloadCloudPlace()}
        onPlans={onPlans}
      />
    );

  return (
    <CloudRoutines
      routines={list}
      models={models}
      noModels={<SetUpCloudAgentButton />}
      onChange={setList}
      backend={backend}
      onRun={(routine) => {
        cloudApi
          .runRoutine(routine.id)
          .then((r) => {
            setCloudNotice(
              r.fired
                ? "Routine started. Its workspace shows on Home once a runner picks it up."
                : `The routine didn’t start${r.reason ? `: ${r.reason}` : "."}`,
            );
            void reloadCloudPlace();
          })
          .catch((e) => setCloudNotice(cloudProblem(e).message));
      }}
      onOpenWorkspace={(id) => openCloudWorkspace(`${PUBLIC_ROW_PREFIX}${id}`)}
    />
  );
}
