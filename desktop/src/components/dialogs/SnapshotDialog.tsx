// Project-wide safety snapshot. Shells out to `aura snapshot
// "<description>"` which creates a hidden `aura/snapshot/<ts>` branch
// from current HEAD and stashes uncommitted work. The dialog just
// gathers the description and shows the CLI's response.

import { useEffect, useState } from "react";
import { Dialog } from "../Dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { api } from "../../lib/api";

type SnapshotDialogProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
};

export function SnapshotDialog({ open, repoRoot, onClose }: SnapshotDialogProps) {
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDesc("");
      setBusy(false);
      setOutput("");
      setErr(null);
    }
  }, [open]);

  async function run() {
    if (!desc.trim()) return;
    setBusy(true);
    setErr(null);
    setOutput("");
    try {
      const res = await api.auraCli(repoRoot, ["snapshot", desc.trim()]);
      setOutput((res.stdout + res.stderr).trim() || `(exit ${res.status})`);
      if (res.status !== 0) setErr(`aura snapshot exited with ${res.status}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save point"
      footer={
        <>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={run}
            disabled={busy || !desc.trim()}
          >
            {busy ? "Saving…" : "Save point"}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[11.5px]">
        <div className="text-text-4 text-[10.5px] uppercase tracking-wider">
          Description
        </div>
        <Input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="before risky refactor of auth middleware"
          disabled={busy}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          className="w-full"
        />
        <div className="text-text-5 text-[10.5px]">
          A point you can always come back to — your current work is kept safe, exactly as it is now.
        </div>
        {err && <div className="text-red text-[11px]">{err}</div>}
        {output && (
          <pre className="bg-bg-1 border border-line rounded p-2 max-h-40 overflow-auto text-[10.5px] font-mono text-text-3 whitespace-pre-wrap">
            {output}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
