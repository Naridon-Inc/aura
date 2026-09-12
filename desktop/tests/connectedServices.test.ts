// Settings → Connected services.
//
//   bun test
//
// This was `integrationsPane.test.ts`, and it pinned four things the old
// Integrations pane got wrong, all found by clicking it. The pane is gone —
// Integrations and API keys are one Connected services pane now — but every
// one of those four defects is re-introducible in the new files, so the rules
// moved here rather than being deleted with the pane that taught them.
//
// 1. ERRORS LANDED NOWHERE NEAR THEIR CAUSE. One `error` string for the whole
//    pane, printed in a banner under the last card. Pressing Connect on Jira
//    (y≈311) put the failure at y≈784 — below Linear, below Beads, half
//    off-screen. With a connected Jira card expanded it was off-screen
//    entirely, so the click read as doing nothing at all.
//
// 2. A BUTTON THAT COULD NEVER WORK. Aura signs in through an OAuth app *you*
//    own — there is no Aura-hosted client — so on a machine whose
//    `integrations.toml` has no `[jira]` block, Connect can only fail. The
//    card offered it anyway, as a primary button, and answered the click with
//    `integration not configured: missing [jira] block`. Same fact, delivered
//    as a failure the user had to trigger.
//
// 3. A FAILED READ RENDERED AS AN ANSWER. When `integrations_list` threw we
//    set `statuses` to `[]` — and `[]` means "no Jira row", which the cards
//    drew as "Not connected". We told the user something we had not found
//    out. `PeopleSection` did the same with its "nothing imported yet" copy.
//
// 4. CANCEL LOOKED LIKE A CRASH. Pressing Cancel rejects the pending connect
//    with "connect cancelled" — the mechanism working. It came out in red as
//    `OAuth flow: connect cancelled`. The "browser didn't open?" link was at
//    the pane foot too, below the fold during the one moment it matters.
//
// The last block is new, and is about the merge itself: the two panes must
// not grow back, and neither half may start listing things you already have.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const DIR = "components/settings/connected";
const HOOK = `${DIR}/useTrackers.ts`;
const PANE = `${DIR}/ConnectedServicesTab.tsx`;
const STORE = `${DIR}/ServiceStore.tsx`;
const PARTS = `${DIR}/trackerParts.tsx`;
const PEOPLE = `${DIR}/JiraPeople.tsx`;
const CATALOG = `${DIR}/catalog.ts`;
const DIALOG = "components/dialogs/SettingsDialog.tsx";
const API = "lib/integrationsApi.ts";
const TAURI = "../src-tauri/src/cmd_integrations.rs";
const TYPES = "../src-tauri/src/integrations/types.rs";

describe("an error prints next to the button that raised it", () => {
  test("the plumbing tags each error with the card that owns it", async () => {
    const src = await readSrc(HOOK);
    expect(src).toContain("export type ScopedError = { kind: TrackerKind; msg: string }");
    expect(src).toContain("useState<ScopedError | null>(null)");
  });

  test("and each surface reads only the error for the row it is drawing", async () => {
    // Both surfaces derive it the same way, per row, from the row's own kind —
    // so neither can print Jira's failure under Linear.
    for (const file of [PANE, STORE]) {
      const src = await readSrc(file);
      expect(src).toContain(
        "trackers.error?.kind === kind ? trackers.error.msg : null",
      );
    }
  });

  test("the red block sits in the row, after the buttons", async () => {
    const src = await readSrc(STORE);
    expect(src).toContain("{error && <CardError msg={error} />}");
    // …and the fallback link with it, not stranded at the pane foot. It shows
    // only while that row's own connect is in flight.
    expect(src).toContain("{busy && trackers.fallbackUrl && (");
    expect(src).toContain("<AuthFallback url={trackers.fallbackUrl} />");
  });
});

describe("a provider with no credentials says so instead of offering a button", () => {
  test("Rust answers whether this machine is set up for the provider", async () => {
    const rs = await readSrc(TAURI);
    expect(rs).toContain("fn provider_configured(kind: IntegrationKind) -> bool");
    expect(rs).toContain("IntegrationKind::Jira => cfg.jira.is_some()");
    expect(rs).toContain("IntegrationKind::Linear => cfg.linear.is_some()");
  });

  test("every status the renderer can receive carries it", async () => {
    const rs = await readSrc(TAURI);
    // Nine places build one: `status_from_state`, the four `_status` /
    // `connect` returns, and the four `_list` pushes. A tenth added without
    // the field would render as a live Connect button on a machine that can't
    // use it, so check them all rather than a count.
    let from = rs.indexOf("ConnectionStatus {");
    let sites = 0;
    while (from !== -1) {
      // `-> ConnectionStatus {` is a signature, not a literal.
      if (rs.slice(from - 3, from) !== "-> ") {
        expect(rs.slice(from, rs.indexOf("}", from))).toContain(
          "configured: provider_configured(",
        );
        sites += 1;
      }
      from = rs.indexOf("ConnectionStatus {", from + 1);
    }
    expect(sites).toBe(9);
  });

  test("it's a real field on the wire, defaulting to today's behaviour", async () => {
    const rs = await readSrc(TYPES);
    expect(rs).toContain('#[serde(default = "yes")]');
    expect(rs).toContain("pub configured: bool");
    expect(await readSrc(API)).toContain("configured: boolean");
  });

  test("the catalogue keeps not-set-up as its own answer", async () => {
    const src = await readSrc(CATALOG);
    expect(src).toContain("export function isReady(");
    expect(src).toContain('if (entry.category !== "tracker") return true;');
    expect(src).toContain("?.configured === true");
  });

  test("the store withholds the button in that state", async () => {
    const src = await readSrc(STORE);
    // No button at all for a tracker we cannot start, rather than a button
    // whose only outcome is an error.
    expect(src).toContain("{isTracker && (!known || !ready) ? null : isTracker ? (");
    expect(src).toContain("{isTracker && known && !ready && (");
    expect(src).toContain("<SetupNeeded");
  });

  test("and what replaces it names the file and the section", async () => {
    const src = await readSrc(PARTS);
    const setup = src.slice(src.indexOf("export function SetupNeeded({"));
    expect(setup).toContain("No {what} app is set up on this machine");
    expect(setup).toContain("[{block}]");
    expect(setup).toContain("this card will");
  });
});

describe("a read that failed is not a read that came back empty", () => {
  test("the hook keeps 'we couldn't ask' apart from 'a button failed'", async () => {
    const src = await readSrc(HOOK);
    expect(src).toContain("const [loadError, setLoadError] = useState<string | null>(null)");
    expect(src).toContain("setLoadError(String(e))");
  });

  test("the pane says so, with a way to ask again", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('title="Aura couldn\'t check your trackers."');
    expect(src).toContain("onRetry={() => void trackers.refresh()}");
  });

  test("an unchecked tracker is not reported as unconfigured", async () => {
    // The trap the split created: a failed list leaves `configured` unset,
    // `isReady` false, and the store would have printed "Not set up here" —
    // a claim about the reader's laptop that we never established.
    const catalog = await readSrc(CATALOG);
    expect(catalog).toContain("trackersKnown: boolean;");
    expect(catalog).toContain("export function isKnown(");
    expect(catalog).toContain("return facts.trackersKnown;");

    const pane = await readSrc(PANE);
    expect(pane).toContain("trackersKnown: trackers.loadError === null,");

    const store = await readSrc(STORE);
    expect(store).toContain("{isTracker && !known && (");
    expect(store).toContain("Aura couldn't check whether {entry.label} is set up");
  });

  test("the people list stops claiming nobody is on your cards", async () => {
    const src = await readSrc(PEOPLE);
    expect(src).toContain("const [failed, setFailed] = useState(false)");
    expect(src).toContain("setFailed(true)");
    expect(src).toContain("if (failed) {");
    expect(src).toContain("Aura couldn't read who's on your Jira cards.");
    // The failure branch is checked before the empty-list reassurance.
    expect(src.indexOf("if (failed) {")).toBeLessThan(
      src.indexOf("if (links.length === 0) {"),
    );
  });
});

describe("cancelling is not a failure", () => {
  test("the catch swallows the rejection Cancel causes", async () => {
    const src = await readSrc(HOOK);
    const connect = src.slice(
      src.indexOf("const connect = useCallback("),
      src.indexOf("const disconnect = useCallback("),
    );
    expect(connect).toContain('if (msg.includes("connect cancelled")) {');
    expect(connect).toContain("setError(kind, null);");
  });

  test("a port collision keeps its hint", async () => {
    const src = await readSrc(HOOK);
    expect(src).toContain('} else if (msg.includes("bind 127.0.0.1")) {');
    expect(src).toContain("setError(kind, `${msg}\\n\\n${PORT_BIND_HINT}`)");
  });

  test("Cancel is offered while a connect is open", async () => {
    // Without it the only way out of a flow Atlassian never redirects back
    // from is to wait out the five-minute server-side timeout.
    const src = await readSrc(STORE);
    expect(src).toContain("onClick={() => void trackers.cancel(kind)}");
  });
});

describe("one pane, and it lists what you have", () => {
  test("the rail has a single Connected services row", async () => {
    const src = await readSrc(DIALOG);
    expect(src).toContain('id: "connected", label: "Connected services"');
    // The two it replaced are gone from the union, the rail and the switch.
    expect(src).not.toContain('| "integrations"');
    expect(src).not.toContain('| "keys"');
    expect(src).not.toContain('label: "API keys"');
    expect(src).not.toContain("IntegrationsTab");
  });

  test("its keywords still find both halves by their old names", async () => {
    // Somebody who knows the old pane types "api key" or "integrations" into
    // the settings search; the merge must not lose them.
    const src = await readSrc(DIALOG);
    const row = src.slice(
      src.indexOf('id: "connected"'),
      src.indexOf("\n", src.indexOf('id: "connected"')),
    );
    for (const word of ["jira", "linear", "beads", "anthropic", "openai", "api key", "integrations"]) {
      expect(row).toContain(`"${word}"`);
    }
  });

  test("it is filed under Personal, because both halves are", async () => {
    // A model key and an OAuth token are facts about this machine, not this
    // project — switching project changes neither. The one per-project thing,
    // which Jira project mirrors onto which repo, stays inside the Jira row.
    const src = await readSrc(DIALOG);
    const scoped = src.slice(
      src.indexOf("const REPO_SCOPED_PANES"),
      src.indexOf("]);", src.indexOf("const REPO_SCOPED_PANES")),
    );
    expect(scoped).not.toContain('"connected"');
    expect(scoped).not.toContain('"integrations"');
  });

  test("the list and the store are a partition, computed once", async () => {
    // The defect both old panes shared: each hand-listed the whole catalogue,
    // so four of six rows offered to set up something already set up. One
    // pass over one list means the two can never disagree.
    const src = await readSrc(CATALOG);
    expect(src).toContain("export function splitServices(");
    expect(src).toContain("if (isConnected(facts, entry)) {");
    expect(src).toContain("} else {");

    const pane = await readSrc(PANE);
    expect(pane).toContain("splitServices(facts)");
    // The pane renders `connected`; the store is handed `available`.
    expect(pane).toContain("{connected.map((svc) => (");
    expect(pane).toContain("available={available}");
  });

  test("the store is a step in the pane, not a dialog over one", async () => {
    // A nested modal on the settings dialog gives two Escape keys with
    // different meanings and two scroll containers fighting over the wheel.
    const src = await readSrc(STORE);
    expect(src).not.toContain("<Dialog");
    expect(src).toContain("Back to what's connected");
  });

  test("nothing connected reads as a prompt, not a blank page", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("connected.length === 0");
    expect(src).toContain("Nothing is connected yet.");
    expect(src).toContain("Add a service");
  });
});
