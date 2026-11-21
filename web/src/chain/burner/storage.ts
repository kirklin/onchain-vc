import type { Hex } from "viem";
import { isHex } from "viem";
import { generatePrivateKey } from "viem/accounts";

const KEY = "onchain-vc.burner-key";
const CONNECTED = "onchain-vc.burner-connected";

function loadBurnerKey(): Hex | undefined {
  const stored = window.localStorage.getItem(KEY);
  return stored !== null && isHex(stored) && stored.length === 66 ? stored : undefined;
}

/** Returns the key kept in this browser, creating one on first use. */
export function ensureBurnerKey(): Hex {
  const existing = loadBurnerKey();
  if (existing !== undefined) {
    return existing;
  }
  const key = generatePrivateKey();
  window.localStorage.setItem(KEY, key);
  return key;
}

/**
 * Whether the visitor chose the burner wallet and has not disconnected it since. Only then
 * may a page load bring the connection back on its own.
 */
export function wasBurnerConnected(): boolean {
  return window.localStorage.getItem(CONNECTED) === "true" && loadBurnerKey() !== undefined;
}

export function rememberBurnerConnected(connected: boolean) {
  if (connected) {
    window.localStorage.setItem(CONNECTED, "true");
  } else {
    window.localStorage.removeItem(CONNECTED);
  }
}
