import { z } from "zod";
import { milestoneDocument, pitchDocument } from "~/chain/committee";
import { fileStore } from "~/server/files";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("kind", [pitchDocument, milestoneDocument]);

/** Documents one address may store per window. Generous, since a venue's phones can share one address. */
const PER_ADDRESS = 200;
const WINDOW_MS = 10 * 60 * 1000;
const recent = new Map<string, number[]>();

function allowed(request: Request): boolean {
  const from = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  const now = Date.now();
  const times = (recent.get(from) ?? []).filter(at => at > now - WINDOW_MS);
  if (times.length >= PER_ADDRESS) {
    return false;
  }
  recent.set(from, [...times, now]);
  return true;
}

/**
 * Stores what a founder wrote, a pitch or a milestone report, and answers with its CID,
 * which the founder then puts on chain. Only documents of those two shapes are taken, so
 * the store holds nothing else.
 */
export async function POST(request: Request) {
  if (!allowed(request)) {
    return Response.json({ error: "Too many documents from this address. Try again later." }, { status: 429 });
  }
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const cid = await fileStore().put(new TextEncoder().encode(JSON.stringify(parsed.data)));
  return Response.json({ cid });
}
