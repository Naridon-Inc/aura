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
import { CheckCircle2, FolderInput, LinkIcon } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { pickPath } from "../../../lib/nativeDialog";
import { countOf } from "@shared/plural";
import {
  integrationsApi,
  type BeadsImportOutcome,
  type BeadsPreview,
} from "../../../lib/integrationsApi";
import { CardError } from "./trackerParts";

export function BeadsImport({ repoRoot }: { repoRoot: string }) {
  const [source, setSource] = useState<string>("");
  const [preview, setPreview] = useState<BeadsPreview | null>(null);
  const [outcome, setOutcome] = useState<BeadsImportOutcome | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  // Beads keeps its own error rather than pushing one up to the pane: it is
  // the only thing here that fails without a sign-in to blame, and a shared
  // banner put the failure a long way from the button that caused it.
  const [error, setError] = useState<string | null>(null);
  const onError = setError;

  const choose = useCallback(async () => {
    onError(null);
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
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }, [repoRoot, onError]);

  const runImport = useCallback(async () => {
    if (!source) return;
    onError(null);
    setBusy("import");
    try {
      const result = await integrationsApi.beadsImport({ repoRoot, source });
      setOutcome(result);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }, [source, repoRoot, onError]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={choose}
          disabled={busy !== null}
        >
          {busy === "preview" ? (
            <AsciiSpinner className="text-sm leading-none" />
          ) : (
            <FolderInput className="h-3.5 w-3.5" />
          )}
          Choose folder…
        </Button>
        {preview && (
          <Button
            size="sm"
            onClick={runImport}
            disabled={busy !== null || preview.total === 0}
          >
            {busy === "import" ? (
              <AsciiSpinner className="text-sm leading-none" />
            ) : (
              <LinkIcon className="h-3.5 w-3.5" />
            )}
            Bring in {preview.total} issue{preview.total === 1 ? "" : "s"}
          </Button>
        )}
      </div>

      {source && (
        <p className="mt-2 truncate text-xs text-text-4" title={source}>
          From: <code className="text-text-3">{source}</code>
        </p>
      )}

      {preview && !outcome && (
        <p className="mt-1 text-xs text-text-4">
          Found <span className="text-text-2">{preview.total}</span> issue
          {preview.total === 1 ? "" : "s"} ({preview.open} open ·{" "}
          {preview.closed} done
          {preview.with_dependencies > 0
            ? ` · ${preview.with_dependencies} with dependencies`
            : ""}
          ).
        </p>
      )}

      {outcome && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-accent-green">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span className="text-text-3">
            Brought in <span className="text-text-1">{outcome.created}</span>{" "}
            new · updated <span className="text-text-1">{outcome.updated}</span>
            {outcome.links > 0
              ? ` · linked ${countOf(outcome.links, "dependency")}`
              : ""}
            {outcome.skipped > 0 ? ` · skipped ${outcome.skipped}` : ""}.
          </span>
        </div>
      )}

      {outcome && outcome.errors.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-amber/90">
          {outcome.errors.slice(0, 5).map((e, i) => (
            <li key={i} className="truncate" title={e}>
              • {e}
            </li>
          ))}
          {outcome.errors.length > 5 && (
            <li className="text-text-4">
              …and {outcome.errors.length - 5} more
            </li>
          )}
        </ul>
      )}

      {error && (
        <div className="mt-2">
          <CardError msg={error} />
        </div>
      )}
    </div>
  );
}
