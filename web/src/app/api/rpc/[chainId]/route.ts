import { chainServices } from "~/server/services";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;

function rpcError(code: number, message: string, status: number) {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

/** The JSON-RPC endpoint browsers use for one chain. See RpcGateway for what happens behind it. */
export async function POST(request: Request, { params }: { params: Promise<{ chainId: string }> }) {
  const services = chainServices(Number((await params).chainId));
  if (services === undefined) {
    return rpcError(-32601, "This chain is not enabled.", 404);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return rpcError(-32600, "Request body too large.", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return rpcError(-32700, "Parse error.", 400);
  }

  return Response.json(await services.gateway.serve(payload));
}
