// The "What changed" block over the editor's diff, rendered on its own.
//
// Dev-server only — reached at /file-insight-harness.html?scene=<name>, never
// bundled. The block is the real one; only the desktop's git, outline,
// reason-log and explanation commands are stood in for, answering from
// ./scenes. Nothing runs and nothing is saved anywhere. Add `&theme=light` for
// the light palette and `&w=<px>` for the editor's width.

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import "../../../styles.css";
import { lineDiff } from "./lineDiff";
import { ROOT, SCENES, symbolAnswers } from "./scenes";

const params = new URLSearchParams(location.search);
const scene = SCENES[params.get("scene") ?? "team"] ?? SCENES.team;
if (params.get("theme") === "light") document.documentElement.classList.add("light");
try {
  localStorage.setItem("aura.fileInsight.open", "1");
} catch {
  /* no storage — the block opens by default anyway */
}

const missed = new Set<string>();
(window as unknown as { __missed: Set<string> }).__missed = missed;

const absPath = `${ROOT}/${scene.path}`;
const diff = lineDiff(scene.path, scene.before, scene.after);

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  git_diff: () => diff,
  aura_semantic_outline: () => scene.outline,
  aura_read_intent_log_v2: () => {
    const entries = scene.intents();
    return { entries, has_more: false, oldest_ts: entries[entries.length - 1]?.timestamp ?? 0 };
  },
  aura_list_snapshots: () => [],
  aura_ask: (a) => ({
    question: String(a.question),
    verdict: "no_match",
    searched: { intents: 2, checkpoints: 0 },
    hits: [],
  }),
  git_show_head: () => scene.before,
  read_file: () => ({ path: absPath, text: scene.after, size: scene.after.length, language: "", status: "ok" }),
  explain_change: () => scene.explanation(),
  explain_symbols: (a) => symbolAnswers(scene, (a.symbols as { identifier: string }[]) ?? []),
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const answer = answers[cmd];
    if (!answer) {
      missed.add(cmd);
      throw new Error(`command ${cmd} not found`);
    }
    return answer(args);
  },
  transformCallback: () => 0,
};

async function mount() {
  const { FileInsightStrip } = await import("../../FileInsightStrip");
  const width = Number(params.get("w")) || 720;
  ReactDOM.createRoot(document.getElementById("file-insight-harness")!).render(
    <StrictMode>
      <div style={{ minHeight: "100vh" }} className="bg-bg-content">
        <div style={{ width }}>
          <FileInsightStrip repoRoot={ROOT} absPath={absPath} fileLabel={scene.path} />
        </div>
      </div>
    </StrictMode>,
  );
  // Ready once the block has drawn its rows (or said there are none).
  const started = Date.now();
  const check = window.setInterval(() => {
    const drawn = document.querySelector(".ui-story-row, .ui-story-empty");
    if (drawn || Date.now() - started > 5000) {
      window.clearInterval(check);
      document.body.dataset.ready = "yes";
    }
  }, 100);
}
void mount();
