// Run / Setup script launcher — Conductor "run scripts in the UI" parity.
//
// Conductor lets you configure per-workspace setup + run commands and fire
// them with a button, streaming output into a log pane. Aura already stores
// those commands (`.aura/settings.toml [worktree] setup`/`run`, edited under
// Settings ▸ Copies & agents) and already has a full terminal — so the Run
// button just boots the configured command in a fresh terminal tab, whose
// scrollback *is* the setup/run-log viewer (persisted by the Term infra).
//
// No new backend: reads the existing RepoWorktreeSettings, launches via the
// editor store's openTerminal(cwd, { bootCommand }). When nothing is
// configured yet, the control deep-links to the settings pane that edits it.

import { useEffect, useState } from "react";
import { Play, Wrench, Plus } from "lucide-react";
import { repoWorktreeSettingsGet } from "../lib/api";
import { useEditorStore } from "../lib/editorStore";

type Props = {
  /** Project root the scripts run in (also the terminal cwd). */
  repoRoot: string;
};

function openScriptSettings() {
  window.dispatchEvent(
    new CustomEvent("aura:open-settings", { detail: { pane: "copies" } }),
  );
}

export function RunScriptButton({ repoRoot }: Props) {
  const openTerminal = useEditorStore().openTerminal;
  const [run, setRun] = useState<string | null>(null);
  const [setup, setSetup] = useState<string | null>(null);
  const [namedScripts, setNamedScripts] = useState<Array<{ name: string; command: string }>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    repoWorktreeSettingsGet(repoRoot)
      .then((s) => {
        if (cancelled) return;
        setRun(s.run && s.run.trim() ? s.run.trim() : null);
        setSetup(s.setup && s.setup.trim() ? s.setup.trim() : null);
        setNamedScripts(Array.isArray(s.namedScripts) ? s.namedScripts : []);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setRun(null);
        setSetup(null);
        setNamedScripts([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  // The settings pane also edits these live; re-read when it closes so a
  // just-configured script shows up without a project reswitch.
  useEffect(() => {
    const reload = () => {
      repoWorktreeSettingsGet(repoRoot)
        .then((s) => {
          setRun(s.run && s.run.trim() ? s.run.trim() : null);
          setSetup(s.setup && s.setup.trim() ? s.setup.trim() : null);
          setNamedScripts(Array.isArray(s.namedScripts) ? s.namedScripts : []);
        })
        .catch(() => {});
    };
    window.addEventListener("aura:worktree-settings-saved", reload);
    return () =>
      window.removeEventListener("aura:worktree-settings-saved", reload);
  }, [repoRoot]);

  const launch = (command: string, label: string) => {
    openTerminal(repoRoot, { bootCommand: command, label });
  };

  if (!loaded) return null;

  // Nothing configured — offer a quiet way to set one up.
  if (!run && !setup && namedScripts.length === 0) {
    return (
      <button
        type="button"
        onClick={openScriptSettings}
        title="Set a run or setup script for this project"
        className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-text-4 hover:text-text-2 hover:bg-state-hover text-xs font-medium transition-colors"
      >
        <Plus size={11} strokeWidth={2} aria-hidden />
        Run script
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      {namedScripts.map((script) => (
        <button
          key={`${script.name}:${script.command}`}
          type="button"
          onClick={() => launch(script.command, script.name)}
          title={`${script.name}: ${script.command}`}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded bg-bg-2 hover:bg-bg-3 text-text-2 hover:text-text-1 text-xs font-medium transition-colors"
        >
          <Play size={10} strokeWidth={2.25} aria-hidden />
          {script.name}
        </button>
      ))}
      {run && (
        <button
          type="button"
          onClick={() => launch(run, "Run")}
          title={`Run: ${run}`}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded bg-bg-2 hover:bg-bg-3 text-[color:var(--color-accent)] text-xs font-medium transition-colors"
        >
          <Play size={10} strokeWidth={2.25} aria-hidden />
          Run
        </button>
      )}
      {setup && (
        <button
          type="button"
          onClick={() => launch(setup, "Setup")}
          title={`Setup: ${setup}`}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded bg-bg-2 text-text-2 hover:bg-bg-3 hover:text-text-1 text-xs font-medium transition-colors"
        >
          <Wrench size={10} strokeWidth={2} aria-hidden />
          Setup
        </button>
      )}
    </div>
  );
}
