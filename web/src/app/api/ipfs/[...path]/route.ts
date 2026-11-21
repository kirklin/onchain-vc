import { serverEnv } from "~/server/env";
import { fileStore, isCid, sniffContentType } from "~/server/files";

export const dynamic = "force-dynamic";

/** The most this route passes along from a gateway. Uploads of its own are far smaller. */
const MAX_PROXIED_BYTES = 10 * 1024 * 1024;
const GATEWAY_TIMEOUT_MS = 20_000;

const headers = {
  // A CID's content never changes.
  "Cache-Control": "public, max-age=31536000, immutable",
  // Files come from anyone. Opened directly, one must not run as a page of this site.
  "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  "X-Content-Type-Options": "nosniff",
};

function reply(bytes: Uint8Array): Response {
  return new Response(bytes as BodyInit, { headers: { ...headers, "Content-Type": sniffContentType(bytes) ?? "application/octet-stream" } });
}

/**
 * Serves `ipfs://<cid>/<path>` from this site's own address: `/api/ipfs/<cid>/<path>`.
 * What this server stored itself comes straight from its file store. Anything else is
 * fetched from the IPFS gateway named by IPFS_GATEWAY_URL, so pages need not depend on a
 * gateway being reachable from the visitor's network.
 */
export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const [cid, ...rest] = (await context.params).path;
  if (cid === undefined || !isCid(cid)) {
    return Response.json({ error: "Not a CID." }, { status: 400 });
  }

  if (rest.length === 0) {
    const stored = await fileStore().get(cid);
    if (stored !== undefined) {
      return reply(stored);
    }
  }

  const url = [serverEnv().ipfsGatewayUrl, "ipfs", cid, ...rest.map(encodeURIComponent)].join("/");
  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
  } catch (error) {
    console.error(`Fetching ${url} failed.`, error);
    return Response.json({ error: "The IPFS gateway did not answer." }, { status: 504 });
  }
  if (!upstream.ok) {
    return Response.json({ error: `The IPFS gateway answered ${upstream.status}.` }, { status: upstream.status === 404 ? 404 : 502 });
  }
  if (Number(upstream.headers.get("content-length") ?? 0) > MAX_PROXIED_BYTES) {
    return Response.json({ error: "The file is too large to pass along." }, { status: 413 });
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_PROXIED_BYTES) {
    return Response.json({ error: "The file is too large to pass along." }, { status: 413 });
  }
  return reply(bytes);
}
