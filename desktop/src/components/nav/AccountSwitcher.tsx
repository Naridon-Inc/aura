import { useState } from "react";
import { Bot, Building2, Check, CreditCard, LogIn, LogOut, Smartphone, UserCog, Users } from "lucide-react";
import { AppNavigationAccount } from "../ui/app-navigation";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  messageOf,
  orgLabel,
  orgSubtitle,
  switchOrg,
  useCloudOrgs,
} from "../../lib/cloudOrgs";
import { CreateOrgDialog } from "../settings/org/CreateOrgDialog";
import { PlaceSwitchItems } from "./PlaceSwitchItems";
import type { AccountView } from "./useAccountStanding";

const fire = (name: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));

/** The account row under the sidebar header and the menu it opens. */
export function AccountSwitcher({ account }: { account: AccountView }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <AppNavigationAccount letter={account.letter} label={account.name} title={account.title} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[232px]">
        <DropdownMenuLabel>
          <span className="block truncate">
            {account.connected ? account.who : "Not signed in"}
          </span>
          <span className="block truncate font-normal opacity-70">{account.orgLine}</span>
        </DropdownMenuLabel>
        <PlaceSwitchItems active={open} connected={account.connected} />
        {account.connected && (
          <>
            <OrganizationItems active={open} />
            <DropdownMenuItem onSelect={() => fire("aura:open-settings", { pane: "billing" })}>
              <CreditCard />
              Billing
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fire("aura:open-settings", { pane: "team" })}>
              <Users />
              Members
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCreating(true)}>
              <Building2 />
              Create organization…
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => fire("aura:open-agent-customizations")}>
          <Bot />
          Customize agent
        </DropdownMenuItem>
        {account.connected && (
          <>
            <DropdownMenuItem onSelect={() => fire("aura:open-pair-phone")}>
              <Smartphone />
              Pair phone
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fire("aura:open-settings", { pane: "identity" })}>
              <UserCog />
              Account settings
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        {account.connected ? (
          <DropdownMenuItem onSelect={() => void account.signOut()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={account.openSignIn}>
            <LogIn />
            Sign in
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </DropdownMenu>
  );
}

/** Organizations, fetched only while the menu is open. */
function OrganizationItems({ active }: { active: boolean }) {
  const { orgs, loading, error, loaded, reload } = useCloudOrgs(active);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const current = orgs.find((org) => org.current);
  const problem = error ?? failed;

  const pick = async (slug: string) => {
    if (slug === current?.slug || pending) return;
    setPending(slug);
    setFailed(null);
    try {
      await switchOrg(slug);
    } catch (e) {
      setFailed(messageOf(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="font-normal opacity-70">Organization</DropdownMenuLabel>
      {loading && !loaded ? (
        <DropdownMenuItem disabled>
          <AsciiSpinner size={11} />
          Loading your orgs…
        </DropdownMenuItem>
      ) : problem ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            reload();
          }}
        >
          <span className="truncate">{problem}</span>
          <span className="ml-auto opacity-70">Try again</span>
        </DropdownMenuItem>
      ) : loaded && orgs.length === 0 ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            reload();
          }}
        >
          No orgs came back.
          <span className="ml-auto opacity-70">Try again</span>
        </DropdownMenuItem>
      ) : (
        orgs.map((org) => (
          <DropdownMenuItem
            key={org.slug}
            onSelect={(event) => {
              event.preventDefault();
              void pick(org.slug);
            }}
          >
            {org.current ? <Check /> : <span className="inline-block w-4" aria-hidden />}
            <span className="truncate">{orgLabel(org)}</span>
            <span className="ml-auto opacity-70">
              {pending === org.slug ? <AsciiSpinner size={11} /> : orgSubtitle(org)}
            </span>
          </DropdownMenuItem>
        ))
      )}
    </>
  );
}
