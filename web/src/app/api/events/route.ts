import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { database } from "~/server/db";
import { chainEvents } from "~/server/db/schema";

export const dynamic = "force-dynamic";

const query = z.object({
  chainId: z.coerce.number().int(),
  dealId: z.coerce.bigint().positive().optional(),
  /** Event names, comma-separated. */
  names: z.string().transform(value => value.split(",").filter(name => name !== "")).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The committee's and the fund's events from the index, newest first, with their transactions. */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { chainId, dealId, names, limit } = parsed.data;
  const rows = await (await database())
    .select()
    .from(chainEvents)
    .where(and(
      eq(chainEvents.chainId, chainId),
      dealId === undefined ? undefined : eq(chainEvents.dealId, dealId),
      names === undefined || names.length === 0 ? undefined : inArray(chainEvents.name, names),
    ))
    .orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex))
    .limit(limit);
  return Response.json({
    events: rows.map(row => ({
      contract: row.contract,
      name: row.name,
      dealId: row.dealId === null ? null : Number(row.dealId),
      account: row.account,
      args: row.args,
      blockNumber: row.blockNumber.toString(),
      transactionHash: row.transactionHash,
      timestamp: row.timestamp.toISOString(),
    })),
  });
}
