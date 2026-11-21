import type { Address, Transport } from "viem";
import type { Database } from "~/server/db";
import type { IndexerOptions, IndexerSource } from "~/server/indexer";
import { and, asc, eq } from "drizzle-orm";
import { createClient, createTestClient, http, keccak256, stringToBytes } from "viem";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { committeeAbi } from "~/contracts/abis";
import { openDatabase } from "~/server/db";
import { chainEvents } from "~/server/db/schema";
import { Indexer } from "~/server/indexer";
import { eventSource } from "~/server/indexing";
import { ANVIL_KEYS, ANVIL_URL, deployFundSystem, testChain, testClient } from "./helpers";

const client = testClient(ANVIL_KEYS[6]);
const author = client.account.address;

let committee: Address;
let startBlock: bigint;
let database: Database;

/** Publishes a profile, the cheapest event the committee emits, named so it can be found again. */
async function publish(name: string) {
  const hash = await client.writeContract({ address: committee, abi: committeeAbi, functionName: "setProfile", args: [name, keccak256(stringToBytes(name))] });
  return client.waitForTransactionReceipt({ hash });
}

function source() {
  return eventSource(testChain.id, "committee", committee, committeeAbi, startBlock);
}

function indexer(overrides: Partial<IndexerOptions> = {}) {
  return new Indexer({
    database,
    client,
    sources: [source()],
    confirmations: 0,
    logRange: 1000n,
    pollMs: 50,
    ...overrides,
  });
}

async function storedNames(): Promise<string[]> {
  const rows = await database
    .select({ args: chainEvents.args })
    .from(chainEvents)
    .where(and(eq(chainEvents.contract, "committee"), eq(chainEvents.name, "ProfileSet"), eq(chainEvents.account, author)))
    .orderBy(asc(chainEvents.blockNumber), asc(chainEvents.logIndex));
  return rows.map(row => String(row.args.name));
}

beforeAll(async () => {
  ({ committee } = await deployFundSystem(ANVIL_KEYS[6], author));
  startBlock = await client.getBlockNumber();
});

beforeEach(async () => {
  // Postgres itself, running in this process with nothing on disk.
  database = await openDatabase({});
});

describe("indexer", () => {
  it("copies events into the database and records how far it read", async () => {
    await publish("one");
    const receipt = await publish("two");
    const subject = indexer();

    await subject.sync();

    expect((await storedNames()).slice(-2)).toEqual(["one", "two"]);
    const [row] = await database.select().from(chainEvents).where(eq(chainEvents.transactionHash, receipt.transactionHash));
    expect(row).toMatchObject({
      chainId: testChain.id,
      contract: "committee",
      name: "ProfileSet",
      account: author,
      dealId: null,
      blockNumber: receipt.blockNumber,
    });
    expect(row!.args).toEqual({ partner: author, name: "two", profileHash: keccak256(stringToBytes("two")) });
    expect(Date.now() - row!.timestamp.getTime()).toBeLessThan(120_000);
    expect(await subject.cursor(source().name)).toBeGreaterThanOrEqual(receipt.blockNumber);
  });

  it("carries on from its cursor without storing anything twice", async () => {
    const subject = indexer();
    await subject.sync();
    const before = await storedNames();

    await publish("three");
    await subject.sync();
    await subject.sync();

    expect(await storedNames()).toEqual([...before, "three"]);
  });

  it("reads a long history in ranges no wider than the limit", async () => {
    const ranges: bigint[] = [];
    const recording: Transport = (parameters) => {
      const inner = http(ANVIL_URL)(parameters);
      const request = (async (call: { method: string; params?: unknown }) => {
        if (call.method === "eth_getLogs") {
          const [{ fromBlock, toBlock }] = call.params as [{ fromBlock: string; toBlock: string }];
          ranges.push(BigInt(toBlock) - BigInt(fromBlock) + 1n);
        }
        return inner.request(call);
      }) as typeof inner.request;
      return { ...inner, request };
    };
    await publish("four");
    const head = await client.getBlockNumber();

    await indexer({
      client: createClient({ chain: testChain, transport: recording }),
      logRange: 3n,
      sources: [eventSource(testChain.id, "committee", committee, committeeAbi, 0n)],
    }).sync();

    expect(ranges.length).toBeGreaterThan(4);
    expect(ranges.every(range => range <= 3n)).toBe(true);
    expect(ranges.reduce((total, range) => total + range, 0n)).toBeGreaterThanOrEqual(head + 1n);
    expect(await storedNames()).toContain("four");
  });

  it("stays behind the newest block by the number of confirmations", async () => {
    const receipt = await publish("five");
    const subject = indexer({ confirmations: 3 });

    await subject.sync();
    expect(await storedNames()).not.toContain("five");

    // Anvil produces a block every 100 ms here, so three more arrive shortly.
    await expect.poll(async () => {
      await subject.sync();
      return storedNames();
    }, { timeout: 5000 }).toContain("five");
    expect(await client.getBlockNumber()).toBeGreaterThanOrEqual(receipt.blockNumber + 3n);
  });

  it("leaves a range to whichever of two indexers stores it first", async () => {
    await publish("six");
    let stores = 0;
    const counting: IndexerSource = {
      ...source(),
      async store(transaction, logs, timeOf) {
        stores += 1;
        await source().store(transaction, logs, timeOf);
      },
    };

    await Promise.all([indexer({ sources: [counting] }).sync(), indexer({ sources: [counting] }).sync()]);

    expect(stores).toBe(1);
    expect((await storedNames()).filter(name => name === "six")).toHaveLength(1);
  });

  it("rolls a range back when storing it fails, and reads it again next time", async () => {
    await publish("seven");
    const failing: IndexerSource = {
      ...source(),
      store: async () => {
        throw new Error("disk full");
      },
    };

    const broken = indexer({ sources: [failing] });
    await expect(broken.sync()).rejects.toThrow("disk full");
    expect(await broken.cursor(failing.name)).toBeUndefined();

    await indexer().sync();
    expect(await storedNames()).toContain("seven");
  });

  it("starts over when the chain no longer has the block it stopped at", async () => {
    const tester = createTestClient({ chain: testChain, mode: "anvil", transport: http(ANVIL_URL) });
    const subject = indexer();
    await subject.sync();
    const kept = await storedNames();

    const snapshot = await tester.snapshot();
    await publish("on a branch that will vanish");
    await subject.sync();
    expect(await storedNames()).toContain("on a branch that will vanish");

    // Back to the snapshot: the blocks since then are replaced by different ones.
    await tester.revert({ id: snapshot });
    await publish("on the branch that stays");
    await subject.sync();

    expect(await storedNames()).toEqual([...kept, "on the branch that stays"]);
  });

  it("keeps up on its own once started, until stopped", async () => {
    const subject = indexer();
    subject.start();

    await publish("eight");
    await expect.poll(storedNames, { timeout: 5000 }).toContain("eight");

    await subject.stop();
    await publish("nine");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await storedNames()).not.toContain("nine");
  });
});
