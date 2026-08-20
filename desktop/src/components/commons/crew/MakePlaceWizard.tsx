// "Have Aura make one" — the second door into a place.
//
// The first, `ConnectMachineWizard`, is a form: you own a Linux box, you type
// its address, three steps of setup follow. This is deliberately not that. An
// admin names a place and picks how big it should be, and there is nothing else
// to fill in, because everything the other wizard asks for — the host, the
// login, the key, the setup — is the part Aura is doing for them. A second
// three-step flow here would have been a shape borrowed from the mode that
// needs it.
//
// So: one screen, two fields, and the two facts that decide whether an admin
// should press the button — what each size is for, and who on the team will be
// able to open the thing once it exists. That second one is the surprise this
// screen exists to remove: cloud is a per-member grant, not a consequence of
// being in the org, so a team of thirty on three seats has three people who can
// open what is about to be made.
//
// Every decision on this screen is in `lib/place/make`. What is left here is
// drawing, the two calls, and the four states a surface is allowed to be in.

import { useCallback, useEffect, useState } from "react";

import { CircleCheck, Server, Sparkles } from "lucide-react";

import { api, type MadePlace, type PlaceMakeOffer, type PlaceRow } from "../../../lib/api";
import {
  canOpenItNow,
  canSubmit,
  entitledLine,
  madeLine,
  nameProblem,
  suggestedSize,
  worthRetrying,
} from "../../../lib/place";
import { FullscreenOverlay } from "../../FullscreenOverlay";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { EmptyState, ErrorState, LoadingState } from "../../ui/state";

export function MakePlaceWizard({
  /** The places already on screen, so a name clash is caught before a machine
   *  is made rather than by the board's 409 afterwards. */
  places,
  onClose,
  /** Called once the place exists, so the list behind this reloads. */
  onMade,
  /** The other door. Always offered, including on every refusal — somebody who
   *  may not have one made can still connect a box they already own, and a
   *  screen that only said no would be a dead end. */
  onConnectInstead,
}: {
  places: PlaceRow[];
  onClose: () => void;
  onMade: (made: MadePlace) => void;
  onConnectInstead: () => void;
}) {
  // `null` is "we haven't asked yet", which is not the same as an offer that
  // came back refusing. Drawing them the same way shows a refusal to somebody
  // whose request is still in flight.
  const [offer, setOffer] = useState<PlaceMakeOffer | null>(null);
  // The offer itself never rejects for a person who may not make one — that
  // comes back as a refusal with a reason. This is the bridge failing, which is
  // the one thing this screen genuinely cannot describe.
  const [offerBroke, setOfferBroke] = useState("");

  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState("");
  const [made, setMade] = useState<MadePlace | null>(null);

  const loadOffer = useCallback(() => {
    setOffer(null);
    setOfferBroke("");
    return api
      .placeMakeOffer()
      .then((next) => {
        setOffer(next);
        // Only ever the backend's suggestion. A picker that kept whatever was
        // selected before a reload would silently move somebody off the size
        // they had chosen.
        setSize((current) => current || suggestedSize(next));
      })
      .catch((e) => setOfferBroke(String(e)));
  }, []);

  useEffect(() => {
    void loadOffer();
  }, [loadOffer]);

  const problem = nameProblem(name, places);
  const ready = canSubmit(offer, name, size, places);

  const make = () => {
    if (!ready || making) return;
    setMaking(true);
    setFailed("");
    api
      .placeMake(name.trim(), size)
      .then((next) => {
        setMade(next);
        onMade(next);
      })
      // Every refusal from here is already a sentence for a person: the desktop
      // writes the ones about authority and the server writes the ones about
      // the board. Wrapping them in our own would bury the only text that says
      // what to do.
      .catch((e) => setFailed(String(e)))
      .finally(() => setMaking(false));
  };

  return (
    <FullscreenOverlay
      onClose={onClose}
      footer={
        made ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onConnectInstead}>
              Connect one I already have
            </Button>
            <Button onClick={make} disabled={!ready || making}>
              {making ? <AsciiSpinner /> : <Sparkles size={14} />}
              {making ? "Making it…" : "Make it"}
            </Button>
          </>
        )
      }
    >
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5 px-6 py-8">
        {made ? (
          <Made made={made} />
        ) : offerBroke ? (
          <ErrorState
            message={`Aura couldn't work out what it can make here. ${offerBroke}`}
            onRetry={() => void loadOffer()}
          />
        ) : offer === null ? (
          <LoadingState label="Working out what Aura can make for you…" size="md" />
        ) : !offer.can_make ? (
          <Barred
            offer={offer}
            onRetry={() => void loadOffer()}
            onConnectInstead={onConnectInstead}
          />
        ) : (
          <>
            <header className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-text-1">
                Have Aura make a machine
              </h2>
              <p className="text-base text-text-4">
                It belongs to {offer.org}. Nobody has to buy hardware, install
                anything or hold a key — Aura keeps the key and lets your
                teammates in.
              </p>
            </header>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-text-4">
                What should it be called?
              </span>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="design-box"
                invalid={problem !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") make();
                }}
              />
              {problem ? (
                <span className="text-xs text-amber">{problem}</span>
              ) : (
                <span className="text-xs text-text-5">
                  How it shows up in everyone's list of places.
                </span>
              )}
            </label>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1.5 text-xs font-medium text-text-4">
                How big?
              </legend>
              {offer.sizes.map((s) => (
                <SizeChoice
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  detail={s.detail}
                  suggested={s.suggested}
                  chosen={size === s.id}
                  onChoose={() => setSize(s.id)}
                />
              ))}
            </fieldset>

            {/* The fact this screen exists to surface. Quiet, because it is
                information rather than a warning — but present before the
                button, not after the machine. */}
            <p className="text-xs text-text-5">{entitledLine(offer.entitled)}</p>

            {failed && (
              <ErrorState
                size="sm"
                title="It wasn't made"
                message={failed}
                onRetry={make}
              />
            )}
          </>
        )}
      </div>
    </FullscreenOverlay>
  );
}

/** One size. A row, not a card — the house rule is no bulky cards, and four
 *  bordered boxes for four one-line choices is exactly the thing it is about. */
function SizeChoice({
  id,
  title,
  detail,
  suggested,
  chosen,
  onChoose,
}: {
  id: string;
  title: string;
  detail: string;
  suggested: boolean;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onChoose}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
        chosen ? "bg-state-selected" : "hover:bg-state-hover"
      }`}
    >
      <span
        className={`mt-0.5 flex-none ${chosen ? "text-accent-green" : "text-text-5"}`}
        aria-hidden
      >
        <CircleCheck size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-base text-text-1">{title}</span>
          {suggested && (
            <span className="flex-none text-xs text-accent-green">Suggested</span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-text-5">{detail}</span>
      </span>
      <span className="sr-only">{id}</span>
    </button>
  );
}

/** Why this person cannot have one made, and what they can do instead.
 *
 *  An `EmptyState` rather than an `ErrorState` on purpose: nothing has gone
 *  wrong. Being a member rather than an admin is the system working, and the
 *  amber triangle would send somebody looking for a bug. */
function Barred({
  offer,
  onRetry,
  onConnectInstead,
}: {
  offer: PlaceMakeOffer;
  onRetry: () => void;
  onConnectInstead: () => void;
}) {
  const retry = worthRetrying(offer.reason);
  return (
    <EmptyState
      icon={Server}
      title="Aura can't make one for you"
      body={offer.blocked}
      action={
        retry
          ? { label: "Try again", onClick: onRetry }
          : { label: "Connect a machine I already have", onClick: onConnectInstead }
      }
      footnote={
        retry ? (
          <button
            type="button"
            onClick={onConnectInstead}
            className="text-text-4 underline-offset-4 hover:underline"
          >
            Or connect a machine you already have
          </button>
        ) : undefined
      }
    />
  );
}

/** It exists. */
function Made({ made }: { made: MadePlace }) {
  return (
    <EmptyState
      icon={CircleCheck}
      title={`${made.name} is yours`}
      body={madeLine(made)}
      footnote={
        <span className="text-text-5">
          {canOpenItNow(made)
            ? `${entitledLine(made.entitled)} It's in your list of places — open it whenever you like.`
            : entitledLine(made.entitled)}
        </span>
      }
    />
  );
}
