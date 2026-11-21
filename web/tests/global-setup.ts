import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { installCanonical } from "../../scripts/lib/canonical.ts";
import { ANVIL_PORT, ANVIL_URL } from "./helpers";

const contractsDir = path.join(import.meta.dirname, "..", "..", "contracts");

function isListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: ANVIL_PORT });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Builds the contracts and runs a throwaway Anvil for the whole test run. */
export default async function setup() {
  execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "inherit" });

  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--block-time", "0.1"], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  while (!(await isListening())) {
    if (Date.now() > deadline) {
      anvil.kill();
      throw new Error(`Anvil did not start on port ${ANVIL_PORT}.`);
    }
    await sleep(50);
  }
  await installCanonical(ANVIL_URL);

  return () => {
    anvil.kill();
  };
}
