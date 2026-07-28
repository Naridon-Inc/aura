// Account menu — the top-right titlebar avatar's popover. Clicking the
// avatar opens this: when signed out it offers a single "Sign in" button
// that opens the full-screen welcome surface (the SignInWizard — the same
// aura-cloud device-code flow, just roomier and more inviting than a
// cramped popover); when signed in it shows who you are plus Account
// settings and Sign out. The popover stays tiny; the welcome does the work.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type CloudAuthStatus } from "../../lib/api";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";

export function AccountMenu({
  userInitial,
  onOpenProfile,
  wide = false,
  square = false,
}: {
  /** Letter shown in the avatar — same value the bare titlebar button
   *  used, kept so the chrome looks identical when the menu is closed. */
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
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CloudAuthStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.cloudAuthStatus());
    } catch {
      setStatus((s) => s ?? { connected: false, cloud_url: "" });
    }
  }, []);

  // Pull status when the menu opens (cheap, reads credentials.json) and
  // keep it fresh while other surfaces flip the auth state. The wide
  // sidebar row shows the name inline, so it also refreshes on mount — and,
  // because it's always visible, on window focus too, so an org created on
  // the web appears in the switcher without restarting the app. The popover
  // variant already re-reads every time it opens, so it needs no focus hook.
  useEffect(() => {
    if (open || wide) refresh();
    const onChange = () => refresh();
    window.addEventListener("aura:cloud-auth-changed", onChange);
    if (wide) window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener("aura:cloud-auth-changed", onChange);
      if (wide) window.removeEventListener("focus", onChange);
    };
  }, [open, wide, refresh]);

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
  const who = status?.user || null;

  const orgLine = connected
    ? status?.org_slug
      ? `${status.org_slug} · Aura Cloud`
      : "Aura Cloud"
    : "Sign in to sync";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {wide ? (
          // Subtle single-line identity row — deliberately quiet, matching the
          // weight of the nav rows below it (Conductor's Workspaces / Mission
          // Control), not a bordered account card. Small avatar + muted name +
          // a faint chevron; the org + actions live in the popover.
          <button
            type="button"
            className="group flex items-center gap-2 w-full min-w-0 pl-1 pr-1.5 py-1 rounded-md text-left text-text-3 hover:bg-bg-2 hover:text-text-1 transition-colors"
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
              {userInitial ?? "·"}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] leading-tight">
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
            {userInitial ?? "·"}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={wide ? "start" : "end"}
        sideOffset={6}
        className="w-72 p-0 overflow-hidden"
      >
        {/* Identity header */}
        <div className="flex items-center gap-2.5 px-3 py-3 border-b border-line-soft">
          <span className="ade-tb-av shrink-0" aria-hidden>
            {userInitial ?? "·"}
          </span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-text-1 truncate">
              {connected ? who ?? "Signed in" : "Not signed in"}
            </div>
            <div className="text-[11px] text-text-4 truncate">
              {connected ? "Aura Cloud" : "Sign in to sync"}
            </div>
          </div>
        </div>

        {/* Shaping how the AI works on this project isn't tied to being
            signed in, so it sits above the auth-specific rows either way. */}
        <div className="border-b border-line-soft p-1.5">
          <MenuItem
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(
                new CustomEvent("aura:open-agent-customizations"),
              );
            }}
          >
            Customize agent
          </MenuItem>
        </div>

        {connected ? (
          <>
            {/* Organizations you belong to. Refreshed every time this popover
                opens (and, in the sidebar row, on window focus), so an org
                created on the web shows up without restarting the app. */}
            {status?.org_slug && (
              <div className="border-b border-line-soft p-1.5">
                <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-5">
                  Organization
                </div>
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded text-[12.5px] text-text-1">
                  <span
                    className="ade-tb-av shrink-0"
                    style={{ width: 18, height: 18, fontSize: 9 }}
                    aria-hidden
                  >
                    {status.org_slug.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {status.org_slug}
                  </span>
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 text-accent"
                    aria-label="Active"
                  >
                    <path
                      d="M3.5 8.5l3 3 6-7"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>
            )}
            {/* Account actions — sit below the org list (Conductor IA #79:
                Settings moved beneath the organizations). */}
            <div className="p-1.5">
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent("aura:open-pair-phone"));
                }}
              >
                Pair phone
              </MenuItem>
              {onOpenProfile && (
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    onOpenProfile();
                  }}
                >
                  Account settings
                </MenuItem>
              )}
              <MenuItem onClick={signOut} tone="danger">
                Sign out
              </MenuItem>
            </div>
          </>
        ) : (
          <div className="p-3">
            <div className="text-[11.5px] leading-snug text-text-3 mb-2.5">
              Sign in to sync across devices and show your real name and
              avatar in Team chat.
            </div>
            <button
              type="button"
              onClick={openSignIn}
              className="h-9 w-full inline-flex items-center justify-center rounded-md text-[12.5px] font-medium hover:brightness-110 transition-[filter]"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-foreground)" }}
            >
              Sign in
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuItem({
  children,
  onClick,
  tone = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-2.5 py-1.5 rounded text-[12.5px] transition-colors ${
        tone === "danger"
          ? "text-red hover:bg-bg-2"
          : "text-text-2 hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}
