// The computer Aura runs for the team — the third door into a place, beside
// connecting a machine you own and having Aura make one on your own cloud.
//
// Nothing is bought here. The computer comes with Pro and Teams: an org on a
// plan that includes one sees it come up (or starts it, when it was paying
// before plans came with one); an org on Free or a trial sees what Pro gives
// and moves to it on Stripe's page in the browser, and the computer appears
// here once the payment goes through. Nothing is typed: the machine, its key
// and its sign-in to the team are all Aura's to do.
//
// Every sentence about the computer itself — its headline, its hours, what
// went wrong — is the server's (managed_computer/view.rs and offer.rs), so
// this screen, the settings page and the chat never disagree.

import { useEffect, useRef, useState } from "react";

import { CircleCheck, Moon, Server, ShieldCheck, Timer } from "lucide-react";

import {
  dozing,
  endsLine,
  offerRefusal,
  offerStartButton,
  progressOf,
  settingUp,
  sizeLine,
  stepLine,
  upgradeLabel,
  upgradePlan,
  usageLine,
  type AuraComputer,
  type AuraComputerOffer,
} from "../../../lib/auraComputer";
import { useAuraComputer } from "../../../lib/useAuraComputer";
import { FullscreenOverlay } from "../../FullscreenOverlay";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Progress } from "../../ui/progress";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";

import { useComputerActions, type ComputerBusy } from "./useComputerActions";
import "../../ui/cloud-onboarding.css";
import "../../ui/make-place.css";
import "../../ui/aura-computer.css";

export function GetComputerWizard({
  onClose,
  /** The computer exists and answers; the list behind this reloads. */
  onReady,
  /** The other door, offered on every refusal so a no is never a dead end. */
  onConnectInstead,
}: {
  onClose: () => void;
  onReady: () => void;
  onConnectInstead: () => void;
}) {
  const pay = useState(false);
  const { status, problem, reload } = useAuraComputer({ watching: true, waiting: pay[0] });
  const live = useComputerActions(status, pay);
  const { busy, failed, paying } = live;
  const told = useRef(false);

  const computer = status?.computer ?? null;
  useEffect(() => {
    if (computer && (computer.stage === "ready" || dozing(computer)) && !told.current) {
      told.current = true;
      onReady();
    }
  }, [computer, onReady]);

  const offer = status?.offer ?? null;
  const upgrade = upgradePlan(offer);
  const canStart = !computer && offerStartButton(offer);

  return (
    <FullscreenOverlay
      onClose={onClose}
      footer={
        computer || (!upgrade && !canStart) ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onConnectInstead}>
              Connect one I already have
            </Button>
            {upgrade ? (
              <Button onClick={live.upgrade} disabled={!!busy}>
                {busy === "upgrade" ? <AsciiSpinner /> : null}
                {busy === "upgrade" ? "Opening the payment page…" : paying ? "Open the payment page again" : upgradeLabel(upgrade)}
              </Button>
            ) : (
              <Button onClick={live.start} disabled={!!busy}>
                {busy === "start" ? <AsciiSpinner /> : null}
                {busy === "start" ? "Starting it…" : "Start the computer"}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="ui-make-place">
        <div className="ui-cloud-setup-page">
          {problem && !status ? (
            <ErrorState
              message={`Aura couldn't check what it can set up for you. ${problem}`}
              onRetry={() => void reload()}
            />
          ) : status === null ? (
            <LoadingState label="Checking what Aura can set up for you…" size="md" />
          ) : computer ? (
            <TeamComputer computer={computer} busy={busy} onRetry={live.retry} onWake={live.wake} />
          ) : (
            <PlanComputer offer={offer} paying={paying} onConnectInstead={onConnectInstead} />
          )}
          {failed && <ErrorState size="sm" title="That didn't work" message={failed} />}
        </div>
      </div>
    </FullscreenOverlay>
  );
}


/** What the plan's computer is, before the team has one. */
export function PlanComputer({
  offer,
  paying,
  onConnectInstead,
}: {
  offer: AuraComputerOffer | null;
  paying: boolean;
  onConnectInstead: () => void;
}) {
  if (!offer) {
    return (
      <EmptyState
        icon={Server}
        title="Aura can't set one up here yet"
        body="This Aura Cloud doesn't offer computers. You can still connect a machine you already have."
        action={{ label: "Connect a machine I already have", onClick: onConnectInstead }}
      />
    );
  }
  const upgrade = upgradePlan(offer);
  const refusal = offerRefusal(offer);
  const hours = offer.month_hours ?? offer.fair_use_hours;
  return (
    <>
      <p className="ui-aura-computer-lede">{offer.summary}</p>
      <ul className="ui-aura-computer-facts">
        <li>
          <Moon aria-hidden />
          <span>
            It sleeps after {offer.idle_minutes} minutes with nothing to do and wakes up when someone sends it a
            message. The first answer after a nap takes a minute or two longer.
          </span>
        </li>
        <li>
          <Timer aria-hidden />
          <span>
            {upgrade ? "Pro includes" : "Your plan includes"} about {hours} awake hours a month. Past{" "}
            {offer.fair_use_hours} it sleeps sooner, and when the hours are used up it sleeps until the 1st. Nothing is
            ever charged on top.
          </span>
        </li>
        <li>
          <ShieldCheck aria-hidden />
          <span>
            Each person's chats run on their own Claude sign-in, and its pushes go out as whoever asked, with their own
            GitHub.
          </span>
        </li>
      </ul>

      {paying ? (
        <small role="status">
          Finish paying in your browser. The computer starts here by itself once the payment goes through.
        </small>
      ) : refusal ? (
        <small role="note">{refusal}</small>
      ) : null}
    </>
  );
}

/** The team's computer, from its first step onwards. */
export function TeamComputer({
  computer,
  busy,
  onRetry,
  onWake,
}: {
  computer: AuraComputer;
  busy: ComputerBusy;
  onRetry: () => void;
  onWake: () => void;
}) {
  const ends = endsLine(computer);
  if (computer.stage === "failed") {
    return (
      <ErrorState
        title="It didn't come up"
        message={computer.problem || computer.headline}
        onRetry={computer.can_retry && !busy ? onRetry : undefined}
      />
    );
  }
  if (settingUp(computer)) {
    const fraction = progressOf(computer);
    return (
      <>
        <p className="ui-aura-computer-lede">
          {computer.stage === "paying"
            ? "Waiting for the plan's payment to go through. This page moves on by itself once it does."
            : `Setting up ${computer.name}. This takes a few minutes. You can close this — it carries on, and shows up in your list of places when it's ready.`}
        </p>
        <div className="ui-aura-computer-progress">
          <div>
            <AsciiSpinner />
            <span>{computer.headline}</span>
          </div>
          <Progress value={fraction === null ? null : fraction * 100} />
          <small>{stepLine(computer)}</small>
        </div>
      </>
    );
  }
  const asleep = dozing(computer);
  const size = sizeLine(computer);
  return (
    <EmptyState
      icon={asleep ? Moon : CircleCheck}
      title={computer.stage === "ending" ? `${computer.name} is being ended` : `${computer.name} is your team's`}
      body={computer.problem ? `${computer.headline} ${computer.problem}` : computer.headline}
      action={
        computer.can_wake
          ? { label: busy === "wake" ? "Waking it…" : "Wake it now", onClick: onWake, disabled: !!busy }
          : undefined
      }
      footnote={ends ?? (size ? `${usageLine(computer)} ${size}` : usageLine(computer))}
    />
  );
}
