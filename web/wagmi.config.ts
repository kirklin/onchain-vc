import type { Plugin } from "@wagmi/cli";
import type { Address } from "viem";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

const contractsDir = path.join(import.meta.dirname, "..", "contracts");
const deploymentsDir = path.join(contractsDir, "deployments");

/** What script/Deploy.s.sol writes to contracts/deployments/<chainId>.json. */
interface Deployment {
  block: number;
  contracts: Record<string, Address>;
}

// Everything in contracts/src, plus the interface the app talks to.
const contractNames = [
  ...readdirSync(path.join(contractsDir, "src"))
    .filter(file => file.endsWith(".sol"))
    .map(file => path.basename(file, ".sol")),
  "IPermit2",
];

const addresses: Record<string, Record<number, Address>> = {};
const blocks: Record<number, number> = {};
for (const file of readdirSync(deploymentsDir).filter(name => name.endsWith(".json"))) {
  const chainId = Number(path.basename(file, ".json"));
  const deployment = JSON.parse(readFileSync(path.join(deploymentsDir, file), "utf8")) as Deployment;
  blocks[chainId] = deployment.block;
  for (const [name, address] of Object.entries(deployment.contracts)) {
    addresses[name] = { ...addresses[name], [chainId]: address };
  }
}

function artifacts() {
  return foundry({
    project: contractsDir,
    include: contractNames.map(name => `${name}.sol/${name}.json`),
    deployments: addresses,
  });
}

/** Adds the block each chain's contracts were first deployed at, where an indexer starts reading. */
function deploymentBlocks(): Plugin {
  return {
    name: "deployment-blocks",
    run: async () => ({
      content: [
        "/** The block the contracts were first deployed at, per chain. */",
        `export const deploymentBlock = ${JSON.stringify(blocks, null, 2)} as const`,
      ].join("\n"),
    }),
  };
}

// ABIs and addresses, safe to import from server code. Pages read through wagmi's own hooks with these.
export default defineConfig({ out: "src/contracts/abis.ts", plugins: [artifacts(), deploymentBlocks()] });
