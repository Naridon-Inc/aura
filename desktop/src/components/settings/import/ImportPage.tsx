import { Fragment, useEffect, useState } from "react";

import {
  IMPORT_SOURCE_EVENT,
  count,
  importSourcesDetect,
  takeAskedSource,
  type ImportSource,
} from "../../../lib/importSources";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsEmpty, SettingsError, SettingsIntro } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { ImportSourcePanel } from "./ImportSourcePanel";
import "./import.css";

// Settings → Import. Lists the other agent apps that left data on this Mac;
// opening one shows what it holds and brings the ticked parts over. The
// reading is done in Rust, read-only, and a second import skips what came
// over the first time.

/** Agents whose chats Aura reads where they are, so they need no import. */
const READ_IN_PLACE = "Claude Code, Codex, OpenCode, Kimi and Pi";

function status(s: ImportSource): string {
  const app = s.installed ? "Installed" : "Not installed, its data is still here";
  return s.imported > 0 ? `${app} · ${count(s.imported, "item")} brought over` : `${app} · nothing brought over yet`;
}

export function ImportPage() {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(() => takeAskedSource());

  const detect = async () => {
    try {
      const found = await importSourcesDetect();
      setSources(found);
      setError(null);
      // With one app to import from, there is nothing to choose.
      const here = found.filter((s) => s.found);
      setOpen((cur) => cur ?? (here.length === 1 ? here[0].id : null));
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void detect();
    const onAsk = (e: Event) => {
      const id = (e as CustomEvent<{ id: string | null }>).detail?.id;
      takeAskedSource();
      if (id) setOpen(id);
    };
    window.addEventListener(IMPORT_SOURCE_EVENT, onAsk);
    return () => window.removeEventListener(IMPORT_SOURCE_EVENT, onAsk);
  }, []);

  const here = (sources ?? []).filter((s) => s.found);
  const names = (sources ?? []).map((s) => s.name);
  const looked =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");

  return (
    <>
      <SettingsIntro>
        Bring your projects, workspaces and chats over from another agent app. Aura only reads the
        other app's files, so nothing there changes, and importing again skips what already came over.
      </SettingsIntro>
      {error && <SettingsError>{error}</SettingsError>}
      <SettingsSection title="Apps on this Mac">
        {!sources && !error && (
          <div className="ui-import-progress">
            <span>
              <AsciiSpinner /> Looking for other agent apps…
            </span>
          </div>
        )}
        {sources && here.length === 0 && (
          <SettingsEmpty>None of the apps Aura imports from left anything on this Mac.</SettingsEmpty>
        )}
        {here.map((s) => (
          <Fragment key={s.id}>
            <SettingsRow
              title={s.name}
              description={status(s)}
              control={
                <Button
                  size="sm"
                  variant={open === s.id ? "ghost" : "outline"}
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                >
                  {open === s.id ? "Hide" : s.imported > 0 ? "Import more" : "Import"}
                </Button>
              }
            />
            {open === s.id && <ImportSourcePanel key={s.id} source={s} onImported={() => void detect()} />}
          </Fragment>
        ))}
      </SettingsSection>
      {sources && (
        <p className="ui-import-footnote">
          Aura looks for {looked}. Chats from {READ_IN_PLACE} need no import: Aura reads them where
          they are.
        </p>
      )}
    </>
  );
}
