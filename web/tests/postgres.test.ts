import type { Address } from "viem";
import type { Database } from "~/server/db";
import process from "node:process";
import { and, asc, eq, sql } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { committeeAbi } from "~/contracts/abis";
import { notesOf } from "~/server/committee/meeting";
import { openDatabase } from "~/server/db";
import { chainEvents, indexerCursors, meetingNotes } from "~/server/db/schema";
import { Indexer } from "~/server/indexer";
import { eventSource } from "~/server/indexing";
import { ANVIL_KEYS, deployFundSystem, testChain, testClient } from "./helpers";

// The other tests run on PGlite. This one runs the same code against a Postgres server,
// when TEST_DATABASE_URL names one whose contents may be thrown away:
//   docker run --rm -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:18-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/postgres pnpm test:web
const url = process.env.TEST_DATABASE_URL;

const client = testClient(ANVIL_KEYS[6]);

describe.skipIf(url === undefined)("with a Postgres server", () => {
  let database: Database;
  let committee: Address;
  let startBlock: bigint;

  beforeAll(async () => {
    database = await openDatabase({ url });
    await database.execute(sql`truncate ${chainEvents}, ${indexerCursors}, ${meetingNotes}`);
    ({ committee } = await deployFundSystem(ANVIL_KEYS[6], client.account.address));
    startBlock = await client.getBlockNumber();
  });

  it("indexes the committee's events with their arguments", async () => {
    const hash = await client.writeContract({ address: committee, abi: committeeAbi, functionName: "setProfile", args: ["On Postgres", keccak256(stringToBytes("postgres"))] });
    await client.waitForTransactionReceipt({ hash });

    await new Indexer({
      database,
      client,
      sources: [eventSource(testChain.id, "committee", committee, committeeAbi, startBlock)],
      confirmations: 0,
      logRange: 1000n,
      pollMs: 50,
    }).sync();

    const rows = await database
      .select({ args: chainEvents.args, account: chainEvents.account })
      .from(chainEvents)
      .where(and(eq(chainEvents.contract, "committee"), eq(chainEvents.name, "ProfileSet")))
      .orderBy(asc(chainEvents.blockNumber));
    expect(rows.at(-1)).toEqual({ account: client.account.address, args: { partner: client.account.address, name: "On Postgres", profileHash: keccak256(stringToBytes("postgres")) } });
  });

  it("keeps meeting notes with their tools, terms and transaction", async () => {
    await database.insert(meetingNotes).values({
      chainId: testChain.id,
      dealId: 7,
      round: 0,
      phase: "terms",
      role: "risk",
      text: "首笔四成，里程碑三十天。",
      tools: [{ tool: "fund_status", input: {}, failed: false }],
      terms: { amount: 300, firstTranchePercent: 40, milestoneDays: 30, milestone: "上线收款页面" },
      cid: "bafkreidemo",
      transactionHash: "0x01",
      confirmMs: 420,
    });

    const [note] = await notesOf(database, testChain.id, 7);
    expect(note).toMatchObject({
      dealId: 7,
      phase: "terms",
      role: "risk",
      terms: { amount: 300, firstTranchePercent: 40, milestoneDays: 30, milestone: "上线收款页面" },
      tools: [{ tool: "fund_status", input: {}, failed: false }],
      confirmMs: 420,
    });
  });
});
