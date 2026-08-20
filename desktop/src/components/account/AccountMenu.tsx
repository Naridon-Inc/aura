// Account menu — the popover behind the plan chip at the foot of the sidebar
// (and behind the wide identity row / bare avatar where those are still used).
// Signed out it offers a single "Sign in" button that opens the full-screen
// welcome surface (the SignInWizard — the same aura-cloud device-code flow,
// just roomier and more inviting than a cramped popover); signed in it shows
// who you are plus Account settings and Sign out. The popover stays tiny; the
// welcome does the work.
//
// It opens on the SAME primitive as every other menu in the app — the shared
// DropdownMenu. It used to be a Medusa Popover, which is a different component
// with a different panel: its own `w-72 p-4` shell, its own elevation, its own
// open animation. Borrowing menuSurface's row classes onto it got the rows
// looking right but left the surface underneath them belonging to a second
// menu family, so the one flyout you open from the foot of the rail was the
// one flyout that didn't match. A popover is for arbitrary content; this is a
// list of things you can do, which is a menu.
//
// It is deliberately short. The compaction came out of the content, not out of
// the metrics: the rows are still the shared 36px at the shared size, because a
// menu that shrinks its own rows to feel tidy is exactly the drift this file
// just stopped doing. What went instead was everything saying the same thing
// twice — the ORGANIZATION caption and its ✓ row (now a subtitle under your
// name), a separator between every pair of rows, and two lines of prose above
// the Sign in button explaining what the button does.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type CloudAuthStatus } from "../../lib/api";
import { onOrgChanged } from "../../lib/cloudOrgs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { OrgSwitcher } from "./OrgSwitcher";

export function AccountMenu({
  userInitial,
  onOpenProfile,
  wide = false,
  square = false,
  trigger,
}: {
  /** Fallback letter for the avatar, used when nobody is signed in and
   *  there is no name to take one from. */
  userInitial?: string;
  /** Opens Settings → Identity. Reused as the "Account settings" action
   *  once the user is signed in. */
  onOpenProfile?: () => void;
  /** Sidebar row variant — a full-width identity row (avatar + name +
   *  org subtitle) instead of the bare titlebar avatar. Used at the top
   *  of the left sidebar (Conductor-style), where the name should be
   *  visible without opening the popover. */
  wide?: boolean;
  /** Compact-trigger variant — a small neutral rounded-square chip instead
   *  of the round accent-filled avatar. Used in the sidebar header strip so
   *  the profile control reads as quiet chrome, not a brand badge. */
  square?: boolean;
  /** Render this element as the trigger instead of one of the built-in
   *  avatars. The sidebar's foot passes its plan chip, so the chip that
   *  states which plan you're on is also the control that opens the account
   *  — one account control in the window rather than a chip at the bottom
   *  and an avatar at the top that each knew half the story. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CloudAuthStatus | null>(null);
  // The name the rest of the app already calls you — your git identity, the
  // one on your commits and in chat and presence. Cloud logins made before
  // the token started carrying `cloud_user` have no name attached, and this
  // popover was the only place that admitted it: it said "Signed in" and drew
  // a placeholder dot while every other surface used your name.
  const [localName, setLocalName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.cloudAuthStatus());
    } catch {
      setStatus((s) => s ?? { connected: false, cloud_url: "" });
    }
  }, []);

  useEffect(() => {
    let live = true;
    api
      .deviceIdentity()
      .then((d) => {
        if (live) setLocalName(d.display_name?.trim() || null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Pull status when the menu opens (cheap, reads credentials.json) and
  // keep it fresh while other surfaces flip the auth state. The wide
  // sidebar row shows the name inline, so it also refreshes on mount — and,
  // because it's always visible, on window focus too, so an org created on
  // the web appears in the switcher without restarting the app. The popover
  // variant already re-reads every time it opens, so it needs no focus hook.
  //
  // A caller-supplied trigger is on screen the same way the wide row is — the
  // sidebar's plan chip states who you are before anything is clicked — so it
  // wants the same always-visible refresh, not the popover's open-time one.
  //
  // Switching org is the third thing that changes this caption — the name
  // stays, the line under it doesn't — so it re-reads on that too.
  const onScreen = wide || !!trigger;
  useEffect(() => {
    if (open || onScreen) refresh();
    const onChange = () => refresh();
    const off = onOrgChanged(onChange);
    if (onScreen) window.addEventListener("focus", onChange);
    return () => {
      off();
      if (onScreen) window.removeEventListener("focus", onChange);
    };
  }, [open, onScreen, refresh]);

  // Opening the full-screen welcome is a one-liner: close the popover and
  // let App.tsx mount the SignInWizard. It broadcasts `aura:cloud-auth-changed`
  // on success, which our `refresh` listener above already picks up.
  const openSignIn = useCallback(() => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("aura:open-signin"));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.cloudAuthLogout();
    } catch {
      /* already signed out / no credentials — fall through to refresh */
    }
    await refresh();
    window.dispatchEvent(new CustomEvent("aura:cloud-auth-changed"));
  }, [refresh]);

  const connected = !!status?.connected;
  const who = status?.user || localName;

  // The avatar's letter comes from whoever is signed in. Every call site used
  // to hand it a literal, so the app showed one developer's initial to
  // everyone; the name is right here, so take it from there and keep the prop
  // only as the last fallback.
  const initial = (who?.trim()?.[0] ?? userInitial ?? "·").toUpperCase();

  // Which org you are acting as. The name when we have learned it — that is
  // what a person calls their team — and the slug otherwise, which is all the
  // pairing exchange ever wrote.
  const orgWord = status?.org_name?.trim() || status?.org_slug?.trim();
  const orgLine = connected
    ? orgWord
      ? `${orgWord} · Aura Cloud`
      : "Aura Cloud"
    : "Sign in to sync";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {trigger ? (
          trigger
        ) : wide ? (
          // Subtle single-line identity row — deliberately quiet, matching the
          // weight of the nav rows below it (Conductor's Workspaces / Mission
          // Control), not a bordered account card. Small avatar + muted name +
          // a faint chevron; the org + actions live in the popover.
          <button
            type="button"
            className="group flex items-center gap-2 w-full min-w-0 pl-1 pr-1.5 py-1 rounded-md text-left text-text-3 hover:bg-state-hover hover:text-text-1 transition-colors"
            aria-label="Profile & account"
            title={
              connected
                ? `${who ?? "Signed in"} · ${orgLine}`
                : "Sign in to Aura Cloud"
            }
          >
            <span
              className="ade-tb-av shrink-0"
              style={{ width: 20, height: 20, fontSize: 10 }}
              aria-hidden
            >
              {initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm leading-tight">
              {connected ? (who ?? "Signed in") : "Sign in"}
            </span>
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              className="shrink-0 text-text-4 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-hidden
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className={square ? "ade-tb-av ade-tb-av--sq" : "ade-tb-av"}
            aria-label="Profile & account"
            title="Profile & account"
          >
            {initial}
          </button>
        )}
      </DropdownMenuTrigger>
      {/* Both the wide row and the foot's plan chip are left-edge controls in
          the leftmost column of the window, so the panel hangs from their left
          edge; only the bare titlebar avatar, which sits at the right end of a
          strip, hangs from its right. */}
      <DropdownMenuContent
        align={wide || trigger ? "start" : "end"}
        sideOffset={6}
        className="w-52"
      >
        {/* Identity — a two-line caption, not a row. The rows below it are
            things you can do; this is the one thing here that is only a fact,
            so it doesn't take a row's height or a row's hover.
            `orgLine` carries the org, which used to cost a separator, an
            ORGANIZATION caption and a full row with a ✓ on it — three elements
            and ~70px to say a word that fits under your name. It stays a
            subtitle: the switching happens in the row right below, which costs
            one line no matter how many orgs you are in. */}
        <div className="px-2 pt-0.5 pb-1.5">
          <div className="truncate text-sm leading-4 text-text-1">
            {connected ? who ?? "Signed in" : "Not signed in"}
          </div>
          <div className="truncate text-2xs leading-4 text-text-4">
            {orgLine}
          </div>
        </div>

        {/* Directly under the line that names the org, because it is the
            control for that line. Signed out there is no org to be in, so
            there is nothing here to offer. */}
        {connected && (
          <>
            <DropdownMenuSeparator />
            <OrgSwitcher />
          </>
        )}

        <DropdownMenuSeparator />

        {/* Shaping how the AI works on this project isn't tied to being
            signed in, so it sits above the auth-specific rows either way. */}
        <DropdownMenuItem
          onSelect={() =>
            window.dispatchEvent(
              new CustomEvent("aura:open-agent-customizations"),
            )
          }
        >
          Customize agent
        </DropdownMenuItem>

        {connected ? (
          <>
            {/* Account actions. No separator ahead of them — "Customize agent"
                already sits above under one, and a four-row menu that rules
                itself off after every row is mostly rules. */}
            <DropdownMenuItem
              onSelect={() =>
                window.dispatchEvent(new CustomEvent("aura:open-pair-phone"))
              }
            >
              Pair phone
            </DropdownMenuItem>
            {onOpenProfile && (
              <DropdownMenuItem onSelect={onOpenProfile}>
                Account settings
              </DropdownMenuItem>
            )}
            {/* Sign out is a plain row, not a red one. Red is how this app says
                something went wrong; signing out is something you meant to do,
                and it takes one click to undo. The rule it sits under is a
                separator, which is what actually marks it as the last thing. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {/* Just the button. It used to sit under two lines of prose about
                syncing and avatars — but the caption at the top of this menu
                already reads "Sign in to sync", so the paragraph was the same
                sentence a second time, in a panel whose whole job here is one
                click. */}
            <button
              type="button"
              onClick={openSignIn}
              className="mt-1 h-7 w-full inline-flex items-center justify-center rounded-md text-sm font-medium outline-none hover:brightness-110 transition-[filter]"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-foreground)",
              }}
            >
              Sign in
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
