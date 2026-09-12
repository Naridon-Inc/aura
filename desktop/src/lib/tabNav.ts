// The keyboard's way around the tab strips: next / previous tab across every
// pane (⌘⌥→ / ⌘⌥←) and "the next tab that needs me" (⌘⌥L).
//
// The arithmetic lives in `tabCycle.ts` and `attentionNav.ts`, both pure and
// tested. This file is the one place that knows what the store looks like:
// it reads the split layout, works out which slot is raised, asks the pure
// helpers for the next one, and raises it through the same setter a click on
// a tab uses.

import { nextNeedingAttention } from "./attentionNav";
import { getManagerSession } from "./managerStore";
import {
  samePaneRef,
  treeLeafNodes,
  type AgentTab,
  type WorkPaneRef,
  type WorkSplitTree,
} from "./editorStore";
import { cycleSlot, flattenSlots, type PaneTabs, type TabSlot } from "./tabCycle";
import { isTabUnread } from "./tabUnread";

/** The slice of the editor store these moves read and write. Structural so
 *  the caller can hand in the hook's return value as-is. */
export type TabNavStore = {
  splitLayout: WorkSplitTree | null;
  activeManagerId: string | null;
  activeAgentId: string | null;
  activeTermId: string | null;
  activePath: string | null;
  agentTabs: AgentTab[];
  setActiveTabInPane: (paneId: string, index: number) => void;
};

/** What the store says is in front of the user, as a pane ref. Chat first —
 *  when a chat is active the store also remembers the last file, and the chat
 *  is the one on screen. */
function activeRef(s: TabNavStore): WorkPaneRef | null {
  if (s.activeManagerId) return { kind: "manager", id: s.activeManagerId };
  if (s.activeAgentId) return { kind: "agent", id: s.activeAgentId };
  if (s.activeTermId) return { kind: "terminal", id: s.activeTermId };
  if (s.activePath) return { kind: "file", path: s.activePath };
  return null;
}

/** Every pane's strip, in tree order. */
function paneTabs(s: TabNavStore): PaneTabs[] {
  if (!s.splitLayout) return [];
  return treeLeafNodes(s.splitLayout).map((l) => ({
    paneId: l.paneId,
    count: l.tabs.length,
    activeIndex: l.activeIndex,
  }));
}

/** The slot holding the active ref, or the raised slot of the first pane
 *  that has one when nothing in the layout matches. */
function currentSlot(s: TabNavStore): TabSlot | null {
  if (!s.splitLayout) return null;
  const leaves = treeLeafNodes(s.splitLayout);
  const ref = activeRef(s);
  if (ref) {
    for (const leaf of leaves) {
      const i = leaf.tabs.findIndex((t) => samePaneRef(t, ref));
      if (i >= 0) return { paneId: leaf.paneId, index: i };
    }
  }
  const first = leaves.find((l) => l.tabs.length > 0);
  return first ? { paneId: first.paneId, index: first.activeIndex } : null;
}

/** ⌘⌥→ / ⌘⌥←. Returns whether anything moved. */
export function cycleOpenTab(s: TabNavStore, delta: 1 | -1): boolean {
  const next = cycleSlot(paneTabs(s), currentSlot(s), delta);
  if (!next) return false;
  s.setActiveTabInPane(next.paneId, next.index);
  return true;
}

/** Whether a tab is asking for a person right now. */
export function tabNeedsAttention(s: TabNavStore, ref: WorkPaneRef): boolean {
  switch (ref.kind) {
    case "agent":
      return !!s.agentTabs.find((t) => t.sessionId === ref.id)?.attention;
    case "manager": {
      if (isTabUnread(ref.id)) return true;
      const session = getManagerSession(ref.id);
      return !!(session?.pending_question || session?.pending_plan);
    }
    default:
      return false;
  }
}

/** ⌘⌥L. Returns whether a tab was raised. */
export function jumpToAttentionTab(s: TabNavStore): boolean {
  if (!s.splitLayout) return false;
  const leaves = treeLeafNodes(s.splitLayout);
  const refs: WorkPaneRef[] = leaves.flatMap((l) => l.tabs);
  const slots = flattenSlots(paneTabs(s));
  const cur = currentSlot(s);
  const curPos = cur
    ? slots.findIndex((x) => x.paneId === cur.paneId && x.index === cur.index)
    : -1;
  const hit = nextNeedingAttention(slots.length, curPos, (i) =>
    tabNeedsAttention(s, refs[i]!),
  );
  if (hit < 0) return false;
  const slot = slots[hit]!;
  s.setActiveTabInPane(slot.paneId, slot.index);
  return true;
}
