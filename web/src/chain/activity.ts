import type { Address, Hash } from "viem";
import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * A transaction the visitor sent from this browser. Kept in localStorage per chain and
 * account, so the list, and anything still waiting, survives a reload.
 */
export interface Activity {
  hash: Hash;
  /** What the transaction does, in the visitor's words at the time: "Transfer tUSD". */
  title: string;
  /** Unix milliseconds. */
  submittedAt: number;
  /** `replaced` means another transaction from the account took this one's nonce. */
  status: "pending" | "confirmed" | "reverted" | "replaced";
  /**
   * The sender and nonce, which is what lets a waiting transaction be followed and
   * replaced. Absent when someone else sent it for the visitor, as the relayer does.
   */
  sender?: { from: Address; nonce: number };
}

const schema = z.array(z.object({
  hash: z.string(),
  title: z.string(),
  submittedAt: z.number(),
  status: z.enum(["pending", "confirmed", "reverted", "replaced"]),
  sender: z.object({ from: z.string(), nonce: z.number() }).optional(),
}));

const LIMIT = 30;
const CHANGED = "onchain-vc.activity-changed";
const EMPTY: Activity[] = [];

function keyOf(chainId: number, account: Address): string {
  return `onchain-vc.activity.${chainId}.${account.toLowerCase()}`;
}

function parse(stored: string | null): Activity[] {
  if (stored === null) {
    return EMPTY;
  }
  const parsed = schema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data as Activity[] : EMPTY;
}

function save(key: string, list: Activity[]) {
  window.localStorage.setItem(key, JSON.stringify(list.slice(0, LIMIT)));
  window.dispatchEvent(new Event(CHANGED));
}

export function readActivity(chainId: number, account: Address): Activity[] {
  return parse(window.localStorage.getItem(keyOf(chainId, account)));
}

/** Puts a transaction at the top of the account's list. */
export function addActivity(chainId: number, account: Address, entry: Activity) {
  const key = keyOf(chainId, account);
  save(key, [entry, ...readActivity(chainId, account).filter(existing => existing.hash !== entry.hash)]);
}

export function setActivityStatus(chainId: number, account: Address, hash: Hash, status: Activity["status"]) {
  const key = keyOf(chainId, account);
  save(key, readActivity(chainId, account).map(entry => (entry.hash === hash ? { ...entry, status } : entry)));
}

// Transactions sent since this page loaded. Whoever sent them is already telling the
// visitor how they went, so the watcher only speaks up for the ones it picked up later.
const sentHere = new Set<Hash>();

export function markSentHere(hash: Hash) {
  sentHere.add(hash);
}

export function wasSentHere(hash: Hash): boolean {
  return sentHere.has(hash);
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/** The account's transactions on a chain, newest first, updating as they are sent and settle. */
export function useActivity(chainId: number, account: Address | undefined): Activity[] {
  const key = account === undefined ? undefined : keyOf(chainId, account);
  const stored = useSyncExternalStore(
    subscribe,
    () => (key === undefined ? null : window.localStorage.getItem(key)),
    () => null,
  );
  return useMemo(() => parse(stored), [stored]);
}
