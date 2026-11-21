import type { Address, Hex } from "viem";
import { isAddress, isHex } from "viem";
import { z } from "zod";
import { chainServices } from "~/server/services";

export const dynamic = "force-dynamic";

const UNSIGNED_INTEGER = /^\d+$/;

const address = z.string().refine(isAddress, "must be an address");
const hex = z.string().refine(value => isHex(value), "must be hex");
const amount = z.string().regex(UNSIGNED_INTEGER, "must be an unsigned integer").transform(value => BigInt(value));

const body = z.object({
  chainId: z.number().int(),
  request: z.object({
    from: address,
    to: address,
    value: amount,
    gas: amount,
    deadline: z.number().int().nonnegative(),
    data: hex,
    signature: hex,
  }),
});

/** Submits a call the user signed for the Forwarder, with the server paying the gas. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const relay = chainServices(parsed.data.chainId)?.relay;
  if (relay === undefined) {
    return Response.json({ error: "This chain has no relayer." }, { status: 404 });
  }

  const { from, to, data, signature, ...rest } = parsed.data.request;
  const result = await relay.relay({ ...rest, from: from as Address, to: to as Address, data: data as Hex, signature: signature as Hex });
  return Response.json(result, { status: result.status === "relayed" ? 200 : 422 });
}
