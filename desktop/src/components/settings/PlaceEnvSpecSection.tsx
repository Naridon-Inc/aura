// The tools a place needs, and whether it has them.
//
// This is NOT environment variables — those are the secrets above it. What
// `place_env_state` and `place_env_apply` speak about is the `[env]` block in
// `.aura/settings.toml`: the toolchains, packages and services a project says
// a machine needs before an agent can work there. "Check" asks the place how
// far it is from that, touching nothing. "Bring up to date" runs the declared
// installs on that place — the machine itself, in place, with no new copy of
// the project made and nothing rebuilt.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import type { Place } from "../../lib/place/contract";
import { trustWarning } from "../../lib/place/drift";
import type { EnvReport, EnvStep, EnvStepState } from "../../lib/place/teamBase";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { SettingsActions } from "../ui/settings-blocks";
import { SettingsRow } from "../ui/settings-row";
import { StatusPill } from "./kit";

function stepTone(state: EnvStepState): "green" | "amber" | "red" {
  switch (state) {
    case "already_at_spec":
    case "brought":
      return "green";
    case "unsatisfied":
      return "amber";
    case "failed":
      return "red";
  }
}

export function stepWord(state: EnvStepState): string {
  switch (state) {
    case "already_at_spec":
      return "ready";
    case "brought":
      return "installed";
    case "unsatisfied":
      return "no install step";
    case "failed":
      return "failed";
  }
}

/** One declared install step: what it is, its kind, and where it stands. Its
 *  output, when there is any, sits under it. */
export function EnvStepRow({ step }: { step: EnvStep }) {
  return (
    <SettingsRow
      title={step.title}
      description={step.kind}
      control={<StatusPill tone={stepTone(step.state)} text={stepWord(step.state)} />}
    >
      {step.detail ? <pre className="ui-settings-log">{step.detail}</pre> : null}
    </SettingsRow>
  );
}

export function PlaceEnvSpecSection({ place, picker }: { place: Place; picker?: ReactNode }) {
  const [report, setReport] = useState<EnvReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setReport(
        await api.placeEnvState({ root: place.project.root ?? "", machineId: place.machineId }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [place]);

  useEffect(() => {
    setReport(null);
    void check();
  }, [check]);

  const apply = async (force: boolean) => {
    setApplying(true);
    setError(null);
    try {
      setReport(
        await api.placeEnvApply(
          { root: place.project.root ?? "", machineId: place.machineId },
          { force },
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  const trust = report ? trustWarning(report.trust) : null;
  const declared = report ? report.steps.length > 0 : false;
  const headline = !report
    ? null
    : !declared
      ? "This repository has not listed any tools a machine needs."
      : report.at_spec
        ? `${place.name} has everything the repository asks for (spec v${report.version}).`
        : `${place.name} is missing some of what the repository asks for (spec v${report.version}).`;

  return (
    <section className="ui-environment-files">
      <h2>Tools this machine needs</h2>
      <p>
        The repository can list the tools a machine must have before agents work on it — languages,
        packages, services. Checking touches nothing. Bringing the machine up to date runs those
        installs on {place.name}, in place: nothing is copied and nothing is rebuilt.
      </p>
      {picker}
      {error && (
        <div role="alert" className="ui-settings-error">
          {error}
        </div>
      )}
      {trust && (
        <Alert>
          <AlertDescription>{trust}</AlertDescription>
        </Alert>
      )}
      <SettingsRow
        title={
          checking && !report ? (
            <span className="ui-settings-status">
              <AsciiSpinner />
              Checking {place.name}…
            </span>
          ) : (
            (headline ?? "Not checked yet.")
          )
        }
        description={
          report?.changed
            ? `Something on ${place.name} was installed or changed just now. Work already running there keeps the environment it started with.`
            : undefined
        }
        control={
          <SettingsActions>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void check()}
              disabled={checking || applying}
            >
              <RefreshCw />
              Check again
            </Button>
            {declared && (
              <Button
                variant={report?.at_spec ? "outline" : "default"}
                size="sm"
                onClick={() => void apply(Boolean(report?.at_spec))}
                disabled={checking || applying}
                title={
                  report?.at_spec
                    ? "Run every declared install again, even though nothing is missing"
                    : "Run the declared installs on this machine"
                }
              >
                {applying ? <AsciiSpinner /> : null}
                {applying
                  ? "Bringing up to date…"
                  : report?.at_spec
                    ? "Install again"
                    : "Bring up to date"}
              </Button>
            )}
          </SettingsActions>
        }
      />
      {report && declared && report.steps.map((s) => <EnvStepRow key={s.id} step={s} />)}
    </section>
  );
}
