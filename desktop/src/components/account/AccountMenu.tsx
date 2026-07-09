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
}: {
  /** Letter shown in the avatar — same value the bare titlebar button
   *  used, kept so the chrome looks identical when the menu is closed. */
  userInitial?: string;
  /** Opens Settings → Identity. Reused as the "Account settings" action
   *  once the user is signed in. */
  onOpenProfile?: () => void;
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
  // keep it fresh while other surfaces flip the auth state.
  useEffect(() => {
    if (open) refresh();
    const onChange = () => refresh();
    window.addEventListener("aura:cloud-auth-changed", onChange);
    return () => window.removeEventListener("aura:cloud-auth-changed", onChange);
  }, [open, refresh]);

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ade-tb-av"
          aria-label="Profile & account"
          title="Profile & account"
        >
          {userInitial ?? "·"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-0 overflow-hidden">
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
              {connected
                ? status?.org_slug
                  ? `${status.org_slug} · Aura Cloud`
                  : "Aura Cloud"
                : "Sign in to sync"}
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
        ) : (
          <div className="p-3">
            <div className="text-[11.5px] leading-snug text-text-3 mb-2.5">
              Sign in to sync across devices and show your real name and
              avatar in Team chat.
            </div>
            <button
              type="button"
              onClick={openSignIn}
              className="h-9 w-full inline-flex items-center justify-center rounded-md text-[12.5px] font-medium text-white hover:brightness-110 transition-[filter]"
              style={{ background: "var(--color-accent)" }}
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
