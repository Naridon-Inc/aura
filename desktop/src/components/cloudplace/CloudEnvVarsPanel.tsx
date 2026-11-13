// Settings › Cloud computer › Environment variables — the member's own
// variables, applied to the cloud workspaces they create.
//
// The cloud never hands a value back, so a saved variable is its name and
// dots: there is nothing to reveal or copy, and Edit gives it a new value.

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { FileUp, MoreHorizontal, Plus } from "lucide-react";

import { parseEnvText, useCloudEnvVars } from "../../lib/cloudEnvVars";
import { toast } from "../../lib/toast";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { SettingsSection } from "../ui/settings-row";
import { ErrorState, LoadingState } from "../ui/state";
import { CloudEnvVarSheet, type EnvSheetMode } from "./CloudEnvVarSheet";
import "./cloud-env.css";

const ABOUT =
  "Applied to workspaces you create, and refreshed when those workspaces restart. May be visible to your teammates.";

function ImportButton({ onImport }: { onImport: (text: string, file: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    file
      .text()
      .then((text) => onImport(text, file.name))
      .catch(() => toast.danger(`Couldn't read ${file.name}.`));
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
        <FileUp size={14} />
        Import .env
      </Button>
      <input ref={input} type="file" hidden onChange={pick} />
    </>
  );
}

export function CloudEnvVarsPanel() {
  const { read, saving, save, remove, reload } = useCloudEnvVars();
  const [sheet, setSheet] = useState<EnvSheetMode | null>(null);
  const existing = useMemo(
    () => new Set(read.status === "ready" ? read.vars.map((v) => v.name) : []),
    [read],
  );

  const imported = (text: string, file: string) => {
    const entries = parseEnvText(text);
    if (entries.length === 0) {
      toast.danger(`No KEY=VALUE lines found in ${file}. Check that it's a .env file.`);
      return;
    }
    setSheet({ type: "add", entries });
  };

  const del = async (name: string) => {
    const ok = await askConfirm({
      title: `Delete ${name}?`,
      body: "Workspaces you create stop getting it, and running ones lose it when they restart.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (ok) await remove(name);
  };

  if (read.status === "unavailable") {
    return (
      <div data-fold="env-vars">
        <SettingsSection title="Environment variables">
          <p className="ui-cloud-env-quiet">{read.message}</p>
        </SettingsSection>
      </div>
    );
  }

  return (
    <div data-fold="env-vars">
      <SettingsSection title="Environment variables" description={ABOUT}>
        {read.status === "loading" ? (
          <LoadingState label="Loading environment variables" />
        ) : read.status === "failed" ? (
          <ErrorState
            size="sm"
            title="Couldn't load your environment variables"
            message={read.message}
            onRetry={() => void reload()}
          />
        ) : (
          <div className="ui-cloud-env">
            <div className="ui-cloud-env-actions">
              <Button type="button" size="sm" onClick={() => setSheet({ type: "add" })}>
                <Plus size={14} />
                Add environment variable
              </Button>
              <ImportButton onImport={imported} />
            </div>
            {read.vars.length === 0 ? (
              <p className="ui-cloud-env-quiet">No variables yet</p>
            ) : (
              <ul className="ui-cloud-env-list">
                {read.vars.map((v) => (
                  <li key={v.name} className="ui-cloud-env-row">
                    <span className="ui-cloud-env-key" title={v.name}>
                      {v.name}
                    </span>
                    <span className="ui-cloud-env-value" aria-label="Value hidden">
                      ••••••••
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="iconXs" aria-label={`${v.name} actions`}>
                          <MoreHorizontal size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setSheet({ type: "edit", key: v.name })}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => void del(v.name)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsSection>
      {sheet && (
        <CloudEnvVarSheet
          mode={sheet}
          existing={existing}
          saving={saving}
          onSave={save}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
