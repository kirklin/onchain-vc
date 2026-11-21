import type { Address } from "viem";
import { isAddress } from "viem";
import { z } from "zod";
import { chainServices } from "~/server/services";

export const dynamic = "force-dynamic";

const body = z.object({
  chainId: z.number().int(),
  address: z.string().refine(isAddress, "must be an address"),
});

/** Tops up an account with native tokens for gas, on chains that have a faucet. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const faucet = chainServices(parsed.data.chainId)?.faucet;
  if (faucet === undefined) {
    return Response.json({ error: "This chain has no faucet." }, { status: 404 });
  }

  const result = await faucet.fund(parsed.data.address as Address);
  return Response.json({
    status: result.status,
    amount: result.status === "funded" ? result.amount.toString() : undefined,
  });
}
