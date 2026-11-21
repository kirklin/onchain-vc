import { z } from "zod";
import { chainStats } from "~/server/stats";

export const dynamic = "force-dynamic";

const query = z.object({ chainId: z.coerce.number().int() });

/** How many transactions the app has put on a chain, the blocks they are in and what they cost. */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const stats = await chainStats(parsed.data.chainId);
  if (stats === undefined) {
    return Response.json({ error: "This chain is not enabled." }, { status: 404 });
  }
  return Response.json(stats);
}
