// Settings → Repository → MCP servers, driven in a real window.
//
//   bun test
//
// Four things this pane got wrong, all found by clicking it.
//
// 1. THE FIRST TEMPLATE COULD NOT BE ADDED. "Atlassian (remote · native
//    OAuth)" ships `command: ""` on purpose — it's a pure-remote server,
//    and `list_tools` / `call_tool` both branch on `server_url` and hand
//    the call to the HTTP transport without ever reading `command`. The
//    form agreed: its Command hint says "Leave blank for pure-remote
//    servers", and Save enables on a URL alone. `mcp_servers_add` then
//    refused every one of them with "server command is required". The
//    flagship native-OAuth path was unreachable from the grid it's
//    advertised in.
//
// 2. THE REFUSAL LANDED NOWHERE NEAR THE BUTTON. One `error` string for
//    the whole pane, printed at the very top. Save sits at the foot of
//    the Add form — past five template cards — so the message rendered
//    roughly 600px above the fold and the click read as doing nothing.
//    Same for a failed toggle or remove down in the configured list.
//
// 3. A FAILED LIST READ SPUN FOREVER. The catch set `error` but left
//    `rows` at null, and null is what the status line draws as
//    "Looking for connected servers…" — so a list call that failed
//    every time span there for as long as the pane stayed open.
//
// 4. THE CARDS CLIPPED THE ONE LINE THEY EXIST FOR. `line-clamp-2` cut
//    Atlassian's description at "ATLASSIAN_EMAIL…", hiding the third
//    variable you need, and GitHub's at "personal access token…",
//    hiding its name. A card whose job is to say what it needs before
//    you click was cutting off exactly that.
//
// 5. A SERVER YOU HAVEN'T SIGNED INTO READ AS BROKEN. Fixing (1) made
//    this visible for the first time: the freshly added remote row came
//    up with a red "error" chip and `http 401 Unauthorized:
//    {"error":"invalid_token","error_description":"Missing or invalid
//    access token"}` printed underneath — next to the Authenticate
//    button that is the entire answer. Nothing was wrong; it just
//    hadn't been signed into yet.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const PANE = "components/settings/McpServersTab.tsx";
const TAURI = "../src-tauri/src/cmd_mcp_servers.rs";

/** The `mcp_servers_add` body — up to the discovery section that
 *  follows it, so assertions don't catch the importer's own writes. */
async function addFn(): Promise<string> {
  const rs = await readSrc(TAURI);
  return rs.slice(
    rs.indexOf("pub fn mcp_servers_add("),
    rs.indexOf("pub struct DiscoveredMcp"),
  );
}

describe("a server with a URL and no command is a real server", () => {
  test("the gate asks for either, not for a command", async () => {
    const add = await addFn();
    expect(add).toContain("if command.trim().is_empty() && !has_remote {");
    expect(add).toContain(
      'give the server a command to run, or a remote URL',
    );
    // The old unconditional refusal is gone.
    expect(add).not.toContain("server command is required");
  });

  test("and the URL it checks is the one about to be written", async () => {
    const add = await addFn();
    expect(add).toContain("let has_remote = server_url");
    expect(add).toContain("is_some_and(|s| !s.trim().is_empty())");
    // Computed before `server_url` is moved into the config.
    expect(add.indexOf("let has_remote")).toBeLessThan(
      add.indexOf("server_url: normalise(server_url)"),
    );
  });

  test("the transport never wanted the command anyway", async () => {
    const rs = await readSrc(TAURI);
    // Both call sites take the HTTP path on `server_url` alone; the
    // stdio spawn is the else-branch. If that ever inverts, the gate
    // above becomes wrong.
    expect(
      rs.split("if let Some(url) = cfg.server_url.as_deref() {").length - 1,
    ).toBe(2);
  });

  test("the template that needs this still ships command-less", async () => {
    const src = await readSrc(PANE);
    const tpl = src.slice(
      src.indexOf('id: "atlassian-remote"'),
      src.indexOf('id: "atlassian"'),
    );
    expect(tpl).toContain('command: ""');
    expect(tpl).toContain('serverUrl: "https://mcp.atlassian.com/v1/sse"');
  });
});

describe("an error prints next to the control that raised it", () => {
  test("the pane keeps three failures apart instead of pooling them", async () => {
    const src = await readSrc(PANE);
    for (const s of ["listError", "formError", "rowError"]) {
      expect(src).toContain(`const [${s}, set${s[0].toUpperCase()}${s.slice(1)}] = useState<string | null>(null)`);
    }
    // No shared bucket left in the tab to fall back into. (The auth
    // modal below keeps its own `error` — it's one dialog, one place.)
    const tab = src.slice(
      src.indexOf("export function McpServersTab({"),
      src.indexOf("function McpServerRow({"),
    );
    expect(tab).not.toContain("const [error, setError] = useState<string | null>(null)");
    expect(tab).not.toContain("setError(");
  });

  test("a refused Save renders inside the form, above its own buttons", async () => {
    const src = await readSrc(PANE);
    const form = src.slice(
      src.indexOf('<Section title="Add server">'),
      src.indexOf('{rows && rows.length > 0 && ('),
    );
    expect(form).toContain("{formError && <ErrorNote>{formError}</ErrorNote>}");
    expect(form.indexOf("{formError &&")).toBeLessThan(form.indexOf("Cancel"));
  });

  test("a refused toggle or remove renders with the rows", async () => {
    const src = await readSrc(PANE);
    const list = src.slice(src.indexOf('<Section title="Configured servers">'));
    expect(list).toContain('{rowError && <ErrorNote className="mb-2">{rowError}</ErrorNote>}');
    expect(src).toContain("setRowError(String(e))");
  });

  test("opening a template clears the last refusal", async () => {
    const src = await readSrc(PANE);
    const apply = src.slice(
      src.indexOf("const applyTemplate = (t: McpTemplate) => {"),
      src.indexOf("const submitAdd = async () => {"),
    );
    expect(apply).toContain("setFormError(null)");
  });
});

describe("a list it never read is not a list with nothing in it", () => {
  test("the failure is kept apart from the empty result", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("setListError(String(e))");
    expect(src).toContain("setListError(null)");
  });

  test("and it says so, with a way to ask again, instead of spinning", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("{rows === null && listError ? (");
    expect(src).toContain("Aura couldn&apos;t read your connections.");
    expect(src).toContain("onClick={() => void refresh()}");
    // The spinner still covers the honest case: no answer yet, no error.
    expect(src).toContain("Looking for connected servers…");
    expect(src.indexOf("{rows === null && listError ? (")).toBeLessThan(
      src.indexOf("Looking for connected servers…"),
    );
  });
});

describe("a template card says what it needs before you click", () => {
  test("the description isn't clamped", async () => {
    const src = await readSrc(PANE);
    const grid = src.slice(
      src.indexOf('<Section title="Ready to add">'),
      src.indexOf("{adding && ("),
    );
    expect(grid).toContain('<div className="text-xs text-text-3 mt-1">{t.description}</div>');
    expect(grid).not.toContain("line-clamp-2");
  });

  test("a command-less template shows its endpoint, not a blank line", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("? `${t.command} ${t.args.join(\" \")}`");
    expect(src).toContain(": (t.serverUrl ?? \"\")");
  });

  test("one already added is marked, not offered again", async () => {
    const src = await readSrc(PANE);
    // Adding it can only fail — `mcp_servers_add` refuses to overwrite.
    expect(src).toContain("const added = rows?.some((r) => r.name === t.id) ?? false");
    expect(src).toContain("disabled={added}");
    expect(src).toContain('<span className="text-xs text-accent-green">added</span>');
    expect(await addFn()).toContain("already exists");
  });
});

describe("not signed in yet is not broken", () => {
  /** The row component — from its declaration to the auth modal. */
  async function row(): Promise<string> {
    const src = await readSrc(PANE);
    return src.slice(
      src.indexOf("function McpServerRow({"),
      src.indexOf("function AuthSetupModal({"),
    );
  }

  test("the chip names the state the button next to it fixes", async () => {
    const r = await row();
    expect(r).toContain('? "not signed in"');
    // Amber — the app's "waiting on you" colour, not red.
    expect(r).toContain('? "text-amber"');
    // Checked before the probe verdict, so it wins over "error".
    expect(r.indexOf('? "not signed in"')).toBeLessThan(r.indexOf('? "error"'));
  });

  test("it's derived from having no token, not from guessing", async () => {
    const r = await row();
    expect(r).toContain("const awaitingAuth = needsAuth && (probeOk !== false || authRefused)");
    expect(r).toContain("const needsAuth = hasRemote && !row.has_oauth_token");
  });

  test("the 401 blob stays off screen — and only the 401", async () => {
    const r = await row();
    expect(r).toContain("{probeErr && !awaitingAuth && (");
    // A real failure (bad host, 500, timeout) isn't an auth refusal, so
    // `awaitingAuth` is false there and the message still prints.
    expect(r).toContain('errBlob.includes("invalid_token")');
  });

  test("and what shows instead says what to do", async () => {
    const r = await row();
    expect(r).toContain("{awaitingAuth && (");
    expect(r).toContain("Authenticate and Aura will keep the tokens for you.");
  });
});

describe("the pane explains itself to someone who hasn't met MCP", () => {
  test("the intro says what a connection does, not what it's called", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain(
      "Connections let your agents reach tools you already use",
    );
    // No protocol name, no config path, no @-mention jargon up top.
    expect(src).not.toContain("External Model Context Protocol servers");
    expect(src).not.toContain("Configs live in ~/.aura/mcp/.");
  });

  test("the confirm dialog calls it what the rest of the pane calls it", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('title: `Remove the connection to "${name}"?`');
  });

  test("the empty state adds the next step rather than repeating it", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain(
      "Pick one below to add the first, or use Add server for anything else.",
    );
    expect(src).not.toContain(
      "Connections let an agent reach a tool you already use.",
    );
  });
});
