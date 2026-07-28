// Screen 4 — New Project. Three real creation modes, all backed by the
// git_clone / git_init / scaffold_template Tauri commands:
//   Empty    -> git init + seeded initial commit
//   Clone    -> git clone <url>
//   Template -> scaffold a built-in starter (Minimal / Node + TS), commit
// On success the new repo path flows through the same open-repo event the
// rest of the app uses, and onboarding ends.

import { useCallback, useEffect, useRef, useState } from "react";
import { AuraWordmark } from "./OnboardingShell";
import { EmptyRepoIcon, CloneIcon, TemplateIcon, FolderIcon } from "./icons";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { api } from "../../lib/api";

type Mode = "empty" | "clone" | "template";
type TemplateId = "minimal" | "node-ts";

const MODES: { id: Mode; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "empty", label: "Empty", hint: "New git repo from scratch", icon: <EmptyRepoIcon /> },
  { id: "clone", label: "Clone", hint: "Clone from a remote URL", icon: <CloneIcon /> },
  { id: "template", label: "Template", hint: "Start from a starter", icon: <TemplateIcon /> },
];

const TEMPLATES: { id: TemplateId; label: string }[] = [
  { id: "minimal", label: "Minimal" },
  { id: "node-ts", label: "Node + TypeScript" },
];

export function NewProjectScreen({
  onCreated,
  onBusyChange,
}: {
  onCreated: (root: string) => void;
  /** Lets the flow hide its Back affordance while a create is in flight. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("empty");
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [template, setTemplate] = useState<TemplateId>("minimal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Default the create location to ~/AuraProjects.
  useEffect(() => {
    import("@tauri-apps/api/path")
      .then(async ({ homeDir }) => {
        const home = (await homeDir()).replace(/\/+$/, "");
        setLocation(`${home}/AuraProjects`);
      })
      .catch(() => {});
  }, []);

  const browseLocation = useCallback(() => {
    import("../../lib/nativeDialog")
      .then(async ({ pickPath }) => {
        const picked = await pickPath({ directory: true, multiple: false });
        if (typeof picked === "string" && picked) setLocation(picked);
      })
      .catch(() => {});
  }, []);

  const canSubmit =
    !busy &&
    location.trim().length > 0 &&
    (mode === "clone" ? url.trim().length > 0 : name.trim().length > 0);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const res =
        mode === "clone"
          ? await api.gitClone(url.trim(), location.trim(), name.trim() || undefined)
          : mode === "template"
            ? await api.scaffoldTemplate(location.trim(), name.trim(), template)
            : await api.gitInit(location.trim(), name.trim());
      window.dispatchEvent(
        new CustomEvent("aura:open-repo-picker-path", { detail: { path: res.root } }),
      );
      onCreated(res.root);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(String(e));
      setBusy(false);
      onBusyChange?.(false);
    }
  }, [canSubmit, mode, url, location, name, template, onCreated, onBusyChange]);

  return (
    <div className="w-full flex justify-center">
      <div className="w-full max-w-[520px] flex flex-col items-center py-12">
        <AuraWordmark />

        <div className="mt-10 w-full">
          <div className="text-[14px] font-semibold text-text-1">New Project</div>

          {/* Location */}
          <div className="mt-5">
            <FieldLabel>Location</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                spellCheck={false}
                className="flex-1 font-mono text-[12.5px]"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={browseLocation}
                aria-label="Choose location"
                className="h-8 w-8 shrink-0"
              >
                <FolderIcon size={16} />
              </Button>
            </div>
          </div>

          {/* Mode tiles */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            {MODES.map((m) => {
              const on = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className={[
                    "flex flex-col items-center text-center gap-1.5 px-2 py-3.5 rounded-md border transition-colors",
                    on
                      ? "border-accent bg-accent-soft"
                      : "border-line-soft bg-bg-2 hover:bg-bg-3 hover:border-line-strong",
                  ].join(" ")}
                >
                  <span className={on ? "text-accent" : "text-text-3"}>{m.icon}</span>
                  <span className="text-[12.5px] font-medium text-text-1">{m.label}</span>
                  <span className="text-[10.5px] leading-tight text-text-4">{m.hint}</span>
                </button>
              );
            })}
          </div>

          {/* Mode-specific input */}
          <div className="mt-4">
            {mode === "clone" ? (
              <>
                <FieldLabel>Repository URL</FieldLabel>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                  placeholder="https:// or git@github.com:user/repo.git"
                  className="font-mono text-[12.5px]"
                />
                <div className="mt-2">
                  <FieldLabel>Folder name (optional)</FieldLabel>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    spellCheck={false}
                    placeholder="defaults to the repo name"
                    className="text-[12.5px]"
                  />
                </div>
              </>
            ) : (
              <>
                <FieldLabel>Project name</FieldLabel>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  spellCheck={false}
                  placeholder="my-project"
                  className="text-[12.5px]"
                />
                {mode === "template" ? (
                  <div className="mt-2">
                    <FieldLabel>Template</FieldLabel>
                    <div className="flex gap-2">
                      {TEMPLATES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTemplate(t.id)}
                          className={[
                            "h-8 px-3 rounded-md border text-[12px] transition-colors",
                            template === t.id
                              ? "border-accent bg-accent-soft text-text-1"
                              : "border-line-soft bg-bg-2 text-text-3 hover:text-text-1 hover:bg-bg-3",
                          ].join(" ")}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {error ? (
            <div className="mt-3 text-[11.5px] text-red break-words">{error}</div>
          ) : null}

          <div className="mt-5 flex items-center justify-end">
            <Button
              type="button"
              variant="default"
              size="lg"
              disabled={!canSubmit}
              onClick={submit}
            >
              {busy ? <AsciiSpinner className="text-[12px] leading-none" /> : null}
              {mode === "clone" ? "Clone" : "Create"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px] font-medium text-text-3">{children}</div>
  );
}
