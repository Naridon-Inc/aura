// First run, the create page of Project. Three real ways to start, all
// backed by Tauri commands:
//   Empty    -> git init + a seeded first commit
//   Clone    -> git clone <url>
//   Template -> scaffold a built-in starter (Minimal / Node + TS), commit
// On success the new repository opens through the same event the rest of the
// app uses, and first run ends.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, FolderOpen } from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { api } from "../../lib/api";
import "../ui/cloud-onboarding.css";
import "../ui/cloud-patterns.css";
import "../ui/onboarding.css";

type Mode = "empty" | "clone" | "template";
type TemplateId = "minimal" | "node-ts";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "empty", label: "Empty", hint: "A new repository with nothing in it yet." },
  { id: "clone", label: "Clone", hint: "A copy of a repository from its URL." },
  { id: "template", label: "Template", hint: "A small starter to build on." },
];

const TEMPLATES: { value: TemplateId; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "node-ts", label: "Node + TypeScript" },
];

export function NewProjectScreen({
  onCreated,
  onBusyChange,
}: {
  onCreated: (root: string) => void;
  /** Lets the flow hold its steps still while a create is in flight. */
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

  const hint = MODES.find((m) => m.id === mode)?.hint;

  return (
    <>
      <header>
        <h1>New repository</h1>
        <p>{hint}</p>
      </header>

      <form
        className="ui-onboarding-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="ui-cloud-segments" role="group" aria-label="How to start">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={mode === m.id}
              disabled={busy}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <Field label="Location" htmlFor="onboarding-location">
          <div className="ui-cloud-inline">
            <Input
              id="onboarding-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              spellCheck={false}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={browseLocation}
              disabled={busy}
              aria-label="Choose location"
              title="Choose location"
            >
              <FolderOpen />
            </Button>
          </div>
        </Field>

        {mode === "clone" ? (
          <>
            <Field label="Repository URL" htmlFor="onboarding-url">
              <Input
                id="onboarding-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                disabled={busy}
                placeholder="https:// or git@github.com:user/repo.git"
              />
            </Field>
            <Field label="Folder name" htmlFor="onboarding-name" optional>
              <Input
                id="onboarding-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                disabled={busy}
                placeholder="Defaults to the repository's name"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Repository name" htmlFor="onboarding-name">
              <Input
                id="onboarding-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                disabled={busy}
                placeholder="my-repo"
              />
            </Field>
            {mode === "template" ? (
              <Field label="Template" htmlFor="onboarding-template">
                <Select
                  id="onboarding-template"
                  value={template}
                  onChange={(v) => setTemplate(v as TemplateId)}
                  options={TEMPLATES}
                  disabled={busy}
                />
              </Field>
            ) : null}
          </>
        )}

        {error ? (
          <Alert variant="destructive" className="ui-onboarding-alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div>
          <Button type="submit" disabled={!canSubmit}>
            {busy ? <AsciiSpinner size={10} /> : null}
            {busy
              ? mode === "clone"
                ? "Cloning…"
                : "Creating…"
              : mode === "clone"
                ? "Clone"
                : "Create"}
            {busy ? null : <ArrowRight />}
          </Button>
        </div>
      </form>
    </>
  );
}
