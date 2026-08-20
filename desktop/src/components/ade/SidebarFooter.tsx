// The foot of the rail — which plan you're on, who you are, and the two doors
// that belong nowhere else.
//
// The sidebar's destinations moved to the top, and settings went with the
// account into the header strip; help was dropped outright. What that left is
// a rail whose last row is a project and whose bottom edge says nothing —
// no answer to "which plan am I on", and no way to ask for help from the one
// panel that is on screen in every section.
//
// So: the plan chip on the left, help and settings on the right. Small, quiet,
// always there. It reports what the cloud actually says — a plan we weren't
// told is a word we don't print, and signed out says signed out rather than
// guessing "Free".
//
// The chip is also the account control. It used to open Settings while a second
// control — an avatar in the header strip above — owned signing in and out, so
// the window carried two account controls that each knew half the story: the
// bottom one your plan, the top one your name. Now the chip states both and
// opens the account menu, and the header strip carries no avatar at all.

import { useEffect, useState } from "react";
import { HelpCircle, Settings } from "lucide-react";

import { api } from "../../lib/api";
import { useEffectiveHandle } from "../../lib/identityHandle";
import { openExternal } from "../../lib/openExternal";
import { AccountMenu } from "../account/AccountMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const DOCS_URL = "https://auravcs.com/docs";

/** What the chip is able to say, from what we were actually told. */
export type AccountStanding = {
  signedIn: boolean;
  /** The account handle, when the cloud named one. */
  user: string | null;
  /** The plan word, when a billing read succeeded. Never inferred. */
  tier: string | null;
};

/** Title-case a plan the cloud spells however it likes (`free`, `PRO`). */
function planWord(tier: string | null): string | null {
  const t = (tier ?? "").trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** `@`-prefixed, exactly once, however it was stored. */
function atHandle(user: string | null): string | null {
  const u = (user ?? "").trim().replace(/^@/, "");
  return u ? `@${u}` : null;
}

/**
 * The plan badge, or nothing.
 *
 * Only a plan we were actually told goes in the badge. Printing "Free" at
 * someone whose plan we couldn't read tells them they're on a plan they may
 * not have — and the person it misleads most is the one paying for a bigger
 * one.
 */
export function standingPlan(s: AccountStanding): string | null {
  return s.signedIn ? planWord(s.tier) : null;
}

/**
 * The name beside the badge — whose plan this is.
 *
 * Signed out is an ask, not a state, so it says so rather than leaving the
 * bottom edge blank. Signed in with no name to show still beats silence,
 * because a badge on its own doesn't say whose account it belongs to.
 */
export function standingWho(s: AccountStanding): string {
  if (!s.signedIn) return "Sign in";
  return atHandle(s.user) ?? "Signed in";
}

/** The chip's hover text — the long form of what the two words compress. */
export function standingTitle(
  s: AccountStanding,
  trialDays: number | null,
): string {
  if (!s.signedIn) return "Sign in to Aura’s cloud";
  const plan = standingPlan(s);
  const who = standingWho(s);
  if (!plan) return `${who}, your account`;
  // A trial is the one case where the plan you can use isn't the plan you're
  // subscribed to, and how many days are left is the whole point of saying so.
  const trial =
    trialDays && trialDays > 0
      ? ` · trial, ${trialDays} day${trialDays === 1 ? "" : "s"} left`
      : "";
  return `${who} · ${plan} plan${trial}`;
}

export function SidebarFooter({ repoRoot = "" }: { repoRoot?: string }) {
  const [cloud, setCloud] = useState<{
    signedIn: boolean;
    user: string | null;
    tier: string | null;
    trialDays: number | null;
  }>({ signedIn: false, user: null, tier: null, trialDays: null });
  // Who you are here, from the repo's roster — the same answer Team shows and
  // `@me` resolves to. The credentials file proves a token exists but carries
  // no name, so on its own the chip could only ever say "signed in", which
  // tells you nothing you didn't know from the app being open.
  const handle = useEffectiveHandle(repoRoot);

  // Re-read when the account changes anywhere in the app. Signing in from the
  // welcome screen — or out, from this chip's own menu — has to move the chip,
  // or the bottom edge goes on insisting on an account you already left.
  const [authNonce, setAuthNonce] = useState(0);
  useEffect(() => {
    const bump = () => setAuthNonce((n) => n + 1);
    window.addEventListener("aura:cloud-auth-changed", bump);
    return () => window.removeEventListener("aura:cloud-auth-changed", bump);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let signedIn = false;
      let user: string | null = null;
      try {
        const s = await api.cloudAuthStatus();
        signedIn = s.connected;
        user = s.user ?? null;
      } catch {
        /* no credentials file yet — signed out is the honest reading */
      }
      if (!alive) return;
      let tier: string | null = null;
      let trialDays: number | null = null;
      if (signedIn) {
        try {
          // The plan comes from billing, not from the Aura Pro brain's token
          // quota. The quota answers a narrower question — how much of the
          // managed brain's monthly allowance is left — and answers it only
          // for people on that brain, so everyone else saw no plan at all.
          const b = await api.cloudBillingStatus();
          // Belonging to no organization comes back as `{ error }` with a 200.
          // That is not a plan, and reading it as one would put the word
          // "Error" in a badge.
          if (!b.error) {
            tier = b.effective_plan ?? b.plan ?? null;
            trialDays = b.trial_active ? b.trial_days_remaining ?? null : null;
          }
        } catch {
          /* a token on disk doesn't guarantee a readable plan; say nothing */
        }
      }
      if (!alive) return;
      setCloud({ signedIn, user, tier, trialDays });
    })();
    return () => {
      alive = false;
    };
  }, [authNonce]);

  const standing: AccountStanding = {
    signedIn: cloud.signedIn,
    // The roster's handle first — it names a person. The cloud's `user` is the
    // fallback for a machine with a token and no project open.
    user: (handle ?? "").trim() || cloud.user,
    tier: cloud.tier,
  };
  const plan = standingPlan(standing);
  const who = standingWho(standing);

  return (
    <div className="ade-side-foot">
      <AccountMenu
        onOpenProfile={() =>
          window.dispatchEvent(
            new CustomEvent("aura:open-settings", {
              detail: { pane: "identity" },
            }),
          )
        }
        trigger={
          <button
            type="button"
            className={`ade-foot-plan${standing.signedIn ? "" : " out"}`}
            aria-label="Plan and account"
            title={standingTitle(standing, cloud.trialDays)}
          >
            {plan ? <span className="ade-foot-plan-badge">{plan}</span> : null}
            <span className="ade-foot-plan-who">{who}</span>
          </button>
        }
      />

      <div className="ade-foot-acts">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button type="button" className="ade-foot-btn" aria-label="Help">
                  <HelpCircle size={15} />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Help</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem
              onSelect={() =>
                window.dispatchEvent(new CustomEvent("aura:start-tour"))
              }
            >
              Take the tour
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                window.dispatchEvent(new CustomEvent("aura:open-shortcuts"))
              }
            >
              Keyboard shortcuts
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void openExternal(DOCS_URL)}>
              Documentation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="ade-foot-btn"
              aria-label="Settings"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("aura:open-settings"))
              }
            >
              <Settings size={15} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Settings</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
