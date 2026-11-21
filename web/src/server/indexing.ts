import type { Abi, Address, Log } from "viem";
import type { IndexerSource } from "./indexer";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { addressOn } from "~/chain/contracts";
import { DEFAULT_LOG_RANGE, networks } from "~/chain/networks";
import { committeeAbi, deploymentBlock, fundAbi } from "~/contracts/abis";
import { database } from "./db";
import { chainEvents } from "./db/schema";
import { serverEnv } from "./env";
import { Indexer } from "./indexer";
import { chainServices } from "./services";

/** The argument naming whom an event is about, by event name. */
const ACCOUNT_ARGUMENT: Record<string, string> = {
  Pitched: "founder",
  Paid: "founder",
  Opined: "partner",
  Voted: "partner",
  Slashed: "partner",
  ProfileSet: "partner",
  BondPosted: "partner",
  BondWithdrawn: "partner",
  Seated: "partner",
  Unseated: "partner",
  MotionOpened: "proposer",
  MotionSupported: "investor",
  Deposit: "owner",
  Withdraw: "owner",
};

function jsonArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([name, value]) => [name, typeof value === "bigint" ? value.toString() : value]));
}

/** Copies every event of a contract into `chain_events`, as `contract` names it. */
export function eventSource(chainId: number, contract: "committee" | "fund", address: Address, abi: Abi, startBlock: bigint): IndexerSource {
  return {
    name: `events:${contract}:${address.toLowerCase()}`,
    address,
    abi,
    startBlock,
    async store(transaction, logs, timeOf) {
      await transaction.insert(chainEvents).values(logs.map((log: Log<bigint, number, false, undefined, true, Abi>) => {
        const args = (log.args ?? {}) as Record<string, unknown>;
        const name = log.eventName as string;
        const account = args[ACCOUNT_ARGUMENT[name] ?? ""];
        return {
          chainId,
          contract,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
          timestamp: timeOf(log.blockNumber),
          name,
          dealId: typeof args.dealId === "bigint" ? args.dealId : null,
          account: typeof account === "string" ? getAddress(account) : null,
          args: jsonArgs(args),
        };
      })).onConflictDoNothing();
    },
    async clear(transaction) {
      await transaction.delete(chainEvents).where(and(eq(chainEvents.chainId, chainId), eq(chainEvents.contract, contract)));
    },
  };
}

/** What gets indexed on a chain. Add a source here for each contract whose history pages need to query. */
function sourcesOn(chainId: number): IndexerSource[] {
  const startBlock = BigInt((deploymentBlock as Partial<Record<number, number>>)[chainId] ?? 0);
  const committee = addressOn("Committee", chainId);
  const fund = addressOn("Fund", chainId);
  return [
    ...(committee === undefined ? [] : [eventSource(chainId, "committee", committee, committeeAbi, startBlock)]),
    ...(fund === undefined ? [] : [eventSource(chainId, "fund", fund, fundAbi, startBlock)]),
  ];
}

// One set per process. Stored on globalThis so dev-server reloads do not start a second set.
const holder = globalThis as typeof globalThis & { onchainVcIndexers?: Promise<Indexer[]> };

/** Starts an indexer for every enabled chain that has something to index. Safe to call more than once. */
export function startIndexers(): Promise<Indexer[]> {
  holder.onchainVcIndexers ??= (async () => {
    const env = serverEnv();
    if (!env.indexerEnabled) {
      return [];
    }
    const indexers: Indexer[] = [];
    for (const services of env.networkNames.map(name => chainServices(networks[name].chain.id)!)) {
      const sources = sourcesOn(services.network.chain.id);
      if (sources.length === 0) {
        continue;
      }
      const indexer = new Indexer({
        database: await database(),
        client: services.client,
        sources,
        confirmations: services.network.confirmations ?? 0,
        logRange: services.network.logRange ?? DEFAULT_LOG_RANGE,
        pollMs: services.network.chain.blockTime ?? 1000,
      });
      indexer.start();
      indexers.push(indexer);
    }
    return indexers;
  })();
  return holder.onchainVcIndexers;
}
