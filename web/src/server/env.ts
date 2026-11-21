import type { Hex } from "viem";
import type { NetworkName } from "~/chain/networks";
import process from "node:process";
import { isHex } from "viem";
import { z } from "zod";
import { LOCAL_OPERATOR_KEY, LOCAL_PARTNER_KEYS, parseNetworkNames, rpcUrlsVariable } from "~/chain/networks";

const POSTGRES_URL = /^postgres(?:ql)?:\/\//;
const TRAILING_SLASHES = /\/+$/;
const MODEL = /^[\w.-]+\/[\w.:-]+$/;

const key = z.string().refine(value => isHex(value) && value.length === 66, "must be a 32-byte hex string");

const schema = z.object({
  NEXT_PUBLIC_NETWORKS: z.string().optional(),
  OPERATOR_PRIVATE_KEY: key.optional(),
  PARTNER_KEYS: z.string().transform(value => value.split(",").map(item => item.trim())).pipe(z.array(key).length(4)).optional(),
  PARTNER_MODEL: z.string().regex(MODEL, "must be <provider>/<model>, e.g. deepseek/deepseek-flash").optional(),
  COMMITTEE: z.enum(["on", "off"]).optional(),
  APP_URL: z.url().optional(),
  DATABASE_URL: z.string().regex(POSTGRES_URL, "must start with postgres:// or postgresql://").optional(),
  INDEXER: z.enum(["on", "off"]).optional(),
  IPFS_API_URL: z.url().optional(),
  IPFS_GATEWAY_URL: z.url().optional(),
  NEXT_PUBLIC_ENS: z.enum(["on", "off"]).optional(),
});

function load() {
  const source = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
  const parsed = schema.parse(source);
  const networkNames = parseNetworkNames(parsed.NEXT_PUBLIC_NETWORKS);

  const rpcUrls = new Map<NetworkName, string[]>();
  // Names live on Ethereum mainnet, so its endpoints matter even when the app does not offer it.
  for (const name of new Set<NetworkName>([...networkNames, "mainnet"])) {
    const value = source[rpcUrlsVariable(name)];
    if (value !== undefined) {
      rpcUrls.set(name, z.array(z.url()).min(1).parse(value.split(",").map(url => url.trim())));
    }
  }

  return {
    networkNames,
    /** Signs the faucet's, the relayer's and other server-side transactions. Absent when no key is configured. */
    operatorKey: (name: NetworkName): Hex | undefined =>
      (parsed.OPERATOR_PRIVATE_KEY ?? (name === "local" ? LOCAL_OPERATOR_KEY : undefined)) as Hex | undefined,
    /** The keys of the partners this server speaks for, in seat order. Absent when none are configured. */
    partnerKeys: (name: NetworkName): Hex[] | undefined =>
      (parsed.PARTNER_KEYS ?? (name === "local" ? [...LOCAL_PARTNER_KEYS] : undefined)) as Hex[] | undefined,
    /** The model the partners run on, as `<provider>/<model>` in the pi-ai catalog. */
    partnerModel: parsed.PARTNER_MODEL ?? "deepseek/deepseek-flash",
    /**
     * Whether this process runs the partners. Turn it off on all but one instance when
     * several serve the same app, or each partner would vote from every one of them.
     */
    committeeEnabled: parsed.COMMITTEE !== "off",
    /** Endpoints from RPC_URLS_<NETWORK>, which may carry provider keys and stay on the server. */
    rpcUrls,
    /** The Postgres server to use. Without one the app keeps its data in PGlite under web/.data. */
    databaseUrl: parsed.DATABASE_URL,
    /**
     * Whether this process copies contract events into the database. Turn it off on all
     * but one instance when several serve the same app.
     */
    indexerEnabled: parsed.INDEXER !== "off",
    /** Whether addresses are looked up for their ENS name and avatar. */
    ensEnabled: parsed.NEXT_PUBLIC_ENS === "on",
    /** The RPC address of a Kubo node to keep documents in. Without one they go to web/.data/files. */
    ipfsApiUrl: parsed.IPFS_API_URL,
    /** Where files this server does not hold itself are fetched from by CID. */
    ipfsGatewayUrl: (parsed.IPFS_GATEWAY_URL ?? "https://ipfs.io").replace(TRAILING_SLASHES, ""),
  };
}

/**
 * The address the app is reached at: APP_URL, or wherever the dev server listens. Read on
 * its own, without the keys `serverEnv` checks, because page metadata needs it while the
 * app is being built, when those are not there yet.
 */
export function appUrl(): URL {
  return new URL(process.env.APP_URL === undefined || process.env.APP_URL === "" ? `http://localhost:${process.env.PORT ?? 3000}` : process.env.APP_URL);
}

export type ServerEnv = ReturnType<typeof load>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= load();
  return cached;
}
