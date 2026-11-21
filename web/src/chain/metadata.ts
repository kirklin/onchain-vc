import { z } from "zod";

const IPFS_URI = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?$/;
const ARWEAVE_URI = /^ar:\/\/([\w-]+)(\/[^?#]*)?$/;
const HTTPS_URI = /^https:\/\//i;
const DATA_URI = /^data:(?:application\/json|image\/[\w.+-]+)[;,]/i;

/**
 * Turns the address a token names its metadata or image by into one a browser can load.
 *
 * - `ipfs://<cid>/<path>` goes through this site's own `/api/ipfs`, which serves its own
 *   uploads and fetches the rest from a gateway.
 * - `ar://<id>` goes to arweave.net.
 * - `https://` addresses and `data:` URIs holding JSON or an image are used as they are.
 *
 * Anything else, plain `http://` and `javascript:` included, gives undefined.
 */
export function resolveUri(uri: string): string | undefined {
  const ipfs = IPFS_URI.exec(uri);
  if (ipfs !== null) {
    return `/api/ipfs/${ipfs[1]}${ipfs[2] ?? ""}`;
  }
  const arweave = ARWEAVE_URI.exec(uri);
  if (arweave !== null) {
    return `https://arweave.net/${arweave[1]}${arweave[2] ?? ""}`;
  }
  return HTTPS_URI.test(uri) || DATA_URI.test(uri) ? uri : undefined;
}

/** The ERC-1155 convention: `{id}` in a URI stands for the token id as 64 hex digits. */
export function withTokenId(uri: string, tokenId: bigint): string {
  return uri.replaceAll("{id}", tokenId.toString(16).padStart(64, "0"));
}

const schema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  // Older collections use these two instead of `image`.
  image_url: z.string().optional(),
  image_data: z.string().optional(),
  attributes: z.array(z.object({ trait_type: z.string().optional(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
});

/** What a token says about itself, in the shape ERC-721 and ERC-1155 metadata takes. */
export interface NftMetadata {
  name?: string;
  description?: string;
  /** Ready for an `<img>`. Absent when the token names no image, or one that cannot be loaded safely. */
  image?: string;
  attributes: { trait: string | undefined; value: string | number | boolean }[];
}

/** Reads the metadata JSON a token points to, and resolves the image it names. */
export function parseNftMetadata(json: unknown): NftMetadata {
  const parsed = schema.parse(json);
  const image = parsed.image ?? parsed.image_url;
  return {
    name: parsed.name,
    description: parsed.description,
    image: image === undefined
      // Raw SVG markup, shown as an image so that nothing in it can run.
      ? (parsed.image_data === undefined ? undefined : `data:image/svg+xml;utf8,${encodeURIComponent(parsed.image_data)}`)
      : resolveUri(image),
    attributes: (parsed.attributes ?? []).map(attribute => ({ trait: attribute.trait_type, value: attribute.value })),
  };
}

/** Fetches and reads a token's metadata from its `tokenURI` or `uri`. */
export async function fetchNftMetadata(tokenUri: string): Promise<NftMetadata> {
  const url = resolveUri(tokenUri);
  if (url === undefined) {
    throw new Error(`Cannot load metadata from ${tokenUri.slice(0, 80)}.`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Loading metadata from ${url.slice(0, 80)} failed with HTTP ${response.status}.`);
  }
  return parseNftMetadata(await response.json());
}
