import type { Database } from "./db";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { eq } from "drizzle-orm";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { database } from "./db";
import { files } from "./db/schema";
import { serverEnv } from "./env";

/**
 * Where uploaded files are kept. A file is named by the hash of its contents, as an IPFS
 * content identifier (CID), so the same bytes always get the same name wherever they are
 * stored, and a name can never come to mean different bytes.
 */
export interface FileStore {
  /** Stores the bytes and returns their CID. Storing the same bytes again changes nothing. */
  put: (bytes: Uint8Array) => Promise<string>;
  /** The bytes behind a CID, or undefined when this store does not have them. */
  get: (cid: string) => Promise<Uint8Array | undefined>;
}

/**
 * Files are stored as single IPFS blocks, which nodes exchange up to this size. It is
 * plenty for metadata and for images prepared for the web.
 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The CID of a file stored as one raw block: version 1, sha2-256. */
export async function cidOf(bytes: Uint8Array): Promise<string> {
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

/** Whether the text is a CID in its canonical form, safe to use as a file name. */
export function isCid(text: string): boolean {
  try {
    return CID.parse(text).toString() === text;
  } catch {
    return false;
  }
}

function assertStorable(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    throw new RangeError(`A file must be between 1 and ${MAX_FILE_BYTES} bytes, not ${bytes.byteLength}.`);
  }
}

/** Keeps files in a directory on this machine. Enough for one server, and for development. */
export class DiskFileStore implements FileStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async put(bytes: Uint8Array): Promise<string> {
    assertStorable(bytes);
    const cid = await cidOf(bytes);
    await mkdir(this.#directory, { recursive: true });
    await writeFile(path.join(this.#directory, cid), bytes);
    return cid;
  }

  async get(cid: string): Promise<Uint8Array | undefined> {
    if (!isCid(cid)) {
      return undefined;
    }
    try {
      return new Uint8Array(await readFile(path.join(this.#directory, cid)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}

/**
 * Keeps files in an IPFS node through Kubo's RPC API, pinned so the node holds on to them.
 * Anyone on the IPFS network can then fetch them by the same CID.
 */
export class KuboFileStore implements FileStore {
  readonly #api: string;

  /** `apiUrl` is the node's RPC address, by default http://127.0.0.1:5001. Never expose that port publicly. */
  constructor(apiUrl: string) {
    this.#api = apiUrl.replace(/\/+$/, "");
  }

  async put(bytes: Uint8Array): Promise<string> {
    assertStorable(bytes);
    const form = new FormData();
    form.set("data", new Blob([Buffer.from(bytes)]));
    const response = await fetch(`${this.#api}/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&pin=true`, { method: "POST", body: form });
    if (!response.ok) {
      throw new Error(`The IPFS node refused the file with HTTP ${response.status}: ${await response.text()}`);
    }
    const { Key: cid } = await response.json() as { Key: string };
    if (cid !== await cidOf(bytes)) {
      throw new Error(`The IPFS node stored the file as ${cid}, which is not the CID of its bytes.`);
    }
    return cid;
  }

  async get(cid: string): Promise<Uint8Array | undefined> {
    if (!isCid(cid)) {
      return undefined;
    }
    // Only what the node already holds. Looking a block up on the network can take minutes.
    const response = await fetch(`${this.#api}/api/v0/block/get?arg=${cid}&offline=true`, { method: "POST" });
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
    const message = await response.text();
    if (response.status === 500 && message.includes("block was not found locally")) {
      return undefined;
    }
    throw new Error(`The IPFS node failed to return ${cid} with HTTP ${response.status}: ${message}`);
  }
}

/**
 * Keeps files in the app's database. Instances that share a database then share its files
 * too, which a directory on one of their machines would not give them.
 */
export class DatabaseFileStore implements FileStore {
  readonly #database: () => Promise<Database>;

  constructor(open: () => Promise<Database>) {
    this.#database = open;
  }

  async put(bytes: Uint8Array): Promise<string> {
    assertStorable(bytes);
    const cid = await cidOf(bytes);
    const db = await this.#database();
    await db.insert(files).values({ cid, bytes }).onConflictDoNothing();
    return cid;
  }

  async get(cid: string): Promise<Uint8Array | undefined> {
    if (!isCid(cid)) {
      return undefined;
    }
    const db = await this.#database();
    const [stored] = await db.select({ bytes: files.bytes }).from(files).where(eq(files.cid, cid));
    return stored?.bytes;
  }
}

// One store per process. Stored on globalThis so dev-server reloads keep it.
const holder = globalThis as typeof globalThis & { onchainVcFileStore?: FileStore };

function configuredStore(): FileStore {
  const { ipfsApiUrl, databaseUrl } = serverEnv();
  if (ipfsApiUrl !== undefined) {
    return new KuboFileStore(ipfsApiUrl);
  }
  // A Postgres server is what several instances share, so their files go where they all look.
  return databaseUrl === undefined
    ? new DiskFileStore(path.join(process.cwd(), ".data", "files"))
    : new DatabaseFileStore(database);
}

/**
 * The app's file store: the IPFS node named by IPFS_API_URL, or else the Postgres server
 * named by DATABASE_URL, or with neither a directory under web/.data.
 */
export function fileStore(): FileStore {
  holder.onchainVcFileStore ??= configuredStore();
  return holder.onchainVcFileStore;
}

const SIGNATURES: readonly (readonly [string, readonly number[]])[] = [
  ["image/png", [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  ["image/jpeg", [0xFF, 0xD8, 0xFF]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Tells what a file is from its first bytes, since a CID carries no file name or type.
 * Recognises the image formats browsers show, and JSON. Anything else is undefined.
 */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  for (const [type, signature] of SIGNATURES) {
    if (startsWith(bytes, signature)) {
      return type;
    }
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return "image/webp";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  if (head.startsWith("{") || head.startsWith("[")) {
    return "application/json";
  }
  return undefined;
}
