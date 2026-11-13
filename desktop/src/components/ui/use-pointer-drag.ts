// Drag to reorder, driven by pointer events instead of HTML5 drag and drop.
//
// The desktop app runs with Tauri's native drag-drop handler on
// (`dragDropEnabled`), because that is the only way a file dropped from the
// Finder arrives with its absolute path. On macOS that handler is wry's
// override of the web view's NSDraggingDestination methods
// (`draggingEntered:`, `draggingUpdated:`, `performDragOperation:`), and
// Tauri's callback always claims the drag, so wry never forwards it to
// WebKit. WebKit is therefore never told a drag is over the page: no
// `dragenter`, no `dragover`, no `drop` — for an in-page drag exactly as for
// a Finder one. Only `dragstart` and `dragend`, which belong to the drag's
// source, still reach the page. On top of that, WebKit starts drag tracking
// on mousedown over a `draggable` element and then never sends its `click`.
//
// So an HTML5 reorder there picks up and never lands, and the click on the
// same element is lost. Pointer events come through the web view's ordinary
// mouse handling, which wry leaves alone, so a reorder built on them behaves
// the same in the desktop app as in a browser. Nothing here is `draggable`,
// so no native drag session ever starts to take the events away.
//
// A press becomes a drag once it has moved a few pixels; a press that does
// not is left alone and clicks as usual. While dragging, a copy of the
// pressed element follows the pointer (the picture a native drag would have
// shown), whatever target is under the pointer is reported as `over`, and
// releasing there calls `onDrop`. Escape, or releasing anywhere else,
// cancels. The click a drag's release would produce is swallowed, so dropping
// a button does not also press it.
//
// Sources and targets meet through a scope. `usePointerDrag` makes one for a
// list that keeps its sources and targets together; a drag that crosses
// components (a tab carried to another pane) names a shared scope instead,
// marks its targets with `dropTarget`, and any component can follow it with
// `usePointerDragState`.

import { useCallback, useEffect, useId, useRef, useSyncExternalStore, type PointerEvent } from "react";

/** How far a press has to travel, in CSS pixels, before it is a drag. */
export const DRAG_THRESHOLD = 4;

export interface DragPoint {
  x: number;
  y: number;
}

/** Whether a press that started at `start` and is now at `now` has become a
 *  drag. A short wobble during a click stays a click. */
export function isDragMove(start: DragPoint, now: DragPoint, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= threshold;
}

/** The node shape the target lookup walks: enough of an element to test. */
export interface DropNode {
  dataset?: DOMStringMap;
  parentElement: DropNode | null;
}

/** The nearest element `node` sits in that is marked as a target of the drag
 *  `scope`. A release over a target's child lands on the target, and a target
 *  of another list on the same page is never hit. */
export function dropNodeFrom<N extends DropNode>(node: N | null, scope: string): N | undefined {
  for (let at: DropNode | null = node; at; at = at.parentElement) {
    if (at.dataset?.pointerDropScope === scope) return at as N;
  }
  return undefined;
}

/** The name of the target `node` sits in for the drag `scope`, or undefined. */
export function dropTargetFrom(node: DropNode | null, scope: string): string | undefined {
  return dropNodeFrom(node, scope)?.dataset?.pointerDrop;
}

/** Props that make an element the target named `key` for drags in `scope`. */
export function dropTarget(scope: string, key: string): { "data-pointer-drop-scope": string; "data-pointer-drop": string } {
  return { "data-pointer-drop-scope": scope, "data-pointer-drop": key };
}

/** Where the pointer is during a drag, and the target element under it, if
 *  any — enough to tell a target's near half from its far one. */
export interface DragAt extends DragPoint {
  element?: HTMLElement;
}

/** Where a drag was released: on a target, so the element is always there. */
export interface DropAt extends DragPoint {
  element: HTMLElement;
}

// The drag in progress. There is one pointer, so there is at most one; a new
// object for every change, so a reader can tell a change by identity.
interface Active {
  scope: string;
  item: unknown;
  over: string | undefined;
}
let active: Active | undefined;
const watchers = new Set<() => void>();

function setActive(next: Active | undefined): void {
  active = next;
  for (const watcher of watchers) watcher();
}

function watch(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export interface DragState<T> {
  /** The item being dragged in this scope, once a press has become a drag. */
  dragged: T | undefined;
  /** The target in this scope under the pointer while dragging. */
  over: string | undefined;
}

/** The drag in `scope`, from any component: a target can light up while a
 *  source somewhere else is carried over it. */
export function usePointerDragState<T>(scope: string): DragState<T> {
  const now = useSyncExternalStore(
    watch,
    () => (active?.scope === scope ? active : undefined),
    () => undefined,
  );
  return { dragged: now?.item as T | undefined, over: now?.over };
}

/** Controls a press inside a source may hold that keep their own click (a
 *  remove button on a draggable card, say). */
const OWN_PRESS = "button, a[href], input, select, textarea, [role='button'], [contenteditable='true']";

/** The picture that follows the pointer: a copy of the pressed element,
 *  kept beside it so the same rules style it, fixed over where it was. */
function lift(source: HTMLElement): { move: (dx: number, dy: number) => void; drop: () => void } {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  for (const named of ghost.querySelectorAll("[id]")) named.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    boxSizing: "border-box",
    pointerEvents: "none",
    opacity: "0.8",
    zIndex: "2147483647",
  });
  (source.parentElement ?? document.body).appendChild(ghost);
  // A transformed ancestor makes `fixed` relative to itself rather than the
  // window. Measure where the copy actually landed and correct once.
  const placed = ghost.getBoundingClientRect();
  ghost.style.left = `${2 * rect.left - placed.left}px`;
  ghost.style.top = `${2 * rect.top - placed.top}px`;
  return {
    move: (dx, dy) => {
      ghost.style.transform = `translate(${dx}px, ${dy}px)`;
    },
    drop: () => ghost.remove(),
  };
}

export interface PointerDragOptions<T> {
  /** Where the targets this drag can land on are marked. */
  scope: string;
  /** What is being carried. */
  item: T;
  /** Runs on every move once the press is a drag, with the target under the
   *  pointer (undefined over empty space). */
  onMove?: (key: string | undefined, at: DragAt) => void;
  /** Runs when the drag is released over a target. */
  onDrop: (key: string, at: DropAt) => void;
}

/** Follow a press on `event.currentTarget`: if it travels far enough it is a
 *  drag of `item`, otherwise it is left to click. Call from `onPointerDown`.
 *  Returns a function that abandons the press or drag, for a source that
 *  goes away mid-drag. */
export function startPointerDrag<T>(
  event: PointerEvent<HTMLElement>,
  { scope, item, onMove, onDrop }: PointerDragOptions<T>,
): () => void {
  if (event.button !== 0 || !event.isPrimary) return none;
  const element = event.currentTarget;
  const own = (event.target as Element).closest?.(OWN_PRESS);
  if (own && own !== element && element.contains(own)) return none;
  abandon?.();
  const start = { x: event.clientX, y: event.clientY };
  const pointer = event.pointerId;
  let ghost: ReturnType<typeof lift> | undefined;
  let hovered: string | undefined;
  const at = (x: number, y: number) => {
    const node = dropNodeFrom(document.elementFromPoint(x, y) as HTMLElement | null, scope);
    return { key: node?.dataset.pointerDrop, element: node };
  };
  const finish = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", finish, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("dragstart", refuse, true);
    window.removeEventListener("selectstart", refuse, true);
    ghost?.drop();
    if (element.hasPointerCapture?.(pointer)) element.releasePointerCapture(pointer);
    if (ghost) setActive(undefined);
    ghost = undefined;
    if (abandon === finish) abandon = undefined;
  };
  const move = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const now = { x: e.clientX, y: e.clientY };
    if (!ghost) {
      if (!isDragMove(start, now)) return;
      ghost = lift(element);
      window.addEventListener("selectstart", refuse, true);
      window.getSelection()?.removeAllRanges();
      try {
        element.setPointerCapture(pointer);
      } catch {
        /* the pointer is already gone; `up` or `cancel` will finish */
      }
      setActive({ scope, item, over: undefined });
    }
    ghost.move(now.x - start.x, now.y - start.y);
    const target = at(now.x, now.y);
    if (target.key !== hovered) {
      hovered = target.key;
      setActive({ scope, item, over: target.key });
    }
    onMove?.(target.key, { ...now, element: target.element });
  };
  const up = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const dropped = ghost ? at(e.clientX, e.clientY) : undefined;
    const wasDrag = !!ghost;
    finish();
    if (!wasDrag) return;
    // The release still produces a click on the element that was pressed;
    // it belongs to the drag, not to the element.
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (dropped?.key !== undefined && dropped.element) {
      onDrop(dropped.key, { x: e.clientX, y: e.clientY, element: dropped.element });
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !ghost) return;
    e.preventDefault();
    e.stopPropagation();
    finish();
  };
  const refuse = (e: Event) => e.preventDefault();
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", finish, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("dragstart", refuse, true);
  abandon = finish;
  return finish;
}

// The press or drag being followed, so a new press replaces it.
let abandon: (() => void) | undefined;

/** What a declined press returns: there is nothing to abandon. */
const none = () => {};

export interface PointerDrag<T> extends DragState<T> {
  /** Props for an element that can be picked up as `item`. */
  source: (item: T) => { onPointerDown: (event: PointerEvent<HTMLElement>) => void };
  /** Props for an element `item` can be dropped on, named `key`. */
  target: (key: string) => { "data-pointer-drop-scope": string; "data-pointer-drop": string };
}

export interface UsePointerDragOptions<T> {
  /** A scope shared with targets in other components. Defaults to one of
   *  this list's own. */
  scope?: string;
  /** Runs on every move during a drag, with the target under the pointer. */
  onMove?: (item: T, key: string | undefined, at: DragAt) => void;
}

/** Drag `T`s onto named targets. `onDrop(item, key, at)` runs when a drag is
 *  released over a target. */
export function usePointerDrag<T>(
  onDrop: (item: T, key: string, at: DropAt) => void,
  options: UsePointerDragOptions<T> = {},
): PointerDrag<T> {
  const own = useId();
  const scope = options.scope ?? own;
  const latest = useRef({ onDrop, onMove: options.onMove });
  latest.current = { onDrop, onMove: options.onMove };
  const end = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => end.current?.(), []);
  const { dragged, over } = usePointerDragState<T>(scope);

  const source = useCallback(
    (item: T) => ({
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const finish = startPointerDrag(event, {
          scope,
          item,
          onMove: (key, at) => latest.current.onMove?.(item, key, at),
          onDrop: (key, at) => latest.current.onDrop(item, key, at),
        });
        // A press this source declines (one on its own button, say) can
        // reach it after a handle has already lifted it; keep that drag's
        // cancel rather than trade it for one that cancels nothing.
        if (finish !== none) end.current = finish;
      },
    }),
    [scope],
  );

  const target = useCallback((key: string) => dropTarget(scope, key), [scope]);

  return { dragged, over, source, target };
}
