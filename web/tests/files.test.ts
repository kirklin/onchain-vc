import type { FileStore } from "~/server/files";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { cidOf, DiskFileStore, isCid, KuboFileStore, MAX_FILE_BYTES, sniffContentType } from "~/server/files";

const encoder = new TextEncoder();
// The CID a Kubo node gives these fourteen bytes when asked to store them as a raw block.
const HELLO = encoder.encode("hello onchain-vc");
const HELLO_CID = "bafkreiepav6fpj23ifh25zw3lwpjswjcxufvtbjx66zyjf6yithn6b67c4";

// The disk store always runs. The IPFS one runs against a Kubo node when TEST_IPFS_API_URL names one:
//   docker run --rm -p 127.0.0.1:5001:5001 ipfs/kubo daemon --offline
//   TEST_IPFS_API_URL=http://127.0.0.1:5001 pnpm test:web
const ipfsApi = process.env.TEST_IPFS_API_URL;

function unique(): Uint8Array {
  return encoder.encode(`file ${Date.now()} ${Math.random()}`);
}

function storeSuite(make: () => Promise<FileStore>) {
  it("names a file by the CID of its bytes and returns the same bytes for it", async () => {
    const store = await make();

    expect(await store.put(HELLO)).toBe(HELLO_CID);
    expect(await store.get(HELLO_CID)).toEqual(HELLO);
  });

  it("gives the same name to the same bytes, and different names to different bytes", async () => {
    const store = await make();
    const bytes = unique();

    const cid = await store.put(bytes);
    expect(await store.put(bytes)).toBe(cid);
    expect(await store.put(unique())).not.toBe(cid);
    expect(await store.get(cid)).toEqual(bytes);
  });

  it("has nothing for a CID it was never given, or for a name that is not a CID", async () => {
    const store = await make();

    expect(await store.get(await cidOf(unique()))).toBeUndefined();
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    expect(await store.get("")).toBeUndefined();
  });

  it("stores a file of the largest size and refuses a larger or an empty one", async () => {
    const store = await make();
    const largest = new Uint8Array(MAX_FILE_BYTES).fill(7);

    expect(await store.get(await store.put(largest))).toEqual(largest);
    await expect(store.put(new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toThrow(RangeError);
    await expect(store.put(new Uint8Array(0))).rejects.toThrow(RangeError);
  });
}

describe("disk file store", () => {
  storeSuite(async () => new DiskFileStore(await mkdtemp(path.join(tmpdir(), "onchain-vc-files-"))));

  it("keeps each file under its CID and nothing else", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "onchain-vc-files-"));
    const store = new DiskFileStore(path.join(directory, "nested", "files"));

    const cid = await store.put(HELLO);
    await store.put(HELLO);

    expect(await readdir(path.join(directory, "nested", "files"))).toEqual([cid]);
  });
});

describe.skipIf(ipfsApi === undefined)("ipfs file store", () => {
  storeSuite(async () => new KuboFileStore(ipfsApi!));

  it("makes a file stored on disk and one stored in IPFS interchangeable", async () => {
    const bytes = unique();
    const onDisk = await new DiskFileStore(await mkdtemp(path.join(tmpdir(), "onchain-vc-files-"))).put(bytes);

    expect(await new KuboFileStore(`${ipfsApi!}/`).put(bytes)).toBe(onDisk);
  });
});

describe("isCid", () => {
  it("accepts canonical CIDs only", () => {
    expect(isCid(HELLO_CID)).toBe(true);
    expect(isCid(HELLO_CID.toUpperCase())).toBe(false);
    expect(isCid(`${HELLO_CID}/..`)).toBe(false);
    expect(isCid("hello")).toBe(false);
  });
});

describe("sniffContentType", () => {
  it("recognises images by their first bytes", () => {
    expect(sniffContentType(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]))).toBe("image/png");
    expect(sniffContentType(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0]))).toBe("image/jpeg");
    expect(sniffContentType(encoder.encode("GIF89a...."))).toBe("image/gif");
    expect(sniffContentType(encoder.encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffContentType(encoder.encode("  <svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"))).toBe("image/svg+xml");
    expect(sniffContentType(encoder.encode("<?xml version=\"1.0\"?>\n<svg></svg>"))).toBe("image/svg+xml");
  });

  it("recognises JSON, and nothing in anything else", () => {
    expect(sniffContentType(encoder.encode("{\"name\":\"A\"}"))).toBe("application/json");
    expect(sniffContentType(encoder.encode("<html><script>alert(1)</script></html>"))).toBeUndefined();
    expect(sniffContentType(encoder.encode("RIFF\u0000\u0000\u0000\u0000WAVEfmt "))).toBeUndefined();
    expect(sniffContentType(HELLO)).toBeUndefined();
  });
});
