// "Aura on your phone" — the waitlist body, shared by the What's New moment
// and Settings → Connections → Aura on your phone.
//
// Deliberately one screen: what the phone app is for, where to reach you,
// which phone. No account, no sign-in, no second step. Once someone has
// joined, the pane says so and stays quiet — the form doesn't come back.
//
// Plain language throughout (the audience are not engineers): "iPhone", not
// "iOS build"; "we'll email you", not "we'll notify you via the waitlist".

import { useEffect, useRef, useState } from "react";
import { Check, Smartphone } from "lucide-react";

import { api } from "../../lib/api";
import {
  PLATFORM_LABEL,
  waitlistJoin,
  waitlistStatus,
  type WaitlistPlatform,
  type WaitlistState,
} from "../../lib/mobileWaitlist";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Segment } from "../ui/segment";

const PLATFORMS: { value: WaitlistPlatform; label: string }[] = [
  { value: "ios", label: "iPhone" },
  { value: "android", label: "Android" },
  { value: "both", label: "Both" },
];

export function MobileWaitlistPane({
  /** Rendered under the form — lets the dialog add its own "Not now". */
  footer,
  onJoined,
}: {
  footer?: React.ReactNode;
  onJoined?: (state: WaitlistState) => void;
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
      <div className="flex items-center gap-2 py-6 text-[12px] text-text-3">
        <AsciiSpinner />
        <span>Checking…</span>
      </div>
    );
  }

  if (state.joined) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5">
          <span
            className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 16%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            <Check className="h-3 w-3" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text-1">
              You&rsquo;re on the list.
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-text-3">
              We&rsquo;ll email {state.email || "you"} the moment the{" "}
              {state.platform ? PLATFORM_LABEL[state.platform].toLowerCase() : "phone"} app
              is ready to try. Nothing else — no newsletter.
            </p>
          </div>
        </div>
        {footer}
      </div>
    );
  }

  const canSend = email.trim().length > 0 && !sending;

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[12px] leading-relaxed text-text-3">
        Aura is coming to iPhone and Android — check on what your agents are
        doing, steer them, and approve work while you&rsquo;re away from your
        desk. Tell us where to reach you and we&rsquo;ll send an invite when
        it&rsquo;s ready.
      </p>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="waitlist-email"
          className="text-[11px] font-medium text-text-3"
        >
          Email
        </label>
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSend) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-text-3">Which phone?</span>
        <Segment<WaitlistPlatform>
          value={platform}
          onChange={setPlatform}
          options={PLATFORMS}
          size="sm"
        />
      </div>

      {error && (
        <div className="text-[11.5px] leading-snug text-red-400">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!canSend}
          onClick={() => void submit()}
          className="gap-1.5"
        >
          {sending ? (
            <>
              <AsciiSpinner />
              Sending…
            </>
          ) : (
            <>
              <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
              Join the waitlist
            </>
          )}
        </Button>
        {footer}
      </div>

      <p className="text-[11px] leading-snug text-text-4">
        Your email goes to us and nobody else, and is used for this one invite.
        Nothing about your code or your projects leaves this computer.
      </p>
    </div>
  );
}
