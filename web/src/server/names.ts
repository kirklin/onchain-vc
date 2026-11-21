import type { Address, Chain, Client, Transport } from "viem";
import { createClient, getAddress } from "viem";
import { getEnsAddress, getEnsName, getEnsText } from "viem/actions";
import { normalize } from "viem/ens";
import { networks } from "~/chain/networks";
import { serverEnv } from "./env";
import { gatewayTransport } from "./operator";
import { RpcGateway } from "./rpc-gateway";

/** What an address calls itself: its primary ENS name and the avatar set on that name. */
export interface Profile {
  name: string | null;
  /** An `https://` or `ipfs://` address of an image. Avatars named any other way are left out. */
  avatar: string | null;
}

const AVATAR_URI = /^(?:https|ipfs):\/\//i;
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Looks up ENS names on Ethereum mainnet, where they live whatever chain the app runs on.
 *
 * Answers are remembered for an hour, misses included, so a page full of addresses costs
 * the mainnet endpoint one round of calls at most.
 *
 * It only ever talks to the mainnet endpoint. Names whose records sit on some other server
 * (CCIP-Read) are not followed, and an avatar is returned as the address the name states
 * and never fetched: either would make this server request URLs chosen by strangers.
 */
export class NameService {
  readonly #client: Client<Transport, Chain>;
  readonly #cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(client: Client<Transport, Chain>) {
    this.#client = client;
  }

  /** The address's primary name and avatar. Both null when it has not set a name that points back at it. */
  profile(address: Address): Promise<Profile> {
    return this.#remember(`profile:${address.toLowerCase()}`, async () => {
      const name = await getEnsName(this.#client, { address });
      if (name === null) {
        return { name: null, avatar: null };
      }
      const avatar = await getEnsText(this.#client, { name, key: "avatar" });
      return { name, avatar: avatar !== null && AVATAR_URI.test(avatar) ? avatar : null };
    });
  }

  /** The address a name points to, or null when it points nowhere or is not a valid name. */
  resolve(name: string): Promise<Address | null> {
    let normalized: string;
    try {
      normalized = normalize(name);
    } catch {
      return Promise.resolve(null);
    }
    return this.#remember(`address:${normalized}`, async () => {
      const address = await getEnsAddress(this.#client, { name: normalized });
      return address === null ? null : getAddress(address);
    });
  }

  #remember<Value>(key: string, load: () => Promise<Value>): Promise<Value> {
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expires > Date.now()) {
      return cached.value as Promise<Value>;
    }
    if (this.#cache.size >= MAX_ENTRIES) {
      this.#cache.clear();
    }
    const value = load();
    this.#cache.set(key, { expires: Date.now() + TTL_MS, value });
    // A lookup that failed is not an answer worth keeping.
    value.catch(() => this.#cache.delete(key));
    return value;
  }
}

/** A client for the mainnet endpoint that refuses to follow a resolver to another server. */
export function ensClient(urls: readonly string[]): Client<Transport, Chain> {
  const gateway = new RpcGateway({ upstreams: [...urls], batchIntervalMs: 0, blockTtlMs: 12_000 });
  return createClient({ chain: networks.mainnet.chain, transport: gatewayTransport(gateway), ccipRead: false });
}

// One per process. Stored on globalThis so dev-server reloads keep its cache.
const holder = globalThis as typeof globalThis & { onchainVcNames?: NameService };

/** The app's name service, or undefined when NEXT_PUBLIC_ENS is not on. */
export function nameService(): NameService | undefined {
  const env = serverEnv();
  if (!env.ensEnabled) {
    return undefined;
  }
  holder.onchainVcNames ??= new NameService(ensClient(env.rpcUrls.get("mainnet") ?? networks.mainnet.chain.rpcUrls.default.http));
  return holder.onchainVcNames;
}
