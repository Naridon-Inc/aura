// Run / Setup script launcher — a workspace's scripts, run from the UI.
//
// A workspace can carry per-workspace setup + run commands and fire
// them with a button, streaming output into a log pane. Aura already stores
// those commands (`.aura/settings.toml [worktree] setup`/`run`, edited under
// Settings ▸ Copies & agents) and already has a full terminal — so the Run
// button just boots the configured command in a fresh terminal tab, whose
// scrollback *is* the setup/run-log viewer (persisted by the Term infra).
//
// No new backend: reads the existing RepoWorktreeSettings, launches via the
// editor store's openTerminal(cwd, { bootCommand }). When nothing is
// configured yet, the control deep-links to the settings pane that edits it.

//
// Where it runs (AURA-1307): the terminal is always a tab here, but when the
// project stands in a machine the command is typed after the box's own boot
// line, so it starts in the checkout over there. The settings that name the
// commands are read here, as before — they are this laptop's notes about the
// project, not the checkout's.

import { useEffect, useState } from "react";
import { Play, Wrench, Plus } from "lucide-react";
import { repoWorktreeSettingsGet } from "../lib/api";
import { useEditorStore } from "../lib/editorStore";
import { bootCommandFor } from "../lib/place/runAt";
import { Button } from "./ui/button";
import "./ui/run-scripts.css";

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
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLaunchError(null);
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

  // A machine that cannot be opened is shown, not worked around: running the
  // command in this laptop's copy would start the wrong thing on the wrong
  // computer while looking like it worked.
  const launch = async (command: string, label: string) => {
    try {
      const bootCommand = await bootCommandFor(repoRoot, command);
      setLaunchError(null);
      openTerminal(repoRoot, { bootCommand, label });
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!loaded) return null;

  // Nothing configured — offer a quiet way to set one up.
  if (!run && !setup && namedScripts.length === 0) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={openScriptSettings}
        title="Set a run or setup script for this repository"
        className="ui-run-empty"
      >
        <Plus aria-hidden />
        Run script
      </Button>
    );
  }

  // Run is the one verb the strip exists for, so it is the filled button;
  // named scripts and Setup sit beside it in the quieter secondary.
  return (
    <div className="ui-run-scripts">
      {namedScripts.map((script) => (
        <Button
          key={`${script.name}:${script.command}`}
          variant="secondary"
          size="xs"
          onClick={() => void launch(script.command, script.name)}
          title={`${script.name}: ${script.command}`}
        >
          <Play aria-hidden />
          {script.name}
        </Button>
      ))}
      {run && (
        <Button size="xs" onClick={() => void launch(run, "Run")} title={`Run: ${run}`}>
          <Play aria-hidden />
          Run
        </Button>
      )}
      {setup && (
        <Button
          variant="secondary"
          size="xs"
          onClick={() => void launch(setup, "Setup")}
          title={`Setup: ${setup}`}
        >
          <Wrench aria-hidden />
          Setup
        </Button>
      )}
      {launchError && (
        <span role="alert" title={launchError} className="ui-run-error">
          {launchError}
        </span>
      )}
    </div>
  );
}
