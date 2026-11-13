// Settings › Cloud computer: the computer Aura runs for the team, as it is
// right now — setting up, ready, asleep or failed — with the month's awake
// hours used and left, and its size.
//
// It comes with the plan, so the only ways to change it are the plan's: an
// org on Free or a trial is offered Pro, an org that was paying before plans
// came with a computer starts the one it now has, and on Teams an admin picks
// a bigger size (the bill changes now, the machine the next time it wakes).
// Every sentence about the computer is the server's (managed_computer/
// view.rs, offer.rs), the same ones the setup page and the chat show.

import { useState } from "react";

import {
  endsLine,
  offerRefusal,
  offerStartButton,
  openPlanBilling,
  paymentStopped,
  progressOf,
  settingUp,
  sizeLine,
  stepLine,
  upgradeLabel,
  upgradePlan,
  usageLine,
  type AuraComputer,
  type AuraComputerStatus,
} from "../../lib/auraComputer";
import { useAuraComputer } from "../../lib/useAuraComputer";
import { ComputerSizes } from "../commons/crew/ComputerSizes";

import { useComputerActions, type ComputerBusy } from "../commons/crew/useComputerActions";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import { ErrorNote } from "../ui/state";
import "../ui/aura-computer.css";

const TITLE = "Aura computer";

/** The month's awake hours as a fraction for the bar, or null without a cap. */
export function hoursUsed(c: Pick<AuraComputer, "awake_hours_this_month" | "month_hours">): number | null {
  if (!c.month_hours || c.month_hours <= 0) return null;
  return Math.min(1, Math.max(0, c.awake_hours_this_month / c.month_hours));
}

export function AuraComputerSection() {
  const pay = useState(false);
  const { status, problem, reload } = useAuraComputer({ waiting: pay[0] });
  const act = useComputerActions(status, pay);

  if (!status) {
    return (
      <SettingsSection title={TITLE}>
        {problem ? (
          <SettingsRow
            title="Couldn’t read your team’s computer"
            description={problem}
            control={
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                Try again
              </Button>
            }
          />
        ) : (
          <SettingsRow title="Reading your team’s computer…" control={<AsciiSpinner />} />
        )}
      </SettingsSection>
    );
  }
  // A server that doesn't offer computers has nothing to say here.
  if (!status.offer && !status.computer) return null;

  return (
    <SettingsSection title={TITLE} description="The computer Aura runs for your team. It comes with Pro and Teams.">
      {status.computer ? (
        <TeamComputerRows status={status} computer={status.computer} act={act} />
      ) : (
        <NoComputerRow status={status} act={act} />
      )}
      {act.failed && <ErrorNote>{act.failed}</ErrorNote>}
    </SettingsSection>
  );
}

type Actions = ReturnType<typeof useComputerActions>;

function NoComputerRow({ status, act }: { status: AuraComputerStatus; act: Actions }) {
  const offer = status.offer;
  const upgrade = upgradePlan(offer);
  const hours = offer?.month_hours ?? offer?.fair_use_hours;
  if (upgrade) {
    return (
      <SettingsRow
        title={offerRefusal(offer) ?? "A cloud computer comes with Pro or Teams."}
        description={
          act.paying
            ? "Finish paying in your browser. The computer starts here by itself once the payment goes through."
            : `Pro includes one, with about ${hours} awake hours a month. It answers your team’s chats even when every laptop is closed.`
        }
        control={
          <Button size="sm" onClick={act.upgrade} disabled={!!act.busy}>
            {act.busy === "upgrade" ? <AsciiSpinner /> : null}
            {act.busy === "upgrade" ? "Opening…" : upgradeLabel(upgrade)}
          </Button>
        }
      />
    );
  }
  return (
    <SettingsRow
      title="Your plan includes a computer"
      description={
        offer?.start_problem ||
        (offerStartButton(offer)
          ? `It comes with about ${hours} awake hours a month. Start it and it’s ready in a few minutes.`
          : offer?.reason || "It starts by itself in a moment and is ready a few minutes later.")
      }
      control={
        offerStartButton(offer) ? (
          <Button size="sm" onClick={act.start} disabled={!!act.busy}>
            {act.busy === "start" ? <AsciiSpinner /> : null}
            {act.busy === "start" ? "Starting…" : "Start the computer"}
          </Button>
        ) : null
      }
    />
  );
}

function stateControl(computer: AuraComputer, busy: ComputerBusy, act: Actions) {
  if (settingUp(computer) || computer.stage === "waking" || computer.stage === "stopping") return <AsciiSpinner />;
  if (computer.stage === "failed" && computer.can_retry)
    return (
      <Button size="sm" variant="outline" onClick={act.retry} disabled={!!busy}>
        {busy === "retry" ? "Trying again…" : "Try again"}
      </Button>
    );
  if (computer.can_wake)
    return (
      <Button size="sm" variant="outline" onClick={act.wake} disabled={!!busy}>
        {busy === "wake" ? "Waking it…" : "Wake it now"}
      </Button>
    );
  return null;
}

function TeamComputerRows({ status, computer, act }: { status: AuraComputerStatus; computer: AuraComputer; act: Actions }) {
  const [draft, setDraft] = useState<string | null>(null);
  const offer = status.offer;
  const building = settingUp(computer);
  const fraction = building ? progressOf(computer) : null;
  const step = building ? stepLine(computer) : null;
  const used = hoursUsed(computer);
  const ends = endsLine(computer);
  const sizes = offer?.sizes ?? [];
  const resizable = !!offer?.can_change_size && sizes.length > 1 && !building;
  const picked = draft ?? computer.size ?? sizes[0]?.instance_type ?? "";
  const changed = !!computer.size && picked !== computer.size;
  const problemLine = computer.problem ? ` ${computer.problem}` : "";

  return (
    <>
      <SettingsRow
        title={computer.name}
        description={`${computer.headline}${problemLine}${step ? ` · ${step}` : ""}`}
        control={stateControl(computer, act.busy, act)}
      >
        {building && (
          <div className="ui-aura-computer-progress">
            <Progress value={fraction === null ? null : fraction * 100} />
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        title="Hours this month"
        description={ends ?? usageLine(computer)}
        control={
          paymentStopped(computer) ? (
            <Button size="sm" onClick={openPlanBilling}>
              Pay again
            </Button>
          ) : null
        }
      >
        {used !== null && !ends && (
          <div className="ui-aura-computer-progress">
            <Progress value={used * 100} aria-label="Awake hours used this month" />
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        title="Size"
        description={
          resizable && changed
            ? "The bill changes now. The computer changes the next time it wakes up."
            : sizeLine(computer) ?? "Standard · 2 cores · 8 GB"
        }
        control={
          resizable ? (
            <Button size="sm" onClick={() => act.resize(picked)} disabled={!changed || !!act.busy}>
              {act.busy === "resize" ? <AsciiSpinner /> : null}
              {act.busy === "resize" ? "Changing…" : "Change size"}
            </Button>
          ) : null
        }
      >
        {resizable && (
          <ComputerSizes
            sizes={sizes}
            value={picked}
            onChange={setDraft}
            larger={offer?.larger}
            disabled={!!act.busy}
          />
        )}
      </SettingsRow>
    </>
  );
}
