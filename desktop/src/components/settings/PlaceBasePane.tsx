// "Base builds" — the team's environment, built once on a shared machine.
//
// On a shared box every member gets their own account, and every account
// starts empty: the first person pays the whole install, and so would the
// second, and the third. The base is the account that belongs to nobody: the
// project's declared install is run there once, and each member joining is
// copied out of it. This pane shows what the base holds and lets someone pay
// that install now, ahead of the next person.
//
// The backend records WHICH spec the base was last built to (version and
// digest) but not WHEN; the pane says what it knows and does not invent a
// clock. The time of the build you start from here is shown, because that
// one this pane witnessed.

import { useCallback, useEffect, useState } from "react";
import { Hammer, RefreshCw } from "lucide-react";
import type { Place } from "../../lib/place/contract";
import {
  askTeamBase,
  baseWarning,
  baseWasBuilt,
  warmSentence,
  warmShortfall,
  warmStart,
  type BaseBuild,
  type TeamBase,
} from "../../lib/place/teamBase";
import { trustWarning } from "../../lib/place/drift";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { ErrorNote, LoadingState } from "../ui/state";
import { PaneIntro, Row, Section, StatusPill } from "./kit";
import { PlacePicker, useProjectPlaces } from "./PlacePicker";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-line-soft py-2 last:border-b-0">
      <span className="w-36 shrink-0 text-xs text-text-4">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] text-text-2">{children}</span>
    </div>
  );
}

function BaseFacts({ base }: { base: TeamBase }) {
  const warning = baseWarning(base);
  const built = baseWasBuilt(base);
  return (
    <div>
      {warning && (
        <div className="mb-3 rounded border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
          {warning}
        </div>
      )}
      <Fact label="Where">
        {base.shared
          ? `A shared account (${base.login}) on ${base.place} that belongs to nobody, so members can start from it.`
          : `${base.place} has one member, so the environment is simply that member's own.`}
      </Fact>
      <Fact label="Built to">
        {built ? (
          <>
            spec v{base.built_version}{" "}
            <span className="font-mono text-[11px] text-text-4">{base.built_digest.slice(0, 12)}</span>
            <span className="ml-2 text-xs text-text-4">(the machine records which spec, not when)</span>
          </>
        ) : (
          <StatusPill tone="muted" text="never built" />
        )}
      </Fact>
      <Fact label="Holds">
        {base.holds.length === 0
          ? "Nothing yet."
          : base.holds.map((h) => h.holds || h.under).join(", ")}
      </Fact>
      <Fact label="Ready for members">
        {base.carries.length > 0 ? (
          <StatusPill tone="red" text="no — holds a credential" />
        ) : !base.readable ? (
          <StatusPill tone="red" text="no — not readable" />
        ) : !base.scoped ? (
          <StatusPill tone="amber" text="no — installs outside itself" />
        ) : (
          <StatusPill tone="green" text="yes" />
        )}
      </Fact>
    </div>
  );
}

function BuildResult({ build, at }: { build: BaseBuild; at: Date }) {
  const shortfall = warmShortfall(build.start);
  const trust = build.report ? trustWarning(build.report.trust) : null;
  return (
    <div className="mt-3 rounded border border-line-soft bg-bg-1 px-3 py-2">
      <div className="text-[13px] text-text-1">{warmSentence(build)}</div>
      <div className="mt-1 text-xs text-text-4">
        Finished {at.toLocaleTimeString()} · {at.toLocaleDateString()}
      </div>
      {shortfall && <div className="mt-2 text-xs text-amber">{shortfall}</div>}
      {trust && <div className="mt-2 text-xs text-amber">{trust}</div>}
      {build.report && build.report.steps.length > 0 && (
        <div className="mt-2">
          {build.report.steps.map((s) => (
            <div key={s.id} className="flex items-start gap-2 py-1 text-xs">
              <StatusPill
                tone={
                  s.state === "failed" ? "red" : s.state === "unsatisfied" ? "amber" : "green"
                }
                text={
                  s.state === "already_at_spec"
                    ? "ready"
                    : s.state === "brought"
                      ? "installed"
                      : s.state === "unsatisfied"
                        ? "no install step"
                        : "failed"
                }
              />
              <span className="min-w-0 flex-1">
                <span className="text-text-2">{s.title}</span>
                {s.detail && (
                  <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-text-4">
                    {s.detail}
                  </pre>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PlaceBasePane({ repoRoot }: { repoRoot: string }) {
  const places = useProjectPlaces(repoRoot);
  const [place, setPlace] = useState<Place>(places[0]);
  useEffect(() => {
    const kept = places.find((p) => p.machineId === place.machineId);
    if (!kept) setPlace(places[0]);
    else if (kept !== place) setPlace(kept);
  }, [places, place]);

  const [base, setBase] = useState<TeamBase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<{ build: BaseBuild; at: Date } | null>(null);

  const ask = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBase(await askTeamBase(place));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [place]);

  useEffect(() => {
    setBase(null);
    setResult(null);
    void ask();
  }, [ask]);

  const build = async (force: boolean) => {
    setBuilding(true);
    setError(null);
    try {
      const out = await warmStart(place, undefined, force);
      setResult({ build: out, at: new Date() });
      setBase(out.base);
    } catch (e) {
      setError(String(e));
    } finally {
      setBuilding(false);
    }
  };

  const built = base ? baseWasBuilt(base) : false;

  return (
    <div>
      <PaneIntro text="On a shared machine, the project's install is run once into an environment that belongs to the team, and each person joining starts from a copy of it. The first build takes minutes; everyone after that pays a file copy." />

      <Row label="Machine" description="Which machine's team environment to look at.">
        <PlacePicker places={places} value={place} onChange={setPlace} disabled={building} />
      </Row>

      <Section title="Team environment">
        {error && <ErrorNote className="mb-3">{error}</ErrorNote>}
        {loading && !base ? (
          <LoadingState label={`Asking ${place.name}…`} />
        ) : base ? (
          <BaseFacts base={base} />
        ) : null}
        <div className="flex items-center gap-2 pt-3">
          <Button
            size="sm"
            variant={built ? "outline" : "default"}
            onClick={() => void build(built)}
            disabled={building || loading || !base}
            title={
              built
                ? "Run the project's install into the team environment again, even though it is already built"
                : "Run the project's install into the team environment now, so the next person to join starts from it"
            }
          >
            {building ? <AsciiSpinner /> : <Hammer />}
            {building ? "Building…" : built ? "Build again" : "Build base now"}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => void ask()} disabled={building || loading}>
            <RefreshCw />
            Check again
          </Button>
          {building && (
            <span className="text-xs text-text-3">
              Running the declared installs on {place.name}. This can take several minutes.
            </span>
          )}
        </div>
        {result && <BuildResult build={result.build} at={result.at} />}
      </Section>
    </div>
  );
}
