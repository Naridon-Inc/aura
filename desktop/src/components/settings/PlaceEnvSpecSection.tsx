// The tools a place needs, and whether it has them.
//
// This is NOT environment variables — those are the secrets above it. What
// `place_env_state` and `place_env_apply` speak about is the `[env]` block in
// `.aura/settings.toml`: the toolchains, packages and services a project says
// a machine needs before an agent can work there. "Check" asks the place how
// far it is from that, touching nothing. "Bring up to date" runs the declared
// installs on that place — the machine itself, in place, with no new copy of
// the project made and nothing rebuilt.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import type { Place } from "../../lib/place/contract";
import { trustWarning } from "../../lib/place/drift";
import type { EnvReport, EnvStep, EnvStepState } from "../../lib/place/teamBase";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { ErrorNote } from "../ui/state";
import { Section, StatusPill } from "./kit";

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

function stepWord(state: EnvStepState): string {
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

function StepRow({ step }: { step: EnvStep }) {
  return (
    <div className="flex items-start gap-3 border-b border-line-soft py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-text-1">{step.title}</div>
        <div className="text-xs text-text-4">{step.kind}</div>
        {step.detail && (
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-text-3">
            {step.detail}
          </pre>
        )}
      </div>
      <StatusPill tone={stepTone(step.state)} text={stepWord(step.state)} />
    </div>
  );
}

export function PlaceEnvSpecSection({ place }: { place: Place }) {
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
      ? "This project has not listed any tools a machine needs."
      : report.at_spec
        ? `${place.name} has everything the project asks for (spec v${report.version}).`
        : `${place.name} is missing some of what the project asks for (spec v${report.version}).`;

  return (
    <Section title="Tools this machine needs">
      <p className="pb-3 text-xs leading-relaxed text-text-3">
        The project can list the tools a machine must have before agents work
        on it — languages, packages, services. Checking touches nothing.
        Bringing the machine up to date runs those installs on {place.name},
        in place: nothing is copied and nothing is rebuilt.
      </p>
      {error && <ErrorNote className="mb-3">{error}</ErrorNote>}
      {trust && (
        <div className="mb-3 rounded border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
          {trust}
        </div>
      )}
      <div className="flex items-center gap-2 pb-2">
        <span className="flex-1 text-[13px] text-text-2">
          {checking && !report ? (
            <>
              <AsciiSpinner className="mr-1.5" />
              Checking {place.name}…
            </>
          ) : (
            headline
          )}
        </span>
        <Button variant="ghost" size="xs" onClick={() => void check()} disabled={checking || applying}>
          <RefreshCw />
          Check again
        </Button>
        {declared && (
          <Button
            variant={report?.at_spec ? "outline" : "default"}
            size="xs"
            onClick={() => void apply(Boolean(report?.at_spec))}
            disabled={checking || applying}
            title={
              report?.at_spec
                ? "Run every declared install again, even though nothing is missing"
                : "Run the declared installs on this machine"
            }
          >
            {applying ? <AsciiSpinner /> : null}
            {applying ? "Bringing up to date…" : report?.at_spec ? "Install again" : "Bring up to date"}
          </Button>
        )}
      </div>
      {report && declared && (
        <div>
          {report.steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </div>
      )}
      {report?.changed && (
        <p className="pt-2 text-xs text-text-3">
          Something on {place.name} was installed or changed just now. Work already running there keeps the environment it started with.
        </p>
      )}
    </Section>
  );
}
