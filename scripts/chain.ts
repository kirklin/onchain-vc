import process from "node:process";
import { startAnvil } from "./lib/anvil.ts";

const anvil = startAnvil("inherit");
anvil.once("exit", code => process.exit(code ?? 0));
