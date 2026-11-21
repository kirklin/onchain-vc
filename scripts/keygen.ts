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

const partners = process.env.PARTNER_KEYS;
if (partners !== undefined && partners !== "") {
  const keys = partners.split(",").map(key => key.trim());
  if (keys.length !== 4 || !keys.every(key => isHex(key))) {
    throw new Error("PARTNER_KEYS in .env must be four hex strings separated by commas.");
  }
  console.log(`Partner addresses: ${keys.map(key => privateKeyToAccount(key as `0x${string}`).address).join(", ")}`);
} else {
  const keys = Array.from({ length: 4 }, () => generatePrivateKey());
  appendFileSync(envFile, `PARTNER_KEYS=${keys.join(",")}\n`);
  console.log(`Wrote four new PARTNER_KEYS to ${envFile}`);
  console.log(`Partner addresses: ${keys.map(key => privateKeyToAccount(key).address).join(", ")}`);
}

console.log("The operator deploys the contracts, pays for the relayer and the faucet, and tops up the partners' gas. Fund it before deploying to a live network.");
