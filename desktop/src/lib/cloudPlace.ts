// Where the app is: your own machine, or your organization's cloud.
//
// The cloud place swaps the sidebar and the page for the cloud's own — Home,
// Dashboard, Routines and setup — the way choosing the organization in the
// account menu does. One store, so the account menu, the sidebar and the page
// agree without passing it down through App.

import { useSyncExternalStore } from "react";

export type CloudPage = "home" | "dashboard" | "routines" | "onboarding" | "workspace";

export type CloudPlaceState = {
  open: boolean;
  page: CloudPage;
  /** The teammates Home is narrowed to, from the sidebar's Team group. */
  owners: string[];
  /** The row open on the workspace page, as Home knows it (`cws:` / `cloud:`). */
  workspaceId: string | null;
  /** The create dialog is up. */
  creating: boolean;
  /** One line in the page's notice bar: what just happened, or why it couldn't. */
  notice: string;
  /** The repository picked first in setup, which Create starts on. */
  defaultRepo: string | null;
};

let state: CloudPlaceState = {
  open: false,
  page: "home",
  owners: [],
  workspaceId: null,
  creating: false,
  notice: "",
  defaultRepo: null,
};
const listeners = new Set<() => void>();

function set(next: CloudPlaceState) {
  state = next;
  for (const l of listeners) l();
}

export function openCloud(page: CloudPage = "home", owners: string[] = []) {
  set({ ...state, open: true, page, owners, workspaceId: null });
}

export function setCloudPage(page: CloudPage) {
  set({
    ...state,
    open: true,
    page,
    owners: page === "home" ? state.owners : [],
    workspaceId: page === "workspace" ? state.workspaceId : null,
  });
}

/** Open one row on the workspace page, keeping the cloud sidebar. */
export function openCloudWorkspace(id: string) {
  set({ ...state, open: true, page: "workspace", workspaceId: id });
}

/** The one teammate Home is narrowed to, when it is: what a Team row opens,
 *  and what keeps that row selected. */
export function workOf(s: CloudPlaceState): string | null {
  return s.page === "home" && s.owners.length === 1 ? (s.owners[0] ?? null) : null;
}

export function setCloudCreating(creating: boolean) {
  set({ ...state, creating });
}

export function setCloudNotice(notice: string) {
  set({ ...state, notice });
}

/** Whether the cloud's own page covers the work area. A job thread opened from
 *  Home is read in the work area itself, beside the cloud sidebar. */
export function cloudCoversWork(s: CloudPlaceState): boolean {
  return s.open && !(s.page === "workspace" && !!s.workspaceId?.startsWith("cloud:"));
}

/** Whether this laptop's terminal dock shows. The cloud place is the
 *  organization's machines, not this one: a shell docked under its pages
 *  would be a prompt on the wrong computer. Only the showing is gated — the
 *  open/closed choice is kept, so the dock is back as it was on leaving. */
export function localTerminalShown(terminalOpen: boolean, s: CloudPlaceState): boolean {
  return terminalOpen && !s.open;
}

export function setCloudDefaultRepo(defaultRepo: string | null) {
  set({ ...state, defaultRepo });
}

export function setCloudOwners(owners: string[]) {
  set({ ...state, owners });
}

export function leaveCloud() {
  set({ ...state, open: false, owners: [], workspaceId: null, creating: false, notice: "" });
}

export function cloudPlaceNow(): CloudPlaceState {
  return state;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCloudPlace(): CloudPlaceState {
  return useSyncExternalStore(subscribe, cloudPlaceNow, cloudPlaceNow);
}

/** `aura:open-cloud` with `{ page }` — how anything outside the store enters. */
export const OPEN_CLOUD_EVENT = "aura:open-cloud";

export function listenForOpenCloud(): () => void {
  const on = (e: Event) => {
    const page = (e as CustomEvent<{ page?: CloudPage }>).detail?.page;
    openCloud(page ?? "home");
  };
  window.addEventListener(OPEN_CLOUD_EVENT, on);
  return () => window.removeEventListener(OPEN_CLOUD_EVENT, on);
}
