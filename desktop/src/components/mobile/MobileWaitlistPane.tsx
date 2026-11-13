// "Aura on your phone" — the waitlist body, shared by the What's New moment
// and Settings → Connections → Aura on your phone.
//
// Deliberately one screen: where to reach you, which phone. What the phone
// app is for is said by whatever frames this — the dialog's description, the
// settings page's intro. No account, no sign-in, no second step. Once someone has
// joined, the pane says so and stays quiet — the form doesn't come back.
//
// Plain language throughout (the audience are not engineers): "iPhone", not
// "iOS build"; "we'll email you", not "we'll notify you via the waitlist".

import { useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";

import { api } from "../../lib/api";
import {
  PLATFORM_LABEL,
  waitlistJoin,
  waitlistStatus,
  type WaitlistPlatform,
  type WaitlistState,
} from "../../lib/mobileWaitlist";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented";
import { SettingsActions } from "../ui/settings-blocks";
import { SettingsRow } from "../ui/settings-row";
import "../ui/waitlist.css";

const PLATFORMS: { value: WaitlistPlatform; label: string }[] = [
  { value: "ios", label: "iPhone" },
  { value: "android", label: "Android" },
  { value: "both", label: "Both" },
];

export function MobileWaitlistPane({
  /** Rendered under the form — lets the dialog add its own "Not now". */
  footer,
  onJoined,
  layout = "form",
}: {
  footer?: React.ReactNode;
  onJoined?: (state: WaitlistState) => void;
  /** "rows" lays the same form out as settings rows, for the Settings page. */
  layout?: "form" | "rows";
}) {
  const [state, setState] = useState<WaitlistState | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<WaitlistPlatform>("both");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Load "have I already joined", and pre-fill from the identity the app
  // already knows so most people only have to pick a phone and press one
  // button. Neither call is allowed to break the pane.
  useEffect(() => {
    void (async () => {
      const known = await waitlistStatus();
      if (!alive.current) return;
      setState(known);
      if (known.joined) return;
      try {
        const me = await api.deviceIdentity();
        if (!alive.current) return;
        setEmail((cur) => cur || (me.email ?? ""));
        setName((cur) => cur || (me.display_name ?? ""));
      } catch {
        /* no identity yet — the fields just start empty */
      }
    })();
  }, []);

  const submit = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const next = await waitlistJoin(email, platform, name);
      if (!alive.current) return;
      setState(next);
      onJoined?.(next);
    } catch (e) {
      if (!alive.current) return;
      setError(String(e));
    } finally {
      if (alive.current) setSending(false);
    }
  };

  if (state == null) {
    return (
      <p className="ui-settings-status">
        <AsciiSpinner size={10} />
        Checking…
      </p>
    );
  }

  if (state.joined && layout === "rows") {
    return (
      <SettingsRow
        title="You’re on the list"
        description={`We’ll email ${state.email || "you"} the moment the ${
          state.platform ? PLATFORM_LABEL[state.platform].toLowerCase() : "phone"
        } app is ready to try. Nothing else. No newsletter.`}
        control={null}
      />
    );
  }

  if (state.joined) {
    return (
      <div className="ui-waitlist">
        <Alert>
          <AlertTitle>You&rsquo;re on the list.</AlertTitle>
          <AlertDescription>
            We&rsquo;ll email {state.email || "you"} the moment the{" "}
            {state.platform ? PLATFORM_LABEL[state.platform].toLowerCase() : "phone"} app is
            ready to try. Nothing else. No newsletter.
          </AlertDescription>
        </Alert>
        {footer && <SettingsActions>{footer}</SettingsActions>}
      </div>
    );
  }

  const canSend = email.trim().length > 0 && !sending;
  const emailInput = (
    <Input
      id="waitlist-email"
      type="email"
      autoComplete="email"
      placeholder="you@example.com"
      value={email}
      invalid={error != null}
      onChange={(e) => {
        setEmail(e.currentTarget.value);
        if (error) setError(null);
      }}
    />
  );
  const phonePicker = (
    <SegmentedControl<WaitlistPlatform>
      value={platform}
      onChange={setPlatform}
      options={PLATFORMS}
      ariaLabel="Which phone?"
    />
  );
  const joinButton = (
    <Button type="submit" size="sm" disabled={!canSend}>
      {sending ? (
        <>
          <AsciiSpinner size={10} />
          Sending…
        </>
      ) : (
        <>
          <Smartphone />
          Join the waitlist
        </>
      )}
    </Button>
  );
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSend) void submit();
  };

  if (layout === "rows") {
    return (
      <form onSubmit={onSubmit}>
        <SettingsRow
          title="Email"
          description="Where to send your invite."
          htmlFor="waitlist-email"
          help={error ? <span className="ui-settings-error">{error}</span> : undefined}
          control={emailInput}
        />
        <SettingsRow title="Which phone?" description="The app you want first." control={phonePicker} />
        <SettingsRow
          title="Waitlist"
          description="Your email goes to us and nobody else, and is used for this one invite. Nothing about your code or your repositories leaves this computer."
          control={joinButton}
        />
      </form>
    );
  }

  return (
    <form className="ui-waitlist" onSubmit={onSubmit}>
      <Field label="Email" htmlFor="waitlist-email" error={error ?? undefined}>
        {emailInput}
      </Field>
      <Field label="Which phone?">{phonePicker}</Field>
      <SettingsActions>
        {joinButton}
        {footer}
      </SettingsActions>
      <p className="ui-waitlist-note">
        Your email goes to us and nobody else, and is used for this one invite. Nothing about
        your code or your repositories leaves this computer.
      </p>
    </form>
  );
}
