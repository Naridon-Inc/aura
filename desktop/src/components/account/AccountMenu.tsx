// Account menu — the panel behind the plan chip at the foot of the sidebar
// (and behind the wide identity row / bare avatar where those are still used).
// Signed out it offers a single "Sign in" button that opens the full-screen
// welcome surface (the SignInWizard — the same aura-cloud device-code flow,
// just roomier and more inviting than a cramped popover); signed in it shows
// who you are, which org you are acting as, and the few things you can do.
//
// It opens on the SAME panel as every drop-out in the web console's sidebar:
// Popover + FinderMenu from aura-shared — one header band (you), rows in
// groups with a hairline between them, a footer band. The desktop's Radix
// menus wear the same row recipe (menuSurface.ts), so this is not a second
// family; it is the one panel the sidebar has, here as well as there.
//
// ## The org is a group, not a submenu
//
// The org used to live in a submenu off a "Switch org" row (OrgSwitcher),
// which cost a hover and a second panel to see the one word that decides what
// every list in the app shows. Here it is a captioned group of rows with the
// accent check on the current one — the shape the console's org picker has —
// and it is fetched only when the menu opens, so a closed menu asks the
// network nothing. Loading, error and empty are each one quiet row that keeps
// the menu open when pressed (the error row is the retry).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bot, LogOut, Smartphone, UserCog } from "lucide-react";

import { api, type CloudAuthStatus } from "../../lib/api";
import {
  messageOf,
  onOrgChanged,
  orgLabel,
  orgSubtitle,
  switchOrg,
  useCloudOrgs,
} from "../../lib/cloudOrgs";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { FinderMenu, type FinderMenuGroup, type FinderMenuItem } from "@shared/ui/FinderList";

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

  const orgGroup = useOrgGroup(open && connected);

  const fire = (name: string, detail?: unknown) => {
    window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
  };

  // Shaping how the AI works on this project isn't tied to being signed in,
  // so it sits in the actions group either way.
  const actions: FinderMenuItem[] = [
    { id: "customize", icon: <Bot />, label: "Customize agent", onSelect: () => fire("aura:open-agent-customizations") },
  ];
  if (connected) {
    actions.push({ id: "pair", icon: <Smartphone />, label: "Pair phone", onSelect: () => fire("aura:open-pair-phone") });
    if (onOpenProfile) actions.push({ id: "settings", icon: <UserCog />, label: "Account settings", onSelect: onOpenProfile });
  }

  const groups: FinderMenuGroup[] = [];
  if (orgGroup) groups.push(orgGroup);
  groups.push({ items: actions });
  if (connected) {
    groups.push({ items: [{ id: "signout", icon: <LogOut />, label: "Sign out", tone: "danger", onSelect: () => void signOut() }] });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
      {/* Both the wide row and the foot's plan chip are left-edge controls in
          the leftmost column of the window, so the panel hangs from their left
          edge; only the bare titlebar avatar, which sits at the right end of a
          strip, hangs from its right. The foot's chip opens upward. */}
      <PopoverContent
        align={wide || trigger ? "start" : "end"}
        side={trigger ? "top" : "bottom"}
        sideOffset={6}
        className="w-[264px] p-0"
      >
        <FinderMenu
          onClose={() => setOpen(false)}
          header={
            <>
              <span className="flex size-[26px] shrink-0 items-center justify-center rounded-md bg-bg-3 text-[11px] font-medium text-text-2" aria-hidden>
                {initial}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[12.5px] font-medium text-text-1">
                  {connected ? who ?? "Signed in" : "Not signed in"}
                </span>
                <span className="truncate text-[10.5px] text-text-4">{orgLine}</span>
              </span>
            </>
          }
          groups={groups}
          footer={
            connected ? undefined : (
              // Just the button. The header already reads "Sign in to sync",
              // so the panel's whole job below it is one click.
              <button
                type="button"
                onClick={openSignIn}
                className="h-7 w-full inline-flex items-center justify-center rounded-md text-sm font-medium outline-none hover:brightness-110 transition-[filter]"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-foreground)",
                }}
              >
                Sign in
              </button>
            )
          }
        />
      </PopoverContent>
    </Popover>
  );
}

/** The org group's rows — the list, or the one line that stands in for it.
 *  Nothing is fetched until `active`: the list costs a round trip to
 *  `/api/v2/repos`, and it is only ever looked at from in here. */
function useOrgGroup(active: boolean): FinderMenuGroup | null {
  const { orgs, loading, error, loaded, reload } = useCloudOrgs(active);
  // Which slug is being switched to, while the write is in flight. Held rather
  // than derived so the row you clicked is the one that shows the spinner —
  // "something is happening somewhere" is not feedback.
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const current = orgs.find((o) => o.current);

  const pick = useCallback(
    async (slug: string) => {
      if (slug === current?.slug || pending) return;
      setPending(slug);
      setFailed(null);
      try {
        await switchOrg(slug);
        // `switchOrg` broadcasts, and `useCloudOrgs` reloads on that — so the
        // ticked row moves on its own without this having to hold a copy.
      } catch (e) {
        setFailed(messageOf(e));
      } finally {
        setPending(null);
      }
    },
    [current?.slug, pending],
  );

  if (!active) return null;
  const stay = () => false as const;
  const retry = () => {
    reload();
    return false as const;
  };
  const problem = error ?? failed;

  let items: FinderMenuItem[];
  if (loading && !loaded) {
    // The first read, before anything has come back. A reload behind a list
    // we already have stays silent — the rows are still true.
    items = [{ id: "loading", label: <span className="inline-flex items-center gap-1.5"><AsciiSpinner size={11} /> Loading your orgs…</span>, onSelect: stay }];
  } else if (problem) {
    // Says what went wrong and IS the retry — a menu you have to close and
    // reopen to retry is a menu that looks broken twice.
    items = [{ id: "error", label: problem, hint: "Try again", onSelect: retry }];
  } else if (loaded && orgs.length === 0) {
    // Not a real state: every signup owns an org, so an empty list means the
    // server answered something we didn't understand. Say that.
    items = [{ id: "empty", label: "No orgs came back.", hint: "Try again", onSelect: retry }];
  } else {
    items = orgs.map((org) => ({
      id: org.slug,
      label: orgLabel(org),
      selected: !!org.current,
      trailing: pending === org.slug ? <AsciiSpinner size={11} /> : orgSubtitle(org),
      // Held open so the tick lands where you can see it.
      onSelect: () => {
        void pick(org.slug);
        return false;
      },
    }));
  }
  return { label: "Organization", items };
}
