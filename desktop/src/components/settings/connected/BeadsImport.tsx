// Beads: a one-shot import of a local issue folder onto this repo's board.
//
// Not a connection. Nothing signs in, nothing persists, nothing is left
// running — so Beads never appears in the connected list, only in the store,
// as something you can run again whenever you like. Point at a folder with a
// Beads tracker in it and its issues land on your board.
//
// We show a count first ("Found 42 issues") so nothing arrives unexpectedly,
// then a one-click bring-in that is safe to run twice: re-running updates the
// same cards instead of making copies.

import { useCallback, useState } from "react";
import { FolderInput, LinkIcon } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { SettingsServiceList } from "../../ui/settings-services-row";
import { pickPath } from "../../../lib/nativeDialog";
import { countOf } from "@shared/plural";
import {
  integrationsApi,
  type BeadsImportOutcome,
  type BeadsPreview,
} from "../../../lib/integrationsApi";
import { ServiceName } from "./ServiceGlyph";
import { CardError } from "./trackerParts";
import type { CatalogEntry } from "./catalog";

/** How many of an import's problems to list before summing up the rest. */
const SHOWN_ERRORS = 5;

export function BeadsImportRow({ entry, repoRoot }: { entry: CatalogEntry; repoRoot: string }) {
  const [source, setSource] = useState<string>("");
  const [preview, setPreview] = useState<BeadsPreview | null>(null);
  const [outcome, setOutcome] = useState<BeadsImportOutcome | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  // Beads keeps its own error rather than pushing one up to the pane: it is
  // the only thing here that fails without a sign-in to blame, and a shared
  // banner put the failure a long way from the button that caused it.
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickPath({
        directory: true,
        title: "Choose a folder with a Beads tracker (.beads)",
        defaultPath: repoRoot || undefined,
      });
      if (typeof picked !== "string") return;
      setSource(picked);
      setOutcome(null);
      setPreview(null);
      setBusy("preview");
      const p = await integrationsApi.beadsPreview(picked);
      setPreview(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [repoRoot]);

  const runImport = useCallback(async () => {
    if (!source) return;
    setError(null);
    setBusy("import");
    try {
      const result = await integrationsApi.beadsImport({ repoRoot, source });
      setOutcome(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [source, repoRoot]);

  const issues = (n: number) => `${n} issue${n === 1 ? "" : "s"}`;
  const found =
    preview &&
    `Found ${issues(preview.total)} (${preview.open} open · ${preview.closed} done${
      preview.with_dependencies > 0 ? ` · ${preview.with_dependencies} with dependencies` : ""
    }).`;
  const result =
    outcome &&
    `Brought in ${outcome.created} new · updated ${outcome.updated}${
      outcome.links > 0 ? ` · linked ${countOf(outcome.links, "dependency")}` : ""
    }${outcome.skipped > 0 ? ` · skipped ${outcome.skipped}` : ""}.`;
  const problems = outcome?.errors ?? [];

  return (
    <SettingsRow
      title={<ServiceName entry={entry} />}
      description={entry.blurb}
      help={
        source || error ? (
          <>
            {source && (
              <p title={source}>
                From <code>{source}</code>
              </p>
            )}
            {found && !outcome && <p>{found}</p>}
            {result && <p role="status">{result}</p>}
            {problems.length > 0 && (
              <SettingsServiceList
                items={problems.slice(0, SHOWN_ERRORS)}
                more={
                  problems.length > SHOWN_ERRORS
                    ? `…and ${problems.length - SHOWN_ERRORS} more`
                    : undefined
                }
              />
            )}
            {error && <CardError msg={error} />}
          </>
        ) : undefined
      }
      control={
        <SettingsActions>
          <Button variant="outline" size="sm" onClick={choose} disabled={busy !== null}>
            {busy === "preview" ? <AsciiSpinner /> : <FolderInput />}
            Choose folder…
          </Button>
          {preview && (
            <Button size="sm" onClick={runImport} disabled={busy !== null || preview.total === 0}>
              {busy === "import" ? <AsciiSpinner /> : <LinkIcon />}
              Bring in {issues(preview.total)}
            </Button>
          )}
        </SettingsActions>
      }
    />
  );
}
