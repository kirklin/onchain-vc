import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import process from "node:process";
import { isAnvilListening, startAnvil, waitForAnvil } from "./anvil.ts";
import { installCanonical } from "./canonical.ts";
import { deploy, isDeployed } from "./deploy.ts";
import { enabledNetworks, rootDir, rpcUrl } from "./env.ts";

const children: ChildProcess[] = [];

function shutdown(code: number) {
  for (const child of children) {
    child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/**
 * Starts the local chain and deploys to it when the app is configured to use it and that
 * has not happened yet. Live networks must be deployed to deliberately, with
 * `pnpm deploy:contracts <network>`.
 */
export async function ensureLocalChain() {
  if (!enabledNetworks().includes("local")) {
    return;
  }
  if (!(await isAnvilListening())) {
    const anvil = startAnvil("ignore");
    children.push(anvil);
    anvil.once("exit", code => shutdown(code ?? 1));
    await waitForAnvil();
  }
  await installCanonical(rpcUrl("local"));
  if (!(await isDeployed("local"))) {
    deploy("local");
  }
}

/** Runs a script of the web package and resolves once it exits successfully. */
export function runWeb(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["--filter", "@onchain-vc/web", script], { cwd: rootDir, stdio: "inherit" });
    children.push(child);
    child.once("exit", (code) => {
      if (code !== 0) {
        shutdown(code ?? 1);
      }
      resolve();
    });
  });
}

export function finish() {
  shutdown(0);
}
