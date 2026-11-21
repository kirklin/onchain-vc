import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineConfig } from "vitest/config";

// The repository's .env, so tests that need an outside service's key find it where the app does.
const rootEnv = path.join(import.meta.dirname, "..", ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  resolve: {
    alias: { "~": path.join(import.meta.dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Every file talks to the same Anvil instance.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
