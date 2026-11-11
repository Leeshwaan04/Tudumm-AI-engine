// Signed-in state. The session itself is an HttpOnly cookie set by the Worker; this module only
// mirrors GET /api/v1/me and switches the profile / watchlist / tracking stores between the
// guest copy (localStorage) and the account (server, optimistic with rollback).
import { useSyncExternalStore } from "react";
import { ApiError, errorText, onAuthSignal } from "./client";
import { authApi, meApi, profileApi, syncApi, trackedApi, watchlistApi } from "./endpoints";
import type { Me } from "./types";
import { clearCache } from "./useApi";
import { track } from "./events";
import { DEFAULT_PROFILE, profileStore, storage, toServerProfile, trackingStore, watchlistStore, type Profile } from "../engine/profile";
import { getInstrument } from "../engine/universe";
import { isTrade } from "../engine/types";
import { toast } from "../components/ui";

export type SessionStatus = "unknown" | "signed_out" | "signed_in" | "suspended";
export interface SessionState {
  status: SessionStatus;
  me: Me | null;
}

let state: SessionState = { status: "unknown", me: null };
const listeners = new Set<() => void>();
function set(next: SessionState) {
  state = next;
  listeners.forEach((l) => l());
}
export function getSession(): SessionState {
  return state;
}
export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/* ---------------- sign-in sheet open state (any component can ask for it) ---------------- */
interface SheetState {
  open: boolean;
  reason: string | null;
}
let sheet: SheetState = { open: false, reason: null };
const sheetListeners = new Set<() => void>();
export function openSignIn(reason: string | null = null) {
  sheet = { open: true, reason };
  sheetListeners.forEach((l) => l());
}
export function closeSignIn() {
  sheet = { open: false, reason: null };
  sheetListeners.forEach((l) => l());
}
export function useSignInSheet(): SheetState {
  return useSyncExternalStore(
    (l) => {
      sheetListeners.add(l);
      return () => sheetListeners.delete(l);
    },
    () => sheet,
  );
}

/* ---------------- store wiring ---------------- */
const onPushError = (err: unknown) => {
  toast(`Couldn't save: ${errorText(err)}`);
};

function trackItems(symbols: string[]) {
  return symbols.map((symbol) => {
    const inst = getInstrument(symbol);
    const sid = inst?.signal.live && isTrade(inst.signal) ? inst.signal.id : null;
    return { symbol, signalId: sid };
  });
}

async function attachStores(me: Me) {
  const [w, t] = await Promise.all([watchlistApi.get().catch(() => null), trackedApi.get().catch(() => null)]);
  const prof: Profile = me.profile ? ({ ...DEFAULT_PROFILE, ...(me.profile as unknown as Partial<Profile>) } as Profile) : { ...DEFAULT_PROFILE };
  profileStore.attach(prof, async (_prev, next) => (await profileApi.put(toServerProfile(next))).profile as unknown as Profile, onPushError);
  watchlistStore.attach(w?.symbols ?? [], async (_prev, next) => (await watchlistApi.put(next)).symbols, onPushError);
  trackingStore.attach(t?.symbols ?? [], async (_prev, next) => (await trackedApi.put(trackItems(next))).symbols, onPushError);
}

function detachStores() {
  profileStore.detach();
  watchlistStore.detach();
  trackingStore.detach();
}

const SYNCED_KEY = "tudumm.synced.v1";
function syncedUsers(): string[] {
  try {
    const v = JSON.parse(storage.get(SYNCED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** One-shot merge of guest localStorage into the account (first sign-in from this browser). */
async function syncGuest(userId: string): Promise<boolean> {
  if (syncedUsers().includes(userId)) return false;
  const gp = profileStore.guest();
  const gw = watchlistStore.guest();
  const gt = trackingStore.guest();
  const hasProfile = gp.onboarded;
  if (!hasProfile && !gw.length && !gt.length) {
    storage.set(SYNCED_KEY, JSON.stringify([...syncedUsers(), userId].slice(-20)));
    return false;
  }
  try {
    await syncApi.run({
      profile: hasProfile ? toServerProfile(gp) : undefined,
      watchlist: gw,
      tracked: trackItems(gt),
    });
    storage.set(SYNCED_KEY, JSON.stringify([...syncedUsers(), userId].slice(-20)));
    return true;
  } catch {
    return false;
  }
}

/* ---------------- lifecycle ---------------- */
export async function refreshMe(): Promise<Me | null> {
  try {
    const me = await meApi.get(true);
    set({ status: "signed_in", me });
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403 && err.code === "account_suspended") {
      set({ status: "suspended", me: null });
      detachStores();
    } else if (err instanceof ApiError && (err.status === 401 || err.unreachable || err.status === 404)) {
      if (state.status === "signed_in") detachStores();
      set({ status: "signed_out", me: null });
    } else if (state.status === "unknown") {
      set({ status: "signed_out", me: null });
    }
    return null;
  }
}

async function boot() {
  const me = await refreshMe();
  if (me) await attachStores(me);
}
if (typeof window !== "undefined") void boot();

/** Called by the sign-in sheet after POST /auth/verify succeeded (cookie now set). */
export async function completeSignIn(isNew: boolean): Promise<Me | null> {
  const meFirst = await meApi.get(true).catch(() => null);
  if (!meFirst) {
    set({ status: "signed_out", me: null });
    return null;
  }
  const merged = await syncGuest(meFirst.user.id);
  const me = merged ? ((await meApi.get(true).catch(() => meFirst)) ?? meFirst) : meFirst;
  await attachStores(me);
  set({ status: "signed_in", me });
  track("login", { isNew, synced: merged });
  if (merged) toast("Signed in · your guest watchlist, tracking and profile were merged into your account");
  return me;
}

export async function signOut(opts: { all?: boolean; silent?: boolean } = {}) {
  track("logout");
  try {
    if (opts.all) await authApi.logoutAll();
    else await authApi.logout();
  } catch {
    /* the cookie may already be gone; sign out locally anyway */
  }
  detachStores();
  clearCache("me:");
  set({ status: "signed_out", me: null });
  if (!opts.silent) toast("Signed out");
}

/** Local-only sign-out after the account was deleted (the server cleared the cookie). */
export function signedOutLocally(message?: string) {
  detachStores();
  clearCache("me:");
  set({ status: "signed_out", me: null });
  if (message) toast(message);
}

export function patchMe(next: Partial<Me>) {
  if (state.me) set({ ...state, me: { ...state.me, ...next } });
}

onAuthSignal((sig) => {
  if (sig === "unauthorized" && state.status === "signed_in") {
    detachStores();
    clearCache("me:");
    set({ status: "signed_out", me: null });
    toast("Your session ended — sign in again");
    openSignIn("Your session ended. Sign in again to keep your watchlist and alerts in sync.");
  }
  if (sig === "suspended") {
    detachStores();
    set({ status: "suspended", me: null });
  }
});
