import type { Address } from "viem";
import { isAddress } from "viem";
import { z } from "zod";
import { chainServices } from "~/server/services";

export const dynamic = "force-dynamic";

const body = z.object({
  chainId: z.number().int(),
  address: z.string().refine(isAddress, "must be an address"),
});

/** Makes the address an investor in the fund, on chains where the app takes visitors in. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const join = chainServices(parsed.data.chainId)?.join;
  if (join === undefined) {
    return Response.json({ error: "This chain does not take visitors into the fund." }, { status: 404 });
  }

  const result = await join.join(parsed.data.address as Address);
  return Response.json({
    status: result.status,
    shares: result.status === "full" ? undefined : result.shares.toString(),
    transactionHash: result.status === "joined" ? result.transactionHash : undefined,
    blockNumber: result.status === "joined" ? result.blockNumber.toString() : undefined,
  });
}
