// Settings › Import and its promo card, rendered on their own.
//
// Dev-server only — reached at /import-harness.html?scene=<name>, never
// bundled. The page and the card are the real ones; only the desktop's
// commands are stood in for, with made-up projects. Nothing is read from any
// other app and nothing is imported.
//
// Scenes:
//   page     — the page with one app unfolded: what it holds, all ready ticked
//   running  — an import under way, with its progress line
//   done     — the run finished: counts, and what didn't come over and why
//   promo    — the card in the toast stack
// Add `&theme=light` for the light palette.

import { StrictMode, useState } from "react";
import ReactDOM from "react-dom/client";

import { openImportFor, type ImportItem, type ImportReport, type ImportScan, type ImportSource } from "../../../lib/importSources";
import { ImportPromoToast } from "../../ImportPromoToast";
import { Toaster } from "../../Toaster";
import { SettingsLayout } from "../../ui/settings-layout";
import { navigationGroups, pageLabel } from "../nav";
import { SettingsPageView } from "../SettingsPageView";
import "../../../styles.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "page";
if (params.get("theme") === "light") document.documentElement.classList.add("light");

const H = 3_600_000;
const now = Date.now();

const SOURCES: ImportSource[] = [
  { id: "conductor", name: "Conductor", installed: true, found: true, imported: 0 },
  { id: "superset", name: "Superset", installed: false, found: false, imported: 0 },
  { id: "cursor", name: "Cursor", installed: true, found: true, imported: 0 },
  { id: "windsurf", name: "Windsurf", installed: false, found: true, imported: 0 },
  { id: "void", name: "Void", installed: false, found: false, imported: 0 },
  { id: "zed", name: "Zed", installed: true, found: true, imported: 0 },
];

const it = (
  key: string,
  kind: ImportItem["kind"],
  title: string,
  detail: string,
  ago: number | null,
  state: ImportItem["state"] = "ready",
  reason: string | null = null,
): ImportItem => ({ key, kind, title, detail, when: ago == null ? null : now - ago * H, state, reason, root: null });

const ITEMS: ImportItem[] = [
  it("repo:1", "repo", "northwind-api", "6 chats · ~/code/northwind-api", 2),
  it("repo:2", "repo", "billing-web", "3 chats · ~/code/billing-web", 30),
  it("repo:3", "repo", "design-tokens", "~/code/design-tokens", 200, "done", "Already in Aura"),
  it("repo:4", "repo", "old-prototype", "~/code/old-prototype", 900, "unavailable", "This folder is no longer on this Mac."),
  it("ws:1", "workspace", "retry-backoff", "northwind-api · branch sam/retry-backoff", 2),
  it("ws:2", "workspace", "invoice-pdf", "billing-web · branch sam/invoice-pdf", 30),
  it("ws:3", "workspace", "dark-mode-tokens", "design-tokens · branch sam/dark-mode", 70),
  it("chat:1", "chat", "Switch retries to exponential backoff", "Claude · 72 messages · retry-backoff", 2),
  it("chat:2", "chat", "Render invoices as PDF", "Claude · 14 messages · invoice-pdf", 30),
  it("chat:3", "chat", "Why is the webhook test flaky?", "Codex · 8 messages · northwind-api", 50),
  it("chat:4", "chat", "Token naming review", "Claude · 2 messages · dark-mode-tokens", 70),
  it("chat:5", "chat", "Upgrade the queue client", "Claude · 21 messages · northwind-api", 120),
  it("chat:6", "chat", "Draft the release notes", "Claude · 5 messages · billing-web", 160),
  it("chat:7", "chat", "Cache the price lookups", "Claude · 33 messages · billing-web", 260),
  it("chat:8", "chat", "Pair on the ACP agent", "", 300, "unavailable", "This chat ran on an agent Aura can't replay yet."),
  it("scripts:1", "scripts", "Scripts for northwind-api", "setup, run", null),
  it("rules:1", "rules", "Rules in northwind-api", "CLAUDE.md, .cursor/rules (3 files)", null),
];

// Set once the stand-in import has run, so the next scan reads "In Aura".
let ran = false;

const scanNow = (): ImportScan => ({
  id: "conductor",
  name: "Conductor",
  installed: true,
  found: true,
  items: ran ? ITEMS.map((i) => (i.state === "ready" && i.key !== "chat:7" ? { ...i, state: "done", reason: "Already in Aura" } : i)) : ITEMS,
  notes: ["2 workspaces Conductor archived are left out.", "1 folder Conductor opened is no longer on this Mac."],
});

const REPORT: ImportReport = {
  outcomes: [
    ...ITEMS.filter((i) => i.state === "ready" && i.key !== "chat:7" && i.key !== "chat:6").map((i) => ({
      key: i.key,
      kind: i.kind,
      title: i.title,
      status: "imported" as const,
      reason: null,
      auraRef: null,
    })),
    { key: "chat:6", kind: "chat", title: "Draft the release notes", status: "skipped", reason: "Already in Aura from an earlier import.", auraRef: null },
    { key: "chat:7", kind: "chat", title: "Cache the price lookups", status: "failed", reason: "Its project couldn't be added: Aura's project list is full (40 projects).", auraRef: null },
  ],
  adopt: [],
};

// Tauri's event bridge: `listen` registers a callback id; the harness calls it.
const callbacks = new Map<number, (e: unknown) => void>();
const listeners = new Map<string, number[]>();
let nextCb = 1;
const emit = (event: string, payload: unknown) =>
  (listeners.get(event) ?? []).forEach((id) => callbacks.get(id)?.({ event, id: 0, payload }));

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  import_sources_detect: () => (ran ? SOURCES.map((s) => (s.id === "conductor" ? { ...s, imported: 13 } : s)) : SOURCES),
  import_source_scan: () => scanNow(),
  import_run: () =>
    scene === "running"
      ? new Promise(() => {
          setTimeout(() => emit("import:progress", { source: "conductor", done: 7, total: 15, title: "Switch retries to exponential backoff" }), 50);
        })
      : Promise.resolve(REPORT).then((r) => {
          ran = true;
          return r;
        }),
  "plugin:event|listen": (args) => {
    const event = String(args.event);
    listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
    return Number(args.handler);
  },
  "plugin:event|unlisten": () => undefined,
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const answer = answers[cmd];
    if (!answer) throw new Error(`command ${cmd} not found`);
    return answer(args);
  },
  transformCallback: (cb: (e: unknown) => void) => {
    const id = nextCb++;
    callbacks.set(id, cb);
    return id;
  },
  unregisterCallback: (id: number) => callbacks.delete(id),
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};
try {
  localStorage.removeItem("aura.import.promoDismissed.conductor");
} catch {
  /* nothing stored */
}

function Settings() {
  const [query, setQuery] = useState("");
  return (
    <SettingsLayout
      title={pageLabel("import")}
      groups={navigationGroups([], query)}
      selected="import"
      onSelect={() => undefined}
      onBack={() => undefined}
      query={query}
      onQueryChange={setQuery}
    >
      <SettingsPageView
        page="import"
        view={null}
        repoRoot=""
        currentRepo=""
        roots={[]}
        query={query}
        foldAsked={null}
        reload={async () => undefined}
        onClose={() => undefined}
        go={() => undefined}
      />
    </SettingsLayout>
  );
}

function Promo() {
  return (
    <div style={{ flex: 1, background: "var(--ui-bg)", position: "relative" }}>
      <Toaster />
      <ImportPromoToast />
    </div>
  );
}

// The page opens on the app the promo's Import asked for.
if (scene !== "promo") openImportFor("conductor");

ReactDOM.createRoot(document.getElementById("import-harness")!).render(
  <StrictMode>
    <div style={{ height: "100vh", display: "flex" }}>{scene === "promo" ? <Promo /> : <Settings />}</div>
  </StrictMode>,
);

const until = async (pick: () => Element | undefined | null) => {
  for (let i = 0; i < 200; i++) {
    const el = pick();
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("never appeared");
};

async function stage() {
  if (scene === "promo") {
    const card = await until(() => document.querySelector(".aura-toast"));
    // Headless capture runs on virtual time, where the enter transition's
    // animation frame never comes: show the card at rest.
    await new Promise((r) => setTimeout(r, 600));
    card.removeAttribute("data-starting-style");
  } else {
    await until(() => document.querySelector(".ui-import-group"));
    if (scene === "running" || scene === "done") {
      const go = (await until(() =>
        [...document.querySelectorAll(".ui-import-footer button")].find((b) => b.textContent?.startsWith("Import")),
      )) as HTMLButtonElement;
      go.click();
      await until(() => document.querySelector(scene === "running" ? ".ui-import-progress [role=progressbar]" : ".ui-import-result"));
    }
  }
  await new Promise((r) => setTimeout(r, 400));
  document.body.dataset.ready = "yes";
}
void stage().catch((e) => {
  console.error("harness:", e);
  document.body.dataset.ready = "yes";
});
