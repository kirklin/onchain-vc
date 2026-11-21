import { defineConfig } from "drizzle-kit";

/** Used by `pnpm db:generate` to turn changes to the schema into SQL migration files. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});
