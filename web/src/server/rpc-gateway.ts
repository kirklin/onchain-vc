import type { Hex } from "viem";
import { keccak256 } from "viem";

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcOutcome = { result: unknown } | { error: RpcError };

export interface RpcGatewayOptions {
  upstreams: readonly string[];
  /** Minimum gap between two batches sent to the same upstream. */
  batchIntervalMs: number;
  /** How long a read stays fresh. One block is the natural choice. */
  blockTtlMs: number;
  maxBatchSize?: number;
  maxAttempts?: number;
  cooldownMs?: number;
  timeoutMs?: number;
}

export interface RpcGatewayStats {
  requests: number;
  cacheHits: number;
  shared: number;
  batches: number;
  forwarded: number;
  upstreamFailures: number;
}

/**
 * - `static` never changes for a given chain.
 * - `block` may change with every block.
 * - `receipt` is settled once the transaction it describes is in a block.
 * - `send` submits a transaction and returns its hash.
 * - `sync` submits a transaction and holds the response until its receipt exists.
 */
type MethodKind = "static" | "block" | "receipt" | "send" | "sync";

const METHODS: Record<string, MethodKind> = {
  eth_chainId: "static",
  net_version: "static",
  web3_clientVersion: "static",
  eth_blockNumber: "block",
  eth_call: "block",
  eth_createAccessList: "block",
  eth_estimateGas: "block",
  eth_feeHistory: "block",
  eth_gasPrice: "block",
  eth_getBalance: "block",
  eth_getBlockByHash: "block",
  eth_getBlockByNumber: "block",
  eth_getBlockReceipts: "block",
  eth_getBlockTransactionCountByHash: "block",
  eth_getBlockTransactionCountByNumber: "block",
  eth_getCode: "block",
  eth_getLogs: "block",
  eth_getStorageAt: "block",
  eth_getTransactionCount: "block",
  eth_maxPriorityFeePerGas: "block",
  eth_syncing: "block",
  eth_getTransactionByHash: "receipt",
  eth_getTransactionReceipt: "receipt",
  eth_sendRawTransaction: "send",
  eth_sendRawTransactionSync: "sync",
};

const RECEIPT_TTL_MS = 30_000;

/**
 * Whether a transaction or receipt lookup found something that is in a block. A transaction
 * still waiting in the pool is found too, with no block, and may yet be replaced.
 */
function isIncluded(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { blockHash?: unknown }).blockHash != null;
}

/** Whether an answer can no longer change, as opposed to holding only until the next block. */
function isSettled(kind: MethodKind, outcome: RpcOutcome): boolean {
  return kind === "static" || (kind === "receipt" && "result" in outcome && isIncluded(outcome.result));
}
const MAX_CACHE_ENTRIES = 10_000;
const MAX_CLIENT_BATCH = 100;
const ALREADY_KNOWN = /already (?:known|imported)|known transaction/i;

interface Job {
  id: number;
  method: string;
  params: readonly unknown[];
  attempts: number;
  resolve: (outcome: RpcOutcome) => void;
}

interface Lane {
  queue: Job[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Upstream {
  url: string;
  readyAt: number;
  usedAt: number;
}

function fail(code: number, message: string): RpcOutcome {
  return { error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON-RPC front for a chain's upstream nodes. Browsers call the app, and the app calls
 * the nodes.
 *
 * - Provider URLs and their API keys never reach the browser.
 * - Everything received is merged into batches paced to each upstream's rate limit, so
 *   many visitors cost few upstream requests.
 * - Identical reads within a block are answered from one upstream call.
 * - A failing or throttling upstream is rested while the others take over.
 */
export class RpcGateway {
  readonly #options: Required<RpcGatewayOptions>;
  readonly #upstreams: Upstream[];
  readonly #lanes: Record<"fast" | "sync", Lane> = {
    fast: { queue: [], timer: undefined },
    sync: { queue: [], timer: undefined },
  };

  readonly #cache = new Map<string, { expires: number; perBlock: boolean; outcome: RpcOutcome }>();
  readonly #inflight = new Map<string, Promise<RpcOutcome>>();
  readonly #stats: RpcGatewayStats = { requests: 0, cacheHits: 0, shared: 0, batches: 0, forwarded: 0, upstreamFailures: 0 };
  #nextId = 1;
  #epoch = 0;
  /** The highest block number any upstream has reported. */
  #head: bigint | undefined;

  constructor(options: RpcGatewayOptions) {
    if (options.upstreams.length === 0) {
      throw new Error("RpcGateway needs at least one upstream.");
    }
    this.#options = { maxBatchSize: 100, maxAttempts: 3, cooldownMs: 1000, timeoutMs: 15_000, ...options };
    this.#upstreams = options.upstreams.map(url => ({ url, readyAt: 0, usedAt: 0 }));
  }

  stats(): RpcGatewayStats {
    return { ...this.#stats };
  }

  request(method: string, params: readonly unknown[] = []): Promise<RpcOutcome> {
    this.#stats.requests += 1;

    const kind = METHODS[method];
    if (kind === undefined) {
      return Promise.resolve(fail(-32601, `The method ${method} is not available through this gateway.`));
    }
    if (kind === "send") {
      return this.#enqueue("fast", method, params);
    }
    if (kind === "sync") {
      return this.#enqueue("sync", method, params).then((outcome) => {
        if ("result" in outcome) {
          this.#forgetBlockReads();
        }
        return outcome;
      });
    }

    const key = `${method}:${JSON.stringify(params)}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expires > Date.now()) {
      this.#stats.cacheHits += 1;
      return Promise.resolve(cached.outcome);
    }

    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      this.#stats.shared += 1;
      return pending;
    }

    const epoch = this.#epoch;
    const promise = this.#enqueue("fast", method, params).then((outcome) => {
      this.#inflight.delete(key);
      if (method === "eth_blockNumber" && "result" in outcome && this.#isNewHead(outcome.result)) {
        // Everything read during the block before this one is out of date.
        this.#forgetBlockReads();
        this.#remember(key, kind, outcome);
        return outcome;
      }
      // A read that was under way while a block arrived or a transaction confirmed may predate it.
      if (isSettled(kind, outcome) || epoch === this.#epoch) {
        this.#remember(key, kind, outcome);
      }
      return outcome;
    });
    this.#inflight.set(key, promise);
    return promise;
  }

  /** Answers a JSON-RPC payload as received over HTTP: one request object or an array of them. */
  async serve(payload: unknown): Promise<unknown> {
    if (!Array.isArray(payload)) {
      return this.#serveOne(payload);
    }
    if (payload.length === 0 || payload.length > MAX_CLIENT_BATCH) {
      return { jsonrpc: "2.0", id: null, ...fail(-32600, `A batch must hold between 1 and ${MAX_CLIENT_BATCH} requests.`) };
    }
    return Promise.all(payload.map(item => this.#serveOne(item)));
  }

  async #serveOne(item: unknown) {
    if (!isRecord(item) || typeof item.method !== "string" || (item.params !== undefined && !Array.isArray(item.params))) {
      return { jsonrpc: "2.0", id: null, ...fail(-32600, "Invalid request.") };
    }
    const id = typeof item.id === "string" || typeof item.id === "number" ? item.id : null;
    const outcome = await this.request(item.method, item.params ?? []);
    return { jsonrpc: "2.0", id, ...outcome };
  }

  #remember(key: string, kind: MethodKind, outcome: RpcOutcome) {
    if ("error" in outcome) {
      return;
    }
    let ttl = this.#options.blockTtlMs;
    if (kind === "static") {
      ttl = Number.POSITIVE_INFINITY;
    } else if (kind === "receipt" && isIncluded(outcome.result)) {
      ttl = RECEIPT_TTL_MS;
      this.#forgetBlockReads();
    }

    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      this.#evict();
    }
    this.#cache.set(key, { expires: Date.now() + ttl, perBlock: !isSettled(kind, outcome), outcome });
  }

  #isNewHead(result: unknown): boolean {
    const number = BigInt(result as string);
    if (this.#head !== undefined && number <= this.#head) {
      return false;
    }
    this.#head = number;
    return true;
  }

  /**
   * Called when the chain is known to have moved on: a higher block number came back, a
   * synchronous send has returned, or a receipt has shown up for the first time. The next
   * read must show the effect, and anything cached from before the block is out of date.
   */
  #forgetBlockReads() {
    this.#epoch += 1;
    for (const [key, entry] of this.#cache) {
      if (entry.perBlock) {
        this.#cache.delete(key);
      }
    }
  }

  #evict() {
    const now = Date.now();
    for (const [key, entry] of this.#cache) {
      if (entry.expires <= now) {
        this.#cache.delete(key);
      }
    }
    // Still full of live entries: drop the oldest half, which a Map yields first.
    let excess = this.#cache.size - MAX_CACHE_ENTRIES / 2;
    for (const [key, entry] of this.#cache) {
      if (excess <= 0) {
        break;
      }
      if (entry.expires !== Number.POSITIVE_INFINITY) {
        this.#cache.delete(key);
        excess -= 1;
      }
    }
  }

  #enqueue(lane: "fast" | "sync", method: string, params: readonly unknown[]): Promise<RpcOutcome> {
    return new Promise((resolve) => {
      this.#lanes[lane].queue.push({ id: this.#nextId++, method, params, attempts: 0, resolve });
      this.#schedule(lane);
    });
  }

  #schedule(name: "fast" | "sync") {
    const lane = this.#lanes[name];
    if (lane.timer !== undefined || lane.queue.length === 0) {
      return;
    }

    const now = Date.now();
    // The soonest free upstream wins, and among several free ones the one idle the longest.
    const upstream = this.#upstreams.reduce((best, candidate) => {
      const wait = Math.max(candidate.readyAt, now) - Math.max(best.readyAt, now);
      return wait < 0 || (wait === 0 && candidate.usedAt < best.usedAt) ? candidate : best;
    });
    const startAt = Math.max(now, upstream.readyAt);
    // Claim the slot now so the other lane cannot be handed the same one.
    upstream.readyAt = startAt + this.#options.batchIntervalMs;
    upstream.usedAt = startAt;

    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      const jobs = lane.queue.splice(0, this.#options.maxBatchSize);
      this.#schedule(name);
      void this.#dispatch(name, jobs, upstream);
    }, startAt - now);
  }

  async #dispatch(lane: "fast" | "sync", jobs: Job[], upstream: Upstream) {
    this.#stats.batches += 1;
    this.#stats.forwarded += jobs.length;

    const replies = await this.#post(upstream, jobs);
    if (typeof replies === "string") {
      this.#stats.upstreamFailures += 1;
      upstream.readyAt = Math.max(upstream.readyAt, Date.now() + this.#options.cooldownMs);

      const retry: Job[] = [];
      for (const job of jobs) {
        job.attempts += 1;
        if (job.attempts >= this.#options.maxAttempts) {
          job.resolve(fail(-32603, `Every upstream attempt failed: ${replies}`));
        } else {
          retry.push(job);
        }
      }
      this.#lanes[lane].queue.unshift(...retry);
      this.#schedule(lane);
      return;
    }

    for (const job of jobs) {
      const reply = replies.get(job.id);
      if (reply === undefined) {
        job.resolve(fail(-32603, "The upstream left this request unanswered."));
        continue;
      }
      if ("error" in reply && job.method === "eth_sendRawTransaction" && job.attempts > 0) {
        void this.#settleRetriedSend(job, reply.error);
        continue;
      }
      job.resolve(reply);
    }
  }

  /**
   * An earlier attempt may have reached the node before its response was lost, in which case
   * the retry is refused as a duplicate or a stale nonce although the transaction is in.
   */
  async #settleRetriedSend(job: Job, error: RpcError) {
    const hash = keccak256(job.params[0] as Hex);
    if (ALREADY_KNOWN.test(error.message)) {
      job.resolve({ result: hash });
      return;
    }
    const receipt = await this.request("eth_getTransactionReceipt", [hash]);
    job.resolve("result" in receipt && receipt.result !== null ? { result: hash } : { error });
  }

  /** Returns the replies keyed by request id, or a description of why the whole batch failed. */
  async #post(upstream: Upstream, jobs: Job[]): Promise<Map<number, RpcOutcome> | string> {
    const body = jobs.map(job => ({ jsonrpc: "2.0", id: job.id, method: job.method, params: job.params }));

    let payload: unknown;
    try {
      const response = await fetch(upstream.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
      if (!response.ok) {
        return `${upstream.url} answered HTTP ${response.status}`;
      }
      payload = await response.json();
    } catch (error) {
      return `${upstream.url} could not be reached (${error instanceof Error ? error.message : String(error)})`;
    }

    if (!Array.isArray(payload)) {
      const message = isRecord(payload) && isRecord(payload.error) ? String(payload.error.message) : "an unexpected body";
      return `${upstream.url} rejected the batch: ${message}`;
    }

    const replies = new Map<number, RpcOutcome>();
    for (const item of payload) {
      if (!isRecord(item) || typeof item.id !== "number") {
        continue;
      }
      if (isRecord(item.error)) {
        replies.set(item.id, { error: item.error as unknown as RpcError });
      } else {
        replies.set(item.id, { result: item.result ?? null });
      }
    }
    return replies;
  }
}
