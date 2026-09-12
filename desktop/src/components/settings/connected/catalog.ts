// What Aura can connect to, in one list.
//
// Settings used to answer that question in two places that never referred to
// each other: an "Integrations" pane listing Jira and Linear whether or not
// you used them, and an "API keys" pane listing four model providers whether
// or not you had keys for them. Both were catalogues pretending to be
// inventories — you read six cards to learn that one thing was connected.
//
// This file is the catalogue, and the only one. The pane above it shows the
// inventory (what you have), the store shows the catalogue minus the
// inventory (what you could add). Neither hand-maintains a list, so adding a
// service is one entry here and nothing else.

/** A model provider is reached with a key you paste; a tracker with a sign-in
 *  through an app you own. The two need different words on screen, and the
 *  store groups by this. */
export type ServiceCategory = "model" | "tracker" | "import";

export type ServiceId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "mercury"
  | "jira"
  | "linear"
  | "beads";

export type CatalogEntry = {
  id: ServiceId;
  label: string;
  category: ServiceCategory;
  /** One line, in the reader's words, saying what connecting it gets them —
   *  never how it is wired. The store shows this and nothing else. */
  blurb: string;
};

/** The order services appear in, everywhere. Model providers first: it is the
 *  connection almost everybody needs, and the one the app stops working
 *  without. */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    category: "model",
    blurb: "Claude models, for chat and for the agents that write code.",
  },
  {
    id: "openai",
    label: "OpenAI",
    category: "model",
    blurb: "GPT models, as an alternative brain for chat and agents.",
  },
  {
    id: "gemini",
    label: "Gemini",
    category: "model",
    blurb: "Google's models, including the long-context ones Aura reads with.",
  },
  {
    id: "mercury",
    label: "Mercury",
    category: "model",
    blurb: "Inception's fast diffusion models, for quick edits.",
  },
  {
    id: "jira",
    label: "Jira",
    category: "tracker",
    blurb: "Two-way sync between your Jira projects and this board.",
  },
  {
    id: "linear",
    label: "Linear",
    category: "tracker",
    blurb: "Sign in to Linear and bring its issues alongside your work.",
  },
  {
    id: "beads",
    label: "Beads",
    category: "import",
    blurb:
      "Import issues from a Beads folder on this machine. Nothing signs in, nothing leaves.",
  },
] as const;

export const MODEL_PROVIDERS: readonly ServiceId[] = CATALOG.filter(
  (e) => e.category === "model",
).map((e) => e.id);

/** What the pane knows about the world, in the two shapes the two halves of
 *  it already speak: last-four digits per provider key, and the tracker rows
 *  `integrations_list` returns. */
export type ServiceFacts = {
  /** Last four characters of each stored provider key, `null` when unset. */
  keyLast4: Partial<Record<ServiceId, string | null>>;
  /** The provider the app currently asks. Marked in the list, because "you
   *  have three keys" and "this is the one in use" are different facts. */
  activeProvider: string | null;
  /** From `integrationsApi.list()`. A tracker missing from this array is one
   *  we have no word on — treated as not connected, same as the server says. */
  trackers: ReadonlyArray<{
    kind: string;
    connected: boolean;
    configured: boolean;
    identity?: { display_name?: string | null; email?: string | null } | null;
  }>;
  /** False when the call that lists trackers failed. An empty `trackers`
   *  array then means "we never found out", not "none of them are set up" —
   *  and the two must not render the same, because one of them is a claim we
   *  cannot make. */
  trackersKnown: boolean;
};

export type ConnectedService = {
  entry: CatalogEntry;
  /** The line under the name: whose account, or which key. Never the secret
   *  itself — a key is shown as its last four and nothing more. */
  detail: string | null;
  /** True for the provider the app is currently asking. */
  active: boolean;
};

export type AvailableService = {
  entry: CatalogEntry;
  /** False when this machine cannot even start the flow — a tracker whose
   *  app id and secret are not in `~/.aura/integrations.toml`. The store
   *  still lists it, and says so, rather than offering a button that can
   *  only fail. */
  ready: boolean;
  /** False when we could not find out. A tracker read that threw leaves
   *  `ready` false by default, and "not set up on this machine" is a
   *  different sentence from "we couldn't check" — the first is a fact about
   *  their laptop, the second is a fact about us. */
  known: boolean;
};

function trackerRow(facts: ServiceFacts, id: ServiceId) {
  return facts.trackers.find((t) => t.kind === id) ?? null;
}

/** Whether a catalogue entry counts as connected right now.
 *
 *  An import is never connected: Beads runs once and finishes, so it has no
 *  state to be in. Listing it as "connected" after an import would promise a
 *  live link that does not exist. */
export function isConnected(facts: ServiceFacts, entry: CatalogEntry): boolean {
  if (entry.category === "model") return Boolean(facts.keyLast4[entry.id]);
  if (entry.category === "tracker")
    return trackerRow(facts, entry.id)?.connected === true;
  return false;
}

/** Whether the machine can start this service's connect flow at all. */
export function isReady(facts: ServiceFacts, entry: CatalogEntry): boolean {
  if (entry.category !== "tracker") return true;
  return trackerRow(facts, entry.id)?.configured === true;
}

/** Whether we actually know this service's state. Only a tracker can be
 *  unknown: a model key is read from a local file that either has it or does
 *  not, and an import has no state at all. */
export function isKnown(facts: ServiceFacts, entry: CatalogEntry): boolean {
  if (entry.category !== "tracker") return true;
  return facts.trackersKnown;
}

function detailFor(facts: ServiceFacts, entry: CatalogEntry): string | null {
  if (entry.category === "model") {
    const last4 = facts.keyLast4[entry.id];
    return last4 ? `Key ending ${last4}` : null;
  }
  const who = trackerRow(facts, entry.id)?.identity;
  return who?.display_name || who?.email || null;
}

/** The inventory and the catalogue-minus-inventory, from one pass over one
 *  list. The two can never disagree about what is connected, because neither
 *  is written down twice. */
export function splitServices(facts: ServiceFacts): {
  connected: ConnectedService[];
  available: AvailableService[];
} {
  const connected: ConnectedService[] = [];
  const available: AvailableService[] = [];
  for (const entry of CATALOG) {
    if (isConnected(facts, entry)) {
      connected.push({
        entry,
        detail: detailFor(facts, entry),
        active: entry.category === "model" && facts.activeProvider === entry.id,
      });
    } else {
      available.push({
        entry,
        ready: isReady(facts, entry),
        known: isKnown(facts, entry),
      });
    }
  }
  return { connected, available };
}

/** The store's headings, in catalogue order, with the entries under each.
 *  Empty groups drop out — a heading over nothing is a promise the page
 *  cannot keep. */
export function groupAvailable(
  available: AvailableService[],
): Array<{ category: ServiceCategory; label: string; items: AvailableService[] }> {
  const LABELS: Record<ServiceCategory, string> = {
    model: "Models",
    tracker: "Issue trackers",
    import: "One-time imports",
  };
  const order: ServiceCategory[] = ["model", "tracker", "import"];
  return order
    .map((category) => ({
      category,
      label: LABELS[category],
      items: available.filter((a) => a.entry.category === category),
    }))
    .filter((g) => g.items.length > 0);
}
