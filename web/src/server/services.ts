import type { Abi, AbiFunction, Chain, Hex, PublicClient, Transport } from "viem";
import type { ContractName } from "~/chain/contracts";
import type { Network, NetworkName } from "~/chain/networks";
import { createPublicClient, toFunctionSelector } from "viem";
import { addressOn, contracts, relayed } from "~/chain/contracts";
import { DEFAULT_GAS_MARGIN_PERCENT, networks } from "~/chain/networks";
import { serverEnv } from "./env";
import { FaucetService } from "./faucet";
import { JoinService } from "./join";
import { gatewayTransport, Operator } from "./operator";
import { RelayService } from "./relay";
import { RpcGateway } from "./rpc-gateway";

export interface ChainServices {
  name: NetworkName;
  network: Network;
  gateway: RpcGateway;
  client: PublicClient<Transport, Chain>;
  /** Present when an operator key is configured for this network. */
  operator: Operator | undefined;
  /** Present when the network has faucet limits, an operator, and a deployed Faucet contract. */
  faucet: FaucetService | undefined;
  /** Present when the network has relay limits, an operator, and a deployed Forwarder contract. */
  relay: RelayService | undefined;
  /** Present when the network takes visitors into the fund, with an operator and a deployed Fund. */
  join: JoinService | undefined;
}

// One set per chain per process. Stored on globalThis so dev-server reloads keep the queues and caches.
const holder = globalThis as typeof globalThis & { onchainVcServices?: Map<number, ChainServices> };

function create(name: NetworkName): ChainServices {
  const env = serverEnv();
  const network: Network = networks[name];
  const { chain } = network;

  const gateway = new RpcGateway({
    upstreams: env.rpcUrls.get(name) ?? chain.rpcUrls.default.http,
    batchIntervalMs: network.batchIntervalMs,
    // Reads stay fresh for one block. Chains without a declared block time get a short default.
    blockTtlMs: chain.blockTime ?? 1000,
  });
  const client = createPublicClient({ chain, transport: gatewayTransport(gateway) });

  const key = env.operatorKey(name);
  const operator = key === undefined ? undefined : new Operator({ key, chain, gateway });

  const contract = addressOn("Faucet", chain.id);
  const faucet = network.faucet === undefined || operator === undefined || contract === undefined
    ? undefined
    : new FaucetService({ operator, contract, ...network.faucet });

  const forwarder = addressOn("Forwarder", chain.id);
  const relay = network.relay === undefined || operator === undefined || forwarder === undefined
    ? undefined
    : new RelayService({ operator, forwarder, targets: relayTargets(chain.id), ...network.relay });

  const fund = addressOn("Fund", chain.id);
  const token = addressOn("Token", chain.id);
  const join = network.join === undefined || operator === undefined || fund === undefined || token === undefined
    ? undefined
    : new JoinService({ operator, fund, token, faucet, gasMarginPercent: network.gasMarginPercent ?? DEFAULT_GAS_MARGIN_PERCENT, ...network.join });

  return { name, network, gateway, client, operator, faucet, relay, join };
}

/** The addresses and selectors of everything listed in `relayed` that is deployed on the chain. */
function relayTargets(chainId: number): Map<string, Set<Hex>> {
  const targets = new Map<string, Set<Hex>>();
  for (const [name, functions] of Object.entries(relayed) as [ContractName, readonly string[]][]) {
    const address = addressOn(name, chainId);
    if (address === undefined) {
      continue;
    }
    const abi: Abi = contracts[name].abi;
    const selectors = abi
      .filter((item): item is AbiFunction => item.type === "function" && functions.includes(item.name))
      .map(item => toFunctionSelector(item));
    targets.set(address.toLowerCase(), new Set(selectors));
  }
  return targets;
}

/** The services for an enabled chain, or undefined when the app does not offer that chain. */
export function chainServices(chainId: number): ChainServices | undefined {
  holder.onchainVcServices ??= new Map();
  const existing = holder.onchainVcServices.get(chainId);
  if (existing !== undefined) {
    return existing;
  }

  const name = serverEnv().networkNames.find(candidate => networks[candidate].chain.id === chainId);
  if (name === undefined) {
    return undefined;
  }
  const created = create(name);
  holder.onchainVcServices.set(chainId, created);
  return created;
}
