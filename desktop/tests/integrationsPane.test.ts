// Settings → Repository → Integrations, driven in a real window.
//
//   bun test
//
// Four things this pane got wrong, all found by clicking it.
//
// 1. ERRORS LANDED NOWHERE NEAR THEIR CAUSE. One `error` string for the
//    whole pane, printed in a banner under the last card. Pressing
//    Connect on Jira (y≈311) put the failure at y≈784 — below Linear,
//    below Beads, half off-screen. With a connected Jira card expanded
//    (mirrors + people) it was off-screen entirely, so the click read as
//    doing nothing at all.
//
// 2. A BUTTON THAT COULD NEVER WORK. Aura signs in through an OAuth app
//    *you* own — there is no Aura-hosted client — so on a machine whose
//    `integrations.toml` has no `[jira]` block, Connect can only fail.
//    The card offered it anyway, as a primary button, and answered the
//    click with `integration not configured: missing [jira] block`.
//    Same fact, delivered as a failure the user had to trigger.
//
// 3. A FAILED READ RENDERED AS AN ANSWER. When `integrations_list` threw
//    we set `statuses` to `[]` — and `[]` means "no Jira row", which
//    the cards drew as "Not connected". We told the user something we
//    had not found out. `PeopleSection` did the same with its
//    reassuring "nothing imported yet" copy.
//
// 4. CANCEL LOOKED LIKE A CRASH. Pressing Cancel rejects the pending
//    connect with "connect cancelled" — the mechanism working. It came
//    out in red as `OAuth flow: connect cancelled`, telling the user
//    their own click had gone wrong. The "browser didn't open?" link
//    was at the pane foot too, below the fold during the one moment it
//    matters.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const PANE = "components/settings/IntegrationsTab.tsx";
const API = "lib/integrationsApi.ts";
const TAURI = "../src-tauri/src/cmd_integrations.rs";
const TYPES = "../src-tauri/src/integrations/types.rs";

/** The Jira card's body — from its render open to the chip helper that
 *  follows it. Keeps assertions off Linear's identical markup. */
async function jiraCard(): Promise<string> {
  const src = await readSrc(PANE);
  return src.slice(
    src.indexOf("function JiraCard({"),
    src.indexOf("function StatusChip({"),
  );
}

describe("an error prints next to the button that raised it", () => {
  test("the pane tags each error with the card that owns it", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain(
      'type ScopedError = { kind: "jira" | "linear"; msg: string }',
    );
    expect(src).toContain("useState<ScopedError | null>(null)");
  });

  test("and each card is handed only its own", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('error={error?.kind === "jira" ? error.msg : null}');
    expect(src).toContain('error={error?.kind === "linear" ? error.msg : null}');
  });

  test("the red block lives inside the card, after the buttons", async () => {
    const card = await jiraCard();
    expect(card).toContain("{error && <CardError msg={error} />}");
    // …and the fallback link with it, not stranded at the pane foot.
    expect(card).toContain("{fallbackUrl && <AuthFallback url={fallbackUrl} />}");
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
    // `connect` returns, and the four `_list` pushes. A tenth added
    // without the field would render as a live Connect button on a
    // machine that can't use it, so check them all rather than a count.
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

  test("the chip has a third state, and the button is gone in it", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('setUp ? "Not connected" : "Not set up here"');

    const card = await jiraCard();
    expect(card).toContain("const setUp = status?.configured !== false;");
    expect(card).toContain("{!connected && !setUp && (");
    // Connect only renders on the set-up branch.
    expect(card).toContain("setUp && (");
    expect(card).toContain('{busy ? "Connecting…" : "Connect Jira"}');
  });

  test("and what replaces it names the file and the section", async () => {
    const src = await readSrc(PANE);
    const setup = src.slice(src.indexOf("function SetupNeeded({"));
    expect(setup).toContain("No {what} app is set up on this machine");
    expect(setup).toContain("[{block}]");
    expect(setup).toContain("this card will");
  });
});

describe("a read that failed is not a read that came back empty", () => {
  test("the pane keeps 'we couldn't ask' apart from 'a button failed'", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("const [loadError, setLoadError] = useState<string | null>(null)");
    expect(src).toContain("setLoadError(String(e))");
  });

  test("it says so, with a way to ask again, instead of drawing the cards", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('title="Aura couldn\'t check your trackers."');
    expect(src).toContain("onRetry={() => void refresh()}");
    // Jira and Linear are hidden; Beads (local) still renders.
    expect(src.split("{!loading && !loadError && (").length - 1).toBe(2);
    expect(src).toContain("{!loading && (\n        <div className=\"mt-3\">\n          <BeadsCard");
  });

  test("the people list stops claiming nobody is on your cards", async () => {
    const src = await readSrc(PANE);
    const sect = src.slice(
      src.indexOf("function PeopleSection({"),
      src.indexOf("function timeAgo("),
    );
    expect(sect).toContain("const [failed, setFailed] = useState(false)");
    expect(sect).toContain("setFailed(true)");
    expect(sect).toContain("if (failed) {");
    expect(sect).toContain("Aura couldn't read who's on your Jira cards.");
    // The failure branch is checked before the empty-list reassurance.
    expect(sect.indexOf("if (failed) {")).toBeLessThan(
      sect.indexOf("if (links.length === 0) {"),
    );
  });
});

describe("cancelling is not a failure", () => {
  test("the catch swallows the rejection Cancel causes", async () => {
    const src = await readSrc(PANE);
    const connect = src.slice(
      src.indexOf("const connect = useCallback("),
      src.indexOf("const disconnect = useCallback("),
    );
    expect(connect).toContain('if (msg.includes("connect cancelled")) {');
    expect(connect).toContain("setError(kind, null);");
  });

  test("a port collision keeps its hint", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('} else if (msg.includes("bind 127.0.0.1")) {');
    expect(src).toContain("setError(kind, `${msg}\\n\\n${PORT_BIND_HINT}`)");
  });
});
