import { ensureLocalChain, finish, runWeb } from "./lib/run.ts";

await ensureLocalChain();
await runWeb("dev");
finish();
