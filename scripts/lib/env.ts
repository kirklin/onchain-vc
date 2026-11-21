import type { Hex } from "viem";
import type { NetworkName } from "../../web/src/chain/networks.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isHex } from "viem";
import { isNetworkName, LOCAL_OPERATOR_KEY, networks, parseNetworkNames, rpcUrlsVariable } from "../../web/src/chain/networks.ts";

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

export function deploymentFile(chainId: number) {
  return path.join(contractsDir, "deployments", `${chainId}.json`);
}
