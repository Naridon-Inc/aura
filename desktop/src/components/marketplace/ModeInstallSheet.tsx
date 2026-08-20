// Mode install sheet — drawer that surfaces the full mode preview
// (system prompt excerpt, tool ACL, permissions warning) before the
// user confirms install. Doubles as the "install from URL" entry
// point: paste any https URL to a mode YAML and we'll fetch + pin +
// install.
//
// Surfaces the advanced-tools gate: if the mode wants `shell.exec`,
// `fs.delete`, etc., we render a red banner with a checkbox the user
// must tick before the install button enables.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { api, type MarketplaceIndexEntry } from "../../lib/api";
import { refreshInstalledModes } from "../../lib/modesStore";
import { RESERVED_TOOLS } from "./ModePermissionsBadge";

type Props = {
  open: boolean;
  /** Pre-filled entry from a marketplace card click; null when the
   *  sheet is invoked via "Install from URL". */
  entry: MarketplaceIndexEntry | null;
  onClose: () => void;
  onInstalled?: (slug: string) => void;
};

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      yaml: string;
      needsAdvanced: boolean;
      wantedReserved: string[];
    };

export function ModeInstallSheet({ open, entry, onClose, onInstalled }: Props) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [acknowledged, setAcknowledged] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Seed the URL field from the marketplace entry when one's provided.
  useEffect(() => {
    if (!open) return;
    setUrl(entry?.url ?? "");
    setPreview({ kind: "idle" });
    setAcknowledged(false);
    setInstallError(null);
  }, [open, entry?.url]);

  // Cheap preview: fetch the YAML, run the local validator, render the
  // first 24 lines + the wanted reserved tools. Doesn't persist
  // anything; the install button does the real `modesInstallFromUrl`.
  const fetchPreview = async (target: string) => {
    setPreview({ kind: "loading" });
    try {
      const resp = await fetch(target);
      if (!resp.ok) {
        setPreview({
          kind: "error",
          message: `HTTP ${resp.status} ${resp.statusText}`,
        });
        return;
      }
      const yaml = await resp.text();
      const report = await api.modesValidateYaml(yaml);
      if (!report.ok || !report.mode) {
        setPreview({
          kind: "error",
          message:
            "validation failed: " +
            report.issues
              .filter((i) => i.level === "error")
              .map((i) => `${i.field}: ${i.message}`)
              .join("; "),
        });
        return;
      }
      const tools = new Set<string>();
      for (const t of report.mode.tool_acl.allow) tools.add(t);
      for (const t of report.mode.tool_acl.advanced) tools.add(t);
      const wantedReserved = Array.from(tools).filter((t) =>
        RESERVED_TOOLS.has(t),
      );
      setPreview({
        kind: "ready",
        yaml,
        needsAdvanced: wantedReserved.length > 0,
        wantedReserved,
      });
    } catch (e) {
      setPreview({ kind: "error", message: String(e) });
    }
  };

  // Auto-fetch the preview when the sheet opens with a pre-filled URL.
  useEffect(() => {
    if (open && url) {
      void fetchPreview(url);
    }
  }, [open]); // intentionally only on open

  const canInstall = useMemo(() => {
    if (preview.kind !== "ready") return false;
    if (preview.needsAdvanced && !acknowledged) return false;
    return !!url.trim();
  }, [preview, acknowledged, url]);

  const handleInstall = async () => {
    if (preview.kind !== "ready") return;
    setInstalling(true);
    setInstallError(null);
    try {
      const desc = await api.modesInstallFromUrl({
        url: url.trim(),
        expectedPin: entry?.pin_blake3 ?? null,
        advancedAcknowledged: preview.needsAdvanced ? acknowledged : false,
      });
      await refreshInstalledModes();
      onInstalled?.(desc.id);
      onClose();
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {entry ? `Install ${entry.display_name}` : "Install Mode"}
          </DialogTitle>
          <DialogDescription>
            {entry?.description ??
              "Paste a URL to a mode YAML file. Aura will fetch, validate, and pin the contents with blake3."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-3 mb-1 block">
              YAML URL
            </label>
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(ev) => setUrl(ev.target.value)}
                placeholder="https://gist.githubusercontent.com/.../code.yaml"
                className="h-8 text-sm"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchPreview(url.trim())}
                disabled={!url.trim()}
              >
                Preview
              </Button>
            </div>
          </div>

          {preview.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-text-3">
              <AsciiSpinner /> Fetching…
            </div>
          )}

          {preview.kind === "error" && (
            <div className="text-sm text-red bg-red/10 rounded p-2">
              {preview.message}
            </div>
          )}

          {preview.kind === "ready" && (
            <>
              <div className="rounded border border-bg-3 bg-bg-2 p-2 max-h-48 overflow-auto">
                <pre className="text-xs font-mono text-text-2 whitespace-pre-wrap">
                  {preview.yaml.split("\n").slice(0, 60).join("\n")}
                </pre>
              </div>

              {preview.needsAdvanced && (
                <div className="rounded border border-amber/30 bg-amber/[0.08] p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-amber">
                      This mode wants <b>advanced tools</b> that can mutate
                      your system. Review and acknowledge before installing.
                    </div>
                  </div>
                  <div className="text-xs text-amber ml-6 font-mono">
                    {preview.wantedReserved.join(", ")}
                  </div>
                  <label className="flex items-center gap-2 ml-6 text-sm text-amber">
                    <Checkbox
                      checked={acknowledged}
                      onCheckedChange={(v) => setAcknowledged(v === true)}
                    />
                    I understand this mode can run shell commands or
                    modify state.
                  </label>
                </div>
              )}
            </>
          )}

          {installError && (
            <div className="text-sm text-red">
              Install failed: {installError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="xs" onClick={onClose} disabled={installing}>
            Cancel
          </Button>
          <Button size="xs" onClick={handleInstall} disabled={!canInstall || installing}>
            {installing ? (
              <>
                <AsciiSpinner className="text-sm leading-none mr-1" />
                Installing…
              </>
            ) : (
              "Install"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
