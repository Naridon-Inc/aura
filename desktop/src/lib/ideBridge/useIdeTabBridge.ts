// The tab half of the agent control plane.
//
// Rust owns the socket an agent CLI talks to, but the tabs live here, so
// every request that touches one arrives as an `ide-bridge:request` event
// and is answered with the `ide_bridge_respond` command. One request id,
// one answer.
//
// Mounted exactly once, from App. Two mounts would mean two answers to the
// same request — the second one landing nowhere, which is harmless, and
// two tabs opening for one ask, which is not.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { clearAgentDiffBase, useEditorStore, type OpenFile } from "../editorStore";
import { currentSelection } from "./selection";
import {
  diffOutcomeFor,
  unsavedEditsMessage,
  wouldClobberUnsavedEdits,
  type IdeReply,
  type IdeRequest,
  type OpenDiffParams,
  type OpenFileParams,
  type PendingDiff,
} from "./protocol";

const REQUEST_EVENT = "ide-bridge:request";

async function respond(requestId: string, reply: IdeReply): Promise<void> {
  try {
    await invoke("ide_bridge_respond", { requestId, reply });
  } catch (e) {
    // The agent is gone or already gave up. Nothing to recover — the Rust
    // side treats an unclaimed answer as "fine, drop it".
    console.debug("ide bridge: reply not delivered", e);
  }
}

export function useIdeTabBridge(): void {
  const store = useEditorStore();
  // The event listener is registered once and must never be re-registered —
  // re-subscribing on every render costs an IPC round-trip per render — so
  // it reads the live store through a ref instead of a closure.
  const storeRef = useRef(store);
  storeRef.current = store;

  const pendingRef = useRef<Map<string, PendingDiff>>(new Map());
  const tabPathsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    async function openDiff(requestId: string, params: OpenDiffParams) {
      const s = storeRef.current;
      const existing = s.files.find((f) => f.path === params.path);
      if (wouldClobberUnsavedEdits(existing)) {
        await respond(requestId, { error: unsavedEditsMessage(params.path) });
        return;
      }
      try {
        await s.open(params.path, {
          defaultView: "diff",
          diffOriginal: params.oldContents,
          // A file the agent wants to create has nothing on disk to read.
          seedIfMissing: params.oldContents,
        });
      } catch (e) {
        await respond(requestId, {
          error: `Aura couldn't open ${params.path}: ${String(e)}`,
        });
        return;
      }
      // Put the proposal in the buffer, then start watching. Registering
      // before this would let the very first render — where the buffer is
      // still the on-disk text — read as "already saved".
      storeRef.current.updateBuffer(params.path, params.newContents);
      pendingRef.current.set(requestId, {
        requestId,
        path: params.path,
        tabName: params.tabName,
        original: params.oldContents,
        proposed: params.newContents,
      });
      tabPathsRef.current.set(params.tabName, params.path);
    }

    async function openFile(requestId: string, params: OpenFileParams) {
      const s = storeRef.current;
      try {
        await s.open(params.path);
      } catch (e) {
        await respond(requestId, {
          error: `Aura couldn't open ${params.path}: ${String(e)}`,
        });
        return;
      }
      const line = params.startLine ?? 0;
      if (line > 0) {
        // The editor mounts asynchronously; it listens for this and reveals
        // the line once its model is attached. Same path a search hit takes.
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("aura:scroll-to-line", {
              detail: { path: params.path, line, column: 1 },
            }),
          );
        }, 120);
      }
      await respond(requestId, { ok: true });
    }

    function closeTabs(names: string[]) {
      const s = storeRef.current;
      for (const name of names) {
        const path = tabPathsRef.current.get(name) ?? name;
        tabPathsRef.current.delete(name);
        if (s.files.some((f) => f.path === path)) s.close(path);
      }
    }

    function describeOpenEditors() {
      const s = storeRef.current;
      return {
        editors: s.files.map((f: OpenFile) => ({
          filePath: f.path,
          languageId: f.language,
          isActive: f.path === s.activePath,
          hasUnsavedChanges: f.current !== f.baseline,
        })),
      };
    }

    function describeSelection() {
      const sel = currentSelection();
      // A selection in a file that has since been closed is not a selection.
      const stillOpen =
        !!sel && storeRef.current.files.some((f) => f.path === sel.filePath);
      if (!sel || !stillOpen) {
        return { success: false, message: "Nothing is selected in Aura." };
      }
      return {
        success: true,
        filePath: sel.filePath,
        text: sel.text,
        selection: {
          start: { line: sel.startLine, character: sel.startColumn },
          end: { line: sel.endLine, character: sel.endColumn },
          isEmpty: sel.text.length === 0,
        },
      };
    }

    async function handle(req: IdeRequest) {
      switch (req.method) {
        case "openDiff":
          await openDiff(req.requestId, req.params as unknown as OpenDiffParams);
          return;
        case "openFile":
          await openFile(req.requestId, req.params as unknown as OpenFileParams);
          return;
        case "closeTab":
          closeTabs([String(req.params.tabName ?? "")]);
          await respond(req.requestId, { ok: true });
          return;
        case "closeTabs":
          closeTabs((req.params.tabNames as string[]) ?? []);
          await respond(req.requestId, { ok: true });
          return;
        case "getOpenEditors":
          await respond(req.requestId, describeOpenEditors());
          return;
        case "getCurrentSelection":
          await respond(req.requestId, describeSelection());
          return;
        default:
          await respond(req.requestId, {
            error: `Aura doesn't know how to ${req.method}.`,
          });
      }
    }

    void listen<IdeRequest>(REQUEST_EVENT, (event) => {
      void handle(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Settle diffs the person has decided on. Runs whenever the open-file list
  // or any buffer changes, which is exactly when a decision can happen: they
  // saved (buffer matches disk again) or they closed the tab (it's gone).
  useEffect(() => {
    if (pendingRef.current.size === 0) return;
    for (const [id, pending] of [...pendingRef.current]) {
      const file = store.files.find((f) => f.path === pending.path);
      const outcome = diffOutcomeFor(file);
      if (!outcome) continue;
      pendingRef.current.delete(id);
      tabPathsRef.current.delete(pending.tabName);
      clearAgentDiffBase(pending.path);
      void respond(id, outcome);
    }
  }, [store.files]);
}
