// Which org you are acting as — the control, in the account menu.
//
// The org used to be a subtitle under your name and nothing else: one word,
// written once at pairing, that no cloud call ever sent and no list ever
// honoured. Changing it meant signing out, which re-resolves from the server
// and lands you wherever it lands you. This is the row that makes it a choice.
//
// ## Why a submenu and not a section
//
// The account menu is deliberately short — a caption and four rows — and the
// list of orgs is unbounded: one for most people, a dozen for a contractor.
// Inlining it would make the length of a menu about signing out depend on how
// many clients you have. A submenu costs one row, always, and doesn't ask the
// network anything until you open it.
//
// ## Loading, empty and error are three different rows
//
// All three are one line inside the same panel — no card, no border, no box
// that appears and shoves the menu around. What they must never do is read as
// each other:
//
// * **Loading** is the app's one spinner, with the word beside it.
// * **Error** says what went wrong *and offers the retry*, because a menu you
//   have to close and reopen to retry is a menu that looks broken twice.
// * **Empty** cannot happen — every account owns at least its own org — so if
//   the list is genuinely empty, that is a fault, and the row says so rather
//   than sitting there blank looking like a correct answer.

import { useCallback, useState } from "react";

import type { CloudOrg } from "../../lib/api";
import {
  messageOf,
  orgLabel,
  orgSubtitle,
  switchOrg,
  useCloudOrgs,
} from "../../lib/cloudOrgs";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";

/** A single quiet line inside the submenu — the shape all three non-list
 *  states take, so none of them is a card and none of them resizes the panel
 *  more than the others. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-2xs leading-4 text-text-4">{children}</div>
  );
}

export function OrgSwitcher() {
  // Nothing is fetched until the submenu is opened. The list costs a round
  // trip to `/api/v2/repos`, and it is only ever looked at from in here.
  const [open, setOpen] = useState(false);
  const { orgs, loading, error, loaded, reload } = useCloudOrgs(open);
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

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>Switch org</DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-60">
          <Body
            orgs={orgs}
            loading={loading}
            loaded={loaded}
            error={error ?? failed}
            pending={pending}
            current={current?.slug}
            onRetry={reload}
            onPick={pick}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function Body({
  orgs,
  loading,
  loaded,
  error,
  pending,
  current,
  onRetry,
  onPick,
}: {
  orgs: CloudOrg[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  pending: string | null;
  current?: string;
  onRetry: () => void;
  onPick: (slug: string) => void;
}) {
  // The first read, before anything has come back. A reload behind a list we
  // already have stays silent — the rows are still true, and flashing them
  // away to show a spinner is a worse answer than the slightly stale one.
  if (loading && !loaded) {
    return (
      <Note>
        <span className="inline-flex items-center gap-1.5">
          <AsciiSpinner size={11} />
          Loading your orgs…
        </span>
      </Note>
    );
  }

  // Shown ahead of any stale list, because a list we already know is out of
  // date should not be the loudest thing here.
  if (error) {
    return (
      <Note>
        <div className="text-text-3">{error}</div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 text-2xs text-accent hover:underline outline-none"
        >
          Try again
        </button>
      </Note>
    );
  }

  if (loaded && orgs.length === 0) {
    // Not a real state: every signup owns an org, so an empty list means the
    // server answered something we didn't understand. Say that, rather than
    // showing a blank panel that reads like a correct "none".
    return (
      <Note>
        <div className="text-text-3">No orgs came back.</div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 text-2xs text-accent hover:underline outline-none"
        >
          Try again
        </button>
      </Note>
    );
  }

  return (
    <DropdownMenuRadioGroup value={current ?? ""}>
      {orgs.map((org) => (
        <DropdownMenuRadioItem
          key={org.slug}
          value={org.slug}
          // Radix would close the menu on select and then unmount the row
          // mid-write. Held open so the tick lands where you can see it.
          onSelect={(e) => {
            e.preventDefault();
            onPick(org.slug);
          }}
          disabled={!!pending}
        >
          <span className="min-w-0 flex-1 truncate">{orgLabel(org)}</span>
          {pending === org.slug ? (
            <AsciiSpinner size={11} className="ml-2 shrink-0" />
          ) : (
            <span className="ml-2 shrink-0 text-2xs text-text-4">
              {orgSubtitle(org)}
            </span>
          )}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
