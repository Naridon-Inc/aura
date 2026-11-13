// First-run consent for anonymous product telemetry.
//
// Aura's audience is non-engineers who fear software doing things behind their
// back, so we ask once, in plain language, and send NOTHING until they answer
// (telemetry.rs gates every event on `decided`). We explain what we collect
// (anonymous usage counts + crash reports — never their code, files, prompts,
// or names) and gently make the case for leaving crash reports on, because
// that's the part that actually helps us fix the thing that just broke for
// them. Both switches default on; either can be turned off here and later in
// Settings → Privacy.
//
// Shown only when `telemetryConsentGet().decided === false`. Once answered it
// never reappears.

import { useEffect, useState } from "react";
import { api, type TelemetryConsent as Consent } from "../lib/api";
import { trackActivation } from "../lib/track";
import { Switch } from "./ui/switch";
import { LiveToast } from "./LiveToast";

export function TelemetryConsent() {
  const [show, setShow] = useState(false);
  const [product, setProduct] = useState(true);
  const [crash, setCrash] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .telemetryConsentGet()
      .then((c: Consent) => {
        if (alive && !c.decided) setShow(true);
      })
      .catch(() => {
        /* no backend / no key — never prompt */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

  const save = async (p: boolean, c: boolean) => {
    try {
      await api.telemetrySetConsent(p, c);
      // First step of the activation funnel. Safe to send after the answer
      // lands: if they said no, the backend drops it on the floor.
      trackActivation("consent_answered", { product: p, crash: c });
    } catch {
      /* best-effort — closing either way so we don't nag */
    } finally {
      setShow(false);
    }
  };

  // No close button and no timer: nothing is sent until they pick one of
  // the two buttons, so the question stays until it's answered.
  return (
    <LiveToast
      id="telemetry-consent"
      tone="accent"
      title="Help make Aura better?"
      durationMs={null}
      dismissible={false}
      message={
        <>
          Aura can send anonymous notes about which features get used and when
          something crashes, so we can see what&rsquo;s working and fix what
          isn&rsquo;t. It <span className="text-[var(--aura-toast-text)]">never</span>{" "}
          sends your code, your files, what you type, or your name. You can change
          this anytime in Settings.
          <span className="mt-3 grid gap-2.5">
            <Row
              on={crash}
              onToggle={() => setCrash((v) => !v)}
              title="Crash reports"
              hint="The most useful. Tells us when Aura breaks so we can fix it for you."
            />
            <Row
              on={product}
              onToggle={() => setProduct((v) => !v)}
              title="Usage analytics"
              hint="Anonymous counts of which features people open. No content."
            />
          </span>
        </>
      }
      actions={[
        {
          label: "No thanks",
          variant: "default",
          keepOpen: true,
          // The returned promise keeps both buttons disabled while it saves.
          onClick: () => save(false, false),
        },
        {
          label: "Allow",
          variant: "primary",
          keepOpen: true,
          onClick: () => save(product, crash),
        },
      ]}
    />
  );
}

function Row({
  on,
  onToggle,
  title,
  hint,
}: {
  on: boolean;
  onToggle: () => void;
  title: string;
  hint: string;
}) {
  return (
    <span className="flex items-start gap-2.5">
      <Switch checked={on} onCheckedChange={onToggle} className="mt-px shrink-0" />
      <span className="min-w-0">
        <span className="block font-medium text-[var(--aura-toast-text)]">{title}</span>
        <span className="block text-xs leading-[1.45]">{hint}</span>
      </span>
    </span>
  );
}
