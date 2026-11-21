import { z } from "zod";
import { notesOf } from "~/server/committee/meeting";
import { database } from "~/server/db";

export const dynamic = "force-dynamic";

const query = z.object({ chainId: z.coerce.number().int() });

/** Everything the partners concluded about a deal: their analyses, votes and the terms. */
export async function GET(request: Request, context: { params: Promise<{ dealId: string }> }) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const dealId = Number((await context.params).dealId);
  if (!parsed.success || !Number.isInteger(dealId) || dealId <= 0) {
    return Response.json({ error: "Pass a chainId and a deal id." }, { status: 400 });
  }
  return Response.json({ notes: await notesOf(await database(), parsed.data.chainId, dealId) });
}
