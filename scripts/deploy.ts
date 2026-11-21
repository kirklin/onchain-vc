import process from "node:process";
import { deploy } from "./lib/deploy.ts";
import { resolveNetwork } from "./lib/env.ts";

deploy(resolveNetwork(process.argv[2]));
