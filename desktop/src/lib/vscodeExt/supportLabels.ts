// Honest, plain-language labels for every VS Code extension kind.
//
// Audience is non-engineers: never assume the reader knows "LSP", "debug
// adapter", or "webview". Each kind gets a plain title ("Language support"),
// a one-line plain summary, a runnability band, and — only on demand — the
// technical term for a tooltip. Shared by the Discover/Installed lists and the
// rail panel so the wording can never drift between surfaces.
//
// The three bands:
//   • "active"      — Aura wires this in right now: themes/languages/snippets, a
//                     web `browser` program, a LANGUAGE SERVER (errors/hovers/
//                     suggestions via the Node host), or a full Node program.
//   • "coming-soon" — a real, planned kind we detect but can't run yet
//                     (panels/views). Roadmap Phase C.
//   • "not-yet"     — detected, further out (debuggers). Roadmap Phase D.
//
// No extension code is inspected or run — this reads only the declarative
// ContributesSummary the Rust side derived from the manifest.

import type { ContributesSummary } from "./vsixTypes";

/** How runnable a contribution kind is in Aura today. Drives the accent: only
 *  "active" earns the arctic-blue primary accent; the rest read muted/amber. */
export type SupportBand = "active" | "coming-soon" | "not-yet";

/** One honest line about a single kind an extension contributes. */
export type KindLabel = {
  /** Stable key for React lists. */
  key: string;
  /** Plain-language title — "Themes & colors", "Language support". */
  title: string;
  /** One-line plain summary of what it does / why it can't run yet. */
  detail: string;
  /** Runnability band → drives accent + the ✓ / "coming soon" suffix. */
  band: SupportBand;
  /** The technical term, for a tooltip only — never shown inline. */
  tech?: string;
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Break a summary into its honest per-kind labels, in priority order (active
 *  kinds first, then coming-soon, then not-yet). Returns every kind the
 *  extension actually contributes — the caller decides how many to show. */
export function kindLabels(c: ContributesSummary): KindLabel[] {
  const out: KindLabel[] = [];
  const panelCount = (c.views ?? 0) + (c.customEditors ?? 0);

  // ── Active: applied today (Tier 0 + Tier 1) ────────────────────────────────
  if (c.themes > 0 || c.iconThemes > 0) {
    const n = c.themes + c.iconThemes;
    out.push({
      key: "themes",
      title: "Themes & colors",
      detail: `${plural(n, "color theme", "color themes")} you can switch to in Settings → Editor Themes.`,
      band: "active",
      tech: "contributes.themes / iconThemes",
    });
  }
  // Language files + grammar = real syntax highlighting, now run by Aura's own
  // TextMate engine (the same one VS Code uses). This applies even when the
  // extension ALSO ships a language server — the highlighting works today; only
  // the deeper smart-help waits. So, unlike before, we surface it for language-
  // server extensions too instead of hiding it behind the "coming soon" line.
  if (c.languages > 0 || c.grammars > 0) {
    const n = Math.max(c.languages, c.grammars);
    out.push({
      key: "languages",
      title: c.grammars > 0 ? "Syntax highlighting" : "Language files",
      detail:
        c.grammars > 0
          ? `Full colour highlighting and editor rules for ${plural(n, "language", "languages")}, applied automatically.`
          : `Editor rules for ${plural(n, "language", "languages")}, applied automatically.`,
      band: "active",
      tech: "contributes.languages / grammars (TextMate engine)",
    });
  }
  if (c.snippets > 0) {
    out.push({
      key: "snippets",
      title: "Snippets",
      detail: `${plural(c.snippets, "snippet pack", "snippet packs")}, available as you type.`,
      band: "active",
      tech: "contributes.snippets",
    });
  }
  // A web program (`browser`) runs in the Web-Worker host.
  if (c.hasBrowser) {
    out.push({
      key: "web",
      title: "Runs its own program",
      detail: c.commands
        ? `Adds ${plural(c.commands, "command", "commands")} you can run from the Command Palette (⌘K).`
        : "Runs as a web extension right here.",
      band: "active",
      tech: "browser entry (web extension host)",
    });
  }
  // A language server now runs for real in Aura's Node extension host: it spawns
  // the extension's helper program and pipes its errors/hovers/suggestions into
  // the editor. (Go-to-definition isn't wired yet, so we don't claim it.)
  if (c.isLanguageServer) {
    const n = Math.max(c.languages, c.grammars);
    out.push({
      key: "language-server",
      title: "Smart code help",
      detail: `Errors as you type, hovers, and smart suggestions${
        n > 0 ? ` for ${plural(n, "language", "languages")}` : ""
      } — running now.`,
      band: "active",
      tech: "language server (LSP) via the Node extension host",
    });
  }
  // A bare Node `main` with nothing richer recognised = a full program extension.
  // Aura now runs these in its Node extension host, so report it as active. (A
  // language server / panels already imply `main`, so only surface this when no
  // richer kind covered it.)
  if (
    c.hasMain &&
    !c.hasBrowser &&
    !c.isLanguageServer &&
    panelCount === 0 &&
    !c.viewsContainers &&
    !c.webviews &&
    (c.debuggers ?? 0) === 0
  ) {
    out.push({
      key: "program",
      title: "Runs its own program",
      detail: c.commands
        ? `Runs as a desktop extension and adds ${plural(c.commands, "command", "commands")} you can run from the Command Palette (⌘K).`
        : "Runs as a desktop extension right here.",
      band: "active",
      tech: "main entry (Node extension host)",
    });
  }

  // ── Coming soon: detected, planned, not yet runnable ───────────────────────
  if (panelCount > 0 || c.viewsContainers || c.webviews) {
    out.push({
      key: "panels",
      title: "Panels & views — coming soon",
      detail:
        "Adds its own side panels or custom editors. Aura doesn't host these yet, so they won't appear.",
      band: "coming-soon",
      tech: "contributes.views / viewsContainers / customEditors / webviews",
    });
  }

  // ── Not yet: detected, further out ─────────────────────────────────────────
  if ((c.debuggers ?? 0) > 0) {
    out.push({
      key: "debuggers",
      title: "Debugging — not yet",
      detail: `Adds ${plural(c.debuggers ?? 0, "debugger", "debuggers")}. Running a debugger needs a host Aura doesn't have yet.`,
      band: "not-yet",
      tech: "contributes.debuggers (debug adapter)",
    });
  }
  return out;
}

/** The single most important band for an extension overall — "active" if it
 *  applies anything today, otherwise the best of what it has. Lets a card show
 *  one honest verdict before the user installs. */
export function overallBand(c: ContributesSummary): SupportBand | "none" {
  const labels = kindLabels(c);
  if (labels.length === 0) return "none";
  if (labels.some((l) => l.band === "active")) return "active";
  if (labels.some((l) => l.band === "coming-soon")) return "coming-soon";
  return "not-yet";
}

/** True when the extension applies *something* today (≥1 active kind). When
 *  false, installing it would silently do nothing — the caller should say so
 *  up front. */
export function hasActiveSupport(c: ContributesSummary): boolean {
  return kindLabels(c).some((l) => l.band === "active");
}

/** A one-line "what you get" summary for a card. Leads with what's active; if
 *  nothing is active, states plainly what's coming-soon / not-yet so the user
 *  isn't misled into installing a no-op. */
export function whatYouGetLine(c: ContributesSummary): string {
  const labels = kindLabels(c);
  if (labels.length === 0) return "Nothing Aura can use.";
  const active = labels.filter((l) => l.band === "active");
  if (active.length > 0) {
    const extra = labels.length - active.length;
    const head = active.map(activeShort).join(" · ");
    return extra > 0 ? `${head} · plus more, coming soon` : head;
  }
  // Nothing active — be honest about the one blocking kind up front.
  return labels[0].detail;
}

/** Short active-kind phrase for the inline "what you get" line. */
function activeShort(l: KindLabel): string {
  switch (l.key) {
    case "themes":
      return l.detail.startsWith("1 ") ? "1 color theme" : countPhrase(l.detail, "color themes");
    case "languages":
      return l.title === "Syntax highlighting" ? "syntax highlighting" : "language files";
    case "snippets":
      return "snippets";
    case "web":
      return "runs its own program";
    case "language-server":
      return "smart code help";
    case "program":
      return "runs its own program";
    default:
      return l.title;
  }
}

/** Pull the leading count out of a detail string for a compact phrase. */
function countPhrase(detail: string, fallback: string): string {
  const m = detail.match(/^(\d+)\s+([a-z ]+?)\b/i);
  return m ? `${m[1]} ${m[2]}` : fallback;
}

/** Tailwind text-color class for a band — arctic-blue accent only for the
 *  things Aura actually runs; amber for the not-yet kinds; muted for none. */
export function bandTextClass(band: SupportBand | "none"): string {
  switch (band) {
    case "active":
      return "text-accent";
    case "coming-soon":
      return "text-text-3";
    case "not-yet":
      return "text-amber-400/90";
    default:
      return "text-text-4";
  }
}
