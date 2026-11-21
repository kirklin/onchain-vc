import type { Chain } from "viem";
import { defineChain, parseEther } from "viem";
import { base, baseSepolia, mainnet, monad, monadTestnet, sepolia } from "viem/chains";

export interface Network {
  chain: Chain;
  /**
   * Shortest gap the RPC gateway leaves between two batches to the same upstream. Set it
   * to match the endpoint's rate limit. 0 sends as soon as there is something to send.
   */
  batchIntervalMs: number;
  /**
   * How far above the node's estimate to set the gas limit of transactions the app signs
   * itself, as the burner wallet does. Defaults to DEFAULT_GAS_MARGIN_PERCENT. Keep it low
   * on chains that bill the limit instead of the gas used.
   */
  gasMarginPercent?: number;
  /**
   * How many blocks the indexer stays behind the newest one, so that what it stores is not
   * undone by a reorganisation. Defaults to 0, which suits a chain with a single producer.
   */
  confirmations?: number;
  /** Most blocks the endpoint searches for logs in one request. Defaults to DEFAULT_LOG_RANGE. */
  logRange?: bigint;
  /** A Sourcify-compatible verifier, for chains whose explorer runs its own. */
  verifierUrl?: string;
  /** Present on chains where the app hands out native tokens for gas. Never set it on a mainnet. */
  faucet?: FaucetLimits;
  /** Present on chains where the app pays the gas of calls its users sign. See ~/server/relay.ts. */
  relay?: RelayLimits;
  /** Present on chains where the app hands visitors a share of the fund. Never set it on a mainnet. */
  join?: JoinLimits;
  /**
   * How many blocks an account waits after receiving native tokens before it can pay for
   * gas with them. Monad's consensus checks balances against the state of three blocks ago.
   */
  spendDelayBlocks?: number;
  /**
   * The balance below which the chain reverts an account's transfers of native tokens,
   * unless the account has sent nothing else for `spendDelayBlocks`. Monad's reserve balance.
   */
  reserveBalance?: bigint;
}

/** The reserve rule the server's own accounts follow on a network, where the chain has one. */
export function reserveRuleOf(network: Network): { balance: bigint; blocks: number } | undefined {
  return network.reserveBalance === undefined || network.spendDelayBlocks === undefined
    ? undefined
    : { balance: network.reserveBalance, blocks: network.spendDelayBlocks };
}

export interface JoinLimits {
  /** The shares each visitor receives, the same for all so that every one counts alike. */
  shares: bigint;
  /** Most visitors the app takes in, per server process. */
  members: number;
}

export const DEFAULT_GAS_MARGIN_PERCENT = 20;
export const DEFAULT_LOG_RANGE = 1000n;

export interface RelayLimits {
  /** Most calls one signer may have relayed within `windowMs`. */
  perSender: number;
  windowMs: number;
  /** Most gas a single relayed call may ask for. */
  maxGas: bigint;
  /** Most the relayer may spend on gas in total, per server process. */
  budget: bigint;
}

export interface FaucetLimits {
  /** Balance a funded account is raised to. */
  target: bigint;
  /** Accounts above this balance are left alone. */
  lowWater: bigint;
  /** Most one address may receive in total. */
  perAddress: bigint;
  /** Most the faucet may spend in total, gas included, per server process. */
  budget: bigint;
}

function faucet(target: string, lowWater: string, perAddress: string, budget: string): FaucetLimits {
  return { target: parseEther(target), lowWater: parseEther(lowWater), perAddress: parseEther(perAddress), budget: parseEther(budget) };
}

function join(shares: string, members: number): JoinLimits {
  return { shares: parseEther(shares), members };
}

/** `perSender` calls an hour for each signer, none above 400k gas, `budget` native tokens in all. */
function relay(perSender: number, budget: string): RelayLimits {
  return { perSender, windowMs: 60 * 60 * 1000, maxGas: 400_000n, budget: parseEther(budget) };
}

/** Anvil on this machine, started by `pnpm dev` or `pnpm chain`. */
const local = defineChain({
  id: 31_337,
  name: "Local",
  // Anvil mines as soon as a transaction arrives. This sets how often clients look for news.
  blockTime: 1000,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["http://127.0.0.1:8545"],
      webSocket: ["ws://127.0.0.1:8545"],
    },
  },
  // Installed on the local chain by scripts/lib/canonical.ts, at the address it has everywhere.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

// Monad bills the gas limit at `base fee + priority fee`, and `maxFeePerGas` only caps that
// price. A generous cap keeps transactions valid while the base fee climbs.
const monadFees = { baseFeeMultiplier: 2 };
const MONAD_VERIFIER = "https://sourcify-api-monad.blockvision.org/";
// Consensus runs three blocks ahead of execution, and holds every account to a 10 MON reserve.
const monadReserve = { spendDelayBlocks: 3, reserveBalance: parseEther("10") };

/**
 * Every chain the project knows how to talk to. NEXT_PUBLIC_NETWORKS picks which of them
 * the app offers, and `pnpm deploy:contracts <name>` deploys to one.
 *
 * To support another EVM chain, add an entry here. Nothing else is chain-specific.
 */
export const networks = {
  local: { chain: local, batchIntervalMs: 0, faucet: faucet("1", "0.1", "10", "1000"), relay: relay(120, "100"), join: join("1000", 1000) },
  sepolia: { chain: sepolia, batchIntervalMs: 0, confirmations: 5, faucet: faucet("0.01", "0.002", "0.05", "1"), relay: relay(30, "0.5") },
  baseSepolia: { chain: baseSepolia, batchIntervalMs: 0, confirmations: 3, faucet: faucet("0.01", "0.002", "0.05", "1"), relay: relay(30, "0.5") },
  monadTestnet: {
    chain: defineChain({
      ...monadTestnet,
      rpcUrls: {
        default: {
          http: ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"],
          webSocket: ["wss://testnet-rpc.monad.xyz", "wss://rpc-testnet.monadinfra.com"],
        },
      },
      blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
      fees: monadFees,
    }),
    // The public Monad endpoints accept 5 batches of up to 100 calls per second.
    batchIntervalMs: 200,
    gasMarginPercent: 10,
    confirmations: 3,
    // The public Monad endpoints refuse a log search wider than this.
    logRange: 100n,
    verifierUrl: MONAD_VERIFIER,
    // Enough for a visitor's own vetoes: the costliest, the one that carries, is billed
    // for about 400k gas at up to twice the base fee.
    faucet: faucet("0.1", "0.03", "0.5", "30"),
    relay: relay(30, "20"),
    join: join("1000", 300),
    ...monadReserve,
  },
  mainnet: { chain: mainnet, batchIntervalMs: 0, confirmations: 5 },
  base: { chain: base, batchIntervalMs: 0, confirmations: 3 },
  monad: {
    chain: defineChain({ ...monad, fees: monadFees }),
    batchIntervalMs: 200,
    gasMarginPercent: 10,
    confirmations: 3,
    // The public Monad endpoints refuse a log search wider than this.
    logRange: 100n,
    verifierUrl: MONAD_VERIFIER,
    ...monadReserve,
  },
} as const satisfies Record<string, Network>;

export type NetworkName = keyof typeof networks;

export function isNetworkName(value: string): value is NetworkName {
  return Object.hasOwn(networks, value);
}

/** Parses NEXT_PUBLIC_NETWORKS: a comma-separated list whose first entry is the default. */
export function parseNetworkNames(value: string | undefined): [NetworkName, ...NetworkName[]] {
  const names = (value ?? "local").split(",").map(name => name.trim()).filter(name => name !== "");
  for (const name of names) {
    if (!isNetworkName(name)) {
      throw new Error(`Unknown network "${name}" in NEXT_PUBLIC_NETWORKS. Use any of: ${Object.keys(networks).join(", ")}`);
    }
  }
  if (names.length === 0) {
    throw new Error("NEXT_PUBLIC_NETWORKS is empty.");
  }
  return names as [NetworkName, ...NetworkName[]];
}

const UPPERCASE = /[A-Z]/g;

/** The environment variable that overrides a network's RPC endpoints, e.g. RPC_URLS_BASE_SEPOLIA. */
export function rpcUrlsVariable(name: NetworkName): string {
  return `RPC_URLS_${name.replace(UPPERCASE, letter => `_${letter}`).toUpperCase()}`;
}

/** The first account Anvil funds at genesis. Public knowledge, only ever used on the local chain. */
export const LOCAL_OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** The next four, which hold the committee's seats on the local chain, in seat order. */
export const LOCAL_PARTNER_KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;

/** The sixth, which receives the shares of the fund's first deposit on the local chain. */
export const LOCAL_INVESTOR_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
