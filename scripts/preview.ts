import { ensureLocalChain, finish, runWeb } from "./lib/run.ts";

// Builds the app and serves the production build, the way it runs once deployed.
await ensureLocalChain();
await runWeb("build");
await runWeb("start");
finish();
