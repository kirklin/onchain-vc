import type { Hash } from "viem";
import { and, countDistinct, desc, eq, isNotNull } from "drizzle-orm";
import { database } from "./db";
import { chainEvents, meetingNotes } from "./db/schema";
import { chainServices } from "./services";

export interface ChainStats {
  /** Transactions that reached the committee or the fund. */
  transactions: number;
  /** Blocks those transactions are in. */
  blocks: number;
  /** Most of those transactions any one block holds. */
  busiestBlock: number;
  /** What all of them cost, in wei. On chains that bill the gas limit this is the limit's price. */
  fees: string;
  /** Half of the partners' transactions had their receipt within this long of being sent. */
  medianConfirmMs: number | null;
}

/** Most receipts looked up for one answer. What is left is looked up for the next. */
const RECEIPTS_PER_CALL = 200;

// What each transaction cost, per chain. A receipt never changes, so this only grows.
const holder = globalThis as typeof globalThis & { onchainVcFees?: Map<number, Map<string, bigint>> };

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** What the app has put on a chain so far, counted from the index and the transactions' receipts. */
export async function chainStats(chainId: number): Promise<ChainStats | undefined> {
  const services = chainServices(chainId);
  if (services === undefined) {
    return undefined;
  }
  const db = await database();
  const onChain = eq(chainEvents.chainId, chainId);

  const [[totals], [busiest], hashes, confirms] = await Promise.all([
    db.select({ transactions: countDistinct(chainEvents.transactionHash), blocks: countDistinct(chainEvents.blockNumber) }).from(chainEvents).where(onChain),
    db.select({ transactions: countDistinct(chainEvents.transactionHash) }).from(chainEvents).where(onChain).groupBy(chainEvents.blockNumber).orderBy(desc(countDistinct(chainEvents.transactionHash))).limit(1),
    db.selectDistinct({ hash: chainEvents.transactionHash }).from(chainEvents).where(onChain),
    db.select({ confirmMs: meetingNotes.confirmMs }).from(meetingNotes).where(and(eq(meetingNotes.chainId, chainId), isNotNull(meetingNotes.confirmMs))),
  ]);

  holder.onchainVcFees ??= new Map();
  const fees = holder.onchainVcFees.get(chainId) ?? new Map<string, bigint>();
  holder.onchainVcFees.set(chainId, fees);
  const missing = hashes.map(row => row.hash).filter(hash => !fees.has(hash)).slice(0, RECEIPTS_PER_CALL);
  const receipts = await Promise.all(missing.map(hash => services.client.getTransactionReceipt({ hash: hash as Hash })));
  for (const receipt of receipts) {
    fees.set(receipt.transactionHash, receipt.gasUsed * receipt.effectiveGasPrice);
  }

  return {
    transactions: totals?.transactions ?? 0,
    blocks: totals?.blocks ?? 0,
    busiestBlock: busiest?.transactions ?? 0,
    fees: hashes.reduce((sum, row) => sum + (fees.get(row.hash) ?? 0n), 0n).toString(),
    medianConfirmMs: median(confirms.map(row => row.confirmMs!)),
  };
}
