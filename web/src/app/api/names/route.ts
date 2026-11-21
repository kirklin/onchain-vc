import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { nameService } from "~/server/names";

export const dynamic = "force-dynamic";

const query = z.union([
  z.object({ address: z.string().refine(isAddress, "must be an address") }),
  z.object({ name: z.string().min(1).max(255) }),
]);

// Names change rarely, so browsers may keep an answer for a few minutes.
const headers = { "Cache-Control": "public, max-age=300" };

/**
 * ENS lookups: `?address=` answers with the address's name and avatar, `?name=` with the
 * address a name points to. Everything is null when NEXT_PUBLIC_ENS is not on.
 */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const names = nameService();

  if ("address" in parsed.data) {
    const profile = names === undefined ? { name: null, avatar: null } : await names.profile(getAddress(parsed.data.address as Address));
    return Response.json(profile, { headers });
  }
  return Response.json({ address: names === undefined ? null : await names.resolve(parsed.data.name) }, { headers });
}
