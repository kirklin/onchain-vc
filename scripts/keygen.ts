import { appendFileSync } from "node:fs";
import process from "node:process";
import { isHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { envFile } from "./lib/env.ts";

// Creates the keys a live deployment needs and stores them in .env. Running it again only
// prints the addresses. Keys are never printed.

const existing = process.env.OPERATOR_PRIVATE_KEY;
if (existing !== undefined && existing !== "") {
  if (!isHex(existing)) {
    throw new Error("OPERATOR_PRIVATE_KEY in .env is not a hex string.");
  }
  console.log(`Operator address: ${privateKeyToAccount(existing).address}`);
} else {
  const key = generatePrivateKey();
  appendFileSync(envFile, `OPERATOR_PRIVATE_KEY=${key}\n`);
  console.log(`Wrote a new OPERATOR_PRIVATE_KEY to ${envFile}`);
  console.log(`Operator address: ${privateKeyToAccount(key).address}`);
}

console.log("The operator deploys the contracts and pays for the relayer and the faucet. Fund it before deploying to a live network.");
