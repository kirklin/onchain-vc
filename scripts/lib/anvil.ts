import type { ChildProcess, StdioOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { networks } from "../../web/src/chain/networks.ts";

const url = new URL(networks.local.chain.rpcUrls.default.http[0]);
const port = Number(url.port);

/**
 * Starts the local chain. ANVIL_ARGS adds flags, for example `--network monad` to run under
 * Monad's rules or `--fork-url <rpc>` to start from a live chain's state.
 */
export function startAnvil(stdio: StdioOptions): ChildProcess {
  const extra = (process.env.ANVIL_ARGS ?? "").split(" ").filter(argument => argument !== "");
  return spawn("anvil", ["--port", String(port), ...extra], { stdio });
}

export function isAnvilListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function waitForAnvil(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await isAnvilListening())) {
    if (Date.now() > deadline) {
      throw new Error(`Anvil did not start listening on port ${port} within ${timeoutMs} ms.`);
    }
    await sleep(100);
  }
}
