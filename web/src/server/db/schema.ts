import { Buffer } from "node:buffer";
import { bigint, boolean, customType, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The app's tables. After changing this file run `pnpm db:generate`, which writes the SQL
 * for the change into web/drizzle. The server applies pending files when it starts.
 */

/** How far each indexer source has read, so a restart carries on where it stopped. */
export const indexerCursors = pgTable("indexer_cursors", {
  chainId: integer().notNull(),
  source: text().notNull(),
  /** The last block whose logs are fully stored. */
  block: bigint({ mode: "bigint" }).notNull(),
  /** That block's hash, to notice when the chain no longer contains it. */
  blockHash: text().notNull(),
}, table => [primaryKey({ columns: [table.chainId, table.source] })]);

/** Every event the committee and the fund emit, so pages can show a deal's history with its transactions. */
export const chainEvents = pgTable("chain_events", {
  chainId: integer().notNull(),
  contract: text().notNull(),
  blockNumber: bigint({ mode: "bigint" }).notNull(),
  /** The log's position in its block, which with the block number orders all events. */
  logIndex: integer().notNull(),
  transactionHash: text().notNull(),
  /** When the block was produced, by the chain's clock. */
  timestamp: timestamp({ withTimezone: true }).notNull(),
  name: text().notNull(),
  /** The deal the event is about, when it is about one. */
  dealId: numeric({ precision: 78, scale: 0, mode: "bigint" }),
  /** The account the event is about: the founder, the partner or the investor. */
  account: text(),
  /** The event's arguments, with integers written as decimal strings. */
  args: jsonb().$type<Record<string, unknown>>().notNull(),
}, table => [
  primaryKey({ columns: [table.chainId, table.blockNumber, table.logIndex] }),
  index().on(table.chainId, table.dealId, table.blockNumber, table.logIndex),
  index().on(table.chainId, table.name, table.blockNumber),
  index().on(table.chainId, table.account),
]);

/** What each partner concluded in each phase of a meeting, kept so a restart does not ask again. */
export const meetingNotes = pgTable("meeting_notes", {
  chainId: integer().notNull(),
  dealId: integer().notNull(),
  round: integer().notNull(),
  phase: text().notNull(),
  role: text().notNull(),
  text: text().notNull(),
  inFavour: boolean(),
  score: integer(),
  tools: jsonb().$type<{ tool: string; input: Record<string, unknown>; failed: boolean }[]>().notNull(),
  terms: jsonb().$type<{ amount: number; firstTranchePercent: number; milestoneDays: number; milestone: string }>(),
  cid: text(),
  transactionHash: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.chainId, table.dealId, table.round, table.phase, table.role] })]);

/** Raw bytes. A Postgres server hands them back as a Buffer and PGlite as a Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: value => Buffer.from(value),
  fromDriver: value => new Uint8Array(value),
});

/** Pitches, reports, opinions and terms by their CID, where every instance that shares the database finds them. */
export const files = pgTable("files", {
  cid: text().primaryKey(),
  bytes: bytea().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
