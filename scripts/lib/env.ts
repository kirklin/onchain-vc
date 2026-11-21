import type { Address, Hex } from "viem";
import type { NetworkName } from "../../web/src/chain/networks.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isNetworkName, LOCAL_INVESTOR_KEY, LOCAL_OPERATOR_KEY, LOCAL_PARTNER_KEYS, networks, parseNetworkNames, rpcUrlsVariable } from "../../web/src/chain/networks.ts";

export const rootDir = path.join(import.meta.dirname, "..", "..");
export const contractsDir = path.join(rootDir, "contracts");
export const envFile = path.join(rootDir, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** The networks the app is configured to offer, default first. */
export function enabledNetworks(): NetworkName[] {
  return parseNetworkNames(process.env.NEXT_PUBLIC_NETWORKS);
}

/** The network named on the command line, or the app's default one. */
export function resolveNetwork(argument: string | undefined): NetworkName {
  if (argument === undefined) {
    return enabledNetworks()[0]!;
  }
  if (!isNetworkName(argument)) {
    throw new Error(`Unknown network "${argument}". Use any of: ${Object.keys(networks).join(", ")}`);
  }
  return argument;
}

export function rpcUrl(name: NetworkName): string {
  const override = process.env[rpcUrlsVariable(name)]?.split(",")[0]?.trim();
  return override === undefined || override === "" ? networks[name].chain.rpcUrls.default.http[0] : override;
}

function isKey(value: string): value is Hex {
  return isHex(value) && value.length === 66;
}

export function operatorKey(name: NetworkName): Hex {
  const key = process.env.OPERATOR_PRIVATE_KEY;
  if (key === undefined || key === "") {
    if (name === "local") {
      return LOCAL_OPERATOR_KEY;
    }
    throw new Error("OPERATOR_PRIVATE_KEY is not set. Run `pnpm keygen`, then fund the printed address.");
  }
  if (!isKey(key)) {
    throw new Error("OPERATOR_PRIVATE_KEY must be a 32-byte hex string starting with 0x.");
  }
  return key;
}

/** The four partners' keys in seat order: product, technology, tokenomics, risk. */
export function partnerKeys(name: NetworkName): Hex[] {
  const value = process.env.PARTNER_KEYS;
  if (value === undefined || value === "") {
    if (name === "local") {
      return [...LOCAL_PARTNER_KEYS];
    }
    throw new Error("PARTNER_KEYS is not set. Run `pnpm keygen`.");
  }
  const keys = value.split(",").map(key => key.trim());
  if (keys.length !== 4 || !keys.every(isKey)) {
    throw new Error("PARTNER_KEYS must be four 32-byte hex strings starting with 0x, separated by commas.");
  }
  return keys;
}

/** Who receives the shares of the fund's first deposit, and with them the say over vetoes. */
export function investor(name: NetworkName): Address {
  const value = process.env.INVESTOR;
  if (value === undefined || value === "") {
    if (name === "local") {
      return privateKeyToAccount(LOCAL_INVESTOR_KEY).address;
    }
    throw new Error("INVESTOR is not set. Set it to the address of the wallet that will speak for the fund's investors.");
  }
  if (!isAddress(value)) {
    throw new Error("INVESTOR must be an address.");
  }
  return value;
}

export function deploymentFile(chainId: number) {
  return path.join(contractsDir, "deployments", `${chainId}.json`);
}
