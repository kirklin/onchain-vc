import type { Chain, Transport } from "viem";
import type { Network, NetworkName } from "./networks";
import { cookieStorage, createConfig, createStorage, fallback, http, injected, webSocket } from "wagmi";
import { burner } from "./burner/connector";
import { addressOn } from "./contracts";
import { DEFAULT_GAS_MARGIN_PERCENT, networks, parseNetworkNames } from "./networks";

export interface EnabledNetwork extends Network {
  name: NetworkName;
}

/** The networks this build offers, default first. Chosen by NEXT_PUBLIC_NETWORKS. */
export const enabledNetworks: EnabledNetwork[] = parseNetworkNames(process.env.NEXT_PUBLIC_NETWORKS)
  .map(name => ({ name, ...networks[name] }));

const chains = enabledNetworks.map(network => network.chain) as [Chain, ...Chain[]];

/** The burner wallet signs without asking, so it is only offered when no enabled chain holds real value. */
export const burnerAvailable = chains.every(chain => chain.testnet === true);

export function networkOf(chainId: number): EnabledNetwork | undefined {
  return enabledNetworks.find(network => network.chain.id === chainId);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The WebSocket endpoint new blocks and events are pushed over, for chains that name one in
 * `rpcUrls.default.webSocket`. Without one the app polls. The local chain only listens on
 * this machine, so it is polled when the page was opened from another device.
 */
export function webSocketUrlOf(chain: Chain): string | undefined {
  const url = chain.rpcUrls.default.webSocket?.[0];
  if (url === undefined || typeof window === "undefined") {
    return undefined;
  }
  return LOCAL_HOSTS.has(new URL(url).hostname) && !LOCAL_HOSTS.has(window.location.hostname) ? undefined : url;
}

function transportOf(chain: Chain): Transport {
  // Every request goes to this app's own gateway. Calls made in the same tick leave as one.
  const gateway = http(`/api/rpc/${chain.id}`, { batch: true, retryCount: 0 });
  const url = webSocketUrlOf(chain);
  // Listed second, the socket carries subscriptions only. See ./live.ts.
  return url === undefined ? gateway : fallback([gateway, webSocket(url)]);
}

/**
 * A config holds the connection of whoever it is rendering for, so the server makes one for
 * each request and the browser keeps a single one. See ./providers.tsx.
 */
export function createWagmiConfig() {
  return createConfig({
    chains,
    // Wallets that announce themselves (EIP-6963) are discovered on their own.
    connectors: burnerAvailable
      ? [
          injected(),
          burner({
            executorOn: chainId => addressOn("BatchExecutor", chainId),
            gasMarginPercentOn: chainId => networkOf(chainId)?.gasMarginPercent ?? DEFAULT_GAS_MARGIN_PERCENT,
          }),
        ]
      : [injected()],
    transports: Object.fromEntries(chains.map(chain => [chain.id, transportOf(chain)])),
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
  });
}

declare module "wagmi" {
  interface Register {
    config: ReturnType<typeof createWagmiConfig>;
  }
}
