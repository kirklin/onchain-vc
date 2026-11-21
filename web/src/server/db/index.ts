import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { serverEnv } from "../env";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

const options = { schema, casing: "snake_case" } as const;

/** Where the SQL files written by `pnpm db:generate` live. The server runs from web/. */
const migrationsFolder = path.join(process.cwd(), "drizzle");

/**
 * Opens the database and brings its tables up to date.
 *
 * With a `postgres://` URL it connects to that server. Without one it runs PGlite, which is
 * Postgres compiled to run inside this process: `dataDir` is where it keeps its files, and
 * leaving that out as well keeps everything in memory. The same SQL runs on both.
 */
export async function openDatabase(parameters: { url?: string; dataDir?: string }): Promise<Database> {
  if (parameters.url !== undefined) {
    const database = drizzlePostgres(postgres(parameters.url), options);
    await migratePostgres(database, { migrationsFolder });
    return database;
  }

  if (parameters.dataDir !== undefined) {
    mkdirSync(parameters.dataDir, { recursive: true });
  }
  const database = drizzlePglite(new PGlite(parameters.dataDir), options);
  await migratePglite(database, { migrationsFolder });
  return database;
}

// One connection per process. Stored on globalThis so dev-server reloads keep it.
const holder = globalThis as typeof globalThis & { onchainVcDatabase?: Promise<Database> };

/** The app's database: the server named by DATABASE_URL, or PGlite under web/.data without one. */
export function database(): Promise<Database> {
  holder.onchainVcDatabase ??= openDatabase({ url: serverEnv().databaseUrl, dataDir: path.join(process.cwd(), ".data", "pglite") });
  return holder.onchainVcDatabase;
}
