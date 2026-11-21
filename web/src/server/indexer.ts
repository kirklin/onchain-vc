import type { Abi, Address, Chain, Client, Hash, Log, Transport } from "viem";
import type { Database } from "./db";
import { and, eq } from "drizzle-orm";
import { hexToBigInt, numberToHex } from "viem";
import { getBlockNumber, getLogs } from "viem/actions";
import { indexerCursors } from "./db/schema";

/** The handle a source writes through. Everything written with it is saved or discarded together. */
export type IndexerTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A contract whose events are copied into the database. */
export interface IndexerSource {
  /** Names this source's place in the cursor table. Change it to index from the start again. */
  name: string;
  address: Address;
  /** The contract's ABI. Every event in it is fetched. */
  abi: Abi;
  /** The first block worth reading, normally the one the contract was deployed in. */
  startBlock: bigint;
  /**
   * Stores a batch of logs, oldest first, decoded against `abi`. It may be handed logs it
   * has stored before, so it must write in a way that makes repeating harmless: insert with
   * `onConflictDoNothing`, or set values instead of adding to them.
   *
   * `timeOf` gives the time of a log's block, which a log does not carry itself.
   */
  store: (transaction: IndexerTransaction, logs: Log<bigint, number, false, undefined, true, Abi>[], timeOf: (blockNumber: bigint) => Date) => Promise<void>;
  /** Deletes everything this source has stored, for when the chain it was read from is gone. */
  clear: (transaction: IndexerTransaction) => Promise<void>;
}

export interface IndexerOptions {
  database: Database;
  client: Client<Transport, Chain>;
  sources: readonly IndexerSource[];
  /** How many blocks to stay behind the newest one. */
  confirmations: number;
  /** Most blocks to search for logs in one request. */
  logRange: bigint;
  /** How long to wait after catching up before looking for new blocks. */
  pollMs: number;
}

interface Cursor {
  block: bigint;
  blockHash: string;
}

/**
 * Copies contract events into the database, a range of blocks at a time, remembering how
 * far it got. Pages can then filter, sort, count and page through history with SQL, which
 * the chain itself cannot do.
 *
 * Each range's rows and its cursor are saved in one database transaction, so a crash never
 * leaves half a range behind. The cursor only moves if nobody else moved it meanwhile:
 * when two processes index the same chain, one of them wins each range and the other
 * discards its copy.
 *
 * The cursor remembers its block's hash. If the chain no longer has that block, because a
 * local chain was restarted or a reorganisation went deeper than `confirmations`, the
 * source's rows are deleted and it is read again from its start.
 */
export class Indexer {
  readonly #options: IndexerOptions;
  readonly #chainId: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;
  /** Set while `stop` waits, so a long catch-up ends between two ranges. */
  #interrupted = false;

  constructor(options: IndexerOptions) {
    this.#options = options;
    this.#chainId = options.client.chain.id;
  }

  /** Reads everything up to the newest confirmed block, for every source, then returns. */
  async sync(): Promise<void> {
    const head = await getBlockNumber(this.#options.client, { cacheTime: 0 });
    const target = head - BigInt(this.#options.confirmations);
    for (const source of this.#options.sources) {
      await this.#catchUp(source, target);
    }
  }

  /** Keeps syncing until `stop` is called. A failed pass is reported and tried again. */
  start() {
    if (!this.#stopped) {
      return;
    }
    this.#stopped = false;
    const pass = () => {
      this.#running = this.sync()
        .catch(error => console.error(`Indexing chain ${this.#chainId} failed, retrying.`, error))
        .then(() => {
          if (!this.#stopped) {
            this.#timer = setTimeout(pass, this.#options.pollMs);
          }
        });
    };
    pass();
  }

  /** Stops once the range being read, if any, is stored. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#interrupted = true;
    clearTimeout(this.#timer);
    await this.#running;
    this.#interrupted = false;
  }

  /** The last block stored for a source, or undefined before its first range. */
  async cursor(source: string): Promise<bigint | undefined> {
    return (await this.#cursor(source))?.block;
  }

  async #cursor(source: string): Promise<Cursor | undefined> {
    const [row] = await this.#options.database
      .select({ block: indexerCursors.block, blockHash: indexerCursors.blockHash })
      .from(indexerCursors)
      .where(this.#is(source));
    return row;
  }

  #is(source: string) {
    return and(eq(indexerCursors.chainId, this.#chainId), eq(indexerCursors.source, source));
  }

  async #hashOf(block: bigint): Promise<Hash | undefined> {
    const found = await this.#options.client.request({ method: "eth_getBlockByNumber", params: [numberToHex(block), false] });
    return found?.hash ?? undefined;
  }

  /** The times of the given blocks, one request each, sent together. */
  async #timesOf(blocks: readonly bigint[]): Promise<Map<bigint, Date>> {
    const times = await Promise.all([...new Set(blocks)].map(async (block) => {
      const found = await this.#options.client.request({ method: "eth_getBlockByNumber", params: [numberToHex(block), false] });
      if (found === null) {
        throw new Error(`Block ${block} of chain ${this.#chainId} disappeared while it was being indexed.`);
      }
      return [block, new Date(Number(hexToBigInt(found.timestamp)) * 1000)] as const;
    }));
    return new Map(times);
  }

  async #catchUp(source: IndexerSource, target: bigint) {
    const { database, client, logRange } = this.#options;
    let stored = await this.#cursor(source.name);

    if (stored !== undefined && await this.#hashOf(stored.block) !== stored.blockHash) {
      const gone = stored;
      await database.transaction(async (transaction) => {
        const removed = await transaction
          .delete(indexerCursors)
          .where(and(this.#is(source.name), eq(indexerCursors.blockHash, gone.blockHash)))
          .returning({ block: indexerCursors.block });
        if (removed.length === 1) {
          await source.clear(transaction);
        }
      });
      stored = await this.#cursor(source.name);
    }

    while (!this.#interrupted && (stored?.block ?? source.startBlock - 1n) < target) {
      const previous = stored;
      const fromBlock = (previous?.block ?? source.startBlock - 1n) + 1n;
      const toBlock = fromBlock + logRange - 1n < target ? fromBlock + logRange - 1n : target;
      const [logs, blockHash] = await Promise.all([
        getLogs(client, { address: source.address, events: source.abi.filter(item => item.type === "event"), fromBlock, toBlock, strict: true }),
        this.#hashOf(toBlock),
      ]);
      if (blockHash === undefined) {
        throw new Error(`Block ${toBlock} of chain ${this.#chainId} disappeared while it was being indexed.`);
      }

      const times = await this.#timesOf(logs.map(log => log.blockNumber));

      const next = { block: toBlock, blockHash };
      const advanced = await database.transaction(async (transaction) => {
        if (!(await this.#advance(transaction, source.name, previous, next))) {
          return false;
        }
        if (logs.length > 0) {
          await source.store(transaction, logs as never, block => times.get(block)!);
        }
        return true;
      });
      // Either way the cursor now says where to continue from.
      stored = advanced ? next : await this.#cursor(source.name);
    }
  }

  /** Moves the cursor from `previous` to `next`, unless someone else has already moved it. */
  async #advance(transaction: IndexerTransaction, source: string, previous: Cursor | undefined, next: Cursor): Promise<boolean> {
    if (previous === undefined) {
      const inserted = await transaction
        .insert(indexerCursors)
        .values({ chainId: this.#chainId, source, ...next })
        .onConflictDoNothing()
        .returning({ block: indexerCursors.block });
      return inserted.length === 1;
    }
    const updated = await transaction
      .update(indexerCursors)
      .set(next)
      .where(and(this.#is(source), eq(indexerCursors.block, previous.block), eq(indexerCursors.blockHash, previous.blockHash)))
      .returning({ block: indexerCursors.block });
    return updated.length === 1;
  }
}
