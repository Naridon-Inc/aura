// What the modes marketplace may say when its list comes up empty.
//
// The dialog had one line for all of it:
//
//     {tab === "updates"
//       ? "All modes are up to date."
//       : query ? `No modes match "${query}".` : "No modes yet."}
//
// None of those three reads any of the store's loading, error or loaded-at
// fields, all of which exist. "All modes are up to date" is the sentence that
// mattered: `refreshUpdates` caught its failure and left `updates` at `[]`, so
// a check that never completed — offline, backend down, first run — printed
// the all-clear, under a tab labelled `Updates (0)`. Nothing on the screen
// said the check hadn't happened.
//
// The other two are the same shape one notch quieter: the Installed tab shows
// "No modes yet." when the read of your installed modes FAILED (its error was
// never rendered anywhere), and the All tab shows it while the marketplace is
// still loading.
//
// One fold, four answers, and each one has to be earned by a read that came
// back.

export type ModesTab = "all" | "installed" | "updates";

/** Everything the fold is allowed to consider — all of it already tracked by
 *  `modesStore`. Flat rather than the store shape so this stays testable and
 *  the call site has to name what it passes. */
export type ModesReadState = {
  tab: ModesTab;
  /** Trimmed search text. Empty string = no search. */
  query: string;
  installedLoading: boolean;
  installedLoadedAt: number | null;
  installedError: string | null;
  marketplaceLoading: boolean;
  marketplaceLoadedAt: number | null;
  marketplaceError: string | null;
  updatesLoading: boolean;
  updatesLoadedAt: number | null;
  updatesError: string | null;
};

/** A tab's label, with its count only once a read has actually produced one.
 *
 *  `Updates (0)` was drawn from `updates.length` whether or not the check had
 *  run, so the tab agreed with the empty state's all-clear — two readouts,
 *  one unread source, both confident. A tab with no number reads as "not
 *  counted yet", which is the truth. */
export function tabCountLabel(
  base: string,
  count: number,
  loadedAt: number | null,
): string {
  return loadedAt === null ? base : `${base} (${count})`;
}

export type ModesEmpty =
  /** A read is still out. The block loader, with `label` as its line. */
  | { kind: "waiting"; label: string }
  /** A read came back broken. `message` is the raw text from the failure. */
  | { kind: "failed"; title: string; message: string }
  /** The search matched nothing — said only when the reads behind it landed. */
  | { kind: "filtered" }
  /** Genuinely nothing here, and we know it. */
  | { kind: "empty"; title: string; body?: string };

/** True while a read hasn't come back and hasn't failed either. `loadedAt`
 *  is the only proof a read ever completed; `loading` alone goes false on
 *  failure too, and a first paint has neither set. */
function pending(loading: boolean, loadedAt: number | null, error: string | null): boolean {
  return loading || (loadedAt === null && error === null);
}

/** What to draw where the list would be, given how much of it we actually
 *  read. Call it only when the visible row list is empty.
 *
 *  Order is deliberate: still-reading beats broken beats no-match beats empty.
 *  A search that matched nothing is only worth saying once the thing being
 *  searched has arrived. */
export function modesEmptyCopy(s: ModesReadState): ModesEmpty {
  switch (s.tab) {
    case "updates": {
      // Two reads back this tab: the installed list, and the update check.
      if (
        pending(s.updatesLoading, s.updatesLoadedAt, s.updatesError) ||
        pending(s.installedLoading, s.installedLoadedAt, s.installedError)
      ) {
        return { kind: "waiting", label: "Checking your modes for updates…" };
      }
      if (s.updatesError) {
        return {
          kind: "failed",
          title: "Aura couldn’t check for updates",
          message: s.updatesError,
        };
      }
      if (s.installedError) {
        return {
          kind: "failed",
          title: "Aura couldn’t read your modes",
          message: s.installedError,
        };
      }
      if (s.query) return { kind: "filtered" };
      return {
        kind: "empty",
        title: "All modes are up to date",
        body: "Every mode you have installed matches the latest published version.",
      };
    }

    case "installed": {
      if (pending(s.installedLoading, s.installedLoadedAt, s.installedError)) {
        return { kind: "waiting", label: "Reading your installed modes…" };
      }
      if (s.installedError) {
        return {
          kind: "failed",
          title: "Aura couldn’t read your modes",
          message: s.installedError,
        };
      }
      if (s.query) return { kind: "filtered" };
      return {
        kind: "empty",
        title: "No modes installed yet",
        body: "Modes are specialists you can switch between in chat. Browse the All tab to add one.",
      };
    }

    case "all": {
      if (
        pending(s.marketplaceLoading, s.marketplaceLoadedAt, s.marketplaceError) ||
        pending(s.installedLoading, s.installedLoadedAt, s.installedError)
      ) {
        return { kind: "waiting", label: "Loading modes…" };
      }
      // The marketplace is what this tab is mostly made of, so its failure
      // leads. The old code showed this as a banner ABOVE the words "No modes
      // yet." — two different answers to one question, stacked.
      if (s.marketplaceError) {
        return {
          kind: "failed",
          title: "Aura couldn’t reach the marketplace",
          message: s.marketplaceError,
        };
      }
      if (s.installedError) {
        return {
          kind: "failed",
          title: "Aura couldn’t read your modes",
          message: s.installedError,
        };
      }
      if (s.query) return { kind: "filtered" };
      return {
        kind: "empty",
        title: "No modes to show",
        body: "The marketplace came back empty and you have none installed.",
      };
    }
  }
}
