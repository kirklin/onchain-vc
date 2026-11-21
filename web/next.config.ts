import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import process from "node:process";
import createNextIntlPlugin from "next-intl/plugin";

// One .env at the repository root serves the scripts, Foundry and this app.
const rootEnv = path.join(import.meta.dirname, "..", ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(item => item !== undefined && item.family === "IPv4" && !item.internal)
    .map(item => item!.address);
}

const nextConfig: NextConfig = {
  // Lets a phone on the same network open the dev server by this machine's address.
  allowedDevOrigins: lanAddresses(),
  // PGlite loads its WebAssembly and data files from its own folder at run time, and pi-ai
  // loads each provider's API on first use through imports a bundler cannot follow.
  serverExternalPackages: ["@electric-sql/pglite", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-schema"],
  // The server reads its SQL migrations from disk when it opens the database. Nothing imports
  // them, so a host that ships only traced files has to be told to take them along.
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"] },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
  ],
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // `typescript` is aliased to @typescript/typescript6, which ships bin/tsc6
    // instead of bin/tsc, so keep Next on the TypeScript API.
    useTypeScriptCli: false,
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
