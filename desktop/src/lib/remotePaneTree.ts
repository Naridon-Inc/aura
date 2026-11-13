// How a remote workspace arranges the tabs it is showing at once.
//
// A remote strip has always had one body: the tab in front. That is the right
// answer for a laptop, where a second terminal costs nothing and the panel can
// just make one — and the wrong answer for a box, where the tabs are long-lived
// sessions someone started on purpose and the reason you are looking at the
// machine at all is usually to watch two of them. An agent is working in one
// session while a build runs in another; a file tree is open beside the agent
// that is editing those files. Flipping between tabs to supervise is the thing
// the split exists to stop.
//
// So the tree here is NOT the local one. `editorStore`'s `WorkSplitTree` has
// per-leaf tab lists, pane ids, drag weights and a 6-pane cap, because locally a
// pane is a container you keep putting things into. Here a pane is a tab that is
// already open — the leaves are tab ids, nothing else — and the arrangement is a
// view of the strip rather than a second place tabs can live. That keeps one
// list of what is open on a box (the strip) and makes the layout a question of
// which of them are on screen together, so a tab can never be "in a pane" and
// missing from the strip.
//
// Pure on purpose: no React, no storage, no BoxSession. The snapshot module
// persists what this builds and the workspace renders it.

export type RemotePaneDirection = "row" | "column";

/** Either one tab filling its space, or a split of two or more arrangements.
 *
 *  A split carries its own direction, so putting something to the right of a
 *  pane and then something below it nests rather than re-orienting everything
 *  you had. Same-direction neighbours are flattened instead (see
 *  `addPaneBeside`), because three panes asked for one at a time across a row
 *  should be thirds — not a half next to two quarters. */
export type RemotePaneTree =
  | { kind: "leaf"; tabId: string }
  | {
      kind: "split";
      direction: RemotePaneDirection;
      children: RemotePaneTree[];
    };

/** How many panes a remote body will draw.
 *
 *  Lower than the local cap of six, and deliberately: every pane here is a
 *  terminal attached to a session over the network, drawing a grid the box is
 *  streaming. Four is where a 13" laptop still gives each one enough columns
 *  for a build log to be readable, which is the whole point of looking. */
export const MAX_REMOTE_PANES = 4;

export function paneLeaf(tabId: string): RemotePaneTree {
  return { kind: "leaf", tabId };
}

/** The tab ids the tree draws, left to right and top to bottom — the order a
 *  person sees them in, so it is also the order to walk for "next pane". */
export function paneTabIds(tree: RemotePaneTree): string[] {
  return tree.kind === "leaf" ? [tree.tabId] : tree.children.flatMap(paneTabIds);
}

export function paneCount(tree: RemotePaneTree): number {
  return tree.kind === "leaf" ? 1 : tree.children.reduce((n, c) => n + paneCount(c), 0);
}

export function paneHolds(tree: RemotePaneTree, tabId: string): boolean {
  return tree.kind === "leaf"
    ? tree.tabId === tabId
    : tree.children.some((c) => paneHolds(c, tabId));
}

/** Collapse the shapes that are a split in name only.
 *
 *  A split of one child is that child — it would render as a single pane with a
 *  divider to nowhere — and it is what every removal leaves behind. Done on the
 *  way out of each rebuild rather than trusted from the input, because a blob
 *  off disk is also an input. */
function collapse(tree: RemotePaneTree): RemotePaneTree {
  if (tree.kind === "leaf") return tree;
  const children = tree.children.map(collapse);
  if (children.length === 1) return children[0];
  return { kind: "split", direction: tree.direction, children };
}

/** Put a tab beside one that is already on screen.
 *
 *  `beside` names the pane you are standing in; the new tab lands immediately
 *  after it along `direction`. Returns the input unchanged when `beside` is not
 *  in the tree or `tabId` already is — this is a layout op and a tab drawn twice
 *  would be two views of one terminal fighting over the same session. */
export function addPaneBeside(
  tree: RemotePaneTree,
  beside: string,
  tabId: string,
  direction: RemotePaneDirection,
): RemotePaneTree {
  if (tabId === beside || paneHolds(tree, tabId) || !paneHolds(tree, beside)) {
    return tree;
  }
  if (tree.kind === "leaf") {
    return { kind: "split", direction, children: [tree, paneLeaf(tabId)] };
  }
  const children: RemotePaneTree[] = [];
  for (const child of tree.children) {
    // A leaf of a split that already runs the right way gets its new
    // neighbour spliced in beside it, so the row shares the axis evenly
    // instead of growing a nested half.
    if (child.kind === "leaf" && child.tabId === beside && tree.direction === direction) {
      children.push(child, paneLeaf(tabId));
      continue;
    }
    children.push(paneHolds(child, beside) ? addPaneBeside(child, beside, tabId, direction) : child);
  }
  return collapse({ kind: "split", direction: tree.direction, children });
}

/** Take a tab off the arrangement, keeping everything else where it was.
 *
 *  Null when nothing is left to draw. One leaf is returned as a leaf, and the
 *  caller decides what a single pane means — for the strip it means no layout at
 *  all, since a body showing one tab is the plain body. */
export function removePane(
  tree: RemotePaneTree,
  tabId: string,
): RemotePaneTree | null {
  return prunePanes(tree, (id) => id !== tabId);
}

/** Keep the leaves `keep` accepts and nothing else.
 *
 *  The honest answer to a tab that is gone — closed here, or named by a blob
 *  written before it was closed somewhere else. A layout is a view OF the strip,
 *  so a leaf the strip no longer has is not a layout to repair but a pane to
 *  drop. */
export function prunePanes(
  tree: RemotePaneTree,
  keep: (tabId: string) => boolean,
): RemotePaneTree | null {
  if (tree.kind === "leaf") return keep(tree.tabId) ? tree : null;
  const children = tree.children
    .map((c) => prunePanes(c, keep))
    .filter((c): c is RemotePaneTree => c !== null);
  if (children.length === 0) return null;
  return collapse({ kind: "split", direction: tree.direction, children });
}

function isDirection(v: unknown): v is RemotePaneDirection {
  return v === "row" || v === "column";
}

/** Read an arrangement back off disk.
 *
 *  Everything is checked rather than cast: the shape is recursive, it is stored
 *  as JSON in a place the user can edit, and a bad node would otherwise reach
 *  the renderer as a pane with no tab. Leaves naming a tab the strip does not
 *  have are dropped (`known`), a tab appearing twice keeps its first place, and
 *  anything that ends up a single pane — or none — comes back null, because a
 *  layout of one is not a layout. */
export function parsePaneTree(
  value: unknown,
  known: (tabId: string) => boolean,
): RemotePaneTree | null {
  const seen = new Set<string>();
  const walk = (node: unknown): RemotePaneTree | null => {
    if (!node || typeof node !== "object") return null;
    const n = node as { kind?: unknown; tabId?: unknown; direction?: unknown; children?: unknown };
    if (n.kind === "leaf") {
      const id = typeof n.tabId === "string" ? n.tabId : "";
      if (!id || seen.has(id) || !known(id)) return null;
      seen.add(id);
      return paneLeaf(id);
    }
    if (n.kind !== "split" || !isDirection(n.direction) || !Array.isArray(n.children)) {
      return null;
    }
    const children = n.children
      .map(walk)
      .filter((c): c is RemotePaneTree => c !== null);
    if (children.length === 0) return null;
    return collapse({ kind: "split", direction: n.direction, children });
  };
  const tree = walk(value);
  return tree && paneCount(tree) > 1 ? tree : null;
}
