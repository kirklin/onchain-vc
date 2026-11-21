import type { Address, Hex } from "viem";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestClient, http, publicActions } from "viem";

const canonicalDir = path.join(import.meta.dirname, "..", "..", "contracts", "canonical");

/**
 * Contracts every live chain already has at the same address. Their runtime code is kept in
 * contracts/canonical and written into the local chain, so code that relies on them runs
 * locally the way it runs in production.
 */
export const CANONICAL: Record<string, Address> = {
  Multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  Permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

/** Writes the canonical contracts into an Anvil chain. Safe to repeat. */
export async function installCanonical(rpcUrl: string) {
  const client = createTestClient({ mode: "anvil", transport: http(rpcUrl) }).extend(publicActions);

  for (const [name, address] of Object.entries(CANONICAL)) {
    const existing = await client.getCode({ address });
    if (existing !== undefined && existing !== "0x") {
      continue;
    }
    const bytecode = readFileSync(path.join(canonicalDir, `${name}.hex`), "utf8").trim() as Hex;
    await client.setCode({ address, bytecode });
  }
}
