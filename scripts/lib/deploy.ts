import type { Address } from "viem";
import type { Network, NetworkName } from "../../web/src/chain/networks.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createPublicClient, http } from "viem";
import { networks } from "../../web/src/chain/networks.ts";
import { contractsDir, deploymentFile, operatorKey, rootDir, rpcUrl } from "./env.ts";

/** Broadcasts script/Deploy.s.sol, then regenerates the typed ABIs and addresses for the web app. */
export function deploy(name: NetworkName) {
  const network: Network = networks[name];
  const args = ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl(name), "--broadcast"];
  if (name !== "local") {
    args.push("--verify", "--verifier", "sourcify");
    if (network.verifierUrl !== undefined) {
      args.push("--verifier-url", network.verifierUrl);
    }
  }

  execFileSync("forge", args, {
    cwd: contractsDir,
    stdio: "inherit",
    env: { ...process.env, OPERATOR_PRIVATE_KEY: operatorKey(name) },
  });
  execFileSync("pnpm", ["--filter", "@onchain-vc/web", "generate"], { cwd: rootDir, stdio: "inherit" });
}

/** Whether every address recorded for the network still has code on chain. */
export async function isDeployed(name: NetworkName): Promise<boolean> {
  const { chain } = networks[name];
  const file = deploymentFile(chain.id);
  if (!existsSync(file)) {
    return false;
  }

  const deployment = JSON.parse(readFileSync(file, "utf8")) as { contracts: Record<string, Address> };
  const addresses = Object.values(deployment.contracts);
  const client = createPublicClient({ chain, transport: http(rpcUrl(name)) });
  const codes = await Promise.all(addresses.map(address => client.getCode({ address })));
  return codes.every(code => code !== undefined && code !== "0x");
}
